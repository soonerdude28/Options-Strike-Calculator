// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

// `withDbRetry` is mocked to a thin passthrough so each `sql` template call
// resolves through our injected fn without paying the retry-cycle delay or
// trying to reach a real db. Tests pass a fresh mockSql per case via the
// public function signature.
vi.mock('../_lib/db.js', () => ({
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import type { NeonQueryFunction } from '@neondatabase/serverless';

import {
  E1_HOLD_BARS,
  E5_BREAKDOWN_PTS,
  PCS_MIN_NODES_FOR_PCTILE,
  PCS_SMALL_WALL_PCTILE,
  PERISCOPE_MAX_AGE_MIN,
  computeEsBasisChange5m,
  detectE1,
  detectE5,
  detectPcsMonday,
  findNearestCeilingAbove,
  findNearestFloorBelow,
  getConfidenceTier,
  getDomFromEtDateStr,
  getDowLabel,
  insertFire,
  loadDayContext,
  loadPositiveGammaNodes,
  loadPreDayFilter,
  loadRecentBars,
  smallWallCutoff,
  type Bar,
  type DayContext,
  type DetectorFire,
  type DowLabel,
  type GammaNode,
} from '../_lib/gamma-detector.js';

type Sql = NeonQueryFunction<false, false>;

/**
 * Build a mock `sql` tagged-template fn whose Nth invocation resolves with
 * the Nth fixture in `responses`. Calls past the end fall back to `[]` so a
 * test that mocks fewer rows than the production function queries still
 * fails predictably (returning empty data) rather than throwing.
 */
function makeMockSql(responses: unknown[]): {
  sql: Sql;
  mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn();
  for (const r of responses) mock.mockResolvedValueOnce(r);
  mock.mockResolvedValue([]);
  return { sql: mock as unknown as Sql, mock };
}

const makeBar = (overrides: Partial<Bar> = {}): Bar => ({
  timestamp: new Date('2026-05-21T14:00:00Z'),
  open: 7400,
  high: 7402,
  low: 7398,
  close: 7401,
  ...overrides,
});

const makeDayContext = (overrides: Partial<DayContext> = {}): DayContext => ({
  today: '2026-05-21',
  dow_label: 'Monday',
  day_open: 7400,
  prior_close: 7390,
  open_gap_pct: 0.27, // > FLAT_GAP threshold
  prior_5d_ret: -0.015,
  prior_iv_rank: 30,
  pre_day_filter_fires: true,
  is_fomc_day: false,
  is_dom_1_5: false,
  is_dom_16_20: false,
  ...overrides,
});

describe('gamma-detector helpers', () => {
  describe('getDowLabel', () => {
    it('returns Monday for a Monday ET date', () => {
      // 2026-05-25 is a Monday in NY
      const d = new Date('2026-05-25T14:00:00Z');
      expect(getDowLabel(d)).toBe('Monday');
    });

    it('returns Friday for a Friday ET date', () => {
      // 2026-05-22 is a Friday in NY
      const d = new Date('2026-05-22T14:00:00Z');
      expect(getDowLabel(d)).toBe('Friday');
    });

    it('returns null on Saturday and Sunday', () => {
      const sat = new Date('2026-05-23T14:00:00Z');
      const sun = new Date('2026-05-24T14:00:00Z');
      expect(getDowLabel(sat)).toBeNull();
      expect(getDowLabel(sun)).toBeNull();
    });
  });

  describe('getConfidenceTier', () => {
    it('returns MAXIMUM for Monday + pre-day filter', () => {
      expect(getConfidenceTier('Monday', true)).toBe('MAXIMUM');
    });

    it('returns HIGH for Monday without pre-day filter', () => {
      expect(getConfidenceTier('Monday', false)).toBe('HIGH');
    });

    it('returns HIGH for Friday regardless of pre-day filter', () => {
      expect(getConfidenceTier('Friday', false)).toBe('HIGH');
      expect(getConfidenceTier('Friday', true)).toBe('HIGH');
    });

    it('returns MEDIUM for Tuesday/Wednesday/Thursday', () => {
      const mids: DowLabel[] = ['Tuesday', 'Wednesday', 'Thursday'];
      for (const dow of mids) {
        expect(getConfidenceTier(dow, false)).toBe('MEDIUM');
        expect(getConfidenceTier(dow, true)).toBe('MEDIUM');
      }
    });
  });

  describe('getDomFromEtDateStr', () => {
    it('extracts day-of-month from ISO date string', () => {
      expect(getDomFromEtDateStr('2026-05-01')).toBe(1);
      expect(getDomFromEtDateStr('2026-05-15')).toBe(15);
      expect(getDomFromEtDateStr('2026-12-31')).toBe(31);
    });
  });

  describe('findNearestFloorBelow / findNearestCeilingAbove', () => {
    const nodes: GammaNode[] = [
      { strike: 7380, value: 100_000 },
      { strike: 7400, value: 500_000 },
      { strike: 7420, value: 300_000 },
      { strike: 7440, value: 150_000 },
    ];

    it('finds highest strike below price', () => {
      const found = findNearestFloorBelow(nodes, 7410);
      expect(found?.strike).toBe(7400);
    });

    it('finds lowest strike above price', () => {
      const found = findNearestCeilingAbove(nodes, 7410);
      expect(found?.strike).toBe(7420);
    });

    it('returns null when no node exists below', () => {
      expect(findNearestFloorBelow(nodes, 7370)).toBeNull();
    });

    it('returns null when no node exists above', () => {
      expect(findNearestCeilingAbove(nodes, 7450)).toBeNull();
    });

    it('excludes nodes at exactly the price (strict comparison)', () => {
      expect(findNearestFloorBelow(nodes, 7400)?.strike).toBe(7380);
      expect(findNearestCeilingAbove(nodes, 7420)?.strike).toBe(7440);
    });
  });
});

describe('detectE1 — long-call breakthrough', () => {
  const node: GammaNode = { strike: 7400, value: 300_000 };

  // Build HOLD_BARS+1 bars: breakthrough at index 0, then HOLD bars
  // all closing above the node strike.
  const validSequence = (): Bar[] => [
    makeBar({ open: 7395, high: 7402, low: 7394, close: 7401 }),
    makeBar({ open: 7401, high: 7404, low: 7400.5, close: 7403 }),
    makeBar({ open: 7403, high: 7405, low: 7402, close: 7404 }),
    makeBar({ open: 7404, high: 7406, low: 7402, close: 7405 }),
  ];

  it('fires when breakthrough + 3-bar hold matches', () => {
    expect(validSequence().length).toBe(E1_HOLD_BARS + 1);
    const hit = detectE1(validSequence(), [node]);
    expect(hit).not.toBeNull();
    expect(hit?.node.strike).toBe(7400);
  });

  it('does not fire when any hold bar closes back below node', () => {
    const bars = validSequence();
    bars[2] = makeBar({ ...bars[2], close: 7399 }); // dropped below node
    const hit = detectE1(bars, [node]);
    expect(hit).toBeNull();
  });

  it('does not fire when breakthrough bar opened ABOVE the node', () => {
    const bars = validSequence();
    bars[0] = makeBar({ open: 7401, high: 7405, low: 7400, close: 7404 });
    const hit = detectE1(bars, [node]);
    expect(hit).toBeNull();
  });

  it('returns null when insufficient bars', () => {
    expect(detectE1([], [node])).toBeNull();
    expect(detectE1([makeBar()], [node])).toBeNull();
  });

  it('returns null when no positive-gamma node exists', () => {
    const hit = detectE1(validSequence(), []);
    expect(hit).toBeNull();
  });
});

// E5 is disabled (returns null) — see api/_lib/gamma-detector.ts for the
// rationale. The 2026-05-23 backfill exposed forward-looking selection bias
// in the brainstorm's +8.95 result. These tests pin the disabled contract
// so a future reactivation must consciously update them. E5_BREAKDOWN_PTS
// is still exported (referenced here) so the surface stays stable for the
// eventual real-time rewrite.
describe('detectE5 — disabled (forward-looking selection bias)', () => {
  const node: GammaNode = { strike: 7400, value: 200_000 };

  it('exports E5_BREAKDOWN_PTS for future reactivation', () => {
    expect(E5_BREAKDOWN_PTS).toBe(1.0);
  });

  it('always returns null even on a textbook wick + breakdown pattern', () => {
    const bars: Bar[] = [
      makeBar({ open: 7405, high: 7406, low: 7404, close: 7405 }),
      makeBar({ open: 7405, high: 7405, low: 7398, close: 7402 }),
      makeBar({ open: 7402, high: 7403, low: 7400, close: 7401 }),
      makeBar({ open: 7401, high: 7402, low: 7398.5, close: 7399 }),
      makeBar({ open: 7399, high: 7400, low: 7396, close: 7397 }),
    ];
    expect(detectE5(bars, [node])).toBeNull();
  });

  it('returns null on empty bars and empty nodes', () => {
    expect(detectE5([], [])).toBeNull();
    expect(detectE5([makeBar()], [])).toBeNull();
    expect(detectE5([], [node])).toBeNull();
  });
});

// ============================================================
// SMALL-WALL QUANTILE HELPER
// ============================================================

describe('smallWallCutoff', () => {
  it('returns null for an empty sample (no quantile of nothing)', () => {
    expect(smallWallCutoff([], 0.15)).toBeNull();
  });

  it('returns null when every value is non-finite', () => {
    expect(
      smallWallCutoff(
        [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        0.5,
      ),
    ).toBeNull();
  });

  it('returns the sole value for a single-element sample, any pctile', () => {
    expect(smallWallCutoff([42], 0)).toBe(42);
    expect(smallWallCutoff([42], 0.15)).toBe(42);
    expect(smallWallCutoff([42], 1)).toBe(42);
  });

  it('lands exactly on an order statistic when the index is integral', () => {
    // n=5 → idx = p * 4. p=0.5 → idx 2 → sorted[2].
    expect(smallWallCutoff([0, 10, 20, 30, 40], 0.5)).toBe(20);
    expect(smallWallCutoff([0, 10, 20, 30, 40], 0.25)).toBe(10);
  });

  it('interpolates linearly between bracketing order statistics', () => {
    // n=5 → idx = 0.15 * 4 = 0.6 → sorted[0] + (sorted[1]-sorted[0])*0.6
    expect(smallWallCutoff([0, 10, 20, 30, 40], 0.15)).toBeCloseTo(6, 10);
    // n=4 → idx = 0.5 * 3 = 1.5 → midpoint of 2 and 3. This is the case
    // that distinguishes percentile_cont (2.5) from a discrete
    // percentile_disc (3) — pinning it keeps us aligned with the SQL
    // PERCENTILE_CONT used elsewhere in the codebase.
    expect(smallWallCutoff([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
  });

  it('returns min at p=0 and max at p=1', () => {
    expect(smallWallCutoff([5, 1, 9, 3], 0)).toBe(1);
    expect(smallWallCutoff([5, 1, 9, 3], 1)).toBe(9);
  });

  it('clamps out-of-range pctiles instead of indexing out of bounds', () => {
    expect(smallWallCutoff([5, 1, 9, 3], -1)).toBe(1);
    expect(smallWallCutoff([5, 1, 9, 3], 2)).toBe(9);
  });

  it('sorts numerically, not lexicographically', () => {
    // Default Array.sort() would order these as 100, 1000, 9 and return
    // 1000 as the median. Numeric sort gives 9, 100, 1000 → 100.
    expect(smallWallCutoff([1000, 9, 100], 0.5)).toBe(100);
  });

  it('accepts unsorted input without mutating the caller array', () => {
    const input = [30, 0, 20, 40, 10];
    expect(smallWallCutoff(input, 0.5)).toBe(20);
    expect(input).toEqual([30, 0, 20, 40, 10]);
  });

  it('drops non-finite values rather than poisoning the sort', () => {
    expect(
      smallWallCutoff(
        [Number.NaN, 0, 10, 20, 30, 40, Number.POSITIVE_INFINITY],
        0.5,
      ),
    ).toBe(20);
  });

  it('is scale-equivariant: cutoff(k*x) === k*cutoff(x)', () => {
    const xs = [3, 1, 4, 1, 5, 9, 2, 6];
    const base = smallWallCutoff(xs, PCS_SMALL_WALL_PCTILE) as number;
    for (const k of [1e-3, 2, 1e3, 1e6]) {
      expect(
        smallWallCutoff(
          xs.map((x) => x * k),
          PCS_SMALL_WALL_PCTILE,
        ),
      ).toBeCloseTo(base * k, 6);
    }
  });
});

describe('detectPcsMonday', () => {
  // Filler nodes sit at strikes 7300–7380, far below the wick window
  // (7398, 7402), so they can never satisfy the wick geometry — they
  // exist only to give the slice a realistic value distribution for the
  // within-slice quantile. Sorted filler values:
  //   1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8, 5e8
  const FILLER_VALUES = [1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8, 5e8];

  /**
   * Build a 10-node slice: the node under test at strike 7400 plus the
   * nine fillers, every value multiplied by `scale` (used by the
   * scale-invariance test).
   */
  const makeSlice = (targetValue: number, scale = 1): GammaNode[] => [
    { strike: 7400, value: targetValue * scale },
    ...FILLER_VALUES.map((v, i) => ({
      strike: 7300 + i * 10,
      value: v * scale,
    })),
  ];

  // With the 10-node slice below, idx = 0.15 * 9 = 1.35, so the cutoff
  // interpolates 35% of the way from sorted[1] to sorted[2].
  //   SMALL: sorted = [2e5, 1e6, 2e6, ...] → cutoff = 1.35e6, 2e5 passes.
  //   BIG:   sorted = [1e6, 2e6, 3e6, ...] → cutoff = 2.35e6, 3e6 fails.
  const SMALL_WALL = 200_000;
  const BIG_WALL = 3_000_000;

  const wickBar = makeBar({
    open: 7405,
    high: 7406,
    low: 7398,
    close: 7402, // wick pierces 7400 floor and closes back above
  });

  it('fires on Monday with small wall + ES basis + non-flat gap', () => {
    const ctx = makeDayContext({ dow_label: 'Monday', open_gap_pct: 0.5 });
    const hit = detectPcsMonday([wickBar], makeSlice(SMALL_WALL), ctx, 1.0);
    expect(hit).not.toBeNull();
    expect(hit?.node.strike).toBe(7400);
    expect(hit?.node.value).toBe(SMALL_WALL);
  });

  it('does not fire on Tuesday', () => {
    const ctx = makeDayContext({ dow_label: 'Tuesday' });
    expect(
      detectPcsMonday([wickBar], makeSlice(SMALL_WALL), ctx, 1.0),
    ).toBeNull();
  });

  it('does not fire on flat-gap day', () => {
    const ctx = makeDayContext({ open_gap_pct: 0.05 });
    expect(
      detectPcsMonday([wickBar], makeSlice(SMALL_WALL), ctx, 1.0),
    ).toBeNull();
  });

  it('does not fire when ES basis is weak', () => {
    const ctx = makeDayContext();
    expect(
      detectPcsMonday([wickBar], makeSlice(SMALL_WALL), ctx, -0.1),
    ).toBeNull();
  });

  it('fires when ES basis is null (passthrough — basis filter skipped)', () => {
    const ctx = makeDayContext();
    expect(
      detectPcsMonday([wickBar], makeSlice(SMALL_WALL), ctx, null),
    ).not.toBeNull();
  });

  it('does not fire on a bar whose range is below MIN_WICK_RANGE_PTS', () => {
    const ctx = makeDayContext();
    const tightBar = makeBar({
      open: 7401,
      high: 7401.5,
      low: 7399.5,
      close: 7400.5, // pierces 7400 but range is only 2pt
    });
    expect(
      detectPcsMonday([tightBar], makeSlice(SMALL_WALL), ctx, 1.0),
    ).toBeNull();
  });

  it('does not fire on empty bars or an empty node slice', () => {
    const ctx = makeDayContext();
    expect(detectPcsMonday([], makeSlice(SMALL_WALL), ctx, 1.0)).toBeNull();
    expect(detectPcsMonday([wickBar], [], ctx, 1.0)).toBeNull();
  });

  // --- within-slice quantile gate -------------------------------------

  it('rejects a node ABOVE the slice p15 and fires on one BELOW it', () => {
    const ctx = makeDayContext();
    const small = makeSlice(SMALL_WALL);
    const big = makeSlice(BIG_WALL);

    // Sanity-check the fixture against the helper so the test documents
    // WHY these two values straddle the gate rather than asserting on
    // magic numbers.
    const smallCutoff = smallWallCutoff(
      small.map((n) => n.value),
      PCS_SMALL_WALL_PCTILE,
    ) as number;
    const bigCutoff = smallWallCutoff(
      big.map((n) => n.value),
      PCS_SMALL_WALL_PCTILE,
    ) as number;
    expect(SMALL_WALL).toBeLessThanOrEqual(smallCutoff);
    expect(BIG_WALL).toBeGreaterThan(bigCutoff);

    expect(detectPcsMonday([wickBar], small, ctx, 1.0)).not.toBeNull();
    expect(detectPcsMonday([wickBar], big, ctx, 1.0)).toBeNull();
  });

  it('fires on a node sitting exactly ON the cutoff (inclusive <=)', () => {
    const ctx = makeDayContext();
    // Uniform slice → every quantile equals the common value, so the
    // target is exactly at the cutoff. Inclusive comparison must fire.
    const uniform: GammaNode[] = [
      { strike: 7400, value: 1e6 },
      { strike: 7300, value: 1e6 },
      { strike: 7310, value: 1e6 },
      { strike: 7320, value: 1e6 },
      { strike: 7330, value: 1e6 },
    ];
    expect(detectPcsMonday([wickBar], uniform, ctx, 1.0)).not.toBeNull();
  });

  // --- degenerate-sample guard ----------------------------------------

  it('exports PCS_MIN_NODES_FOR_PCTILE and PCS_SMALL_WALL_PCTILE', () => {
    expect(PCS_MIN_NODES_FOR_PCTILE).toBe(5);
    expect(PCS_SMALL_WALL_PCTILE).toBe(0.15);
  });

  it('does not fire below PCS_MIN_NODES_FOR_PCTILE, even on a tiny wall', () => {
    const ctx = makeDayContext();
    // Same geometry that fires with a full slice — only the sample size
    // differs. A p15 over <5 points is an interpolation between two
    // arbitrary observations, so we decline rather than guess.
    for (let n = 1; n < PCS_MIN_NODES_FOR_PCTILE; n += 1) {
      const slice = makeSlice(SMALL_WALL).slice(0, n);
      expect(slice).toHaveLength(n);
      expect(detectPcsMonday([wickBar], slice, ctx, 1.0)).toBeNull();
    }
  });

  it('fires at exactly PCS_MIN_NODES_FOR_PCTILE nodes (boundary is >=)', () => {
    const ctx = makeDayContext();
    const slice = makeSlice(SMALL_WALL).slice(0, PCS_MIN_NODES_FOR_PCTILE);
    expect(slice).toHaveLength(5);
    expect(detectPcsMonday([wickBar], slice, ctx, 1.0)).not.toBeNull();
  });

  // --- SCALE INVARIANCE (regression guard for the whole bug class) -----

  it('is SCALE-INVARIANT: multiplying every node value by 1000 (or any positive constant) changes no decision', () => {
    const ctx = makeDayContext();

    // This is the regression guard for the GEXBot→UW class of bug: an
    // absolute dollar cutoff silently changed meaning when the feed's
    // units changed. A within-slice quantile cannot, because the cutoff
    // scales with the data. If someone reintroduces an absolute
    // threshold anywhere in this gate, this test fails.
    for (const scale of [1e-6, 1e-3, 0.5, 1, 2, 1e3, 1e6, 1e9]) {
      const smallHit = detectPcsMonday(
        [wickBar],
        makeSlice(SMALL_WALL, scale),
        ctx,
        1.0,
      );
      const bigHit = detectPcsMonday(
        [wickBar],
        makeSlice(BIG_WALL, scale),
        ctx,
        1.0,
      );
      // Small wall fires at every scale; big wall never does.
      expect(smallHit, `small wall @ scale ${scale}`).not.toBeNull();
      expect(smallHit?.node.strike).toBe(7400);
      expect(smallHit?.node.value).toBeCloseTo(SMALL_WALL * scale, 6);
      expect(bigHit, `big wall @ scale ${scale}`).toBeNull();
    }
  });

  it('is scale-invariant even at the 1000x gap that broke the old constant', () => {
    // The repoint moved gamma between two feeds ~1000x apart in units
    // (normalized greek-exposure vs raw-dollar spot-exposures). Assert
    // the exact 1000x pair explicitly, not just as one loop iteration.
    const ctx = makeDayContext();
    const at1x = detectPcsMonday([wickBar], makeSlice(SMALL_WALL, 1), ctx, 1.0);
    const at1000x = detectPcsMonday(
      [wickBar],
      makeSlice(SMALL_WALL, 1000),
      ctx,
      1.0,
    );
    expect(at1x).not.toBeNull();
    expect(at1000x).not.toBeNull();
    expect(at1000x?.node.strike).toBe(at1x?.node.strike);

    const bigAt1x = detectPcsMonday(
      [wickBar],
      makeSlice(BIG_WALL, 1),
      ctx,
      1.0,
    );
    const bigAt1000x = detectPcsMonday(
      [wickBar],
      makeSlice(BIG_WALL, 1000),
      ctx,
      1.0,
    );
    expect(bigAt1x).toBeNull();
    expect(bigAt1000x).toBeNull();
  });
});

// ============================================================
// DB LOADERS
// ============================================================

describe('loadRecentBars', () => {
  it('reverses DESC SQL output into chronological ASC bars', async () => {
    // SQL returns newest-first; loader should walk back so the output is
    // oldest-first. Three rows in mixed numeric/string column types
    // (Neon serializes numerics as strings).
    const { sql, mock } = makeMockSql([
      [
        {
          timestamp: '2026-05-21T14:02:00Z',
          open: '7402',
          high: 7404,
          low: '7400',
          close: 7403,
        },
        {
          timestamp: '2026-05-21T14:01:00Z',
          open: '7401',
          high: 7403,
          low: '7399',
          close: 7402,
        },
        {
          timestamp: '2026-05-21T14:00:00Z',
          open: '7400',
          high: 7402,
          low: '7398',
          close: 7401,
        },
      ],
    ]);

    const bars = await loadRecentBars(sql, '2026-05-21');

    expect(mock).toHaveBeenCalledOnce();
    expect(bars).toHaveLength(3);
    expect(bars[0]?.timestamp.toISOString()).toBe('2026-05-21T14:00:00.000Z');
    expect(bars[2]?.timestamp.toISOString()).toBe('2026-05-21T14:02:00.000Z');
    // Strings coerced to numbers.
    expect(bars[0]?.open).toBe(7400);
    expect(typeof bars[0]?.high).toBe('number');
  });

  it('returns empty array when SQL returns no rows', async () => {
    const { sql } = makeMockSql([[]]);
    const bars = await loadRecentBars(sql, '2026-05-21');
    expect(bars).toEqual([]);
  });

  it('skips null rows defensively (driver-edge sparse arrays)', async () => {
    const { sql } = makeMockSql([
      [
        null,
        {
          timestamp: '2026-05-21T14:00:00Z',
          open: 7400,
          high: 7402,
          low: 7398,
          close: 7401,
        },
      ],
    ]);
    const bars = await loadRecentBars(sql, '2026-05-21');
    expect(bars).toHaveLength(1);
    expect(bars[0]?.close).toBe(7401);
  });
});

describe('loadPositiveGammaNodes', () => {
  it('coerces numeric strings and returns the rows verbatim', async () => {
    const { sql, mock } = makeMockSql([
      [
        { strike: 7380, value: '150000' },
        { strike: 7400, value: 500_000 },
        { strike: '7420', value: '300000.5' },
      ],
    ]);

    const nodes = await loadPositiveGammaNodes(sql, '2026-05-21');

    expect(mock).toHaveBeenCalledOnce();
    expect(nodes).toEqual([
      { strike: 7380, value: 150_000 },
      { strike: 7400, value: 500_000 },
      { strike: 7420, value: 300_000.5 },
    ]);
  });

  it('returns empty list when no fresh snapshot exists', async () => {
    const { sql } = makeMockSql([[]]);
    const nodes = await loadPositiveGammaNodes(sql, '2026-05-21');
    expect(nodes).toEqual([]);
  });

  it('pins the outer read AND the MAX(captured_at) subquery to uw_spot', async () => {
    // Migration #191: node values are diffed slice-over-slice and the
    // small-wall gate is a WITHIN-SLICE quantile, so mixing sources
    // would blend two unit systems into one distribution. The
    // normalized uw_eod backfill must never satisfy this read —
    // including inside the subquery, where a 15:00 CT backfill row
    // would otherwise win MAX(captured_at) and hand the detector a
    // stale one-slice-per-day board.
    const { sql, mock } = makeMockSql([[]]);
    await loadPositiveGammaNodes(sql, '2026-05-21');
    const [strings, ...params] = mock.mock.calls[0] as [string[], ...unknown[]];
    const text = strings.join('?');
    expect(text.match(/source = /g) ?? []).toHaveLength(2);
    expect(params.filter((p) => p === 'uw_spot')).toHaveLength(2);
    expect(params).not.toContain('uw_eod');
    expect(params).not.toContain('gexbot');
  });

  it('exports PERISCOPE_MAX_AGE_MIN so a future loosening of the freshness window is a one-line change', () => {
    // Captures the constant in test scope so a regression in the SQL
    // freshness window (e.g. someone dropping the NOW() - INTERVAL clause)
    // would also need to flip this constant — making intent traceable.
    expect(PERISCOPE_MAX_AGE_MIN).toBe(15);
  });
});

describe('loadPreDayFilter', () => {
  it('computes 5-day return from oldest-of-6 vs newest, plus prior iv_rank', async () => {
    // closes (newest-first per SQL): 7400, 7390, 7380, 7370, 7360, 7350
    // 5d return = (7400 - 7350) / 7350 = +0.006802...
    const { sql } = makeMockSql([
      [
        { day_close: '7400' },
        { day_close: '7390' },
        { day_close: '7380' },
        { day_close: '7370' },
        { day_close: '7360' },
        { day_close: '7350' },
      ],
      [{ date: '2026-05-20', iv_rank: '42.5' }],
    ]);

    const out = await loadPreDayFilter(sql, '2026-05-21');

    expect(out.prior_5d_ret).toBeCloseTo((7400 - 7350) / 7350, 6);
    expect(out.prior_iv_rank).toBe(42.5);
  });

  it('returns null prior_5d_ret when fewer than 6 closing rows available', async () => {
    const { sql } = makeMockSql([
      [{ day_close: 7400 }, { day_close: 7390 }, { day_close: 7380 }],
      [{ date: '2026-05-20', iv_rank: 20 }],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_5d_ret).toBeNull();
    expect(out.prior_iv_rank).toBe(20);
  });

  it('returns null prior_5d_ret when oldest close is zero (defensive divide-by-zero guard)', async () => {
    const { sql } = makeMockSql([
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 0 },
      ],
      [{ date: '2026-05-20', iv_rank: 20 }],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_5d_ret).toBeNull();
  });

  it('returns null prior_iv_rank when vol_realized has no recent row', async () => {
    const { sql } = makeMockSql([
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 7350 },
      ],
      [],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_iv_rank).toBeNull();
  });

  it('returns null prior_iv_rank when iv_rank column is null', async () => {
    const { sql } = makeMockSql([
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 7350 },
      ],
      [{ date: '2026-05-20', iv_rank: null }],
    ]);
    const out = await loadPreDayFilter(sql, '2026-05-21');
    expect(out.prior_iv_rank).toBeNull();
  });
});

describe('loadDayContext', () => {
  // 2026-05-25 is a Monday in NY. Day-of-month is 25, so neither
  // is_dom_1_5 nor is_dom_16_20 should fire.
  const REFERENCE_TIME = new Date('2026-05-25T14:00:00Z');

  it('assembles full context: open, gap, dow, pre-day filter, DOM flags', async () => {
    const { sql } = makeMockSql([
      // todayOpenRows
      [{ day_open: 7405 }],
      // priorCloseRows
      [{ day_close: 7400 }],
      // loadPreDayFilter → close rows (6)
      [
        { day_close: 7400 },
        { day_close: 7390 },
        { day_close: 7380 },
        { day_close: 7370 },
        { day_close: 7360 },
        { day_close: 7300 }, // oldest
      ],
      // loadPreDayFilter → iv rows
      [{ date: '2026-05-22', iv_rank: 30 }],
    ]);

    const ctx = await loadDayContext(sql, REFERENCE_TIME);

    expect(ctx.today).toBe('2026-05-25');
    expect(ctx.dow_label).toBe('Monday');
    expect(ctx.day_open).toBe(7405);
    expect(ctx.prior_close).toBe(7400);
    expect(ctx.open_gap_pct).toBeCloseTo(((7405 - 7400) / 7400) * 100, 6);
    // 5d return = (7400 - 7300) / 7300 = +0.013...  > -0.01, so pre-day
    // filter does NOT fire (it requires <-0.01 AND iv_rank>25).
    expect(ctx.pre_day_filter_fires).toBe(false);
    expect(ctx.is_fomc_day).toBe(false);
    expect(ctx.is_dom_1_5).toBe(false);
    expect(ctx.is_dom_16_20).toBe(false);
  });

  it('marks pre_day_filter_fires when prior_5d < -1% AND iv_rank > 25', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7300 }],
      [{ day_close: 7400 }],
      [
        { day_close: 7300 },
        { day_close: 7350 },
        { day_close: 7380 },
        { day_close: 7420 },
        { day_close: 7440 },
        { day_close: 7450 }, // oldest = 7450, newest = 7300 → -2% 5d ret
      ],
      [{ date: '2026-05-22', iv_rank: 40 }],
    ]);

    const ctx = await loadDayContext(sql, REFERENCE_TIME);
    expect(ctx.prior_5d_ret).toBeLessThan(-0.01);
    expect(ctx.prior_iv_rank).toBe(40);
    expect(ctx.pre_day_filter_fires).toBe(true);
  });

  it('open_gap_pct is 0 when prior_close is 0 (defensive)', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7405 }],
      [{ day_close: 0 }],
      [],
      [],
    ]);
    const ctx = await loadDayContext(sql, REFERENCE_TIME);
    expect(ctx.open_gap_pct).toBe(0);
  });

  it('passes isFomcDay through from caller opts', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7400 }],
      [{ day_close: 7400 }],
      [],
      [],
    ]);
    const ctx = await loadDayContext(sql, REFERENCE_TIME, { isFomcDay: true });
    expect(ctx.is_fomc_day).toBe(true);
  });

  it('flags is_dom_1_5 for early-month dates', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7400 }],
      [{ day_close: 7400 }],
      [],
      [],
    ]);
    // 2026-05-04 is a Monday + DOM 4 → should hit is_dom_1_5
    const ctx = await loadDayContext(sql, new Date('2026-05-04T14:00:00Z'));
    expect(ctx.is_dom_1_5).toBe(true);
    expect(ctx.is_dom_16_20).toBe(false);
  });

  it('flags is_dom_16_20 for mid-month dates', async () => {
    const { sql } = makeMockSql([
      [{ day_open: 7400 }],
      [{ day_close: 7400 }],
      [],
      [],
    ]);
    // 2026-05-18 is DOM 18 → should hit is_dom_16_20
    const ctx = await loadDayContext(sql, new Date('2026-05-18T14:00:00Z'));
    expect(ctx.is_dom_1_5).toBe(false);
    expect(ctx.is_dom_16_20).toBe(true);
  });
});

