/**
 * GET /api/periscope-map
 *
 * Deterministic Periscope "trader's map" served directly from
 * `gex_strike_0dte` at 1-min cadence. No Claude. No scraper.
 *
 * Source of truth is the Unusual Whales spot-exposures feed
 * (`/stock/SPX/spot-exposures/expiry-strike`, SPX 0DTE, ~1-min cadence)
 * which a cron lands in `gex_strike_0dte`. Each tick carries every
 * strike's call/put gamma, charm and vanna in one row set, so a single
 * query per slot yields all three panels:
 *
 *   gamma = call_gamma_oi + put_gamma_oi
 *   charm = call_charm_oi + put_charm_oi
 *   vanna = call_vanna_oi + put_vanna_oi
 *
 * This endpoint used to read `gexbot_api_capture`; the GEXBot trial key
 * expired (HTTP 401) and that table is permanently empty. The GEXBot
 * crons + decoder are kept in place in case the subscription is renewed.
 *
 * The historical lookup path (`/api/periscope-exposure?date=...`) stays,
 * reading `periscope_snapshots`. That table is fed by the 10-min adapter
 * crons and only covers what those crons have written — it is NOT a
 * longer history than this live path.
 *
 * Pipeline:
 *   1. Read every strike of the latest `gex_strike_0dte` tick within the
 *      staleness window (one query — all three greeks come together)
 *   2. Read the same for the nearest tick >= PRIOR_LOOKBACK_MIN earlier
 *      (for sign-flip detection and per-strike delta semantics in the
 *      existing view-builder)
 *   3. Net call+put per strike -> PeriscopeRow[] for each panel
 *   4. Build PeriscopeSlot for latest + prior
 *   5. Spot anchor: the tick's own `price` column, falling back to
 *      fetchSpxSpot(today) when UW left it null
 *   6. fetchConeLevels + fetchConeBreaches (nullable; cone may not exist yet)
 *   7. computePeriscopeView() — same pure builder the analyze prompt uses
 *   8. Return { marketOpen, asOf, data, reason, availableSlots: [] }
 *
 * Response shape matches /api/periscope-exposure so the existing
 * usePeriscopeExposure hook can swap source URLs without further changes.
 *
 * Auth: owner or guest (same as /api/periscope-exposure — Periscope data
 * is not Anthropic-gated).
 *
 * Spec: docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md
 *   — this is the MVP of that build. Full analyzer + structure
 *   recommendations are a follow-up.
 * Repoint spec: docs/superpowers/specs/periscope-uw-repoint-2026-08-21.md
 */

import { Sentry, metrics } from './_lib/sentry.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setCacheHeaders, isMarketOpen } from './_lib/api-helpers.js';
import { guardOwnerOrGuestEndpoint } from './_lib/guest-auth.js';
import { getDb, withDbRetry } from './_lib/db.js';
import { sendDbErrorResponse } from './_lib/transient-db-response.js';
import {
  computePeriscopeView,
  fetchConeLevels,
  fetchConeBreaches,
  type PeriscopeSlot,
  type PeriscopeRow,
  type PeriscopeView,
} from './_lib/periscope-format.js';
import {
  fetchAvailableSlots,
  fetchSpxSpot,
  resolveSnapshotSource,
} from './_lib/periscope-query.js';
import { getETDateStr } from '../src/utils/timezone.js';
import logger from './_lib/logger.js';
import {
  PANELS,
  PRIOR_LOOKBACK_FLOOR_MIN,
  PRIOR_LOOKBACK_MIN,
  STALENESS_CUTOFF_MS,
  type PanelName,
} from './_lib/periscope-gexbot.js';
import {
  PANEL_SOURCE_COLUMNS,
  SOURCE_UW_SPOT,
  netValue,
  type UwStrikeRow,
} from './_lib/periscope-uw.js';

/**
 * A NUMERIC column as the Neon driver hands it back: normally a string,
 * occasionally already a number, and NULL when UW omitted it.
 */
type NumericCol = string | number | null;

/**
 * One `gex_strike_0dte` row — one strike of one 1-min UW tick. The six
 * greek legs are deliberately NOT spelled out here: they are read
 * through `netValue()` off the shared column map, so this endpoint
 * carries no second copy of their names.
 */
interface UwGexStrikeRow extends UwStrikeRow {
  timestamp: Date | string;
  strike: NumericCol;
  price: NumericCol;
}

