// @vitest-environment node

import { describe, it, expect } from 'vitest';

import {
  SLICE_INTERVAL_MS,
  mapSliceRows,
  selectTenMinuteSlices,
  sliceBoundaryMs,
} from '../_lib/periscope-spot-seed.js';
import { SNAPSHOT_VALUE_MAX } from '../_lib/periscope-uw.js';

/** Terser than `new Date(...)` everywhere; the specs are all ISO. */
const at = (iso: string): Date => new Date(iso);

/** Compare `Date[]` results as ISO strings for readable diffs. */
const isos = (dates: readonly Date[]): string[] =>
  dates.map((d) => d.toISOString());

/**
 * One `gex_strike_0dte` row as the Neon driver returns it — every
 * NUMERIC column arrives as a STRING (verified against the live table
 * 2026-08-21), so the fixtures use strings by default.
 */
function makeRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: '2026-08-20T14:59:32.000Z',
    strike: '7870.00',
    call_gamma_oi: '2975542.8400',
    put_gamma_oi: '-104429.4600',
    call_charm_oi: '-92597216896.2800',
    put_charm_oi: '3249785334.3900',
    call_vanna_oi: '1745170.1400',
    put_vanna_oi: '-61248.3700',
    ...overrides,
  };
}

describe('SLICE_INTERVAL_MS', () => {
  it('is the live cron cadence — 10 minutes', () => {
    expect(SLICE_INTERVAL_MS).toBe(600_000);
  });
});

describe('sliceBoundaryMs', () => {
  it('rounds a mid-bucket tick UP to the next grid point', () => {
    const ms = at('2026-08-20T13:24:07.999Z').getTime();
    expect(new Date(sliceBoundaryMs(ms)).toISOString()).toBe(
      '2026-08-20T13:30:00.000Z',
    );
  });

  it('leaves a tick that is already on the grid where it is', () => {
    const ms = at('2026-08-20T14:00:00.000Z').getTime();
    expect(sliceBoundaryMs(ms)).toBe(ms);
  });
});