describe('computeEsBasisChange5m', () => {
  const REFERENCE_TIME = new Date('2026-05-25T14:30:00Z');

  it('returns the ES-vs-SPX delta when both series have 6 bars', async () => {
    // esNow.close - esThen.close = 7402 - 7400 = +2
    // spxNow.close - spxThen.close = 7401 - 7400 = +1
    // basis change = esDelta - spxDelta = +1
    const { sql } = makeMockSql([
      [
        { close: 7402 }, // newest (idx 0)
        { close: 7401.8 },
        { close: 7401.5 },
        { close: 7401 },
        { close: 7400.5 },
        { close: 7400 }, // oldest (idx 5)
      ],
      [
        { close: 7401 },
        { close: 7400.8 },
        { close: 7400.5 },
        { close: 7400 },
        { close: 7400.2 },
        { close: 7400 },
      ],
    ]);

    const basis = await computeEsBasisChange5m(sql, REFERENCE_TIME);
    expect(basis).toBeCloseTo(1, 6);
  });

  it('returns null when ES has fewer than 6 bars (sidecar gap)', async () => {
    const { sql } = makeMockSql([
      [{ close: 7402 }, { close: 7401 }, { close: 7400 }], // only 3
      [
        { close: 7401 },
        { close: 7400.8 },
        { close: 7400.5 },
        { close: 7400 },
        { close: 7400.2 },
        { close: 7400 },
      ],
    ]);

    const basis = await computeEsBasisChange5m(sql, REFERENCE_TIME);
    expect(basis).toBeNull();
  });

  it('returns null when SPX has fewer than 6 bars (RTH-gate transitions)', async () => {
    const { sql } = makeMockSql([
      [
        { close: 7402 },
        { close: 7401.8 },
        { close: 7401.5 },
        { close: 7401 },
        { close: 7400.5 },
        { close: 7400 },
      ],
      [], // SPX dry
    ]);

    const basis = await computeEsBasisChange5m(sql, REFERENCE_TIME);
    expect(basis).toBeNull();
  });

  it('defaults referenceTime to NOW() when no arg passed', async () => {
    const { sql } = makeMockSql([
      [
        { close: 7402 },
        { close: 7401 },
        { close: 7401 },
        { close: 7401 },
        { close: 7400 },
        { close: 7400 },
      ],
      [
        { close: 7401 },
        { close: 7401 },
        { close: 7401 },
        { close: 7400 },
        { close: 7400 },
        { close: 7400 },
      ],
    ]);
    // Just confirm it doesn't throw — the value asserts the contract that
    // the default referenceTime doesn't break the SQL template.
    const basis = await computeEsBasisChange5m(sql);
    expect(basis).toBeCloseTo(1, 6);
  });
});

