// @vitest-environment node

/**
 * Regression: monthly OPEX silently overwrote per-strike Greek exposure.
 *
 * UW's `/stock/{t}/greek-exposure/strike-expiry` returns the AM-settled and
 * PM-settled series merged into one array with **no discriminator field**.
 * Confirmed by UW staff 2026-08-21, and reproduced against the live API on
 * 2026-08-25:
 *
 *     date=2026-08-21 (monthly OPEX) → 1090 rows, 590 unique (expiry, strike),
 *                                       500 duplicated keys, 293 of them
 *                                       carrying DIFFERENT greeks
 *     date=2026-08-20 (non-OPEX)     →  261 rows, 261 unique keys, 0 duplicates
 *
 * `greek_exposure_strike` is keyed `UNIQUE (date, expiry, strike)` and the
 * cron writes with `ON CONFLICT ... DO UPDATE`, so the second row of each pair
 * overwrote the first. Nothing raised: both statements returned a row, so the
 * cron counted two `stored` where one row existed, and the day looked healthy.
 *
 * The test asserts the property that was violated — **the ingestion must not
 * hand the database two rows that collapse into one** — because that is the
 * boundary this code controls. Whether Postgres then overwrites is not in
 * question; it is documented behaviour of the constraint.
 *
 * Two expiries are used deliberately, per the fix's requirement that expiry
 * survive as a key in its own right: the nearest monthly OPEX (2026-09-18)
 * carrying the duplicate, and a non-OPEX expiry (2026-09-17) that must pass
 * through untouched. A fix that deduplicated by date bucket, by DTE, or by an
 * "is OPEX" label rather than by expiry would pass the first assertion and
 * fail the second.
 */

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

const { mockUwFetch, mockCronGuard, mockCheckDataQuality, mockLogger } =
  vi.hoisted(() => ({
    mockUwFetch: vi.fn(),
    mockCronGuard: vi.fn(),
    mockCheckDataQuality: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));

vi.mock('../_lib/logger.js', () => ({ default: mockLogger }));

vi.mock('../_lib/api-helpers.js', () => ({
  uwFetch: mockUwFetch,
  cronGuard: mockCronGuard,
  checkDataQuality: mockCheckDataQuality,
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

import handler from '../cron/fetch-greek-exposure-strike.js';

// ── Fixture: the shape the vendor actually returns ───────────

const OPEX_EXPIRY = '2026-09-18'; // third Friday — AM and PM series coexist
const NON_OPEX_EXPIRY = '2026-09-17'; // Thursday — one series only
const TRADE_DATE = '2026-09-17';

/** A vendor row. Note the payload has no root/settlement/option_type field. */
const vendorRow = (
  expiry: string,
  strike: string,
  callGex: string,
  callDelta: string,
) => ({
  date: TRADE_DATE,
  expiry,
  strike,
  dte: expiry === TRADE_DATE ? 0 : 1,
  call_gex: callGex,
  put_gex: '-699.9181',
  call_delta: callDelta,
  put_delta: '-75428.0846',
  call_charm: '-1025514.4594',
  put_charm: '-117569.0952',
  call_vanna: '165653.1431',
  put_vanna: '18991.1969',
});

/**
 * Two expiries. The OPEX one carries the AM/PM collision at strike 6800 —
 * same (date, expiry, strike), different greeks — exactly as observed live.
 */
const PAYLOAD = [
  vendorRow(OPEX_EXPIRY, '6800', '6105.1409', '394699.3301'), // AM series
  vendorRow(OPEX_EXPIRY, '6800', '2201.0002', '11122.2222'), // PM series
  vendorRow(OPEX_EXPIRY, '6850', '3000.0000', '50000.0000'),
  vendorRow(NON_OPEX_EXPIRY, '6800', '4444.4444', '60000.0000'),
  vendorRow(NON_OPEX_EXPIRY, '6850', '5555.5555', '70000.0000'),
];

const GUARD = { apiKey: 'test-uw-key', today: TRADE_DATE };

/** Values bound to each INSERT, in the cron's declared column order. */
interface Insert {
  date: unknown;
  expiry: unknown;
  strike: unknown;
  callGex: unknown;
}

describe('regression: monthly OPEX overwrite in greek_exposure_strike', () => {
  let inserts: Insert[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    inserts = [];
    mockCronGuard.mockReturnValue(GUARD);
    mockUwFetch.mockResolvedValue(PAYLOAD);
    mockSql.mockResolvedValue([{ total: '5', nonzero: '5' }]);
    mockSql.transaction = mockTransaction;
    mockTransaction.mockImplementation(
      async (fn: (txn: (...args: unknown[]) => unknown) => unknown[]) => {
        const txnFn = (..._args: unknown[]) => {
          const values = _args.slice(1);
          inserts.push({
            date: values[0],
            expiry: values[1],
            strike: values[2],
            callGex: values[4],
          });
          return {};
        };
        const queries = fn(txnFn);
        return queries.map(() => [{ strike: '6800' }]);
      },
    );
    mockCheckDataQuality.mockResolvedValue(undefined);
  });

  async function run() {
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    });
    const res = mockResponse();
    await handler(req, res);
    return res;
  }

  it('never hands the database two rows that collapse under its own key', async () => {
    await run();

    const keys = inserts.map((i) => `${i.date}|${i.expiry}|${i.strike}`);
    const collapsed = keys.filter((k, i) => keys.indexOf(k) !== i);

    // Before the fix this failed with one collapsed key: the AM and PM rows
    // for 2026-09-18 @ 6800 were both sent, and ON CONFLICT DO UPDATE kept
    // whichever arrived last — discarding the other series entirely.
    expect(collapsed).toEqual([]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every expiry distinct rather than bucketing by date or DTE', async () => {
    await run();

    const expiries = new Set(inserts.map((i) => i.expiry));
    expect(expiries).toEqual(new Set([OPEX_EXPIRY, NON_OPEX_EXPIRY]));

    // The non-OPEX expiry has no collision and must survive byte-for-byte:
    // a fix that deduplicated by date bucket or by an "is OPEX" label would
    // damage this row while appearing to fix the other.
    const untouched = inserts.filter((i) => i.expiry === NON_OPEX_EXPIRY);
    expect(untouched).toHaveLength(2);
    expect(untouched.map((i) => String(i.callGex)).sort()).toEqual(
      ['4444.4444', '5555.5555'].sort(),
    );
  });

  it('does not silently discard the second series of a collided strike', async () => {
    await run();

    const collided = inserts.filter(
      (i) => i.expiry === OPEX_EXPIRY && i.strike === '6800',
    );
    expect(collided).toHaveLength(1);

    // Under the documented `sum` rule both series are retained by addition;
    // the old behaviour kept exactly one of 6105.1409 / 2201.0002 and threw
    // the other away, which is the data loss this regression exists for.
    expect(Number(collided[0]!.callGex)).toBeCloseTo(6105.1409 + 2201.0002, 4);
  });

  it('reports the collision instead of resolving it silently', async () => {
    const res = await run();

    expect(res._json).toMatchObject({ collisions: 1, dedupeRule: 'sum' });
    const logged = mockLogger.warn.mock.calls.some(([arg]) =>
      JSON.stringify(arg ?? '').includes('collision'),
    );
    expect(logged).toBe(true);
  });
});
