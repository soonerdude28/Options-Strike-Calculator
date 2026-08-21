/**
 * GET /api/cron/populate-periscope-from-gexbot
 *
 * Adapter: reads the latest GEXBot `state/{gamma,charm,vanna}_zero`
 * captures for SPX from `gexbot_api_capture` and writes them into the
 * `periscope_snapshots` table in the schema the existing scraper used.
 *
 * Replaces the Railway periscope-scraper service. GEXBot's REST API is
 * reliable where Playwright was not. The scraper-fed crons
 * (detect-periscope-call-lottery, detect-periscope-put-lottery,
 * enrich-periscope-lottery-outcomes, periscope-auto-playbook) keep
 * working unchanged because they only SELECT from periscope_snapshots —
 * they don't care who writes the rows.
 *
 * Cadence: every 10 min during RTH. Matches the existing
 * detect-periscope-* slice-over-slice delta semantics. For true 1-min
 * latency in the panel, see
 * `docs/superpowers/specs/periscope-analyzer-build-2026-05-21.md` —
 * that build replaces the panel reading path entirely.
 *
 * What's covered: gamma, charm, vanna panels for SPX 0DTE.
 * What's NOT covered (vs. the scraper): positions panel — GEXBot's
 * Orderflow tier doesn't expose a positions endpoint. Detectors don't
 * use positions, so this is fine for now.
 *
 * Idempotency: `periscope_snapshots` UNIQUE
 * (captured_at, expiry, panel, strike, source) gives natural dedup.
 * Re-running the cron on the same minute is a no-op. Migration #191
 * widened the original migration #140 4-column tuple with `source`, so
 * the ON CONFLICT inference spec below MUST name `source` too — the
 * only surviving index on the bare 4 columns is #140's non-unique
 * `idx_periscope_snapshots_lookup`, which cannot satisfy an inference
 * spec (Postgres 42P10). This cron writes no explicit `source`; the
 * column's `DEFAULT 'gexbot'` is applied before conflict resolution, so
 * legacy GEXBot rows keep their own uniqueness namespace and never
 * collide with the `uw_spot` / `uw_eod` series.
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
import {
  PANELS,
  PANEL_TO_CATEGORY,
  STALENESS_CUTOFF_MS,
  TICKER,
  decodeStrikes,
  type GexbotStatePayload,
} from '../_lib/periscope-gexbot.js';
// `formatTimeframe` moved to _lib/periscope-uw so the gexbot adapter,
// the UW adapter and the EOD backfill emit one identical slot label.
import { formatTimeframe } from '../_lib/periscope-uw.js';

export const config = { maxDuration: 30 };

// Re-export for the existing test file that imports `decodeStrikes` from
// this module. New callers should import from _lib/periscope-gexbot.
export { decodeStrikes };

export default withCronInstrumentation(
  'populate-periscope-from-gexbot',
  async (): Promise<CronResult> => {
    const sql = getDb();
    const todayEt = getETDateStr(new Date()); // 0DTE expiry

    // Pull the latest capture row per panel within the staleness
    // window. Anything older means GEXBot is down — we skip rather
    // than backfill a stale slice.
    const stalenessCutoff = new Date(Date.now() - STALENESS_CUTOFF_MS);

    let totalRows = 0;
    let panelsWritten = 0;
    const errors: string[] = [];

    for (const panel of PANELS) {
      const category = PANEL_TO_CATEGORY[panel];
      const rows = (await withDbRetry(
        () => sql`
          SELECT captured_at, raw_response
          FROM gexbot_api_capture
          WHERE ticker = ${TICKER}
            AND endpoint = 'state'
            AND category = ${category}
            AND captured_at >= ${stalenessCutoff.toISOString()}
          ORDER BY captured_at DESC
          LIMIT 1
        `,
      )) as { captured_at: Date | string; raw_response: GexbotStatePayload }[];

      if (rows.length === 0) {
        errors.push(`no fresh ${category} row for ${TICKER}`);
        continue;
      }

      const row = rows[0]!;
      const capturedAt = new Date(row.captured_at);
      const decoded = decodeStrikes(row.raw_response);

      if (decoded.length === 0) {
        errors.push(`${category}: no strikes decoded from payload`);
        continue;
      }

      const timeframe = formatTimeframe(capturedAt);

      // Build VALUES clause for batch insert.
      const strikes = decoded.map((d) => d.strike);
      const values = decoded.map((d) => d.value);
      const inserted = (await withDbRetry(
        () => sql`
          INSERT INTO periscope_snapshots (captured_at, expiry, panel, strike, value, timeframe)
          SELECT
            ${capturedAt.toISOString()}::timestamptz,
            ${todayEt}::date,
            ${panel},
            unnest(${strikes}::int[]) AS strike,
            unnest(${values}::numeric[]) AS value,
            ${timeframe}
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
          decoded: decoded.length,
          inserted: inserted.length,
          timeframe,
        },
        'populated periscope_snapshots',
      );
    }

    if (errors.length > 0) {
      Sentry.captureMessage(
        `populate-periscope-from-gexbot: ${errors.length} panel(s) failed`,
        { level: 'warning', extra: { errors } },
      );
    }

    return {
      status: panelsWritten === PANELS.length ? 'success' : 'partial',
      rows: totalRows,
      metadata: { panelsWritten, errors },
    };
  },
  // Gate to futures-tied RTH (08:30–15:55 CT), matching the upstream
  // gexbot capture crons it reads from. Without this, ticks outside the
  // gexbot window find no fresh `gexbot_api_capture` row and emit a
  // "no fresh row" Sentry warning every cycle.
  { requireApiKey: false, timeCheck: isFuturesRthCt },
);
