// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockUnsafe, mockSentryCapture, TransientDbError } = vi.hoisted(
  () => {
    class TransientDbError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TransientDbError';
      }
    }
    // `db.unsafe(raw)` → the raw string (mirrors neon's UnsafeRawSql).
    // The endpoint splices its SELECT column list through it, so the
    // list lands as interpolation #0 of every tick query.
    const mockUnsafe = vi.fn((raw: string) => raw);
    return {
      mockSql: Object.assign(vi.fn(), { unsafe: mockUnsafe }),
      mockUnsafe,
      mockSentryCapture: vi.fn(),
      TransientDbError,
    };
  },
);

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  TransientDbError,
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    setTag: vi.fn(),
    captureException: mockSentryCapture,
    captureMessage: vi.fn(),
    withScope: (fn: (s: { setTransactionName: () => void }) => unknown) =>
      fn({ setTransactionName: vi.fn() }),
  },
  metrics: {
    request: vi.fn(() => vi.fn()),
    increment: vi.fn(),
  },
}));

vi.mock('../_lib/guest-auth.js', () => ({
  guardOwnerOrGuestEndpoint: vi.fn(async () => false),
}));

vi.mock('../_lib/api-helpers.js', async (orig) => {
  const actual = (await orig()) as object;
  return {
    ...actual,
    setCacheHeaders: vi.fn(),
    isMarketOpen: vi.fn(() => true),
  };
});

vi.mock('../../src/utils/timezone.js', () => ({
  getETDateStr: vi.fn(() => '2026-05-26'),
}));

import handler from '../periscope-map.js';
import { PANEL_SOURCE_COLUMNS, SOURCE_UW_SPOT } from '../_lib/periscope-uw.js';

const SPOT = 7515;

/**
 * One `gex_strike_0dte` row as the Neon driver hands it back — every
 * NUMERIC column is a string.
 */
function uwRow(
  ts: Date,
  strike: number,
  net: { gamma: number; charm: number; vanna: number },
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    timestamp: ts,
    strike: strike.toFixed(2),
    price: SPOT.toFixed(2),
    // call leg carries the value, put leg is zero → net === call.
    call_gamma_oi: net.gamma.toFixed(4),
    put_gamma_oi: '0.0000',
    call_charm_oi: net.charm.toFixed(4),
    put_charm_oi: '0.0000',
    call_vanna_oi: net.vanna.toFixed(4),
    put_vanna_oi: '0.0000',
    ...overrides,
  };
}

function tickRows(ts: Date): Record<string, unknown>[] {
  return [
    uwRow(ts, 7505, { gamma: 800_000, charm: -400_000, vanna: 120_000 }),
    uwRow(ts, 7510, { gamma: -500_000, charm: 250_000, vanna: -90_000 }),
    uwRow(ts, 7520, { gamma: 1_250_000, charm: 310_000, vanna: 210_000 }),
  ];
}