/**
 * The `SELECT` list for one tick: the row-identity columns plus the six
 * greek legs derived from `PANEL_SOURCE_COLUMNS` (api/_lib/periscope-uw.ts),
 * the single copy of the UW column map. Spelling the legs out here
 * would let this live render drift from the `uw_spot` rows the cron
 * stores for the very same tick.
 */
const UW_SPOT_TICK_COLUMNS = [
  'timestamp',
  'strike',
  'price',
  ...PANELS.flatMap((panel) => {
    const cols = PANEL_SOURCE_COLUMNS[SOURCE_UW_SPOT][panel];
    return [cols.call, cols.put];
  }),
].join(', ');

/** A latest/prior slot plus the spot price UW stamped on that tick. */
interface UwSlot {
  slot: PeriscopeSlot;
  /** `price` from the tick — null when UW left the column empty. */
  spot: number | null;
}

/**
 * Coerce `strike` / `price` — the two non-greek NUMERIC columns, which
 * the shared mapper does not cover — to a finite number. NUMERIC comes
 * back as a string; SonarJS forbids the bare `parseFloat` global.
 */
function parseNumeric(raw: NumericCol | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn one tick's rows into a `PeriscopeSlot` (all three panels) plus
 * the tick's spot. Returns null when the tick yields no usable strike
 * on any panel — treated the same as "no tick" by the caller.
 */
function buildSlotFromRows(
  date: string,
  rows: UwGexStrikeRow[],
): UwSlot | null {
  if (rows.length === 0) return null;

  const panels: Record<PanelName, PeriscopeRow[]> = {
    gamma: [],
    charm: [],
    vanna: [],
  };
  let capturedAt: Date | null = null;
  let spot: number | null = null;

  for (const r of rows) {
    const ts = new Date(r.timestamp);
    if (
      !Number.isNaN(ts.getTime()) &&
      (capturedAt == null || ts > capturedAt)
    ) {
      capturedAt = ts;
    }

    if (spot == null) {
      const price = parseNumeric(r.price);
      if (price != null && price > 0) spot = price;
    }

    const strikeRaw = parseNumeric(r.strike);
    if (strikeRaw == null) continue;
    // PeriscopeRow.strike is an integer everywhere downstream (the
    // GEXBot decoder rounded too) — SPX strikes are whole points.
    const strike = Math.round(strikeRaw);

    // Per-panel skip: `netValue` returns null for a half-sided or
    // non-numeric leg, which drops the strike from THAT panel only — a
    // bad gamma leg must not cost the strike its charm and vanna.
    for (const panel of PANELS) {
      const net = netValue(r, panel, SOURCE_UW_SPOT);
      if (net != null) panels[panel].push({ strike, value: net });
    }
  }

  if (capturedAt == null) return null;
  if (PANELS.every((panel) => panels[panel].length === 0)) return null;

  return {
    slot: {
      capturedAt: capturedAt.toISOString(),
      expiry: date,
      gamma: panels.gamma,
      charm: panels.charm,
      vanna: panels.vanna,
    },
    spot,
  };
}

/**
 * Every strike of the newest `gex_strike_0dte` tick for `date`, provided
 * that tick is inside the staleness window. Outside the window we return
 * null rather than serving numbers that no longer describe the book.
 *
 * The `date = ...` predicate keeps the (date, timestamp DESC) composite
 * index driving the scan; the timestamp floor is what actually enforces
 * freshness (and incidentally excludes the stray prior-evening snapshot
 * the fetch cron mis-stamps onto the next trading day).
 */
async function fetchLatestUwSlot(date: string): Promise<UwSlot | null> {
  const sql = getDb();
  const stalenessCutoff = new Date(
    Date.now() - STALENESS_CUTOFF_MS,
  ).toISOString();

  const rows = (await withDbRetry(
    () => sql`
      SELECT ${sql.unsafe(UW_SPOT_TICK_COLUMNS)}
      FROM gex_strike_0dte
      WHERE date = ${date}
        AND timestamp >= ${stalenessCutoff}
        AND timestamp = (
          SELECT MAX(timestamp)
          FROM gex_strike_0dte
          WHERE date = ${date}
            AND timestamp >= ${stalenessCutoff}
        )
      ORDER BY strike ASC
    `,
  )) as UwGexStrikeRow[];

  const built = buildSlotFromRows(date, rows);
  if (built == null) {
    logger.warn(
      { date, stalenessCutoff },
      'periscope-map: no fresh gex_strike_0dte tick — returning no_slot',
    );
  }
  return built;
}

/**
 * The newest tick at-or-before (latest - PRIOR_LOOKBACK_MIN), bounded
 * below by PRIOR_LOOKBACK_FLOOR_MIN. Used as the "prior slice" for
 * sign-flip detection. Returns null if no qualifying tick exists
 * (e.g. the feed just started for the day).
 */
async function fetchPriorUwSlot(
  date: string,
  latestCapturedAt: string,
): Promise<UwSlot | null> {
  const sql = getDb();
  const latestMs = new Date(latestCapturedAt).getTime();
  const priorCutoff = new Date(
    latestMs - PRIOR_LOOKBACK_MIN * 60_000,
  ).toISOString();
  const priorFloor = new Date(
    latestMs - PRIOR_LOOKBACK_FLOOR_MIN * 60_000,
  ).toISOString();

  const rows = (await withDbRetry(
    () => sql`
      SELECT ${sql.unsafe(UW_SPOT_TICK_COLUMNS)}
      FROM gex_strike_0dte
      WHERE date = ${date}
        AND timestamp = (
          SELECT MAX(timestamp)
          FROM gex_strike_0dte
          WHERE date = ${date}
            AND timestamp <= ${priorCutoff}
            AND timestamp >= ${priorFloor}
        )
      ORDER BY strike ASC
    `,
  )) as UwGexStrikeRow[];

  return buildSlotFromRows(date, rows);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const done = metrics.request('/api/periscope-map');

  if (await guardOwnerOrGuestEndpoint(req, res, done)) return;

  try {
    Sentry.setTag('route', '/api/periscope-map');
    const marketOpen = isMarketOpen();
    const date = getETDateStr(new Date()); // today CT

    // Cache: edge 30s live / 300s after-hours, SWR 30s live / 60s after-hours.
    // Panel polls at POLL_INTERVALS.PERISCOPE (60s) so the cache + SWR keeps
    // the worst-case rendered staleness around 30-90s even with the cache layer.
    setCacheHeaders(res, marketOpen ? 30 : 300, marketOpen ? 30 : 60);

    // Available slots backs the prev/next stepper. The stepper is meant
    // for historical replay (date picker active) — for live mode we still
    // return the day's slots so the user can step back into history without
    // first manually changing the date selector.
    //
    // Pinned to the SAME series `/api/periscope-exposure` will resolve
    // for this date. An unpinned list would advertise the EOD backfill's
    // synthetic 20:00Z slot alongside the day's `uw_spot` ticks, and
    // clicking it would silently render the nearest `uw_spot` tick
    // instead — a slot the exposure endpoint can never reach.
    const slotSource = await resolveSnapshotSource(date);
    const availableSlots = await fetchAvailableSlots(date, slotSource);

    const latestSlot = await fetchLatestUwSlot(date);
    if (latestSlot == null) {
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data: null,
        reason: 'no_slot',
        availableSlots,
      });
      return;
    }
    const latest = latestSlot.slot;

    // UW stamps SPX spot on every row of the tick — prefer it (it is
    // simultaneous with the exposures). Fall back to the 1-min candle
    // close when the column is null.
    const spot =
      latestSlot.spot ?? (await fetchSpxSpot(date, latest.capturedAt));
    if (spot == null) {
      done({ status: 200 });
      res.status(200).json({
        marketOpen,
        asOf: new Date().toISOString(),
        data: null,
        reason: 'no_spot',
        availableSlots,
      });
      return;
    }

    const priorSlot = await fetchPriorUwSlot(date, latest.capturedAt);
    const prior = priorSlot?.slot ?? null;
    const cone = await fetchConeLevels(date);
    const breaches = cone ? await fetchConeBreaches(date) : [];

    const view: PeriscopeView = computePeriscopeView({
      latest,
      prior,
      spot,
      cone,
      breaches,
    });

    // Staleness signal — `ageSec` is the gap between the UW tick
    // timestamp and now. The panel can render a "stale" badge once this
    // exceeds ~90s. `priorAvailable` tells the panel whether sign-flip
    // detection had a valid prior slice (false during the first ~10
    // minutes of session).
    const ageSec = Math.round(
      (Date.now() - new Date(latest.capturedAt).getTime()) / 1000,
    );

    done({ status: 200 });
    res.status(200).json({
      marketOpen,
      asOf: new Date().toISOString(),
      data: view,
      ageSec,
      priorAvailable: prior != null,
      availableSlots,
    });
  } catch (error) {
    sendDbErrorResponse(res, error, {
      label: 'periscope_map',
      serverErrorBody: { error: 'Internal server error' },
      done,
    });
  }
}
