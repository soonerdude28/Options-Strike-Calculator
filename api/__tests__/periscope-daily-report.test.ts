// @vitest-environment node

/**
 * Tests for the periscope-daily-report EOD cron: auth guard, the
 * trading-day gate, the report→upsert→push→record pipeline, the
 * push-throw-must-not-fail-the-run contract, and the hard-error path
 * when the daily_reports upsert itself fails.
 *
 * The trading-day gate uses REAL marketHours data with chosen dates
 * (fetch-outcomes precedent): Tuesday 2026-03-24 is a trading day,
 * Saturday 2026-03-28 is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockRequest, mockResponse } from './helpers';
import type { DailyReport } from '../_lib/daily-report.js';

const mockSql = vi.fn().mockResolvedValue([]);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
}));

vi.mock('../_lib/daily-report.js', () => ({
  buildDailyReport: vi.fn(),
}));

vi.mock('../_lib/push.js', () => ({
  sendPushToOwner: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
  },
  metrics: {
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/api-helpers.js', () => ({
  cronGuard: vi.fn(),
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn().mockResolvedValue(undefined),
}));

import handler from '../cron/periscope-daily-report.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { buildDailyReport } from '../_lib/daily-report.js';
import { sendPushToOwner } from '../_lib/push.js';
import { Sentry } from '../_lib/sentry.js';

const mockedBuild = vi.mocked(buildDailyReport);
const mockedPush = vi.mocked(sendPushToOwner);

/** Tuesday — a regular NYSE trading day. */
const TRADING_DAY = '2026-03-24';
/** Saturday — never a trading day. */
const WEEKEND_DAY = '2026-03-28';

function makeReport(over: Partial<DailyReport> = {}): DailyReport {
  return {
    date: TRADING_DAY,
    generatedAt: '2026-03-24T22:10:05.000Z',
    headline: 'SPX 5710 · range 40pts (0.7%) · cone held · 12 fires',
    session: {
      open: 5700,
      high: 5735,
      low: 5695,
      close: 5710,
      rangePts: 40,
      rangePct: 0.7,
      candleCount: 390,
      cone: { lower: 5680, upper: 5740, closedInside: true },
      coneBreaches: [],
    },
    playbook: null,
    positioning: null,
    flow: null,
    signals: {
      lottery: { fires: 12, enriched: 4, wins: 1, losses: 2, partial: true },
      periscopeLottery: { fires: 2, locked: 2, wins: 1 },
      gammaSetups: { fires: 1, resolved: 1, wins: 0 },
      silentBoom: { alerts: 3, enriched: 3, wins: 1 },
    },
    dataQuality: {
      spxCandles: 390,
      gexTicks: 480,
      flowRows: 700,
      wsTrades: 120_000,
      playbookSlots: { complete: 0, failed: 1 },
      notes: ['playbook: relation does not exist'],
    },
    ...over,
  };
}

function makeCronReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/** Joined text of the Nth tagged-template sql call (strings array). */
function sqlText(call: number): string {
  const strings = mockSql.mock.calls[call]?.[0] as string[] | undefined;
  return (strings ?? []).join(' ');
}

describe('periscope-daily-report cron', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv, CRON_SECRET: 'test-secret' };
    delete process.env.SENTRY_DSN;
    vi.mocked(cronGuard).mockReturnValue({ apiKey: '', today: TRADING_DAY });
    mockedBuild.mockResolvedValue(makeReport());
    mockedPush.mockResolvedValue({ sent: 1, expired: 0, failed: 0 });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('bails when cronGuard rejects (401)', async () => {
    vi.mocked(cronGuard).mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(res._status).toBe(401);
    expect(mockedBuild).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips on a non-trading day without touching the DB or push', async () => {
    vi.mocked(cronGuard).mockReturnValue({ apiKey: '', today: WEEKEND_DAY });
    const res = mockResponse();
    await handler(makeCronReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'periscope-daily-report',
      status: 'skipped',
      message: 'not_trading_day',
    });
    expect(mockedBuild).not.toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('builds, upserts, pushes, records the outcome, and reports metadata', async () => {
    const res = mockResponse();
    await handler(makeCronReq(), res);

    // Report built for the ET date cronGuard supplied, with the shared sql.
    expect(mockedBuild).toHaveBeenCalledWith(mockSql, TRADING_DAY);

    // 1st query: the daily_reports upsert with the stringified report.
    expect(sqlText(0)).toContain('INSERT INTO daily_reports');
    expect(sqlText(0)).toContain('ON CONFLICT (date) DO UPDATE');
    expect(mockSql.mock.calls[0]?.[1]).toBe(TRADING_DAY);
    expect(mockSql.mock.calls[0]?.[2]).toBe(JSON.stringify(makeReport()));

    // Push carries the headline as the body plus the fixed envelope.
    expect(mockedPush).toHaveBeenCalledWith({
      title: `SPX Daily Report — ${TRADING_DAY}`,
      body: makeReport().headline,
      tag: 'daily-report',
      requireInteraction: true,
      url: '/#sec-daily-report',
    });

    // 2nd query: fan-out outcome recorded on the row.
    expect(sqlText(1)).toContain('UPDATE daily_reports');
    expect(mockSql.mock.calls[1]?.[1]).toBe(true); // push_sent (sent > 0)
    expect(mockSql.mock.calls[1]?.[2]).toBe(
      JSON.stringify({ sent: 1, expired: 0, failed: 0 }),
    );
    expect(mockSql.mock.calls[1]?.[3]).toBe(TRADING_DAY);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'periscope-daily-report',
      status: 'success',
      date: TRADING_DAY,
      sections: {
        session: true,
        playbook: false,
        positioning: false,
        flow: false,
        signals: true,
      },
      notes: 1,
      push: { sent: 1, expired: 0, failed: 0 },
    });
  });

  it('still succeeds when the push throws (VAPID missing): Sentry + push_result error', async () => {
    mockedPush.mockRejectedValueOnce(
      new Error('web-push not configured: set VAPID_SUBJECT'),
    );
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      job: 'periscope-daily-report',
      status: 'success',
      push: 'failed',
    });
    expect(Sentry.captureException).toHaveBeenCalled();

    // Fan-out outcome still recorded: not sent, error preserved.
    expect(sqlText(1)).toContain('UPDATE daily_reports');
    expect(mockSql.mock.calls[1]?.[1]).toBe(false); // push_sent
    expect(mockSql.mock.calls[1]?.[2]).toBe(
      JSON.stringify({ error: 'web-push not configured: set VAPID_SUBJECT' }),
    );
  });

  it('records push_sent=false when the fan-out reaches zero devices', async () => {
    mockedPush.mockResolvedValueOnce({ sent: 0, expired: 0, failed: 0 });
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(200);
    expect(mockSql.mock.calls[1]?.[1]).toBe(false); // push_sent
    expect(res._json).toMatchObject({
      status: 'success',
      push: { sent: 0, expired: 0, failed: 0 },
    });
  });

  it('500s and reports to Sentry when the daily_reports upsert fails', async () => {
    mockSql.mockRejectedValueOnce(new Error('relation daily_reports missing'));
    const res = mockResponse();
    await handler(makeCronReq(), res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({
      job: 'periscope-daily-report',
      error: 'Internal error',
    });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(mockedPush).not.toHaveBeenCalled();
  });
});