function req() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // resetAllMocks drops the raw-SQL passthrough — restore it.
  mockUnsafe.mockImplementation((raw: string) => raw);
  process.env.CRON_SECRET = 'test-secret';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('/api/periscope-map', () => {
  it('returns reason:no_slot + empty data when no fresh gex_strike_0dte tick', async () => {
    // Every query returns [] — the source probe and the latest-tick
    // read. The latest read is bounded by STALENESS_CUTOFF_MS, so a
    // stale-only table produces zero rows and the endpoint refuses to
    // serve.
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({
      data: null,
      reason: 'no_slot',
      availableSlots: [],
    });
  });

  it('pins availableSlots to the source the historical read resolves', async () => {
    // The stepper's slots are clicked straight into
    // /api/periscope-exposure, which pins one series. An unpinned list
    // would advertise the EOD backfill's synthetic 20:00Z slot next to
    // the day's uw_spot ticks and render a different slice than clicked.
    mockSql
      // resolveSnapshotSource — only the EOD backfill covers this date
      .mockResolvedValueOnce([
        { has_uw_spot: false, has_uw_eod: true, has_gexbot: false },
      ])
      // fetchAvailableSlots — the single synthetic EOD slot
      .mockResolvedValueOnce([{ captured_at: '2026-05-26T20:00:00.000Z' }])
      // latest tick — none (historical date, no live feed)
      .mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);

    const slotValues = mockSql.mock.calls[1]!.slice(1);
    expect(slotValues).toEqual(['2026-05-26', 'uw_eod']);
    expect(res._json).toMatchObject({
      reason: 'no_slot',
      availableSlots: ['2026-05-26T20:00:00.000Z'],
    });
  });

  it('derives the tick SELECT list from the shared UW column map', async () => {
    // Anti-drift guard: the six greek legs must come from
    // PANEL_SOURCE_COLUMNS (api/_lib/periscope-uw.ts), the same map the
    // cron writes uw_spot rows with. A local hardcoded copy here would
    // let the live render and the stored rows diverge for one tick.
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);
    const legs = (['gamma', 'charm', 'vanna'] as const).flatMap((panel) => {
      const cols = PANEL_SOURCE_COLUMNS[SOURCE_UW_SPOT][panel];
      return [cols.call, cols.put];
    });
    expect(mockUnsafe).toHaveBeenCalledWith(
      ['timestamp', 'strike', 'price', ...legs].join(', '),
    );
  });

  it('bounds the latest-tick query by the 5-minute staleness cutoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T18:00:00.000Z'));
    mockSql.mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);
    // call 0 = resolveSnapshotSource (returns [] → null source, so
    // fetchAvailableSlots short-circuits without a query), call 1 =
    // latest tick.
    const values = mockSql.mock.calls[1]!.slice(1);
    // [selectColumns, date, stalenessCutoff, date, stalenessCutoff]
    expect(values[1]).toBe('2026-05-26');
    expect(values[2]).toBe('2026-05-26T17:55:00.000Z');
    expect(values[3]).toBe('2026-05-26');
    expect(values[4]).toBe('2026-05-26T17:55:00.000Z');
  });

  it('returns reason:no_spot when the tick has no price and no SPX candle', async () => {
    const latestAt = new Date(Date.now() - 60_000);
    const noPrice = tickRows(latestAt).map((r) => ({ ...r, price: null }));
    mockSql
      .mockResolvedValueOnce([]) // resolveSnapshotSource -> null (no slot query)
      .mockResolvedValueOnce(noPrice) // latest tick
      .mockResolvedValueOnce([]); // fetchSpxSpot fallback → no candle
    const res = mockResponse();
    await handler(req(), res);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ data: null, reason: 'no_spot' });
  });

  it('falls back to fetchSpxSpot when the tick price is null', async () => {
    const latestAt = new Date(Date.now() - 60_000);
    const noPrice = tickRows(latestAt).map((r) => ({ ...r, price: null }));
    mockSql
      .mockResolvedValueOnce([]) // resolveSnapshotSource -> null (no slot query)
      .mockResolvedValueOnce(noPrice) // latest tick
      .mockResolvedValueOnce([{ close: '7515' }]) // fetchSpxSpot
      .mockResolvedValue([]); // prior tick + cone
    const res = mockResponse();
    await handler(req(), res);
    expect(res._status).toBe(200);
    const body = res._json as { data: { spot: number } | null };
    expect(body.data).not.toBeNull();
    expect(body.data!.spot).toBe(7515);
  });

  it('builds all three panels from a single UW tick', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    const priorAt = new Date(Date.now() - 12 * 60 * 1000);
    mockSql
      .mockResolvedValueOnce([]) // resolveSnapshotSource -> null (no slot query)
      .mockResolvedValueOnce(tickRows(latestAt)) // latest tick
      // price present on the tick → no fetchSpxSpot query
      .mockResolvedValueOnce(tickRows(priorAt)) // prior tick
      .mockResolvedValueOnce([]) // cone levels → null (no breaches query)
      .mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);

    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.data).not.toBeNull();
    const view = body.data as {
      spot: number;
      capturedAt: string;
      priorCapturedAt: string | null;
      gamma: {
        ceiling: { strike: number; value: number } | null;
        floor: { strike: number; value: number } | null;
        accelTop: { strike: number; value: number }[];
      };
      charm: { tallyWide100: number; topByAbs: { strike: number }[] };
      vanna: { topByAbs: { strike: number; value: number }[] };
    };

    // Spot comes off the tick's own `price` column.
    expect(view.spot).toBe(SPOT);
    expect(view.capturedAt).toBe(latestAt.toISOString());
    expect(view.priorCapturedAt).toBe(priorAt.toISOString());

    // gamma = call_gamma_oi + put_gamma_oi
    expect(view.gamma.ceiling).toEqual({
      strike: 7520,
      value: 1_250_000,
      ptsFromSpot: 5,
    });
    expect(view.gamma.floor).toEqual({
      strike: 7505,
      value: 800_000,
      ptsFromSpot: -10,
    });
    expect(view.gamma.accelTop[0]).toMatchObject({
      strike: 7510,
      value: -500_000,
    });

    // charm = call_charm_oi + put_charm_oi → -400k + 250k + 310k
    expect(view.charm.tallyWide100).toBe(160_000);
    // vanna = call_vanna_oi + put_vanna_oi
    expect(view.vanna.topByAbs[0]).toEqual({ strike: 7520, value: 210_000 });

    expect(typeof body.ageSec).toBe('number');
    expect(body.ageSec).toBeGreaterThanOrEqual(0);
    expect(body.priorAvailable).toBe(true);
  });

  it('nets both legs rather than reading only the call side', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    const rows = [
      uwRow(
        latestAt,
        7520,
        { gamma: 0, charm: 0, vanna: 0 },
        {
          call_gamma_oi: '900000.0000',
          put_gamma_oi: '350000.0000',
        },
      ),
    ];
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows)
      .mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);
    const view = (
      res._json as { data: { gamma: { ceiling: { value: number } } } }
    ).data;
    expect(view.gamma.ceiling.value).toBe(1_250_000);
  });

  it('skips strikes whose legs are null, non-numeric, or NaN', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    const rows = [
      // Good row.
      uwRow(latestAt, 7520, { gamma: 1_250_000, charm: 10, vanna: 10 }),
      // Null put leg → gamma dropped, charm/vanna survive.
      uwRow(
        latestAt,
        7530,
        { gamma: 9_999_999, charm: 7, vanna: 7 },
        { put_gamma_oi: null },
      ),
      // Non-numeric string → dropped.
      uwRow(
        latestAt,
        7540,
        { gamma: 8_888_888, charm: 5, vanna: 5 },
        { call_gamma_oi: 'NaN' },
      ),
      // Junk strike → whole row dropped from every panel.
      uwRow(
        latestAt,
        7550,
        { gamma: 7_777_777, charm: 3, vanna: 3 },
        { strike: null },
      ),
    ];
    mockSql
      .mockResolvedValueOnce([]) // resolveSnapshotSource -> null (no slot query)
      .mockResolvedValueOnce(rows) // latest tick
      .mockResolvedValue([]); // prior + cone
    const res = mockResponse();
    await handler(req(), res);

    const view = (
      res._json as {
        data: {
          gamma: { ceiling: { strike: number; value: number } | null };
          charm: { topByAbs: { strike: number }[] };
        };
      }
    ).data;
    // The 9_999_999 / 8_888_888 / 7_777_777 rows must never win the ceiling.
    expect(view.gamma.ceiling).toMatchObject({
      strike: 7520,
      value: 1_250_000,
    });
    // 7530/7540 keep their charm (only the gamma leg was bad); 7550 is gone.
    const charmStrikes = view.charm.topByAbs.map((r) => r.strike);
    expect(charmStrikes).toContain(7530);
    expect(charmStrikes).toContain(7540);
    expect(charmStrikes).not.toContain(7550);
  });

  it('rounds fractional strikes to integers', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    const rows = [
      uwRow(
        latestAt,
        7520,
        { gamma: 1_250_000, charm: 1, vanna: 1 },
        { strike: '7520.4000' },
      ),
    ];
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows)
      .mockResolvedValue([]);
    const res = mockResponse();
    await handler(req(), res);
    const view = (
      res._json as { data: { gamma: { ceiling: { strike: number } } } }
    ).data;
    expect(view.gamma.ceiling.strike).toBe(7520);
    expect(Number.isInteger(view.gamma.ceiling.strike)).toBe(true);
  });

  it('widens the prior-slice window to the 30-minute floor when the ideal 10-minute lookback is empty', async () => {
    const latestAt = new Date('2026-05-26T18:00:00.000Z');
    // No tick at exactly -10 min; the nearest is 25 min back, still
    // inside PRIOR_LOOKBACK_FLOOR_MIN.
    const priorAt = new Date('2026-05-26T17:35:00.000Z');
    mockSql
      .mockResolvedValueOnce([]) // resolveSnapshotSource -> null (no slot query)
      .mockResolvedValueOnce(tickRows(latestAt)) // latest tick
      .mockResolvedValueOnce(tickRows(priorAt)) // prior tick (single windowed query)
      .mockResolvedValue([]); // cone
    const res = mockResponse();
    await handler(req(), res);

    // call 2 = the prior-slice query.
    // values = [selectColumns, date, date, cutoff, floor]
    const values = mockSql.mock.calls[2]!.slice(1);
    expect(values[3]).toBe('2026-05-26T17:50:00.000Z'); // latest - 10 min
    expect(values[4]).toBe('2026-05-26T17:30:00.000Z'); // latest - 30 min

    const body = res._json as { priorAvailable: boolean; data: unknown };
    expect(body.priorAvailable).toBe(true);
    expect((body.data as { priorCapturedAt: string }).priorCapturedAt).toBe(
      priorAt.toISOString(),
    );
  });

  it('sets priorAvailable=false when no qualifying prior slice exists', async () => {
    const latestAt = new Date(Date.now() - 30 * 1000);
    mockSql
      .mockResolvedValueOnce([]) // resolveSnapshotSource -> null (no slot query)
      .mockResolvedValueOnce(tickRows(latestAt)) // latest tick
      .mockResolvedValue([]); // prior tick → none; cone → none
    const res = mockResponse();
    await handler(req(), res);
    expect(res._status).toBe(200);
    const body = res._json as Record<string, unknown>;
    expect(body.priorAvailable).toBe(false);
    expect(
      (body.data as { priorCapturedAt: string | null }).priorCapturedAt,
    ).toBe(null);
  });

  it('returns 503 + Retry-After on a transient DB error', async () => {
    mockSql.mockRejectedValue(new TransientDbError('db attempt timeout'));
    const res = mockResponse();
    await handler(req(), res);
    expect(res._status).toBe(503);
    expect(res._headers['Retry-After']).toBe('5');
    const body = res._json as { transient?: boolean };
    expect(body.transient).toBe(true);
  });

  it('returns 500 on a generic DB error', async () => {
    mockSql.mockRejectedValue(new Error('Neon pool exhausted'));
    const res = mockResponse();
    await handler(req(), res);
    expect(res._status).toBe(500);
  });
});
