// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockSentryMessage } = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockSentryMessage: vi.fn(),
}));

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: vi.fn(),
    captureMessage: mockSentryMessage,
  },
  metrics: {},
}));

import handler from '../cron/populate-periscope-from-uw.js';
import { SNAPSHOT_VALUE_MAX } from '../_lib/periscope-uw.js';

// Wednesday 13:00 CT / 14:00 ET — inside the isFuturesRthCt window.
const MARKET_TIME = new Date('2026-05-27T18:00:00.000Z');
const WEEKEND_TIME = new Date('2026-05-30T18:00:00.000Z'); // Sat
const TODAY_ET = '2026-05-27';

const FRESH_TS = new Date(MARKET_TIME.getTime() - 60_000); // 1 min ago

/** A `gex_strike_0dte` row as the Neon driver hands it back: NUMERIC → string. */
function uwRow(
  strike: string,
  overrides: Record<string, string | null> = {},
): Record<string, unknown> {
  return {
    timestamp: FRESH_TS,
    strike,
    price: '7513.32',
    call_gamma_oi: '1000.50',
    put_gamma_oi: '-400.25',
    call_charm_oi: '5000000.00',
    put_charm_oi: '-1250000.00',
    call_vanna_oi: '900000.00',
    put_vanna_oi: '100000.00',
    ...overrides,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

describe('populate-periscope-from-uw handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv };
    vi.setSystemTime(MARKET_TIME);
    process.env.CRON_SECRET = 'test-secret';
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('rejects without CRON_SECRET', async () => {
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('skips outside the futures-RTH window', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ skipped: true });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('writes all three panels from one fresh tick', async () => {
    mockSql
      .mockResolvedValueOnce([uwRow('7375'), uwRow('7435.4')]) // SELECT tick
      .mockResolvedValueOnce([{ strike: 7375 }, { strike: 7435 }]) // INSERT gamma
      .mockResolvedValueOnce([{ strike: 7375 }, { strike: 7435 }]) // INSERT charm
      .mockResolvedValueOnce([{ strike: 7375 }, { strike: 7435 }]); // INSERT vanna

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'success',
      rows: 6,
      panelsWritten: 3,
      strikes: 2,
      clamped: 0,
    });
    // 1 SELECT + 3 INSERTs — never one SELECT per panel.
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(mockSentryMessage).not.toHaveBeenCalled();
  });

  it('inserts net call+put values tagged with source uw_spot', async () => {
    mockSql
      .mockResolvedValueOnce([uwRow('7375'), uwRow('7435.4')])
      .mockResolvedValue([{ strike: 7375 }, { strike: 7435 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    // Tagged-template call args: (strings, ...values)
    const gammaInsert = mockSql.mock.calls[1] as unknown[];
    expect(gammaInsert).toContain('gamma');
    expect(gammaInsert).toContain('uw_spot');
    expect(gammaInsert).toContain(TODAY_ET);
    expect(gammaInsert).toContainEqual([7375, 7435]); // strikes rounded to INT
    expect(gammaInsert).toContainEqual([600.25, 600.25]); // 1000.50 + -400.25

    const charmInsert = mockSql.mock.calls[2] as unknown[];
    expect(charmInsert).toContain('charm');
    expect(charmInsert).toContainEqual([3750000, 3750000]);

    const vannaInsert = mockSql.mock.calls[3] as unknown[];
    expect(vannaInsert).toContain('vanna');
    expect(vannaInsert).toContainEqual([1000000, 1000000]);
  });

  it('skips strikes whose panel legs are null or malformed', async () => {
    mockSql
      .mockResolvedValueOnce([
        uwRow('7375'),
        // charm half-missing → dropped from charm only
        uwRow('7400', { put_charm_oi: null }),
        // non-numeric vanna leg → dropped from vanna only
        uwRow('7425', { call_vanna_oi: 'n/a' }),
        // unusable strike → dropped from every panel
        uwRow('not-a-strike'),
      ])
      .mockResolvedValue([{ strike: 7375 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'success', panelsWritten: 3 });

    const gammaInsert = mockSql.mock.calls[1] as unknown[];
    expect(gammaInsert).toContainEqual([7375, 7400, 7425]);
    const charmInsert = mockSql.mock.calls[2] as unknown[];
    expect(charmInsert).toContainEqual([7375, 7425]);
    const vannaInsert = mockSql.mock.calls[3] as unknown[];
    expect(vannaInsert).toContainEqual([7375, 7400]);
  });

  it('reports a partial run when a panel has no usable strikes', async () => {
    mockSql
      .mockResolvedValueOnce([
        uwRow('7375', { call_charm_oi: null, put_charm_oi: null }),
      ])
      .mockResolvedValue([{ strike: 7375 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'partial', panelsWritten: 2 });
    expect(mockSentryMessage).toHaveBeenCalled();
  });

  it('counts clamped values pushed past the NUMERIC(20,4) ceiling', async () => {
    // Migration #192 widened value to NUMERIC(20,4) — the same precision
    // as the gex_strike_0dte DECIMAL(20,4) source columns — so no value
    // the source can hold reaches this branch any more. The clamp is a
    // defensive backstop; this drives it with a value no UW feed could
    // produce (1e17, four orders past the column ceiling).
    mockSql
      .mockResolvedValueOnce([
        uwRow('7375', {
          call_charm_oi: '99999999999999999',
          put_charm_oi: '1',
        }),
      ])
      .mockResolvedValue([{ strike: 7375 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'success', clamped: 1 });
    const charmInsert = mockSql.mock.calls[2] as unknown[];
    expect(charmInsert).toContainEqual([SNAPSHOT_VALUE_MAX]);
  });

  it('does not clamp a full-scale gex_strike_0dte DECIMAL(20,4) value', async () => {
    // Regression guard for the pre-#192 NUMERIC(14,2) target: this value
    // is legal in the source column and used to saturate to
    // 999999999999.99, which then ranked as the single largest wall on
    // the board. It must now pass through untouched.
    mockSql
      .mockResolvedValueOnce([
        uwRow('7375', {
          call_charm_oi: '9999999999999.5000',
          put_charm_oi: '0.5000',
        }),
      ])
      .mockResolvedValue([{ strike: 7375 }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._json).toMatchObject({ status: 'success', clamped: 0 });
    const charmInsert = mockSql.mock.calls[2] as unknown[];
    expect(charmInsert).toContainEqual([1e13]);
  });

  it('skips the write when the latest tick is stale', async () => {
    // 10 min old — past STALENESS_CUTOFF_MS (5 min).
    const staleTs = new Date(MARKET_TIME.getTime() - 10 * 60_000);
    mockSql.mockResolvedValueOnce([{ ...uwRow('7375'), timestamp: staleTs }]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 0,
      panelsWritten: 0,
      stale: true,
    });
    // SELECT only — no INSERT for a stale tick.
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSentryMessage).toHaveBeenCalled();
  });

  it('reports no data when today has no gex_strike_0dte tick', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      status: 'partial',
      rows: 0,
      panelsWritten: 0,
    });
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSentryMessage).toHaveBeenCalled();
  });
});
