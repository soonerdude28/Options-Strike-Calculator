/**
 * Shared query helpers + validation regexes for Periscope endpoints.
 *
 * Both `api/periscope-exposure.ts` (formatted Top-N view) and
 * `api/periscope-strikes.ts` (raw per-strike grid for the GEX Landscape)
 * need:
 *   - The same YYYY-MM-DD / HH:MM regex shapes for query-param validation
 *   - `endOfMinute()` ISO rounding so a slot captured at HH:MM:XX is
 *     included when the user picks HH:MM (the scrub round-trip depends
 *     on this; HH:MM truncates seconds otherwise)
 *   - `fetchSpxSpot()` — SPX close at-or-before asOf for ranking strikes
 *   - `fetchAvailableSlots()` — distinct captured_at list for the scrub
 *     stepper, anchored on panel='gamma' (per migration #141, gamma /
 *     charm / vanna land at the same captured_at)
 *   - `resolveSnapshotSource()` — which of the three `source` series in
 *     `periscope_snapshots` a display read should render (migration
 *     #191). See the doc comment on that function.
 *
 * Kept here so the two endpoints can't drift on these primitives.
 */

import { getDb } from './db.js';
import {
  SOURCE_UW_EOD,
  SOURCE_UW_SPOT,
  type UwSource,
} from './periscope-uw.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Round an ISO timestamp UP to the end of its minute (XX:XX:59.999Z). */
export function endOfMinute(iso: string): string {
  const d = new Date(iso);
  d.setUTCSeconds(59, 999);
  return d.toISOString();
}

/**
 * Read the SPX close at-or-before `asOf` (ISO) for the given date, or
 * the latest close for that date when asOf is omitted. The authoritative
 * spot for ranking Periscope strikes (the periscope skill enforces:
 * never the chart's red dotted line).
 */
export async function fetchSpxSpot(
  date: string,
  asOf?: string,
): Promise<number | null> {
  const sql = getDb();
  const rows = asOf
    ? ((await sql`
        SELECT close
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND date = ${date} AND timestamp <= ${asOf}
        ORDER BY timestamp DESC
        LIMIT 1
      `) as Array<{ close: string | number }>)
    : ((await sql`
        SELECT close
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND date = ${date}
        ORDER BY timestamp DESC
        LIMIT 1
      `) as Array<{ close: string | number }>);
  if (rows.length === 0) return null;
  const v = Number(rows[0]!.close);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Legacy GEXBot rows — migration #191's `DEFAULT 'gexbot'`. The trial
 *  key returns 401 so no new rows arrive, but a renewed subscription
 *  would resume writing them and the panel must still render. */
export const SOURCE_GEXBOT = 'gexbot';

/** Every value migration #191's CHECK constraint permits. */
export type PeriscopeSnapshotSource = UwSource | typeof SOURCE_GEXBOT;

/**
 * Display-read source preference, highest first. `uw_spot` is the live
 * raw-dollar series, `uw_eod` the normalized one-slice-per-day
 * backfill, `gexbot` the dead legacy feed.
 */
export const SNAPSHOT_SOURCE_PRIORITY: readonly PeriscopeSnapshotSource[] = [
  SOURCE_UW_SPOT,
  SOURCE_UW_EOD,
  SOURCE_GEXBOT,
];

/** Postgres `bool` arrives as a real boolean over the Neon HTTP driver,
 *  but tolerate the wire forms so a driver change can't silently make
 *  every source look absent (which would blank the panel). */
const isTrue = (v: unknown): boolean => v === true || v === 't' || v === 'true';

/**
 * Decide which single `source` series a DISPLAY read should render for
 * `expiry`, or null when the expiry has no rows at all.
 *
 * The three sources in `periscope_snapshots` are on different scales
 * and units (migration #191): `uw_spot` is raw dollar exposure at
 * ~10-min cadence, `uw_eod` is UW's NORMALIZED greek-exposure backfill
 * (~1000x smaller for gamma) with exactly one synthetic 15:00 CT slice
 * per trading day, and `gexbot` is the dead legacy feed. Rendering two
 * of them in one response would fabricate enormous phantom moves, so
 * callers resolve once here and pin every subsequent query to the
 * winner — never a UNION.
 *
 * Preference order is SNAPSHOT_SOURCE_PRIORITY: the live series when
 * the date has one, otherwise the backfill so time-travel to a date
 * that predates the live feed still renders something.
 *
 * Delta consumers (lottery finder, gamma-node detector) do NOT use this
 * — a one-slice-per-day backfill row can never enter a slice-over-slice
 * computation, so they pin `uw_spot` unconditionally.
 */
export async function resolveSnapshotSource(
  expiry: string,
): Promise<PeriscopeSnapshotSource | null> {
  const sql = getDb();
  // Three EXISTS probes in one round-trip; each is an index-only lookup
  // on idx_periscope_snapshots_source_lookup (source, expiry, ...).
  const rows = (await sql`
    SELECT
      EXISTS (
        SELECT 1 FROM periscope_snapshots
        WHERE expiry = ${expiry} AND source = ${SOURCE_UW_SPOT}
      ) AS has_uw_spot,
      EXISTS (
        SELECT 1 FROM periscope_snapshots
        WHERE expiry = ${expiry} AND source = ${SOURCE_UW_EOD}
      ) AS has_uw_eod,
      EXISTS (
        SELECT 1 FROM periscope_snapshots
        WHERE expiry = ${expiry} AND source = ${SOURCE_GEXBOT}
      ) AS has_gexbot
  `) as Array<{
    has_uw_spot: unknown;
    has_uw_eod: unknown;
    has_gexbot: unknown;
  }>;
  const r = rows[0];
  if (r == null) return null;
  if (isTrue(r.has_uw_spot)) return SOURCE_UW_SPOT;
  if (isTrue(r.has_uw_eod)) return SOURCE_UW_EOD;
  if (isTrue(r.has_gexbot)) return SOURCE_GEXBOT;
  return null;
}

/**
 * List the distinct slot capture timestamps for the picked date, used
 * to back the prev/next stepper in the panel. Filters on panel='gamma'
 * — the per-row timeframe migration (#141) guarantees gamma / charm /
 * vanna land at the same captured_at, so gamma is a safe anchor.
 *
 * `source` is REQUIRED and pins the list to one series so the stepper
 * can't interleave the EOD backfill's single synthetic 15:00 CT slot
 * with the live 10-min `uw_spot` slots. Every slot this returns is
 * clicked straight back into a source-pinned read
 * (`/api/periscope-exposure`, `/api/periscope-strikes`), so an
 * unpinned list would advertise slots those reads can never resolve.
 *
 * `null` — `resolveSnapshotSource` found no rows for the date in ANY
 * series — short-circuits to an empty list without a round-trip, the
 * same contract `fetchLatestPeriscopeSlot` uses.
 */
export async function fetchAvailableSlots(
  date: string,
  source: PeriscopeSnapshotSource | null,
): Promise<string[]> {
  if (source == null) return [];
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT captured_at
    FROM periscope_snapshots
    WHERE expiry = ${date} AND panel = 'gamma' AND source = ${source}
    ORDER BY captured_at ASC
  `) as Array<{ captured_at: string | Date }>;
  return rows.map((r) =>
    r.captured_at instanceof Date ? r.captured_at.toISOString() : r.captured_at,
  );
}