describe('insertFire', () => {
  const makeFire = (overrides: Partial<DetectorFire> = {}): DetectorFire => ({
    fired_at: new Date('2026-05-25T15:00:00Z'),
    signal_type: 'e1_long_call',
    dow_label: 'Monday',
    confidence_tier: 'HIGH',
    spot_at_fire: 7401,
    node_strike: 7400,
    node_gex: 300_000,
    bar_open: 7395,
    bar_high: 7402,
    bar_low: 7394,
    bar_close: 7401,
    bar_range: 8,
    es_basis_change_5m: 1.0,
    prior_5d_ret: -0.012,
    prior_iv_rank: 32,
    pre_day_filter_fires: true,
    open_gap_pct: 0.4,
    is_fomc_day: false,
    is_dom_1_5: false,
    is_dom_16_20: false,
    ...overrides,
  });

  it('returns true when INSERT returns a row (new fire persisted)', async () => {
    const { sql, mock } = makeMockSql([[{ id: 42 }]]);
    const inserted = await insertFire(sql, makeFire());
    expect(inserted).toBe(true);
    expect(mock).toHaveBeenCalledOnce();
  });

  it('returns false when ON CONFLICT DO NOTHING skipped the insert', async () => {
    // Idempotency contract: the unique key (fired_at, signal_type, node_strike)
    // collides → INSERT … RETURNING id returns zero rows.
    const { sql } = makeMockSql([[]]);
    const inserted = await insertFire(sql, makeFire());
    expect(inserted).toBe(false);
  });
});
