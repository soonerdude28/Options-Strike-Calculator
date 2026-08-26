// @vitest-environment node

/**
 * Rules that keep per-strike greek exposure honest.
 *
 * The before/after fixture below is modelled on the real vendor response for
 * 2026-08-21 (a monthly OPEX) and 2026-08-20 (not), sampled live on
 * 2026-08-25 — see the header of gex-strike-integrity.ts for the counts.
 */

import { describe, it, expect } from 'vitest';

import {
  AGGREGATION_MODES,
  TRUSTED_STRIKE_ROW_SQL,
  isTrustedStrikeRow,
  DEFAULT_AGGREGATION_MODE,
  DEFAULT_DEDUPE_RULE,
  DuplicateStrikeRowsError,
  GEX_STRIKE_SPEC_VERSION,
  NEAR_IDENTICAL_REL_DIFF,
  assessSpotFreshness,
  dedupeStrikeRows,
  isOpexExpiry,
  reconcileExpiryTotals,
  selectByMode,
} from '../_lib/gex-strike-integrity.js';

// ── Fixture: before ──────────────────────────────────────────

const OPEX = '2026-09-18';
const NON_OPEX = '2026-09-17';

const row = (
  expiry: string,
  strike: string,
  callGex: string,
  putGex = '-100.0000',
) => ({
  date: NON_OPEX,
  expiry,
  strike,
  dte: 1,
  call_gex: callGex,
  put_gex: putGex,
  call_delta: '1000.0000',
  put_delta: '-500.0000',
  call_charm: '10.0000',
  put_charm: '-5.0000',
  call_vanna: '20.0000',
  put_vanna: '-10.0000',
});

/** Exactly what the vendor sends on an OPEX date: the key repeats. */
const BEFORE = [
  row(OPEX, '6800', '6105.1409'), // AM series
  row(OPEX, '6800', '2201.0002'), // PM series, same key
  row(OPEX, '6850', '3000.0000'),
  row(NON_OPEX, '6800', '4444.4444'),
];

