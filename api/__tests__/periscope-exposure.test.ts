// @vitest-environment node

/**
 * Tests for /api/periscope-exposure handler.
 *
 * Covers the three response shapes the frontend hook depends on:
 *   - 200 with data when a slot exists
 *   - 200 with data:null + reason:'no_slot' when no slot ingested yet
 *   - 200 with data:null + reason:'no_spot' when neither query nor DB
 *     can produce an SPX spot
 *   - 500 on internal error
 *
 * The DB layer is mocked because the periscope-format module's pure
 * `computePeriscopeView` logic is already exercised by
 * periscope-format.test.ts. Here we only verify the handler contract.
 */

import { vi, beforeEach, describe, it, expect } from 'vitest';

const { mockSql, mockGuard, mockSetCacheHeaders, mockIsMarketOpen } =
  vi.hoisted(() => ({
    mockSql: vi.fn(),
    mockGuard: vi.fn(),
    mockSetCacheHeaders: vi.fn(),
    mockIsMarketOpen: vi.fn(),
  }));

vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  guardOwnerOrGuestEndpoint: mockGuard,
  setCacheHeaders: mockSetCacheHeaders,
  isMarketOpen: mockIsMarketOpen,
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    withIsolationScope: (
      fn: (s: { setTransactionName: (n: string) => void }) => unknown,
    ) => fn({ setTransactionName: () => undefined }),
  },
  metrics: { request: () => () => undefined },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { error: vi.fn() },
}));

import handler from '../periscope-exposure.js';

function makeReqRes(query: Record<string, string> = {}) {
  const req = { query, method: 'GET', headers: {} } as never;
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader: vi.fn(),
  };
  return { req, res };
}

beforeEach(() => {
  mockSql.mockReset();
  mockGuard.mockReset();
  mockGuard.mockResolvedValue(false);
  mockSetCacheHeaders.mockReset();
  mockIsMarketOpen.mockReset();
  mockIsMarketOpen.mockReturnValue(true);
});

