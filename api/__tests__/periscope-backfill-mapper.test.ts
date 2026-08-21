// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  EOD_CT_MINUTES,
  EOD_PANELS,
  HISTORY_FLOOR_CODE,
  classifyForbidden,
  eodCapturedAtIso,
  mapDayRows,
} from '../_lib/periscope-backfill-mapper.js';
import { SNAPSHOT_VALUE_MAX } from '../_lib/periscope-uw.js';

/**
 * One raw UW `/greek-exposure/strike-expiry` row. Every numeric field is
 * a STRING in the live payload (verified against the API 2026-08-21), so
 * the fixtures use strings by default.
 */
function makeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    date: '2026-08-20',
    expiry: '2026-08-20',
    strike: '6400',
    call_gex: '1000.5',
    put_gex: '-400.25',
    call_charm: '20',
    put_charm: '5',
    call_vanna: '-7',
    put_vanna: '2',
    dte: '0',
    ...overrides,
  };
}

/** All three panels zeroed — the deep-wing tail UW pads its payload with. */
function makeZeroRow(strike: string): Record<string, unknown> {
  return makeRow({
    strike,
    call_gex: '0',
    put_gex: '0',
    call_charm: '0',
    put_charm: '-0',
    call_vanna: '0',
    put_vanna: '0',
  });
}

describe('EOD_PANELS', () => {
  it('is derived from the shared column map, not hand-listed', () => {
    expect(EOD_PANELS).toEqual(['gamma', 'charm', 'vanna']);
  });
});