describe('dedupeStrikeRows', () => {
  it('is the documented default rule', () => {
    expect(DEFAULT_DEDUPE_RULE).toBe('sum');
  });

  it('collapses a collided key and records how many rows made it', () => {
    const { rows, collisions, rule } = dedupeStrikeRows(BEFORE);

    expect(rule).toBe('sum');
    expect(rows).toHaveLength(3); // 4 in, one pair combined
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      expiry: OPEX,
      strike: '6800',
      rows: 2,
      identical: false,
    });

    const combined = rows.find(
      (r) => r.expiry === OPEX && r.strike === '6800',
    )!;
    expect(Number(combined.call_gex)).toBeCloseTo(6105.1409 + 2201.0002, 4);
    expect(Number(combined.put_gex)).toBeCloseTo(-200, 4);
    expect(combined.source_rows).toBe(2);
  });

  it('marks untouched rows as coming from exactly one vendor row', () => {
    const { rows } = dedupeStrikeRows(BEFORE);
    const untouched = rows.find((r) => r.expiry === NON_OPEX)!;
    expect(untouched.source_rows).toBe(1);
    expect(untouched.call_gex).toBe('4444.4444');
  });

  it('does not depend on the order the vendor listed the series', () => {
    const forward = dedupeStrikeRows(BEFORE).rows.find(
      (r) => r.expiry === OPEX && r.strike === '6800',
    )!;
    const reversed = dedupeStrikeRows([...BEFORE].reverse()).rows.find(
      (r) => r.expiry === OPEX && r.strike === '6800',
    )!;
    // The property the old upsert lacked: last-write-wins made the stored
    // value depend on arrival order.
    expect(Number(forward.call_gex)).toBeCloseTo(Number(reversed.call_gex), 6);
  });

  it('notices when the collided rows were identical anyway', () => {
    const twin = row(OPEX, '6900', '77.0000');
    const { collisions } = dedupeStrikeRows([twin, { ...twin }]);
    expect(collisions[0]!.identical).toBe(true);
  });

  it('refuses the batch under the strict rule, naming the keys', () => {
    expect(() => dedupeStrikeRows(BEFORE, { rule: 'strict' })).toThrow(
      DuplicateStrikeRowsError,
    );
    try {
      dedupeStrikeRows(BEFORE, { rule: 'strict' });
    } catch (err) {
      expect((err as DuplicateStrikeRowsError).collisions).toHaveLength(1);
      expect((err as Error).message).toContain('2026-09-18@6800');
      expect((err as Error).message).toContain('no discriminator');
    }
  });

  it('passes a clean payload through unchanged under either rule', () => {
    const clean = [
      row(NON_OPEX, '6800', '1.0000'),
      row(NON_OPEX, '6850', '2.0000'),
    ];
    for (const rule of ['sum', 'strict'] as const) {
      const { rows, collisions } = dedupeStrikeRows(clean, { rule });
      expect(collisions).toEqual([]);
      expect(rows.map((r) => r.call_gex)).toEqual(['1.0000', '2.0000']);
    }
  });

  it('averages the summable fields under the uniform mean rule', () => {
    const { rows, collisions, rule } = dedupeStrikeRows(BEFORE, {
      rule: 'mean',
    });

    expect(rule).toBe('mean');
    const combined = rows.find(
      (r) => r.expiry === OPEX && r.strike === '6800',
    )!;
    expect(Number(combined.call_gex)).toBeCloseTo(
      (6105.1409 + 2201.0002) / 2,
      4,
    );
    expect(Number(combined.put_gex)).toBeCloseTo(-100, 4);
    expect(combined.dedupe_rule).toBe('mean');
    expect(collisions[0]!.rule).toBe('mean');
  });

  it('divides by the full group size when more than two snapshots collide', () => {
    const triple = [
      row(NON_OPEX, '6800', '100.0000'),
      row(NON_OPEX, '6800', '110.0000'),
      row(NON_OPEX, '6800', '120.0000'),
    ];
    const { rows, collisions } = dedupeStrikeRows(triple, { rule: 'mean' });

    expect(collisions[0]).toMatchObject({ rows: 3, rule: 'mean' });
    const combined = rows[0]!;
    expect(Number(combined.call_gex)).toBeCloseTo((100 + 110 + 120) / 3, 4);
    expect(combined.source_rows).toBe(3);
    expect(combined.dedupe_rule).toBe('mean');
  });

  it('resolves the rule per expiry when root evidence is supplied', () => {
    const dualRoot = OPEX; // listed under both SPX and SPXW roots
    const singleRoot = NON_OPEX; // SPXW only
    const batch = [
      row(dualRoot, '6800', '6105.1409'), // AM series
      row(dualRoot, '6800', '2201.0002'), // PM series, same key
      row(singleRoot, '6800', '1000.0000'), // one snapshot…
      row(singleRoot, '6800', '1010.0000'), // …served twice
      row(singleRoot, '6850', '3000.0000'), // untouched
    ];
    const { rows, collisions, rule } = dedupeStrikeRows(batch, {
      dualRootExpiries: new Set([dualRoot]),
    });

    // Top-level rule is still the batch rule; the per-expiry resolution is
    // recorded on the collisions and rows it touched.
    expect(rule).toBe('sum');

    const summed = rows.find(
      (r) => r.expiry === dualRoot && r.strike === '6800',
    )!;
    expect(Number(summed.call_gex)).toBeCloseTo(6105.1409 + 2201.0002, 4);
    expect(summed.dedupe_rule).toBe('sum');

    const averaged = rows.find(
      (r) => r.expiry === singleRoot && r.strike === '6800',
    )!;
    expect(Number(averaged.call_gex)).toBeCloseTo(1005, 4);
    expect(averaged.dedupe_rule).toBe('mean');

    const untouched = rows.find((r) => r.strike === '6850')!;
    expect(untouched.source_rows).toBe(1);
    expect(untouched.dedupe_rule).toBe('sum');

    expect(collisions).toHaveLength(2);
    expect(collisions.find((c) => c.expiry === dualRoot)!.rule).toBe('sum');
    expect(collisions.find((c) => c.expiry === singleRoot)!.rule).toBe('mean');
  });

  it('reports zero spread for an identical pair', () => {
    const twin = row(OPEX, '6900', '77.0000');
    const { collisions } = dedupeStrikeRows([twin, { ...twin }]);
    expect(collisions[0]!.maxRelDiff).toBe(0);
  });

  it('measures the spread of a near-identical snapshot pair', () => {
    const pair = [
      row(NON_OPEX, '6800', '1000.0000'),
      row(NON_OPEX, '6800', '985.0000'),
    ];
    const { collisions } = dedupeStrikeRows(pair);
    expect(collisions[0]!.maxRelDiff).toBeCloseTo(0.015, 4);
  });

  it('measures the AM/PM pair as structurally different', () => {
    const { collisions } = dedupeStrikeRows(BEFORE);
    expect(collisions[0]!.maxRelDiff).toBeGreaterThan(0.4);
  });

  it('draws the near-identical line at five percent', () => {
    expect(NEAR_IDENTICAL_REL_DIFF).toBe(0.05);
  });

  it('still refuses the batch under strict when root evidence is supplied', () => {
    expect(() =>
      dedupeStrikeRows(BEFORE, {
        rule: 'strict',
        dualRootExpiries: new Set([OPEX]),
      }),
    ).toThrow(DuplicateStrikeRowsError);
  });
});