describe('GET /api/periscope-exposure', () => {
  it('returns no_spot when neither query nor DB yields a spot', async () => {
    // fetchSpxSpot returns []. resolveSnapshotSource finds nothing, so
    // fetchAvailableSlots short-circuits to [] without querying (the
    // third mock below goes unused).
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { has_uw_spot: false, has_uw_eod: false, has_gexbot: false },
      ])
      .mockResolvedValueOnce([]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      data: null,
      reason: 'no_spot',
      availableSlots: [],
      source: null,
    });
  });

  it('returns no_slot when spot is available but no periscope rows exist', async () => {
    mockSql
      // fetchSpxSpot — spot from index_candles_1m
      .mockResolvedValueOnce([{ close: '7337.07' }])
      // resolveSnapshotSource — the live series has rows for the date
      .mockResolvedValueOnce([
        { has_uw_spot: true, has_uw_eod: false, has_gexbot: false },
      ])
      // fetchAvailableSlots — no slots yet
      .mockResolvedValueOnce([])
      // fetchLatestPeriscopeSlot — no captured_at
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
      data: null,
      reason: 'no_slot',
      availableSlots: [],
    });
  });

  it('returns full view when slot + cone exist', async () => {
    mockSql
      .mockResolvedValueOnce([{ close: '7337' }])
      // resolveSnapshotSource — the live series has rows for the date
      .mockResolvedValueOnce([
        { has_uw_spot: true, has_uw_eod: false, has_gexbot: false },
      ])
      // fetchAvailableSlots — two slots
      .mockResolvedValueOnce([
        { captured_at: '2026-05-08T13:40:00Z' },
        { captured_at: '2026-05-08T13:50:00Z' },
      ])
      // fetchLatestPeriscopeSlot — captured_at
      .mockResolvedValueOnce([{ captured_at: '2026-05-08T13:50:00Z' }])
      // loadSlot — gamma + charm + vanna rows
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 7350, value: '3187.00' },
        { panel: 'charm', strike: 7350, value: '-401000.00' },
        { panel: 'vanna', strike: 7375, value: '-109000.00' },
      ])
      // fetchPriorPeriscopeSlot — no prior
      .mockResolvedValueOnce([{ captured_at: null }])
      // fetchConeLevels
      .mockResolvedValueOnce([
        {
          cone_upper: '7395.00',
          cone_lower: '7280.00',
          cone_width: '115.00',
          asymmetry_pts: '0',
          spot_at_calc: '7337.50',
        },
      ])
      // fetchConeBreaches
      .mockResolvedValueOnce([]);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      marketOpen: true,
    });
    const body = res.body as {
      data: {
        spot: number;
        gamma: { ceiling: { strike: number } | null };
        cone: { coneUpper: number } | null;
      };
      availableSlots: string[];
    };
    expect(body.data.spot).toBe(7337);
    expect(body.data.gamma.ceiling?.strike).toBe(7350);
    expect(body.data.cone?.coneUpper).toBe(7395);
    expect(body.availableSlots).toHaveLength(2);
  });

  it('honors the spot query param over the DB value', async () => {
    mockSql
      // resolveSnapshotSource — the live series has rows for the date
      .mockResolvedValueOnce([
        { has_uw_spot: true, has_uw_eod: false, has_gexbot: false },
      ])
      // fetchAvailableSlots
      .mockResolvedValueOnce([])
      // fetchLatestPeriscopeSlot — no slot, short-circuit before cone fetches
      .mockResolvedValueOnce([{ captured_at: null }]);
    const { req, res } = makeReqRes({ spot: '7400' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { reason: string }).reason).toBe('no_slot');
    // 3 calls: source resolution + availableSlots + slot lookup. The
    // spot query param short-circuited the index_candles_1m lookup.
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it('rejects ?date with non-YYYY-MM-DD format', async () => {
    const { req, res } = makeReqRes({ date: 'not-a-date' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'date must be YYYY-MM-DD' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects ?time with out-of-range value', async () => {
    const { req, res } = makeReqRes({
      date: '2026-05-08',
      time: '25:99',
    });
    await handler(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'time must be HH:MM (CT)' });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('resolves picked (date, time) → asOf rounded to end-of-minute (catches HH:MM:XX slots)', async () => {
    // 2026-05-08 14:30 CT (CDT = UTC-5) → asOf rounds UP to
    // 19:30:59.999Z so a slot captured at 19:30:48.478Z is INCLUDED
    // (the prev/next stepper depends on this — HH:MM truncates seconds
    // and at-or-before would otherwise skip the intended slot).
    mockSql
      // fetchSpxSpot — at-or-before asOf
      .mockResolvedValueOnce([{ close: '7388.07' }])
      // resolveSnapshotSource — the live series has rows for the date
      .mockResolvedValueOnce([
        { has_uw_spot: true, has_uw_eod: false, has_gexbot: false },
      ])
      // fetchAvailableSlots
      .mockResolvedValueOnce([
        { captured_at: '2026-05-08T19:20:48.478Z' },
        { captured_at: '2026-05-08T19:30:48.478Z' },
      ])
      // fetchLatestPeriscopeSlot at-or-before asOf
      .mockResolvedValueOnce([{ captured_at: '2026-05-08T19:30:48.478Z' }])
      // loadSlot
      .mockResolvedValueOnce([{ panel: 'gamma', strike: 7390, value: '5000' }])
      // fetchPriorPeriscopeSlot
      .mockResolvedValueOnce([{ captured_at: null }])
      // fetchConeLevels
      .mockResolvedValueOnce([])
      // fetchConeBreaches
      .mockResolvedValueOnce([]);
    const { req, res } = makeReqRes({
      date: '2026-05-08',
      time: '14:30',
    });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      data: { capturedAt: string; spot: number };
      availableSlots: string[];
    };
    expect(body.data.capturedAt).toBe('2026-05-08T19:30:48.478Z');
    expect(body.data.spot).toBe(7388.07);
    expect(body.availableSlots).toEqual([
      '2026-05-08T19:20:48.478Z',
      '2026-05-08T19:30:48.478Z',
    ]);
  });

  it('surfaces source:uw_eod and pins every snapshot read to it on a backfill-only date', async () => {
    mockSql
      // fetchSpxSpot
      .mockResolvedValueOnce([{ close: '5800' }])
      // resolveSnapshotSource — date predates the live feed
      .mockResolvedValueOnce([
        { has_uw_spot: false, has_uw_eod: true, has_gexbot: true },
      ])
      // fetchAvailableSlots — the single synthetic 15:00 CT slot
      .mockResolvedValueOnce([{ captured_at: '2025-03-14T20:00:00Z' }])
      // fetchLatestPeriscopeSlot — MAX
      .mockResolvedValueOnce([{ captured_at: '2025-03-14T20:00:00Z' }])
      // loadSlot — normalized-scale values
      .mockResolvedValueOnce([
        { panel: 'gamma', strike: 5800, value: '-431.96' },
      ])
      // fetchPriorPeriscopeSlot — one slice per day, so no prior
      .mockResolvedValueOnce([{ captured_at: null }])
      // fetchConeLevels + fetchConeBreaches
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { req, res } = makeReqRes({ date: '2025-03-14' });
    await handler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect((res.body as { source: string }).source).toBe('uw_eod');

    // Resolution probe aside, no query may reference the live series —
    // its dollar scale is ~1000x the backfill's on gamma.
    const snapshotCalls = mockSql.mock.calls
      .filter((c) =>
        (c[0] as string[]).join('?').includes('periscope_snapshots'),
      )
      .slice(1);
    expect(snapshotCalls.length).toBe(4);
    for (const call of snapshotCalls) {
      expect(call.slice(1)).toContain('uw_eod');
      expect(call.slice(1)).not.toContain('uw_spot');
    }
  });

  it('returns 500 on unhandled error', async () => {
    mockSql.mockRejectedValueOnce(new Error('connection refused'));
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('returns nothing extra when guard rejects', async () => {
    mockGuard.mockResolvedValueOnce(true);
    const { req, res } = makeReqRes();
    await handler(req, res as never);
    // Guard short-circuits with its own response; handler does not
    // touch res.status / res.json after guard returns true.
    expect(res.statusCode).toBe(0);
  });
});