describe('selectTenMinuteSlices', () => {
  it('returns nothing for an empty input', () => {
    expect(selectTenMinuteSlices([])).toEqual([]);
  });

  it('keeps a single tick, mapped onto its own bucket', () => {
    const out = selectTenMinuteSlices([at('2026-08-20T13:24:07.999Z')]);
    expect(isos(out)).toEqual(['2026-08-20T13:24:07.999Z']);
  });

  it('keeps only the LAST tick when several land in one bucket', () => {
    // All four fall in the bucket (13:20, 13:30] — exactly the window
    // the cron firing at 13:30 would have taken MAX(timestamp) over.
    const out = selectTenMinuteSlices([
      at('2026-08-20T13:23:55.751Z'),
      at('2026-08-20T13:24:55.000Z'),
      at('2026-08-20T13:28:01.500Z'),
      at('2026-08-20T13:29:59.999Z'),
    ]);
    expect(isos(out)).toEqual(['2026-08-20T13:29:59.999Z']);
  });

  it('omits a bucket with no ticks instead of fabricating a slice', () => {
    // 14:00–14:20 has no ticks at all (a feed outage). The result must
    // have a HOLE there, not the 13:5x value carried forward onto the
    // 14:10 / 14:20 boundaries — a duplicated value at a new timestamp
    // would read downstream as a genuine zero delta.
    const out = selectTenMinuteSlices([
      at('2026-08-20T13:52:00.000Z'),
      at('2026-08-20T14:23:00.000Z'),
      at('2026-08-20T14:31:00.000Z'),
    ]);
    expect(isos(out)).toEqual([
      '2026-08-20T13:52:00.000Z',
      '2026-08-20T14:23:00.000Z',
      '2026-08-20T14:31:00.000Z',
    ]);
    expect(out).toHaveLength(3);
  });

  it('assigns a tick exactly on a boundary to THAT boundary, not the next', () => {
    // 14:00:00.000 belongs to the bucket ending 14:00 — the instant a
    // 14:00 cron firing would have read it. So it shares a bucket with
    // 13:59:59.999 (which it beats) and does NOT merge with 14:00:00.001.
    const out = selectTenMinuteSlices([
      at('2026-08-20T13:59:59.999Z'),
      at('2026-08-20T14:00:00.000Z'),
      at('2026-08-20T14:00:00.001Z'),
    ]);
    expect(isos(out)).toEqual([
      '2026-08-20T14:00:00.000Z',
      '2026-08-20T14:00:00.001Z',
    ]);
  });

  it('does not merge ticks across a day boundary', () => {
    const out = selectTenMinuteSlices([
      at('2026-08-20T23:55:00.000Z'),
      at('2026-08-21T00:03:00.000Z'),
      at('2026-08-21T00:08:00.000Z'),
    ]);
    expect(isos(out)).toEqual([
      '2026-08-20T23:55:00.000Z',
      '2026-08-21T00:08:00.000Z',
    ]);
  });

  it('returns an ascending, duplicate-free series from shuffled input', () => {
    const out = selectTenMinuteSlices([
      at('2026-08-20T14:31:00.000Z'),
      at('2026-08-20T13:52:00.000Z'),
      at('2026-08-20T14:31:00.000Z'), // exact duplicate
      at('2026-08-20T14:09:00.000Z'),
      at('2026-08-20T13:52:00.000Z'), // exact duplicate
    ]);

    expect(isos(out)).toEqual([
      '2026-08-20T13:52:00.000Z',
      '2026-08-20T14:09:00.000Z',
      '2026-08-20T14:31:00.000Z',
    ]);
    const times = out.map((d) => d.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it('is pure — it does not reorder, mutate or alias its input', () => {
    const input = [
      at('2026-08-20T14:31:00.000Z'),
      at('2026-08-20T13:52:00.000Z'),
      at('2026-08-20T14:09:00.000Z'),
    ];
    const before = isos(input);
    const identities = [...input];

    const out = selectTenMinuteSlices(input);

    // Input order, contents and element identity are all untouched.
    expect(isos(input)).toEqual(before);
    expect(input).toHaveLength(3);
    input.forEach((d, i) => expect(d).toBe(identities[i]));

    // Returned Dates are fresh objects, so mutating one cannot reach
    // back into the caller's array.
    for (const d of out) expect(input).not.toContain(d);
    out[0]!.setTime(0);
    expect(isos(input)).toEqual(before);
  });

  it('accepts Date, ISO string and epoch-ms inputs interchangeably', () => {
    const out = selectTenMinuteSlices([
      at('2026-08-20T13:52:00.000Z'),
      '2026-08-20T14:09:00.000Z',
      at('2026-08-20T14:31:00.000Z').getTime(),
    ]);
    expect(isos(out)).toEqual([
      '2026-08-20T13:52:00.000Z',
      '2026-08-20T14:09:00.000Z',
      '2026-08-20T14:31:00.000Z',
    ]);
  });

  it('drops unparseable timestamps rather than emitting an Invalid Date', () => {
    const out = selectTenMinuteSlices([
      'not-a-date',
      new Date('nope'),
      Number.NaN,
      at('2026-08-20T13:52:00.000Z'),
    ]);
    expect(isos(out)).toEqual(['2026-08-20T13:52:00.000Z']);
  });
});

describe('mapSliceRows', () => {
  it('emits one row per panel per strike, in PANELS order', () => {
    const mapped = mapSliceRows([
      makeRow({
        strike: '6400.00',
        call_gamma_oi: '1000.5',
        put_gamma_oi: '-400.25',
        call_charm_oi: '20',
        put_charm_oi: '5',
        call_vanna_oi: '-7',
        put_vanna_oi: '2',
      }),
    ]);

    expect(mapped.panels).toEqual(['gamma', 'charm', 'vanna']);
    expect(mapped.strikes).toEqual([6400, 6400, 6400]);
    expect(mapped.values).toEqual([600.25, 25, -5]);
    expect(mapped.stats).toEqual({
      rows: 1,
      malformed: 0,
      nullSkipped: 0,
      clamped: 0,
    });
  });

  it('groups panel-outer / strike-inner, matching the cron loop', () => {
    const mapped = mapSliceRows([
      makeRow({ strike: '6400' }),
      makeRow({ strike: '6405' }),
    ]);

    expect(mapped.panels).toEqual([
      'gamma',
      'gamma',
      'charm',
      'charm',
      'vanna',
      'vanna',
    ]);
    expect(mapped.strikes).toEqual([6400, 6405, 6400, 6405, 6400, 6405]);
  });

  it('returns empty arrays and zeroed stats for an empty tick', () => {
    const mapped = mapSliceRows([]);
    expect(mapped.panels).toEqual([]);
    expect(mapped.strikes).toEqual([]);
    expect(mapped.values).toEqual([]);
    expect(mapped.stats).toEqual({
      rows: 0,
      malformed: 0,
      nullSkipped: 0,
      clamped: 0,
    });
  });

  it('rounds the DECIMAL(10,2) strike to the INT column', () => {
    const mapped = mapSliceRows([makeRow({ strike: '6402.60' })]);
    expect(mapped.strikes).toEqual([6403, 6403, 6403]);
  });

  it('KEEPS an all-zero strike — deliberate asymmetry vs. the EOD backfill', () => {
    // `mapDayRows` drops these; the forward cron does not, and the seed
    // must be indistinguishable from the cron. If this test ever starts
    // failing because someone added a zero-skip, that is the bug.
    const mapped = mapSliceRows([
      makeRow({
        strike: '5000',
        call_gamma_oi: '0',
        put_gamma_oi: '-0',
        call_charm_oi: '0',
        put_charm_oi: '0',
        call_vanna_oi: '0',
        put_vanna_oi: '0',
      }),
    ]);

    expect(mapped.panels).toEqual(['gamma', 'charm', 'vanna']);
    expect(mapped.values).toEqual([0, 0, 0]);
    expect(mapped.stats.rows).toBe(1);
  });

  it('skips only the affected panel when one leg is missing', () => {
    const mapped = mapSliceRows([
      makeRow({ strike: '6400', put_charm_oi: null }),
    ]);

    expect(mapped.panels).toEqual(['gamma', 'vanna']);
    expect(mapped.strikes).toEqual([6400, 6400]);
    expect(mapped.stats.nullSkipped).toBe(1);
    expect(mapped.stats.malformed).toBe(0);
  });

  it('drops a row with an unparseable strike, counting it once', () => {
    const mapped = mapSliceRows([
      makeRow({ strike: 'n/a' }),
      makeRow({ strike: null }),
      null,
      'not-a-row',
      makeRow({ strike: '6400' }),
    ]);

    expect(mapped.strikes).toEqual([6400, 6400, 6400]);
    // Once per bad ROW, not once per row per panel.
    expect(mapped.stats.malformed).toBe(4);
    expect(mapped.stats.rows).toBe(5);
    expect(mapped.stats.nullSkipped).toBe(0);
  });

  it('clamps and counts a value beyond the NUMERIC(20,4) ceiling', () => {
    const mapped = mapSliceRows([
      makeRow({ strike: '6400', call_gamma_oi: '1e16', put_gamma_oi: '0' }),
    ]);

    expect(mapped.values[0]).toBe(SNAPSHOT_VALUE_MAX);
    expect(mapped.stats.clamped).toBe(1);
  });

  it('does not mutate the rows it is given', () => {
    const row = makeRow({ strike: '6400' });
    const snapshot = structuredClone(row);
    mapSliceRows([row]);
    expect(row).toEqual(snapshot);
  });
});
