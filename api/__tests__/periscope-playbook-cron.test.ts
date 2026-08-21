// @vitest-environment node

/**
 * Tests for `api/cron/periscope-playbook.ts` — the cron writer that
 * revives the Periscope Claude auto-playbook on the repaired UW data
 * (Phase 3 of docs/superpowers/specs/periscope-playbook-revival-2026-08-21.md).
 *
 * The runner (`runPeriscopeAutoPlaybook`) is mocked in every case — this
 * suite must never touch Anthropic, OpenAI or a live database.
 *
 * `fetchSPXSpotAtTimestamp` is mocked by DEFAULT but NOT unconditionally:
 * `withRealSpotLookup()` swaps the real implementation back in over the
 * mocked `getDb`. Mocking it everywhere is precisely what hid the
 * future-`read_time` bug — the arithmetic that decides which candle
 * minute gets queried was never exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';
import type { RunPeriscopeAutoPlaybookOutcome } from '../_lib/periscope-playbook-runner.js';

const {
  mockSql,
  mockSentryException,
  mockSentryMessage,
  mockResolveSnapshotSource,
  mockFetchAvailableSlots,
  mockFetchSpot,
  mockSave,
  mockComplete,
  mockRunner,
  mockRequireEnv,
  realSpx,
} = vi.hoisted(() => ({
  mockSql: vi.fn().mockResolvedValue([]),
  mockSentryException: vi.fn(),
  mockSentryMessage: vi.fn(),
  mockResolveSnapshotSource: vi.fn(),
  mockFetchAvailableSlots: vi.fn(),
  mockFetchSpot: vi.fn(),
  mockSave: vi.fn(),
  mockComplete: vi.fn(),
  mockRunner: vi.fn(),
  mockRequireEnv: vi.fn(),
  // Mutable holder so the real (unmocked) spot lookup can be handed back
  // to individual tests. `vi.hoisted` runs before the mock factories, so
  // assigning into it from a factory is TDZ-safe.
  realSpx: {
    fetchSPXSpotAtTimestamp: null as
      | typeof import('../_lib/spx-candles.js').fetchSPXSpotAtTimestamp
      | null,
  },
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
    addBreadcrumb: vi.fn(),
    captureException: mockSentryException,
    captureMessage: mockSentryMessage,
  },
  metrics: { increment: vi.fn(), distribution: vi.fn(), gauge: vi.fn() },
}));

vi.mock('../_lib/env.js', () => ({
  requireEnv: mockRequireEnv,
  optionalEnv: vi.fn(() => undefined),
}));

vi.mock('../_lib/periscope-query.js', () => ({
  resolveSnapshotSource: mockResolveSnapshotSource,
  fetchAvailableSlots: mockFetchAvailableSlots,
}));

vi.mock('../_lib/spx-candles.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../_lib/spx-candles.js')>();
  realSpx.fetchSPXSpotAtTimestamp = actual.fetchSPXSpotAtTimestamp;
  return { ...actual, fetchSPXSpotAtTimestamp: mockFetchSpot };
});

vi.mock('../_lib/periscope-db.js', () => ({
  savePeriscopeAnalysis: mockSave,
  completePeriscopeAnalysis: mockComplete,
}));

vi.mock('../_lib/periscope-playbook-runner.js', () => ({
  runPeriscopeAutoPlaybook: mockRunner,
}));

import handler from '../cron/periscope-playbook.js';

// Wednesday 2026-05-27 13:00 CT / 18:00 UTC — inside isFuturesRthCt and
// inside CDT (UTC-5), so CT wall clock = UTC - 5h throughout.
const MARKET_TIME = new Date('2026-05-27T18:00:00.000Z');
const WEEKEND_TIME = new Date('2026-05-30T18:00:00.000Z'); // Sat
const TODAY_ET = '2026-05-27';

// Friday 2026-11-27 — NYSE Black Friday early close (13:00 ET / 12:00 CT)
// and inside CST (UTC-6). 18:30 UTC = 12:30 CT, i.e. after the early
// close but still inside the futures-tied RTH gate.
const EARLY_CLOSE_TIME = new Date('2026-11-27T18:30:00.000Z');
const EARLY_CLOSE_DATE = '2026-11-27';

/** captured_at ISO for a CT wall-clock time on a given day. */
function ctSlotOn(date: string, hhmm: string, utcOffsetHours: number): string {
  const [h, m] = hhmm.split(':').map((v) => Number.parseInt(v, 10));
  const utcHour = (h ?? 0) + utcOffsetHours;
  return `${date}T${String(utcHour).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}:00.000Z`;
}