describe('isOpexExpiry', () => {
  it.each([
    ['2026-09-18', true],
    ['2026-08-21', true],
    ['2026-01-16', true],
    ['2026-09-17', false], // Thursday
    ['2026-09-11', false], // second Friday
    ['2026-09-25', false], // fourth Friday
    ['not-a-date', false],
  ])('%s → %s', (date, expected) => {
    expect(isOpexExpiry(date)).toBe(expected);
  });
});

describe('aggregation modes', () => {
  const rows = [
    { expiry: OPEX, v: 1 },
    { expiry: NON_OPEX, v: 2 },
    { expiry: '2026-10-16', v: 3 }, // also an OPEX
  ];

  it('names all three modes explicitly', () => {
    expect([...AGGREGATION_MODES]).toEqual([
      'all_expiries',
      'target_expiry',
      'opex_only',
    ]);
  });

  it('defaults to target_expiry, which every current consumer wants', () => {
    expect(DEFAULT_AGGREGATION_MODE).toBe('target_expiry');
  });

  it('all_expiries keeps every expiry separate', () => {
    const out = selectByMode(rows, 'all_expiries');
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.expiry)).size).toBe(3);
  });

  it('target_expiry returns one named expiry', () => {
    expect(selectByMode(rows, 'target_expiry', { targetExpiry: OPEX })).toEqual(
      [{ expiry: OPEX, v: 1 }],
    );
  });

  it('target_expiry refuses to guess when no expiry is named', () => {
    expect(() => selectByMode(rows, 'target_expiry')).toThrow('requires');
  });

  it('opex_only filters by expiry date, still one row per expiry', () => {
    const out = selectByMode(rows, 'opex_only');
    expect(out.map((r) => r.expiry)).toEqual([OPEX, '2026-10-16']);
  });

  it('the default applied with no mode argument matches the named default', () => {
    expect(selectByMode(rows, undefined, { targetExpiry: OPEX })).toEqual(
      selectByMode(rows, DEFAULT_AGGREGATION_MODE, { targetExpiry: OPEX }),
    );
  });
});