describe('mapDayRows', () => {
  it('emits one row per panel for a usable strike', () => {
    const mapped = mapDayRows([makeRow()]);

    expect(mapped.panels).toEqual(['gamma', 'charm', 'vanna']);
    expect(mapped.strikes).toEqual([6400, 6400, 6400]);
    // net = call + put, per panel
    expect(mapped.values).toEqual([600.25, 25, -5]);
    expect(mapped.stats).toEqual({
      fetched: 1,
      kept: 1,
      zeroSkipped: 0,
      nullSkipped: 0,
      malformed: 0,
      duplicates: 0,
      clamped: 0,
    });
  });

  it('returns empty arrays and zeroed stats for an empty payload', () => {
    const mapped = mapDayRows([]);

    expect(mapped.panels).toEqual([]);
    expect(mapped.strikes).toEqual([]);
    expect(mapped.values).toEqual([]);
    expect(mapped.stats.fetched).toBe(0);
    expect(mapped.stats.kept).toBe(0);
  });

  it('rounds fractional strikes to INT (the column type)', () => {
    const mapped = mapDayRows([makeRow({ strike: '6402.5' })]);

    expect(mapped.strikes).toEqual([6403, 6403, 6403]);
  });

  describe('all-zero skip', () => {
    it('drops a strike whose gamma, charm AND vanna are all exactly 0', () => {
      const mapped = mapDayRows([makeZeroRow('7000')]);

      expect(mapped.panels).toEqual([]);
      expect(mapped.stats.zeroSkipped).toBe(1);
      expect(mapped.stats.kept).toBe(0);
      expect(mapped.stats.nullSkipped).toBe(0);
    });

    it('keeps a strike where only ONE panel is non-zero', () => {
      const mapped = mapDayRows([
        makeRow({
          strike: '7000',
          call_gex: '0',
          put_gex: '0',
          call_charm: '0',
          put_charm: '0',
          call_vanna: '3',
          put_vanna: '0',
        }),
      ]);

      expect(mapped.stats.kept).toBe(1);
      expect(mapped.stats.zeroSkipped).toBe(0);
      // Zero panels are still written — only the ALL-zero strike is dropped.
      expect(mapped.panels).toEqual(['gamma', 'charm', 'vanna']);
      expect(mapped.values).toEqual([0, 0, 3]);
    });

    it('treats a strike whose legs cancel to 0 as all-zero', () => {
      const mapped = mapDayRows([
        makeRow({
          strike: '7000',
          call_gex: '500',
          put_gex: '-500',
          call_charm: '2',
          put_charm: '-2',
          call_vanna: '-9',
          put_vanna: '9',
        }),
      ]);

      expect(mapped.stats.zeroSkipped).toBe(1);
      expect(mapped.panels).toEqual([]);
    });

    it('separates the all-zero tail from the usable strikes in one payload', () => {
      const mapped = mapDayRows([
        makeRow({ strike: '6400' }),
        makeZeroRow('9000'),
        makeZeroRow('9100'),
        makeRow({ strike: '6500' }),
      ]);

      expect(mapped.stats).toMatchObject({
        fetched: 4,
        kept: 2,
        zeroSkipped: 2,
      });
      expect(mapped.strikes).toEqual([6400, 6400, 6400, 6500, 6500, 6500]);
    });
  });

  describe('per-panel null skipping', () => {
    it('drops only the one-sided panel and keeps the rest of the strike', () => {
      const mapped = mapDayRows([makeRow({ put_charm: null })]);

      expect(mapped.panels).toEqual(['gamma', 'vanna']);
      expect(mapped.values).toEqual([600.25, -5]);
      expect(mapped.stats.kept).toBe(1);
      // A partially-usable strike is NOT counted as null-skipped.
      expect(mapped.stats.nullSkipped).toBe(0);
    });

    it('drops a panel whose leg is a non-numeric string', () => {
      const mapped = mapDayRows([makeRow({ call_vanna: 'n/a' })]);

      expect(mapped.panels).toEqual(['gamma', 'charm']);
      expect(mapped.stats.kept).toBe(1);
    });

    it('counts the strike as nullSkipped when every panel is unusable', () => {
      const mapped = mapDayRows([
        makeRow({
          call_gex: null,
          call_charm: undefined,
          put_vanna: '',
        }),
      ]);

      expect(mapped.panels).toEqual([]);
      expect(mapped.stats.nullSkipped).toBe(1);
      expect(mapped.stats.kept).toBe(0);
      expect(mapped.stats.zeroSkipped).toBe(0);
    });

    it('checks nullSkipped BEFORE zeroSkipped for a row that is both', () => {
      // Every panel unusable → nullSkipped, never zeroSkipped (there is no
      // value to call zero).
      const mapped = mapDayRows([
        { strike: '6400', call_gex: '0', call_charm: '0', call_vanna: '0' },
      ]);

      expect(mapped.stats.nullSkipped).toBe(1);
      expect(mapped.stats.zeroSkipped).toBe(0);
    });
  });

  describe('duplicate strikes', () => {
    it('keeps the first copy, counts the second, and writes it once', () => {
      const mapped = mapDayRows([
        makeRow({ strike: '6400' }),
        makeRow({ strike: '6400', call_gex: '999999' }),
      ]);

      expect(mapped.strikes).toEqual([6400, 6400, 6400]);
      expect(mapped.values).toEqual([600.25, 25, -5]);
      expect(mapped.stats.kept).toBe(1);
      expect(mapped.stats.duplicates).toBe(1);
    });

    it('treats strikes that collide only after rounding as duplicates', () => {
      const mapped = mapDayRows([
        makeRow({ strike: '6400.2' }),
        makeRow({ strike: '6399.8' }),
      ]);

      expect(mapped.stats.kept).toBe(1);
      expect(mapped.stats.duplicates).toBe(1);
      expect(mapped.strikes).toEqual([6400, 6400, 6400]);
    });

    it('does not count an all-zero repeat as a duplicate', () => {
      // The all-zero skip fires first, so the strike is never marked seen.
      const mapped = mapDayRows([makeZeroRow('9000'), makeZeroRow('9000')]);

      expect(mapped.stats.zeroSkipped).toBe(2);
      expect(mapped.stats.duplicates).toBe(0);
    });
  });

  describe('malformed rows', () => {
    it.each([
      ['missing strike', makeRow({ strike: undefined })],
      ['null strike', makeRow({ strike: null })],
      ['non-numeric strike', makeRow({ strike: 'ATM' })],
      ['empty-string strike', makeRow({ strike: '' })],
    ])('counts %s as malformed', (_label, row) => {
      const mapped = mapDayRows([row]);

      expect(mapped.stats.malformed).toBe(1);
      expect(mapped.panels).toEqual([]);
    });

    it.each([[null], [undefined], ['6400'], [42]])(
      'counts the non-object payload entry %p as malformed',
      (row) => {
        const mapped = mapDayRows([row]);

        expect(mapped.stats.malformed).toBe(1);
        expect(mapped.panels).toEqual([]);
      },
    );

    it('accepts an already-parsed numeric strike', () => {
      const mapped = mapDayRows([makeRow({ strike: 6400 })]);

      expect(mapped.stats.malformed).toBe(0);
      expect(mapped.strikes).toEqual([6400, 6400, 6400]);
    });

    it('keeps mapping the rest of the payload after a malformed row', () => {
      const mapped = mapDayRows([
        makeRow({ strike: 'ATM' }),
        makeRow({ strike: '6500' }),
      ]);

      expect(mapped.stats.malformed).toBe(1);
      expect(mapped.stats.kept).toBe(1);
      expect(mapped.strikes).toEqual([6500, 6500, 6500]);
    });
  });

  describe('clamp accounting', () => {
    // Deliberately expressed against the imported SNAPSHOT_VALUE_MAX, not a
    // literal, so widening `periscope_snapshots.value` cannot silently
    // invalidate this test.
    it('saturates an over-range value and counts the clamp', () => {
      const mapped = mapDayRows([
        makeRow({ strike: '6400', call_gex: '1e30', put_gex: '0' }),
      ]);

      expect(mapped.values[0]).toBe(SNAPSHOT_VALUE_MAX);
      expect(mapped.stats.clamped).toBe(1);
      // Only the offending panel is clamped.
      expect(mapped.values[1]).toBe(25);
    });

    it('saturates an under-range value at the negative bound', () => {
      const mapped = mapDayRows([
        makeRow({ strike: '6400', call_gex: '-1e30', put_gex: '0' }),
      ]);

      expect(mapped.values[0]).toBe(-SNAPSHOT_VALUE_MAX);
      expect(mapped.stats.clamped).toBe(1);
    });

    it('passes an in-range value through untouched', () => {
      // SPX charm peaks around ~1e10 — comfortably inside the column.
      const mapped = mapDayRows([
        makeRow({ strike: '6400', call_charm: '1e10', put_charm: '0' }),
      ]);

      expect(mapped.values[1]).toBe(1e10);
      expect(mapped.stats.clamped).toBe(0);
    });

    it('counts one clamp per panel, not per strike', () => {
      const mapped = mapDayRows([
        makeRow({
          strike: '6400',
          call_gex: '1e30',
          put_gex: '0',
          call_charm: '1e30',
          put_charm: '0',
        }),
      ]);

      expect(mapped.stats.clamped).toBe(2);
      expect(mapped.stats.kept).toBe(1);
    });
  });

  it('reports fetched as the raw payload length regardless of skips', () => {
    const mapped = mapDayRows([
      makeRow({ strike: '6400' }),
      makeZeroRow('9000'),
      makeRow({ strike: 'ATM' }),
      makeRow({ strike: '6400' }),
      makeRow({
        strike: '6600',
        call_gex: null,
        call_charm: null,
        put_vanna: null,
      }),
    ]);

    expect(mapped.stats).toEqual({
      fetched: 5,
      kept: 1,
      zeroSkipped: 1,
      nullSkipped: 1,
      malformed: 1,
      duplicates: 1,
      clamped: 0,
    });
  });
});

