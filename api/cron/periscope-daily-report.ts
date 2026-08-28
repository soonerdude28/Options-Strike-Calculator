/**
 * GET /api/cron/periscope-daily-report
 *
 * End-of-day cron that assembles the Periscope Daily Report for the
 * current ET trading date via `buildDailyReport` (session OHLC + cone
 * verdict, latest auto playbook, dealer positioning, flow closes, tape,
 * signal scoreboards, data-quality footer), UPSERTs the JSON blob into
 * `daily_reports`, then pushes a one-line headline to the owner's phone
 * through the existing web-push fan-out. The push outcome is recorded
 * back onto the row (push_sent / push_result) separately from the
 * report itself, so a failed push never blocks — or is hidden by — a
 * successfully built report.
 *
 * Schedule: 10 22 * * 1-5 (22:10 UTC weekdays). Post-close year-round:
 * 18:10 ET in EDT / 17:10 ET in EST — both comfortably after the 16:00
 * ET cash close. It also lands after the two EOD writers the report
 * reads from: periscope-lottery enrichment (21:50 UTC) and
 * capture-flow-regime-daily (21:55 UTC). Lottery-finder enrichment is
 * still draining at this hour (enrich-lottery-outcomes runs until
 * ~23:55 UTC), so the report's signals section flags `partial: true`
 * while enriched < fires — a deliberate trade for capturing the tape
 * section before ws_option_trades' T+2 retention prunes it.
 *
 * Failure model: buildDailyReport never rejects on data problems (each
 * section fails soft to null with a note), so the only hard-error paths
 * here are the daily_reports writes. A push throw (e.g. VAPID env vars
 * missing) is caught, Sentry-captured, and recorded as
 * push_result = { error } — it must NOT fail the run.
 *
 * Environment: CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { buildDailyReport } from '../_lib/daily-report.js';
import { sendPushToOwner, type FanOutResult } from '../_lib/push.js';
import { Sentry } from '../_lib/sentry.js';
import { isTradingDay } from '../../src/data/marketHours.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

export default withCronInstrumentation(
  'periscope-daily-report',
  async (ctx): Promise<CronResult> => {
    // ctx.today IS the ET date (cronGuard computes getETDateStr(new
    // Date())), so it doubles as both the holiday gate input and the
    // report/storage key.
    const { today: date, logger: log } = ctx;

    // Holiday/weekend gate: the fixed-UTC crontab fires on NYSE-closed
    // weekdays too; there is no session to report on those days.
    if (!isTradingDay(date)) {
      return {
        status: 'skipped',
        message: 'not_trading_day',
        metadata: { skipped: true, reason: 'not_trading_day', date },
      };
    }

    const sql = getDb();
    const report = await buildDailyReport(sql, date);

    // UPSERT so a same-day re-run refreshes the row instead of failing
    // on the date PK. `JSON.stringify(...)::jsonb` is the repo's
    // standardized jsonb-parameter convention.
    await sql`
      INSERT INTO daily_reports (date, report)
      VALUES (${date}, ${JSON.stringify(report)}::jsonb)
      ON CONFLICT (date) DO UPDATE
        SET report = EXCLUDED.report, updated_at = NOW()
    `;

    // Push the headline. A throw here (VAPID env missing, web-push SDK
    // failure) must NOT fail the run — the report is already stored; the
    // error is captured and recorded as the push_result instead.
    let pushResult: FanOutResult | { error: string };
    try {
      pushResult = await sendPushToOwner({
        title: `SPX Daily Report — ${date}`,
        body: report.headline,
        tag: 'daily-report',
        requireInteraction: true,
        url: '/#sec-daily-report',
      });
    } catch (err) {
      Sentry.captureException(err);
      log.error({ err, date }, 'periscope-daily-report: push failed');
      pushResult = { error: err instanceof Error ? err.message : String(err) };
    }

    // Record the fan-out outcome on the row. Best-effort: the pushes (if
    // any) already landed, so a failure here only loses bookkeeping.
    // `'error' in` is discriminated-union narrowing, not a set-vs-unset
    // probe (see the optional-props policy in CLAUDE.md).
    const pushSent = !('error' in pushResult) && pushResult.sent > 0;
    try {
      await sql`
        UPDATE daily_reports
        SET push_sent = ${pushSent},
            push_result = ${JSON.stringify(pushResult)}::jsonb
        WHERE date = ${date}
      `;
    } catch (err) {
      log.warn(
        { err, date },
        'periscope-daily-report: push_result update failed',
      );
    }

    log.info(
      {
        date,
        headline: report.headline,
        notes: report.dataQuality.notes.length,
        pushSent,
      },
      'periscope-daily-report: stored',
    );

    return {
      status: 'success',
      metadata: {
        date,
        sections: {
          session: report.session != null,
          playbook: report.playbook != null,
          positioning: report.positioning != null,
          flow: report.flow != null,
          signals: report.signals != null,
        },
        notes: report.dataQuality.notes.length,
        push: 'error' in pushResult ? 'failed' : pushResult,
      },
    };
  },
  { marketHours: false, requireApiKey: false },
);
