/**
 * GET /api/daily-report
 *
 * Serves the stored Periscope Daily Report (written by the 22:10 UTC
 * periscope-daily-report cron into `daily_reports`). One row per trading
 * day — the endpoint reads the pre-assembled JSON blob instead of
 * re-aggregating the seven source tables, several of which (notably
 * ws_option_trades) have retention windows shorter than the report's.
 *
 * Query params:
 *   ?date=YYYY-MM-DD — optional. Return that day's report; invalid
 *                      format → 400. Omitted → the latest report.
 *
 * Responses:
 *   200 { date, report, createdAt } — report is the DailyReport JSON.
 *   404 { error: 'No report available' } — no row for the date (or an
 *       empty table in latest mode).
 *
 * Owner-or-guest — the report aggregates UW-derived data (OPRA
 * compliance), same posture as the other periscope readers.
 */

import { getDb, withDbRetry } from './_lib/db.js';
import { withDbReader } from './_lib/request-scope.js';
import { setCacheHeaders } from './_lib/api-helpers.js';

function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

export default withDbReader(
  '/api/daily-report',
  'daily_report',
  'owner-or-guest',
  async (req, res, done) => {
    // Inline regex validation (greek-exposure-strike precedent) — but a
    // MALFORMED date is a 400 here rather than a silent fallback, so a
    // typo'd panel request can't masquerade as "latest".
    const dateParam = req.query.date as string | undefined;
    if (dateParam != null && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      done({ status: 400 });
      res.status(400).json({ error: 'Invalid date' });
      return;
    }

    const sql = getDb();
    // `date::text` avoids the driver's DATE→JS-Date localization;
    // `report` is JSONB and comes back already parsed.
    const rows = await withDbRetry(
      () =>
        dateParam != null
          ? sql`
              SELECT date::text AS date, report, created_at
              FROM daily_reports
              WHERE date = ${dateParam}
            `
          : sql`
              SELECT date::text AS date, report, created_at
              FROM daily_reports
              ORDER BY date DESC
              LIMIT 1
            `,
      2,
      10_000,
    );

    const row = rows[0];
    if (!row) {
      done({ status: 404 });
      res.status(404).json({ error: 'No report available' });
      return;
    }

    // Short edge TTL: the row only changes on the 22:10 UTC cron run (or
    // a manual re-run), but 60s keeps a re-run visible quickly.
    setCacheHeaders(res, 60);
    done({ status: 200 });
    res.status(200).json({
      date: String(row.date),
      report: row.report,
      createdAt: toIso(row.created_at as string | Date),
    });
  },
);