describe('classifyForbidden', () => {
  // SAFETY-CRITICAL. A 403 is end-of-history ONLY when UW says so with the
  // machine-readable code. Anything else is an auth/permission failure that
  // must abort the run — otherwise a revoked key would "successfully"
  // backfill zero days and nothing would fail.
  it('recognises the history-floor code and extracts the earliest date', () => {
    const verdict = classifyForbidden({
      code: HISTORY_FLOOR_CODE,
      message:
        'The earliest date currently available to you is 2023-09-21 ' +
        '(730 trading days) for this endpoint.',
    });

    expect(verdict).toEqual({ kind: 'end-of-history', earliest: '2023-09-21' });
  });

  it('reports a null earliest when the message carries no date', () => {
    const verdict = classifyForbidden({
      code: HISTORY_FLOOR_CODE,
      message: 'Historic data access missing.',
    });

    expect(verdict).toEqual({ kind: 'end-of-history', earliest: null });
  });

  it.each([
    ['a missing message', { code: HISTORY_FLOOR_CODE }],
    ['a null message', { code: HISTORY_FLOOR_CODE, message: null }],
    ['a non-string message', { code: HISTORY_FLOOR_CODE, message: 12345 }],
  ])('still terminates cleanly with %s', (_label, body) => {
    expect(classifyForbidden(body)).toEqual({
      kind: 'end-of-history',
      earliest: null,
    });
  });

  it('takes the FIRST date in the message', () => {
    const verdict = classifyForbidden({
      code: HISTORY_FLOOR_CODE,
      message: 'earliest is 2023-09-21, requested 2020-01-02',
    });

    expect(verdict).toEqual({ kind: 'end-of-history', earliest: '2023-09-21' });
  });

  it.each([
    ['an unparseable (non-JSON) body', null],
    ['an undefined body', undefined],
    ['an empty object', {}],
    ['a plain-string body', 'Forbidden'],
    ['a different error code', { code: 'forbidden', message: 'no access' }],
    ['a null code', { code: null, message: 'The earliest date is 2023-09-21' }],
    [
      'the code in the wrong field',
      { code: 'forbidden', message: HISTORY_FLOOR_CODE },
    ],
    [
      'a code that merely contains the sentinel as a substring',
      { code: `not_${HISTORY_FLOOR_CODE}` },
    ],
    ['an array body', [{ code: HISTORY_FLOOR_CODE }]],
  ])('treats %s as an auth failure, NOT end-of-history', (_label, body) => {
    expect(classifyForbidden(body)).toEqual({ kind: 'auth-failure' });
  });
});