/** captured_at ISO for a CT wall-clock time on the CDT test trading day. */
function ctSlot(hhmm: string): string {
  return ctSlotOn(TODAY_ET, hhmm, 5);
}

/** captured_at ISO for a CT wall-clock time on the CST early-close day. */
function ctSlotEarly(hhmm: string): string {
  return ctSlotOn(EARLY_CLOSE_DATE, hhmm, 6);
}

/** A finished row the idempotency probe must treat as terminal. */
function completeRow(id: number): Record<string, unknown> {
  return { id, status: 'complete', failure_reason: null, attempt: '1' };
}

function okOutcome(
  overrides: Partial<RunPeriscopeAutoPlaybookOutcome> = {},
): RunPeriscopeAutoPlaybookOutcome {
  return {
    status: 'complete',
    prose: 'the read',
    structured: {
      spot: 5901,
      cone_lower: 5880,
      cone_upper: 5930,
      long_trigger: null,
      short_trigger: null,
      regime_tag: 'pinned',
      bias: 'two-sided',
      trade_types_recommended: ['iron condor'],
      trade_types_avoided: [],
      key_levels: null,
      expected_dealer_behavior: null,
      confidence: 'medium',
      confidence_basis: null,
      futures_plan: null,
    },
    parseOk: true,
    fullResponse: { source: 'uw_spot' },
    embedding: [0.1, 0.2],
    panelPayload: { spot: 5900 },
    failureReason: null,
    modelUsed: 'claude-opus-5',
    durationMs: 42_000,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    ...overrides,
  };
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

/** The tagged-template SQL text of the Nth `sql` call. */
function sqlText(callIndex: number): string {
  const strings = mockSql.mock.calls[callIndex]?.[0] as
    | TemplateStringsArray
    | undefined;
  return strings == null ? '' : strings.join('?');
}

/**
 * Wire the default happy-path mock chain: one live `uw_spot` slot at the
 * given CT wall-clock time, no existing row, no parent, spot resolves.
 */
function primeHappyPath(slotCt = '13:00'): void {
  mockResolveSnapshotSource.mockResolvedValue('uw_spot');
  mockFetchAvailableSlots.mockResolvedValue([ctSlot(slotCt)]);
  // 1st sql call: existing-row probe. 2nd: parent probe.
  mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  mockFetchSpot.mockResolvedValue({ price: 5900.25, source: 'db_exact' });
  mockSave.mockResolvedValue(4242);
  mockComplete.mockResolvedValue(true);
  mockRunner.mockResolvedValue(okOutcome());
}

/**
 * Replace the spot-lookup mock with the REAL implementation, backed by a
 * fake `index_candles_1m` that only holds bars at-or-before "now". Any
 * `read_time` in the future therefore resolves to null, exactly as it
 * does in production against `market_time = 'r'`.
 */
function withRealSpotLookup(closePrice = 5899.75): void {
  mockFetchSpot.mockImplementation(
    (
      args: Parameters<NonNullable<typeof realSpx.fetchSPXSpotAtTimestamp>>[0],
    ) => realSpx.fetchSPXSpotAtTimestamp!(args),
  );

  mockSql.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (!text.includes('index_candles_1m')) return Promise.resolve([]);
      // Both the exact and the snapped query take the requested instant
      // as their LAST ISO parameter.
      const requested = values
        .filter((v): v is string => typeof v === 'string' && v.endsWith('Z'))
        .at(-1);
      if (requested != null && Date.parse(requested) <= Date.now()) {
        return Promise.resolve([
          { close: String(closePrice), timestamp: requested },
        ]);
      }
      return Promise.resolve([]);
    },
  );
}

/** Every instant the real spot lookup asked `index_candles_1m` about. */
function queriedCandleInstants(): string[] {
  return mockSql.mock.calls
    .filter((call) => {
      const strings = call[0] as TemplateStringsArray | undefined;
      return strings != null && strings.join('?').includes('index_candles_1m');
    })
    .flatMap((call) =>
      call
        .slice(1)
        .filter((v): v is string => typeof v === 'string' && v.endsWith('Z')),
    );
}