describe('reconciliation', () => {
  it('accepts totals that agree within tolerance', () => {
    const r = reconcileExpiryTotals([100.5, -20.25, 3.75], 84.0);
    expect(r.ok).toBe(true);
    expect(r.difference).toBeLessThanOrEqual(r.tolerance);
  });

  it('rejects a shortfall the size of a discarded series', () => {
    // The before/after case: the aggregate still holds both series while the
    // per-expiry sum has lost one.
    const r = reconcileExpiryTotals([6105.1409], 6105.1409 + 2201.0002);
    expect(r.ok).toBe(false);
    expect(r.difference).toBeCloseTo(2201.0002, 4);
  });

  it('reconciles the after-fixture end to end', () => {
    const { rows } = dedupeStrikeRows(BEFORE);
    const net = (r: (typeof rows)[number]) =>
      Number(r.call_gex) + Number(r.put_gex);
    const perExpiry = new Map<string, number>();
    for (const r of rows) {
      perExpiry.set(r.expiry, (perExpiry.get(r.expiry) ?? 0) + net(r));
    }
    const aggregate = rows.reduce((t, r) => t + net(r), 0);
    expect(reconcileExpiryTotals(perExpiry.values(), aggregate).ok).toBe(true);
  });

  it('uses an absolute tolerance, not a relative one', () => {
    // Dollar-gamma is in the hundreds of thousands; a relative epsilon would
    // wave through an error bigger than a whole strike's exposure.
    const r = reconcileExpiryTotals([1_000_000], 1_000_001);
    expect(r.ok).toBe(false);
  });
});

describe('spot freshness', () => {
  const now = new Date('2026-08-25T16:00:00Z');

  it('verifies a spot stamped moments ago', () => {
    const r = assessSpotFreshness({
      spot: 7675,
      spotObservedAt: '2026-08-25T15:59:55.000000Z',
      now,
    });
    expect(r.freshness).toBe('verified');
    expect(r.ageSeconds).toBeCloseTo(5, 0);
  });

  it('calls a spot older than the window stale', () => {
    // The premarket case UW confirmed: gamma computed against yesterday's spot.
    expect(
      assessSpotFreshness({
        spot: 7675,
        spotObservedAt: '2026-08-24T20:00:00Z',
        now,
      }).freshness,
    ).toBe('stale');
  });

  it('reports unverified when there is no timestamp to check', () => {
    expect(
      assessSpotFreshness({ spot: 7675, spotObservedAt: null, now }).freshness,
    ).toBe('unverified');
  });

  it('reports unverified when there is no spot at all', () => {
    expect(
      assessSpotFreshness({
        spot: null,
        spotObservedAt: '2026-08-25T15:59:55Z',
        now,
      }).freshness,
    ).toBe('unverified');
  });

  it('reports unverified rather than trusting an unparseable timestamp', () => {
    expect(
      assessSpotFreshness({ spot: 7675, spotObservedAt: 'yesterday', now })
        .freshness,
    ).toBe('unverified');
  });
});

describe('spec version', () => {
  it('is 3 — the rule is now chosen per expiry from root evidence', () => {
    expect(GEX_STRIKE_SPEC_VERSION).toBe(3);
  });
});

describe('invalidating what the faulty version wrote', () => {
  it('distrusts a pre-fix row on a monthly OPEX expiry', () => {
    expect(isTrustedStrikeRow({ spec_version: null, expiry: OPEX })).toBe(
      false,
    );
    expect(isTrustedStrikeRow({ spec_version: 1, expiry: OPEX })).toBe(false);
  });

  it('keeps a pre-fix row on a non-OPEX expiry, which nothing could collide', () => {
    // Verified against the live API: the non-OPEX session came back with zero
    // duplicated keys, so those rows were never at risk. Excluding them would
    // discard years of good data to fix twelve days a year.
    expect(isTrustedStrikeRow({ spec_version: null, expiry: NON_OPEX })).toBe(
      true,
    );
  });

  it('trusts anything written at or above the fixed spec version', () => {
    expect(isTrustedStrikeRow({ spec_version: 2, expiry: OPEX })).toBe(true);
    expect(isTrustedStrikeRow({ spec_version: 3, expiry: OPEX })).toBe(true);
  });

  it('keys off the expiry, not the trade date', () => {
    // The collision belongs to the expiry whose two settlement series merged.
    expect(isTrustedStrikeRow({ spec_version: 1, expiry: '2026-10-16' })).toBe(
      false,
    );
  });

  it('expresses the same rule in SQL', () => {
    expect(TRUSTED_STRIKE_ROW_SQL).toContain('COALESCE(spec_version, 0) >= 2');
    expect(TRUSTED_STRIKE_ROW_SQL).toContain('ISODOW');
    expect(TRUSTED_STRIKE_ROW_SQL).toContain('BETWEEN 15 AND 21');
  });
});