describe('eodCapturedAtIso', () => {
  it('anchors on the 15:00 CT regular-session close', () => {
    expect(EOD_CT_MINUTES).toBe(15 * 60);
  });

  it('resolves a CST (winter) date to 21:00Z', () => {
    expect(eodCapturedAtIso('2024-01-15')).toBe('2024-01-15T21:00:00.000Z');
  });

  it('resolves a CDT (summer) date to 20:00Z', () => {
    expect(eodCapturedAtIso('2024-07-15')).toBe('2024-07-15T20:00:00.000Z');
  });

  it.each([
    // Friday before the 2024-03-10 spring-forward — still CST.
    ['2024-03-08', '2024-03-08T21:00:00.000Z'],
    // Monday after it — CDT.
    ['2024-03-11', '2024-03-11T20:00:00.000Z'],
    // Friday before the 2024-11-03 fall-back — still CDT.
    ['2024-11-01', '2024-11-01T20:00:00.000Z'],
    // Monday after it — CST.
    ['2024-11-04', '2024-11-04T21:00:00.000Z'],
  ])('handles the DST boundary at %s', (date, expected) => {
    expect(eodCapturedAtIso(date)).toBe(expected);
  });

  it.each([['not-a-date'], ['2024-13-01'], ['2024-02-30'], ['20240115'], ['']])(
    'returns null for the invalid date %p so the caller can fail loudly',
    (date) => {
      expect(eodCapturedAtIso(date)).toBeNull();
    },
  );
});