describe('cron/periscope-playbook', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.mockResolvedValue([]);
    mockRequireEnv.mockImplementation((key: string) => `${key}-value`);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(MARKET_TIME);
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it('rejects a request without the CRON_SECRET bearer and touches no DB', async () => {
    const res = mockResponse();
    await handler(mockRequest({ method: 'GET', headers: {} }), res);

    expect(res._status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockResolveSnapshotSource).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips outside the futures-RTH window', async () => {
    vi.setSystemTime(WEEKEND_TIME);
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockResolveSnapshotSource).not.toHaveBeenCalled();
  });

  it('fails fast when ANTHROPIC_API_KEY is missing', async () => {
    mockRequireEnv.mockImplementation((key: string) => {
      if (key === 'ANTHROPIC_API_KEY') {
        throw new Error(
          'Missing required environment variable: ANTHROPIC_API_KEY',
        );
      }
      return `${key}-value`;
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(mockResolveSnapshotSource).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('fails fast when OPENAI_API_KEY is missing', async () => {
    mockRequireEnv.mockImplementation((key: string) => {
      if (key === 'OPENAI_API_KEY') {
        throw new Error(
          'Missing required environment variable: OPENAI_API_KEY',
        );
      }
      return `${key}-value`;
    });
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(500);
    expect(mockResolveSnapshotSource).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('inserts an in_progress row, runs the runner, then completes the row', async () => {
    primeHappyPath('13:00');
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // `withCronInstrumentation` spreads CronResult.metadata into the body.
    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('success');

    // Phase 1: placeholder row BEFORE the Claude call.
    expect(mockSave).toHaveBeenCalledTimes(1);
    const saved = mockSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(saved.status).toBe('in_progress');
    expect(saved.autoGenerated).toBe(true);
    expect(saved.tradingDate).toBe(TODAY_ET);
    expect(saved.slotCapturedAt).toBe(ctSlot('13:00'));
    expect(saved.mode).toBe('intraday');
    expect(saved.spotAtReadTime).toBe(5900.25);
    expect(saved.spotSource).toBe('db_exact');
    expect(saved.parseOk).toBe(false);
    expect(saved.fullResponse).toEqual({
      auto_playbook: 'in_progress',
      auto_playbook_attempt: 1,
    });

    // The in_progress row must land before the Claude call.
    expect(mockSave.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRunner.mock.invocationCallOrder[0]!,
    );

    // Phase 2: the runner's output is persisted onto that row id.
    expect(mockRunner).toHaveBeenCalledTimes(1);
    const runnerArg = mockRunner.mock.calls[0]![0] as Record<string, unknown>;
    expect(runnerArg.mode).toBe('intraday');
    expect(runnerArg.tradingDate).toBe(TODAY_ET);
    expect(runnerArg.spotAtReadTime).toBe(5900.25);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [rowId, completion] = mockComplete.mock.calls[0]! as [
      number,
      Record<string, unknown>,
    ];
    expect(rowId).toBe(4242);
    expect(completion.status).toBe('complete');
    expect(completion.proseText).toBe('the read');
    expect(completion.model).toBe('claude-opus-5');
    expect(completion.outputTokens).toBe(200);
    expect(completion.panelPayload).toEqual({ spot: 5900 });
    // The attempt counter must survive the runner overwriting full_response,
    // or the retry cap could never bind.
    expect(completion.fullResponse).toEqual({
      source: 'uw_spot',
      auto_playbook_attempt: 1,
    });
    expect(mockSentryException).not.toHaveBeenCalled();
  });

  describe('read_time anchoring', () => {
    it('anchors read_time at the END of the slot label', async () => {
      // 12:40 CT capture → slot "12:40 - 12:50"; the END is in the past
      // at 13:00 CT, so no clamp applies.
      primeHappyPath('12:40');
      await handler(authedReq(), mockResponse());

      expect(mockFetchSpot).toHaveBeenCalledWith({
        date: TODAY_ET,
        time: '12:50',
        toleranceMin: 5,
        isLiveRead: false,
      });
      const runnerArg = mockRunner.mock.calls[0]![0] as { readTimeIso: string };
      expect(runnerArg.readTimeIso).toBe('2026-05-27T17:50:00.000Z');
    });

    it('clamps read_time to now rather than ten minutes into the future', async () => {
      // `populate-periscope-from-uw` stamps captured_at = MAX(tick). When
      // that tick's minute is ≡ 0 mod 10 the derived label is [M, M+10)
      // and its END has not happened yet. This test drives the REAL
      // `fetchSPXSpotAtTimestamp` against a candle table that only holds
      // past bars, so an unclamped read_time silently loses the slot.
      vi.setSystemTime(new Date('2026-05-27T18:00:30.000Z')); // 13:00:30 CT
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
      withRealSpotLookup(5899.75);
      mockSave.mockResolvedValue(31);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.slotKey).toBe('13:00 - 13:10');

      // The lookup ran for 13:00 CT (== now), never 13:10 CT.
      const instants = queriedCandleInstants();
      expect(instants.length).toBeGreaterThan(0);
      expect(instants).toContain('2026-05-27T18:00:00.000Z');
      expect(instants).not.toContain('2026-05-27T18:10:00.000Z');
      for (const iso of instants) {
        expect(Date.parse(iso)).toBeLessThanOrEqual(Date.now());
      }

      // …and the slot was actually analyzed rather than silently dropped.
      expect(mockSave).toHaveBeenCalledTimes(1);
      const saved = mockSave.mock.calls[0]![0] as {
        readTime: string;
        spotAtReadTime: number;
      };
      expect(saved.readTime).toBe('2026-05-27T18:00:00.000Z');
      expect(Date.parse(saved.readTime)).toBeLessThanOrEqual(Date.now());
      expect(saved.spotAtReadTime).toBe(5899.75);
      expect(mockRunner).toHaveBeenCalledTimes(1);
    });
  });

  describe('mode derivation from the CT slot label', () => {
    it('maps the 08:20 - 08:30 boundary slot to pre_trade', async () => {
      primeHappyPath('08:20');
      await handler(authedReq(), mockResponse());
      const saved = mockSave.mock.calls[0]![0] as { mode: string };
      expect(saved.mode).toBe('pre_trade');
    });

    it('maps the 14:50 - 15:00 boundary slot to debrief', async () => {
      primeHappyPath('14:50');
      await handler(authedReq(), mockResponse());
      const saved = mockSave.mock.calls[0]![0] as { mode: string };
      expect(saved.mode).toBe('debrief');
    });

    it('maps everything between the boundaries to intraday', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlot('08:20'),
        ctSlot('11:30'),
      ]);
      mockSql
        .mockResolvedValueOnce([completeRow(1)]) // pre_trade root already written
        .mockResolvedValueOnce([]) // newest slot: no row
        .mockResolvedValueOnce([]); // parent probe
      mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });
      mockSave.mockResolvedValue(7);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());
      const saved = mockSave.mock.calls[0]![0] as { mode: string };
      expect(saved.mode).toBe('intraday');
    });

    it('promotes the first analyzable slot of the day to pre_trade', async () => {
      // 08:30 CT is the realistic first ingested slot after a feed outage;
      // it is still functionally the pre-trade read.
      primeHappyPath('08:30');
      await handler(authedReq(), mockResponse());
      const saved = mockSave.mock.calls[0]![0] as { mode: string };
      expect(saved.mode).toBe('pre_trade');
    });

    it('skips a post-debrief slot with no analyzable slot behind it', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('15:00')]);
      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as { status: string };
      expect(body.status).toBe('skipped');
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('falls back to the latest ANALYZABLE slot when the newest slot is past 15:00', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlot('08:30'),
        ctSlot('14:50'),
        ctSlot('15:00'),
      ]);
      mockSql
        .mockResolvedValueOnce([completeRow(1)]) // pre_trade root already written
        .mockResolvedValueOnce([]) // debrief slot: no row
        .mockResolvedValueOnce([]); // parent probe
      mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });
      mockSave.mockResolvedValue(9);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());
      const saved = mockSave.mock.calls[0]![0] as {
        mode: string;
        slotCapturedAt: string;
      };
      expect(saved.mode).toBe('debrief');
      expect(saved.slotCapturedAt).toBe(ctSlot('14:50'));
    });
  });

  describe('early-close sessions', () => {
    it('derives the debrief slot from the session close, not a hardcoded 15:00', async () => {
      // Black Friday 2026-11-27 closes at 13:00 ET / 12:00 CT, so the
      // debrief slot is 11:50 - 12:00 and 14:50 - 15:00 never exists.
      vi.setSystemTime(EARLY_CLOSE_TIME);
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlotEarly('08:20'),
        ctSlotEarly('11:50'),
        ctSlotEarly('12:00'),
      ]);
      mockSql
        .mockResolvedValueOnce([completeRow(1)]) // pre_trade root already written
        .mockResolvedValueOnce([]) // debrief slot: no row
        .mockResolvedValueOnce([]); // parent probe
      mockFetchSpot.mockResolvedValue({ price: 6100, source: 'db_exact' });
      mockSave.mockResolvedValue(55);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());

      const saved = mockSave.mock.calls[0]![0] as {
        mode: string;
        slotCapturedAt: string;
        tradingDate: string;
        readTime: string;
      };
      expect(saved.tradingDate).toBe(EARLY_CLOSE_DATE);
      expect(saved.mode).toBe('debrief');
      expect(saved.slotCapturedAt).toBe(ctSlotEarly('11:50'));
      // read_time is the close itself: 12:00 CT == 18:00 UTC in CST.
      expect(saved.readTime).toBe('2026-11-27T18:00:00.000Z');
    });

    it('keeps 11:50 - 12:00 as an intraday slot on a regular session', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlot('08:20'),
        ctSlot('11:50'),
      ]);
      mockSql
        .mockResolvedValueOnce([completeRow(1)])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });
      mockSave.mockResolvedValue(56);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());
      const saved = mockSave.mock.calls[0]![0] as { mode: string };
      expect(saved.mode).toBe('intraday');
    });
  });

  describe("backfilling the day's pre_trade root", () => {
    it('prefers the first analyzable slot over the newest when it has no row', async () => {
      // The 08:30 CT tick routinely loses its race with fetch-spx-candles-1m.
      // Nothing but this backfill can produce a pre_trade read afterwards.
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlot('08:20'),
        ctSlot('08:30'),
        ctSlot('08:40'),
      ]);
      mockSql
        .mockResolvedValueOnce([]) // first slot: no row → backfill it
        .mockResolvedValueOnce([]); // parent probe
      mockFetchSpot.mockResolvedValue({ price: 5890, source: 'db_exact' });
      mockSave.mockResolvedValue(11);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());

      const saved = mockSave.mock.calls[0]![0] as {
        mode: string;
        slotCapturedAt: string;
      };
      expect(saved.mode).toBe('pre_trade');
      expect(saved.slotCapturedAt).toBe(ctSlot('08:20'));
      // Exactly one extra probe — the backfill check is bounded to one slot.
      expect(mockSql).toHaveBeenCalledTimes(2);
    });

    it('moves on to the newest slot once the pre_trade root exists', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlot('08:20'),
        ctSlot('08:40'),
      ]);
      mockSql
        .mockResolvedValueOnce([completeRow(11)]) // root already written
        .mockResolvedValueOnce([]) // newest slot: no row
        .mockResolvedValueOnce([]); // parent probe
      mockFetchSpot.mockResolvedValue({ price: 5895, source: 'db_exact' });
      mockSave.mockResolvedValue(12);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());

      const saved = mockSave.mock.calls[0]![0] as {
        mode: string;
        slotCapturedAt: string;
      };
      expect(saved.mode).toBe('intraday');
      expect(saved.slotCapturedAt).toBe(ctSlot('08:40'));
    });

    it('never adopts a later read as the parent of a backfilled slot', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([
        ctSlot('08:20'),
        ctSlot('08:40'),
      ]);
      mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockFetchSpot.mockResolvedValue({ price: 5890, source: 'db_exact' });
      mockSave.mockResolvedValue(13);
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      await handler(authedReq(), mockResponse());

      // The parent query is bounded to rows strictly EARLIER than the
      // slot being written, so a backfill cannot invert the chain.
      const parentSql = sqlText(1);
      expect(parentSql).toContain('slot_captured_at <');
      const parentArgs = mockSql.mock.calls[1]!.slice(1);
      expect(parentArgs).toContain(ctSlot('08:20'));
    });
  });

  it('links parent_id to the latest complete non-debrief row for the day', async () => {
    mockResolveSnapshotSource.mockResolvedValue('uw_spot');
    mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
    mockSql.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 88 }]);
    mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });
    mockSave.mockResolvedValue(101);
    mockComplete.mockResolvedValue(true);
    mockRunner.mockResolvedValue(okOutcome());

    await handler(authedReq(), mockResponse());

    const saved = mockSave.mock.calls[0]![0] as { parentId: number | null };
    expect(saved.parentId).toBe(88);
    const runnerArg = mockRunner.mock.calls[0]![0] as {
      parentId: number | null;
    };
    expect(runnerArg.parentId).toBe(88);
  });

  it('is a no-op when a row already exists for the slot', async () => {
    mockResolveSnapshotSource.mockResolvedValue('uw_spot');
    mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
    mockSql.mockResolvedValueOnce([completeRow(555)]);
    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('skipped');
    expect(body.existingRowId).toBe(555);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockFetchSpot).not.toHaveBeenCalled();
  });

  describe('retrying a burnt slot', () => {
    /** A failed row the probe should hand back for a retry decision. */
    function failedRow(
      failureReason: string,
      attempt: string,
      status = 'failed',
    ): Record<string, unknown> {
      return { id: 77, status, failure_reason: failureReason, attempt };
    }

    it('reclaims a transiently failed row in place and re-runs it', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
      mockSql
        .mockResolvedValueOnce([failedRow('anthropic_call_failed: 529', '1')])
        .mockResolvedValueOnce([]) // parent probe
        .mockResolvedValueOnce([{ id: 77 }]); // reclaim UPDATE won the claim
      mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });
      mockComplete.mockResolvedValue(true);
      mockRunner.mockResolvedValue(okOutcome());

      const res = mockResponse();
      await handler(authedReq(), res);

      // No second row: the unique index forbids one, so the retry is an
      // in-place UPDATE back to in_progress.
      expect(mockSave).not.toHaveBeenCalled();
      const reclaimSql = sqlText(2);
      expect(reclaimSql).toContain('UPDATE periscope_analyses');
      expect(reclaimSql).toContain("status = 'in_progress'");
      // Atomic claim: only a still-failed row may be reclaimed.
      expect(reclaimSql).toContain("status = 'failed'");

      expect(mockRunner).toHaveBeenCalledTimes(1);
      const [rowId, completion] = mockComplete.mock.calls[0]! as [
        number,
        Record<string, unknown>,
      ];
      expect(rowId).toBe(77);
      expect(completion.fullResponse).toEqual({
        source: 'uw_spot',
        auto_playbook_attempt: 2,
      });
      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('success');
      expect(body.attempt).toBe(2);
    });

    it('stops retrying once the attempt cap is reached', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
      mockSql.mockResolvedValueOnce([
        failedRow('anthropic_call_failed: 529', '2'),
      ]);
      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('skipped');
      expect(body.existingRowId).toBe(77);
      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
      expect(mockFetchSpot).not.toHaveBeenCalled();
    });

    it.each([
      ['source_not_uw_spot: uw_eod', 'failed'],
      ['claude_refusal', 'failed'],
      ['no_periscope_snapshots_for_slot', 'failed'],
      ['truncated_at_max_tokens output=32000', 'truncated'],
    ])('never retries the deterministic outcome %s', async (reason, status) => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
      mockSql.mockResolvedValueOnce([failedRow(reason, '1', status)]);
      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('skipped');
      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    });

    it('leaves an in_progress row alone rather than double-spending on it', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
      mockSql.mockResolvedValueOnce([
        { id: 77, status: 'in_progress', failure_reason: null, attempt: '1' },
      ]);
      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as { status: string };
      expect(body.status).toBe('skipped');
      expect(mockRunner).not.toHaveBeenCalled();
    });

    it('backs off when a concurrent invocation wins the retry claim', async () => {
      mockResolveSnapshotSource.mockResolvedValue('uw_spot');
      mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
      mockSql
        .mockResolvedValueOnce([failedRow('runner_threw: boom', '1')])
        .mockResolvedValueOnce([]) // parent probe
        .mockResolvedValueOnce([]); // reclaim UPDATE matched nothing
      mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });

      const res = mockResponse();
      await handler(authedReq(), res);

      const body = res._json as Record<string, unknown>;
      expect(body.status).toBe('skipped');
      expect(body.raceLoser).toBe(true);
      expect(mockRunner).not.toHaveBeenCalled();
      expect(mockComplete).not.toHaveBeenCalled();
    });

    it('stamps the attempt counter onto the row when the runner throws', async () => {
      primeHappyPath('13:00');
      mockRunner.mockRejectedValue(new Error('anthropic exploded'));

      await handler(authedReq(), mockResponse());

      const [, completion] = mockComplete.mock.calls[0]! as [
        number,
        Record<string, unknown>,
      ];
      expect(completion.status).toBe('failed');
      expect(completion.fullResponse).toMatchObject({
        auto_playbook_attempt: 1,
      });
    });
  });

  it('treats the runner source_not_uw_spot refusal as a normal outcome, not an error', async () => {
    primeHappyPath('13:00');
    mockRunner.mockResolvedValue(
      okOutcome({
        status: 'failed',
        prose: '',
        parseOk: false,
        embedding: null,
        panelPayload: null,
        failureReason: 'source_not_uw_spot: uw_eod',
        modelUsed: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      }),
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Record<string, unknown>;
    // Expected on any day the live series has no rows yet — never an alert.
    expect(body.status).not.toBe('error');
    expect(body.refused).toBe(true);
    expect(body.failureReason).toBe('source_not_uw_spot: uw_eod');
    expect(mockSentryException).not.toHaveBeenCalled();
    expect(mockSentryMessage).not.toHaveBeenCalled();
    // The row is still closed out rather than left in_progress.
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [, completion] = mockComplete.mock.calls[0]! as [
      number,
      Record<string, unknown>,
    ];
    expect(completion.status).toBe('failed');
    expect(completion.failureReason).toBe('source_not_uw_spot: uw_eod');
  });

  it('skips before any insert when the resolved source is not uw_spot', async () => {
    mockResolveSnapshotSource.mockResolvedValue('uw_eod');
    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('skipped');
    expect(body.source).toBe('uw_eod');
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockSentryException).not.toHaveBeenCalled();
  });

  it('skips when the day has no snapshot slots at all', async () => {
    mockResolveSnapshotSource.mockResolvedValue(null);
    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as { status: string };
    expect(body.status).toBe('skipped');
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('skips when no SPX candle can be resolved for the slot', async () => {
    mockResolveSnapshotSource.mockResolvedValue('uw_spot');
    mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
    mockFetchSpot.mockResolvedValue(null);
    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as { status: string };
    expect(body.status).toBe('skipped');
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRunner).not.toHaveBeenCalled();
  });

  it('marks the row failed (never orphaned in_progress) when the runner throws', async () => {
    primeHappyPath('13:00');
    mockRunner.mockRejectedValue(new Error('anthropic exploded'));

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [rowId, completion] = mockComplete.mock.calls[0]! as [
      number,
      Record<string, unknown>,
    ];
    expect(rowId).toBe(4242);
    expect(completion.status).toBe('failed');
    expect(String(completion.failureReason)).toContain('anthropic exploded');
    expect(mockSentryException).toHaveBeenCalled();

    const body = res._json as { status: string };
    expect(body.status).toBe('error');
  });

  it('resolves the unique-index race by reporting the winning row id', async () => {
    mockResolveSnapshotSource.mockResolvedValue('uw_spot');
    mockFetchAvailableSlots.mockResolvedValue([ctSlot('13:00')]);
    mockSql
      .mockResolvedValueOnce([]) // existing-row probe: none
      .mockResolvedValueOnce([]) // parent probe
      .mockResolvedValueOnce([{ id: 999 }]); // re-probe after the failed insert
    mockFetchSpot.mockResolvedValue({ price: 5900, source: 'db_exact' });
    mockSave.mockResolvedValue(null);

    const res = mockResponse();
    await handler(authedReq(), res);

    const body = res._json as Record<string, unknown>;
    expect(body.status).toBe('skipped');
    expect(body.existingRowId).toBe(999);
    expect(mockRunner).not.toHaveBeenCalled();
  });
});
