/**
 * GET /api/cron/populate-periscope-from-uw
 *
 * Adapter: reads the latest per-strike Unusual Whales SPX 0DTE tick out
 * of `gex_strike_0dte` (UW `/stock/SPX/spot-exposures/expiry-strike`,
 * landed at ~1-min cadence by the upstream fetch cron) and writes the
 * gamma / charm / vanna panels into `periscope_snapshots` with
 * `source = 'uw_spot'`.
 *
 * The UW-sourced replacement for `populate-periscope-from-gexbot`,
 * whose GEXBot trial key now returns HTTP 401 — leaving
 * `periscope_snapshots` (and every Periscope consumer downstream of it)
 * at zero rows. Same contract as that adapter: 10-min RTH cadence,
 * `withCronInstrumentation`, `timeCheck: isFuturesRthCt`, maxDuration
 * 30. See docs/superpowers/specs/periscope-uw-repoint-2026-08-21.md.
 *
 * Key difference vs. the gexbot adapter: GEXBot exposes one endpoint
 * per greek, so that cron runs a SELECT per panel. A `gex_strike_0dte`
 * tick already carries all three greeks on every strike row, so this
 * one reads a single tick once and fans it out into three panels.
 *
 * Units warning: `spot-exposures` is RAW DOLLAR exposure, ~1000x the
 * normalized `greek-exposure` scale the EOD backfill writes as
 * `uw_eod`. That's why every row is tagged with `source` and read paths
 * pin one source — a mixed delta series would fabricate phantom sign
 * flips. Detector thresholds calibrated on GEXBot magnitudes do NOT
 * carry over to this scale; recalibration is tracked separately.
 *
 * What's NOT covered: the `positions` panel — neither UW exposure
 * endpoint serves one. Same gap the gexbot adapter had.
 *
 * Idempotency: UNIQUE (captured_at, expiry, panel, strike, source)
 * (migration #191 widened the migration #140 tuple with `source`) makes
 * a re-run on the same tick a no-op.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { isFuturesRthCt } from '../_lib/cron-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getETDateStr } from '../../src/utils/timezone.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { PANELS, STALENESS_CUTOFF_MS } from '../_lib/periscope-gexbot.js';
import {
  SOURCE_UW_SPOT,
  clampSnapshotValue,
  formatTimeframe,
  netValue,
  type UwStrikeRow,
} from '../_lib/periscope-uw.js';

export const config = { maxDuration: 30 };

/** `gex_strike_0dte` row shape this cron reads. NUMERIC → string. */
interface GexStrikeTickRow extends UwStrikeRow {
  timestamp: Date | string;
  strike: string | number | null;
}

/** One strike's insert payload for a single panel. */
interface PanelPoint {
  strike: number;
  value: number;
}

/**
 * `periscope_snapshots.strike` is INT while `gex_strike_0dte.strike` is
 * DECIMAL(10,2) arriving as a string. Round; drop anything unparseable
 * rather than writing a NaN strike.
 */
