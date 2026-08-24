// @vitest-environment node

/**
 * The TAKE-IT floor is applied server-side and excludes NULL scores. That is
 * correct while a model exists — an unscored row really is below the floor.
 * It is wrong when NO model is published at all: `NULL >= 0.70` is NULL, so
 * every row drops and the feed goes silently empty.
 *
 * On 2026-08-23 that was live: the model bundles were missing from Blob, so
 * 16,858/16,858 lottery fires and 634/634 silent boom alerts were unscored and
 * both feeds returned nothing at the default 0.70 floor.
 *
 * getTakeitCoverage is the probe that separates the two cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { getTakeitCoverage } from '../_lib/takeit-availability.js';

const mockSql = Object.assign(vi.fn(), { unsafe: (raw: string) => raw });
type Db = Parameters<typeof getTakeitCoverage>[0];
const db = mockSql as unknown as Db;

/** The SQL text of the Nth tagged-template call, values elided. */
function sqlText(call = 0): string {
  return (mockSql.mock.calls[call]?.[0] as string[]).join(' ? ');
}

beforeEach(() => {
  mockSql.mockReset();
});

describe('getTakeitCoverage', () => {
  it('reports unavailable when rows exist but none are scored', async () => {
    mockSql.mockResolvedValueOnce([{ total: 4371, scored: 0 }]);

    const out = await getTakeitCoverage(db, 'lottery', '2026-08-21');

    expect(out).toEqual({ total: 4371, scored: 0, unavailable: true });
  });

  it('is available when at least one row carries a score', async () => {
    mockSql.mockResolvedValueOnce([{ total: 4371, scored: 1 }]);

    const out = await getTakeitCoverage(db, 'lottery', '2026-08-21');

    expect(out.unavailable).toBe(false);
  });

  it('an empty day is NOT "unavailable"', async () => {
    // Weekends and holidays have zero fires. Reporting "model unavailable"
    // there would show a false banner on every non-trading day.
    mockSql.mockResolvedValueOnce([{ total: 0, scored: 0 }]);

    const out = await getTakeitCoverage(db, 'lottery', '2026-08-22');

    expect(out).toEqual({ total: 0, scored: 0, unavailable: false });
  });

  it('queries lottery_finder_fires for the lottery feed', async () => {
    mockSql.mockResolvedValueOnce([{ total: 1, scored: 1 }]);
    await getTakeitCoverage(db, 'lottery', '2026-08-21');

    expect(sqlText()).toContain('lottery_finder_fires');
    expect(sqlText()).not.toContain('silent_boom_alerts');
  });

  it('queries silent_boom_alerts for the silent_boom feed', async () => {
    mockSql.mockResolvedValueOnce([{ total: 1, scored: 1 }]);
    await getTakeitCoverage(db, 'silent_boom', '2026-08-21');

    expect(sqlText()).toContain('silent_boom_alerts');
    expect(sqlText()).not.toContain('lottery_finder_fires');
  });

  it('counts takeit_prob, not rows, for the scored tally', async () => {
    mockSql.mockResolvedValueOnce([{ total: 1, scored: 1 }]);
    await getTakeitCoverage(db, 'lottery', '2026-08-21');

    expect(sqlText()).toContain('count(takeit_prob)');
  });

  it('coerces the Neon driver’s string counts to numbers', async () => {
    // The serverless driver returns bigint/numeric aggregates as STRINGS.
    // Without coercion `scored === 0` is false for "0" and the bug survives.
    mockSql.mockResolvedValueOnce([{ total: '4371', scored: '0' }]);

    const out = await getTakeitCoverage(db, 'lottery', '2026-08-21');

    expect(out.total).toBe(4371);
    expect(out.scored).toBe(0);
    expect(out.unavailable).toBe(true);
  });

  it('treats an empty result set as an empty day, not as unavailable', async () => {
    mockSql.mockResolvedValueOnce([]);

    const out = await getTakeitCoverage(db, 'lottery', '2026-08-21');

    expect(out).toEqual({ total: 0, scored: 0, unavailable: false });
  });
});
