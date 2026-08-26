// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const mockTransaction = vi.fn();
const mockSql = vi.fn().mockResolvedValue([]) as ReturnType<typeof vi.fn> & {
  transaction: typeof mockTransaction;
};
mockSql.transaction = mockTransaction;

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { captureException: vi.fn(), setTag: vi.fn() },
}));

vi.mock('../_lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockUwFetch, mockCronGuard, mockCheckDataQuality } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockCronGuard: vi.fn(),
  mockCheckDataQuality: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  checkDataQuality: mockCheckDataQuality,
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler from '../cron/fetch-greek-exposure-strike.js';

// ── Fixture factory ──────────────────────────────────────────

const makeStrikeRow = (
  strike = '6800',
  callGex = '6105.1409',
  putGex = '-699.9181',
) => ({
  date: '2026-04-10',
  expiry: '2026-04-10',
  strike,
  dte: 0,
  call_gex: callGex,
  put_gex: putGex,
  call_delta: '394699.3301',
  put_delta: '-75428.0846',
  call_charm: '-1025514.4594',
  put_charm: '-117569.0952',
  call_vanna: '165653.1431',
  put_vanna: '18991.1969',
});

// ── Helpers ──────────────────────────────────────────────────

/** Default guard result returned by a passing cronGuard mock */
const GUARD = { apiKey: 'test-uw-key', today: '2026-04-10' };

describe('fetch-greek-exposure-strike handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: cronGuard passes
    mockCronGuard.mockReturnValue(GUARD);
    // Default: uwFetch returns empty
    mockUwFetch.mockResolvedValue([]);
    // Default: direct-call mockSql (the data-quality SELECT) returns a stored row
    mockSql.mockResolvedValue([{ strike: '6800' }]);
    // Default: transaction runs each per-row query and returns one stored
    // row ([{ strike }]) per INSERT — mirrors Neon's sql.transaction contract.
    mockSql.transaction = mockTransaction;
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        return queries.map(() => [{ strike: '6800' }]);
      },
    );
    mockCheckDataQuality.mockResolvedValue(undefined);
  });

  // ── Auth guard ─────────────────────────────────────────────

  it('returns 401 when cronGuard returns null (not authorized)', async () => {
    // cronGuard already wrote the 401 response and returned null
    mockCronGuard.mockImplementation((_req, res) => {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    });

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
    // uwFetch must never be called when guard fails
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  // ── Empty API response ─────────────────────────────────────

  it('returns 200 when no rows are fetched (empty API response)', async () => {
    mockUwFetch.mockResolvedValue([]);
    // No INSERT rows needed; data-quality SELECT still runs
    mockSql.mockResolvedValue([{ total: '0', nonzero: '0' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 0, stored: 0, skipped: 0 });
    // Data-quality SELECT still fires even with zero rows
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockCheckDataQuality).toHaveBeenCalledOnce();
  });

  // ── Happy path: store with computed values ─────────────────

  it('returns 200 and stores rows with correct computed values', async () => {
    const row = makeStrikeRow('6800', '6105.1409', '-699.9181');
    mockUwFetch.mockResolvedValue([row]);

    // QC SELECT (direct mockSql call after the transaction)
    mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

    // Capture the interpolated values bound to the per-row INSERT inside the
    // transaction (Neon's tagged-template signature: (strings, ...values)).
    let insertValues: unknown[] = [];
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = (..._args: unknown[]) => {
          insertValues = _args.slice(1);
          return {};
        };
        const queries = fn(txnFn);
        return queries.map(() => [{ strike: '6800' }]);
      },
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 1, stored: 1, skipped: 0 });

    // One transaction (the INSERT batch) + one direct QC SELECT.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(1);

    // Inspect the interpolated values passed to the per-row INSERT template.
    const values = insertValues;

    const callGex = 6105.1409;
    const putGex = -699.9181;
    const expectedNetGex = callGex + putGex;
    const expectedAbsGex = Math.abs(callGex) + Math.abs(putGex);
    const expectedCallGexFraction = callGex / expectedAbsGex;

    // net_gex
    expect(values).toContain(expectedNetGex);
    // abs_gex
    expect(values).toContain(expectedAbsGex);
    // call_gex_fraction
    expect(
      values.some(
        (v: unknown) =>
          typeof v === 'number' &&
          Math.abs((v as number) - expectedCallGexFraction) < 1e-9,
      ),
    ).toBe(true);
  });

  // ── Zero-GEX filter ────────────────────────────────────────

  it('filters out zero-GEX strikes (call_gex and put_gex both 0.0000)', async () => {
    const zeroRow = makeStrikeRow('5000', '0.0000', '0.0000');
    const validRow = makeStrikeRow('6800', '6105.1409', '-699.9181');
    mockUwFetch.mockResolvedValue([zeroRow, validRow]);

    // QC SELECT (direct mockSql call); transaction default stores each row
    mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

    // Capture the number of INSERTs that reached the transaction.
    let insertCount = 0;
    mockTransaction.mockImplementationOnce(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = () => ({});
        const queries = fn(txnFn);
        insertCount = queries.length;
        return queries.map(() => [{ strike: '6800' }]);
      },
    );

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // fetched = 2 (raw from API), stored = 1 (zeroRow excluded before INSERT)
    expect(res._json).toMatchObject({ fetched: 2, stored: 1, skipped: 0 });

    // Only one INSERT should reach the transaction (the valid row); the
    // zero-GEX row is filtered before storeStrikeRows runs.
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(insertCount).toBe(1);
  });

  it('keeps a strike where only call_gex is 0.0000 (put_gex is non-zero)', async () => {
    const halfZeroRow = makeStrikeRow('6500', '0.0000', '-1234.5678');
    mockUwFetch.mockResolvedValue([halfZeroRow]);

    // QC SELECT (direct mockSql call); transaction default stores the row
    mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 1, stored: 1 });
  });

  // ── Transaction abort → all rows skipped (atomic batch) ────

  it('skips the entire batch when the transaction aborts', async () => {
    const { Sentry } = await import('../_lib/sentry.js');
    const goodRow = makeStrikeRow('6800', '6105.1409', '-699.9181');
    const badRow = makeStrikeRow('6900', '100.0000', '-50.0000');
    mockUwFetch.mockResolvedValue([goodRow, badRow]);

    // The whole transaction rejects — the INSERT batch is atomic, so a single
    // failed row aborts every row (stored = 0, skipped = all). The store
    // helper catches it, reports via Sentry, and returns the all-skipped tuple.
    mockTransaction.mockRejectedValueOnce(new Error('unique violation'));
    // QC SELECT (direct mockSql call) still runs afterward.
    mockSql.mockResolvedValue([{ total: '0', nonzero: '0' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ fetched: 2, stored: 0, skipped: 2 });
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  // ── Largest-magnitude GEX strike logging ───────────────────

  it('computes and logs the largest-magnitude GEX strike when rows > 1', async () => {
    const { default: logger } = await import('../_lib/logger.js');
    // Two rows with different total absolute GEX magnitudes
    const smallRow = makeStrikeRow('6700', '100.0000', '-50.0000');
    const largeRow = makeStrikeRow('6800', '6105.1409', '-699.9181');
    mockUwFetch.mockResolvedValue([smallRow, largeRow]);

    // Transaction default stores both rows; QC SELECT is the direct mockSql call
    mockSql.mockResolvedValue([{ total: '2', nonzero: '2' }]);

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(200);
    // Logger should have been called with the largest strike (6800) net GEX info
    expect(vi.mocked(logger).info).toHaveBeenCalledWith(
      expect.objectContaining({ strike: '6800' }),
      'Largest-magnitude strike net GEX',
    );
  });

  // ── DB error ───────────────────────────────────────────────

  it('returns 500 on unexpected DB error and reports via Sentry', async () => {
    const { Sentry } = await import('../_lib/sentry.js');
    const { default: logger } = await import('../_lib/logger.js');

    const row = makeStrikeRow();
    mockUwFetch.mockResolvedValue([row]);

    // Make withRetry (which calls storeStrikeRows) propagate the error by
    // having the INSERT throw and also the QC SELECT throw so the outer try/catch fires.
    // We re-override withRetry for this test to propagate errors as the real impl would.
    const { withRetry } = await import('../_lib/api-helpers.js');
    vi.mocked(withRetry).mockImplementationOnce(async (fn) => {
      // first withRetry call = uwFetch — let it succeed
      return fn();
    });
    vi.mocked(withRetry).mockImplementationOnce(async () => {
      // second withRetry call = storeStrikeRows — throw
      throw new Error('DB connection lost');
    });

    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);

    expect(res._status).toBe(500);
    expect(res._json).toMatchObject({ error: 'Internal error' });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.setTag).toHaveBeenCalledWith(
      'cron.job',
      'fetch-greek-exposure-strike',
    );
    expect(logger.error).toHaveBeenCalled();
  });

  // ── Collision-day root evidence ────────────────────────────

  describe('collision-day root evidence', () => {
    /**
     * Route uwFetch by path: the strike-expiry fetch, the spot preflight,
     * and — on collision days only — the option-chains root-evidence call.
     * Omitting `chains` makes the option-chains call reject, which is the
     * evidence-unavailable case.
     */
    const stubUwFeeds = (
      strikeRows: ReturnType<typeof makeStrikeRow>[],
      chains?: string[],
    ) => {
      mockUwFetch.mockImplementation(async (_key: unknown, path: unknown) => {
        const p = String(path);
        if (p.includes('option-chains')) {
          if (!chains) throw new Error('option-chains unavailable');
          return chains;
        }
        if (p.includes('spot-exposures')) return [];
        return strikeRows;
      });
    };

    const optionChainsCalled = () =>
      mockUwFetch.mock.calls.some((call) =>
        String(call[1]).includes('option-chains'),
      );

    /** Capture the values bound to the (single) per-row INSERT template. */
    const captureInsertValues = () => {
      const captured: { values: unknown[] } = { values: [] };
      mockTransaction.mockImplementationOnce(
        async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
          const txnFn = (..._args: unknown[]) => {
            captured.values = _args.slice(1);
            return {};
          };
          const queries = fn(txnFn);
          return queries.map(() => [{ strike: '6800' }]);
        },
      );
      return captured;
    };

    const run = async () => {
      const req = mockRequest({
        method: 'GET',
        headers: { authorization: 'Bearer test-secret' },
      });
      const res = mockResponse();
      await handler(req, res);
      return res;
    };

    it('does not spend the option-chains call on a clean day', async () => {
      stubUwFeeds([makeStrikeRow()], ['SPXW260410C06800000']);
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

      const res = await run();

      expect(res._status).toBe(200);
      expect(optionChainsCalled()).toBe(false);
      expect(res._json).toMatchObject({
        rootEvidence: 'not_needed',
        meanCollisions: 0,
      });
    });

    it('sums a collision on a dual-root expiry without raising Sentry', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      stubUwFeeds(
        [
          makeStrikeRow('6800', '6105.1409', '-699.9181'),
          makeStrikeRow('6800', '2201.0002', '-699.9181'),
        ],
        // Both roots list the expiry → genuine AM/PM merge → sum.
        ['SPX260410P06800000', 'SPXW260410C06800000'],
      );
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);
      const captured = captureInsertValues();

      const res = await run();

      expect(res._status).toBe(200);
      expect(optionChainsCalled()).toBe(true);
      const summedCallGex = 6105.1409 + 2201.0002;
      expect(
        captured.values.some(
          (v) =>
            typeof v === 'string' &&
            Math.abs(Number.parseFloat(v) - summedCallGex) < 1e-6,
        ),
      ).toBe(true);
      expect(captured.values).toContain('sum');
      expect(captured.values).not.toContain('mean');
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(res._json).toMatchObject({
        dedupeRule: 'sum',
        rootEvidence: 'applied',
        meanCollisions: 0,
      });
    });

    it('keeps the plain warn for a near-identical pair under applied evidence', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      const { default: logger } = await import('../_lib/logger.js');
      stubUwFeeds(
        [
          makeStrikeRow('6800', '1000.0000', '-100.0000'),
          makeStrikeRow('6800', '1010.0000', '-100.0000'),
        ],
        // Both roots list the expiry, so the close pair is a confirmed AM/PM
        // merge that happens to be close — summed and warned, not escalated.
        ['SPX260410P06800000', 'SPXW260410C06800000'],
      );
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

      const res = await run();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        dedupeRule: 'sum',
        rootEvidence: 'applied',
        sumCollisions: 1,
        nearIdenticalCollisions: 0,
        meanCollisions: 0,
      });
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ rootEvidence: 'applied', collisions: 1 }),
        expect.stringContaining('resolved by named rule'),
      );
    });

    it('treats evidence that misses the collided expiry as unavailable', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      stubUwFeeds(
        [
          makeStrikeRow('6800', '1000.0000', '-100.0000'),
          makeStrikeRow('6800', '1010.0000', '-100.0000'),
        ],
        // The fetch resolves, but only with symbols for a different expiry —
        // it cannot say which rule 2026-04-10 needs, so it must not be used.
        ['SPXW260417C06800000', 'SPX260417P06800000'],
      );
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

      const res = await run();

      expect(res._status).toBe(200);
      expect(optionChainsCalled()).toBe(true);
      expect(res._json).toMatchObject({
        dedupeRule: 'sum',
        rootEvidence: 'unavailable',
        nearIdenticalCollisions: 1,
        meanCollisions: 0,
      });
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('doubled'),
        }),
      );
    });

    it('averages a collision on a single-root expiry and raises Sentry', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      const { default: logger } = await import('../_lib/logger.js');
      stubUwFeeds(
        [
          makeStrikeRow('6800', '1000.0000', '-100.0000'),
          makeStrikeRow('6800', '1010.0000', '-100.0000'),
        ],
        // Only the SPXW root lists the expiry → snapshot duplicate → mean.
        ['SPXW260410C06800000', 'SPXW260410P06800000'],
      );
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);
      const captured = captureInsertValues();

      const res = await run();

      expect(res._status).toBe(200);
      // (1000 + 1010) / 2, not their sum.
      expect(captured.values).toContain('1005');
      expect(captured.values).toContain('mean');
      expect(Sentry.captureException).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
      expect(res._json).toMatchObject({
        rootEvidence: 'applied',
        meanCollisions: 1,
      });
    });

    it('sums and raises the doubled-gamma alarm when evidence is unavailable', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      stubUwFeeds([
        makeStrikeRow('6800', '1000.0000', '-100.0000'),
        makeStrikeRow('6800', '1010.0000', '-100.0000'),
      ]); // option-chains rejects; the pair is ~1% apart
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

      const res = await run();

      expect(res._status).toBe(200);
      expect(optionChainsCalled()).toBe(true);
      expect(res._json).toMatchObject({
        dedupeRule: 'sum',
        rootEvidence: 'unavailable',
        nearIdenticalCollisions: 1,
        meanCollisions: 0,
      });
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('doubled'),
        }),
      );
    });

    it('keeps the plain warn for a structurally different pair without evidence', async () => {
      const { Sentry } = await import('../_lib/sentry.js');
      const { default: logger } = await import('../_lib/logger.js');
      stubUwFeeds([
        makeStrikeRow('6800', '1000.0000', '-100.0000'),
        makeStrikeRow('6800', '130.0000', '-100.0000'),
      ]); // option-chains rejects; the pair is ~87% apart — AM/PM shaped
      mockSql.mockResolvedValue([{ total: '1', nonzero: '1' }]);

      const res = await run();

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        dedupeRule: 'sum',
        rootEvidence: 'unavailable',
        nearIdenticalCollisions: 0,
        meanCollisions: 0,
      });
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ rootEvidence: 'unavailable' }),
        expect.stringContaining('resolved by named rule'),
      );
    });
  });
});