function parseStrike(raw: string | number | null): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export default withCronInstrumentation(
  'populate-periscope-from-uw',
  async (): Promise<CronResult> => {
    const sql = getDb();
    const todayEt = getETDateStr(new Date()); // gex_strike_0dte is 0DTE → expiry == date

    // The newest tick of the day, all strikes, in one read. Freshness is
    // asserted in JS (not in the WHERE clause) so "no data at all today"
    // and "data exists but it's stale" stay distinguishable — they mean
    // different things operationally (feed never started vs. feed died).
    const rows = (await withDbRetry(
      () => sql`
        SELECT timestamp, strike,
               call_gamma_oi, put_gamma_oi,
               call_charm_oi, put_charm_oi,
               call_vanna_oi, put_vanna_oi
        FROM gex_strike_0dte
        WHERE date = ${todayEt}
          AND timestamp = (
            SELECT MAX(timestamp)
            FROM gex_strike_0dte
            WHERE date = ${todayEt}
          )
        ORDER BY strike ASC
      `,
    )) as GexStrikeTickRow[];

    if (rows.length === 0) {
      const message = `no gex_strike_0dte rows for ${todayEt}`;
      logger.warn({ date: todayEt }, `populate-periscope-from-uw: ${message}`);
      Sentry.captureMessage(`populate-periscope-from-uw: ${message}`, {
        level: 'warning',
      });
      return {
        status: 'partial',
        rows: 0,
        message,
        metadata: { panelsWritten: 0, strikes: 0, clamped: 0 },
      };
    }

    const capturedAt = new Date(rows[0]!.timestamp);
    const ageMs = Date.now() - capturedAt.getTime();

    if (ageMs > STALENESS_CUTOFF_MS) {
      const message = `latest gex_strike_0dte tick is stale (${Math.round(ageMs / 1000)}s old)`;
      logger.warn(
        { date: todayEt, capturedAt: capturedAt.toISOString(), ageMs },
        `populate-periscope-from-uw: ${message}`,
      );
      Sentry.captureMessage(`populate-periscope-from-uw: ${message}`, {
        level: 'warning',
        extra: { capturedAt: capturedAt.toISOString(), ageMs },
      });
      return {
        status: 'partial',
        rows: 0,
        message,
        metadata: {
          panelsWritten: 0,
          strikes: 0,
          clamped: 0,
          stale: true,
          capturedAt: capturedAt.toISOString(),
        },
      };
    }

    const timeframe = formatTimeframe(capturedAt);

    let totalRows = 0;
    let panelsWritten = 0;
    let clamped = 0;
    const errors: string[] = [];

    for (const panel of PANELS) {
      const points: PanelPoint[] = [];

      for (const row of rows) {
        const strike = parseStrike(row.strike);
        if (strike == null) continue;
        const net = netValue(row, panel, SOURCE_UW_SPOT);
        if (net == null) continue; // half-sided / non-numeric leg

        const value = clampSnapshotValue(net);
        if (value !== net) {
          clamped += 1;
          logger.warn(
            { panel, strike, raw: net, clamped: value },
            'populate-periscope-from-uw: clamped value to NUMERIC(20,4) range',
          );
        }
        points.push({ strike, value });
      }

      if (points.length === 0) {
        errors.push(`${panel}: no usable strikes in tick`);
        continue;
      }

      const strikes = points.map((p) => p.strike);
      const values = points.map((p) => p.value);
      const inserted = (await withDbRetry(
        () => sql`
          INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value, timeframe, source)
          SELECT
            ${capturedAt.toISOString()}::timestamptz,
            ${todayEt}::date,
            ${panel},
            unnest(${strikes}::int[]) AS strike,
            unnest(${values}::numeric[]) AS value,
            ${timeframe},
            ${SOURCE_UW_SPOT}
          ON CONFLICT (captured_at, expiry, panel, strike, source) DO NOTHING
          RETURNING strike
        `,
      )) as { strike: number }[];

      totalRows += inserted.length;
      panelsWritten += 1;
      logger.info(
        {
          panel,
          capturedAt: capturedAt.toISOString(),
          strikes: points.length,
          inserted: inserted.length,
          timeframe,
          source: SOURCE_UW_SPOT,
        },
        'populated periscope_snapshots from uw',
      );
    }

    if (errors.length > 0 || clamped > 0) {
      Sentry.captureMessage(
        `populate-periscope-from-uw: ${errors.length} panel(s) failed, ${clamped} value(s) clamped`,
        { level: 'warning', extra: { errors, clamped } },
      );
    }

    return {
      status: panelsWritten === PANELS.length ? 'success' : 'partial',
      rows: totalRows,
      metadata: {
        panelsWritten,
        strikes: rows.length,
        clamped,
        timeframe,
        capturedAt: capturedAt.toISOString(),
        errors,
      },
    };
  },
  // Same futures-tied RTH gate (08:30–15:55 CT) as the gexbot adapter —
  // outside it the upstream UW fetch cron isn't running either, so every
  // tick would just emit a "no fresh row" warning.
  { requireApiKey: false, timeCheck: isFuturesRthCt },
);
