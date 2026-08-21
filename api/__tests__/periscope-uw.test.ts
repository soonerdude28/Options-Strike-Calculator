// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  PANEL_SOURCE_COLUMNS,
  SNAPSHOT_VALUE_MAX,
  SOURCE_UW_EOD,
  SOURCE_UW_SPOT,
  clampSnapshotValue,
  formatTimeframe,
  netValue,
} from '../_lib/periscope-uw';

describe('source constants', () => {
  it('matches the migration #191 CHECK values', () => {
    expect(SOURCE_UW_SPOT).toBe('uw_spot');
    expect(SOURCE_UW_EOD).toBe('uw_eod');
  });

  it('maps every panel to a call/put column pair for both sources', () => {
    expect(PANEL_SOURCE_COLUMNS[SOURCE_UW_SPOT]).toEqual({
      gamma: { call: 'call_gamma_oi', put: 'put_gamma_oi' },
      charm: { call: 'call_charm_oi', put: 'put_charm_oi' },
      vanna: { call: 'call_vanna_oi', put: 'put_vanna_oi' },
    });
    expect(PANEL_SOURCE_COLUMNS[SOURCE_UW_EOD]).toEqual({
      gamma: { call: 'call_gex', put: 'put_gex' },
      charm: { call: 'call_charm', put: 'put_charm' },
      vanna: { call: 'call_vanna', put: 'put_vanna' },
    });
  });
});

describe('netValue — uw_spot (gex_strike_0dte rows)', () => {
  // Postgres NUMERIC comes back as a string from @neondatabase/serverless.
  const row = {
    strike: '7600.00',
    call_gamma_oi: '1234.5000',
    put_gamma_oi: '-234.5000',
    call_charm_oi: '-6477287668.0000',
    put_charm_oi: '1000.0000',
    call_vanna_oi: '1667214.0000',
    put_vanna_oi: '-214.0000',
  };

  it('sums call + put for gamma', () => {
    expect(netValue(row, 'gamma', SOURCE_UW_SPOT)).toBe(1000);
  });

  it('sums call + put for charm', () => {
    expect(netValue(row, 'charm', SOURCE_UW_SPOT)).toBe(-6477286668);
  });

  it('sums call + put for vanna', () => {
    expect(netValue(row, 'vanna', SOURCE_UW_SPOT)).toBe(1667000);
  });

  it('reads numeric (already-parsed) columns too', () => {
    expect(
      netValue({ call_gamma_oi: 10, put_gamma_oi: -2.5 }, 'gamma', 'uw_spot'),
    ).toBe(7.5);
  });

  it('does not read the uw_eod column names', () => {
    expect(
      netValue({ call_gex: '1', put_gex: '2' }, 'gamma', SOURCE_UW_SPOT),
    ).toBeNull();
  });
});

describe('netValue — uw_eod (UW /greek-exposure/strike-expiry rows)', () => {
  // The UW JSON API returns every greek as a decimal string.
  const row = {
    strike: '7600.0',
    call_gex: '0.0355',
    put_gex: '-0.1326',
    call_charm: '3200795.5',
    put_charm: '-795.5',
    call_vanna: '-242323.25',
    put_vanna: '23.25',
  };

  it('sums call + put for gamma', () => {
    expect(netValue(row, 'gamma', SOURCE_UW_EOD)).toBeCloseTo(-0.0971, 10);
  });

  it('sums call + put for charm', () => {
    expect(netValue(row, 'charm', SOURCE_UW_EOD)).toBe(3200000);
  });

  it('sums call + put for vanna', () => {
    expect(netValue(row, 'vanna', SOURCE_UW_EOD)).toBe(-242300);
  });

  it('does not read the uw_spot column names', () => {
    expect(
      netValue(
        { call_gamma_oi: '1', put_gamma_oi: '2' },
        'gamma',
        SOURCE_UW_EOD,
      ),
    ).toBeNull();
  });
});

describe('netValue — missing / malformed sides', () => {
  it.each([
    ['null call', { call_gex: null, put_gex: '1' }],
    ['null put', { call_gex: '1', put_gex: null }],
    ['undefined call', { call_gex: undefined, put_gex: '1' }],
    ['absent put', { call_gex: '1' }],
    ['NaN literal', { call_gex: Number.NaN, put_gex: 1 }],
    ['NaN string', { call_gex: 'NaN', put_gex: '1' }],
    ['empty string', { call_gex: '', put_gex: '1' }],
    ['non-numeric string', { call_gex: 'abc', put_gex: '1' }],
    ['Infinity', { call_gex: Number.POSITIVE_INFINITY, put_gex: 1 }],
    ['both sides missing', {}],
  ])('returns null for %s', (_label, row) => {
    expect(netValue(row, 'gamma', SOURCE_UW_EOD)).toBeNull();
  });

  it('treats an explicit zero as a real value, not a missing side', () => {
    expect(
      netValue({ call_gex: '0.0000', put_gex: '0' }, 'gamma', 'uw_eod'),
    ).toBe(0);
  });
});

describe('formatTimeframe', () => {
  // America/Chicago is CDT (UTC-5) on these August dates.
  it('floors to the prior 10-min CT slot', () => {
    // 14:32 UTC = 09:32 CT
    expect(formatTimeframe(new Date('2026-08-21T14:32:00.000Z'))).toBe(
      '09:30 - 09:40',
    );
  });

  it('labels an exact slot boundary as the slot that starts there', () => {
    // 15:00 UTC = 10:00 CT
    expect(formatTimeframe(new Date('2026-08-21T15:00:00.000Z'))).toBe(
      '10:00 - 10:10',
    );
  });

  it('rolls the hour over on the :50 slot', () => {
    // 14:55 UTC = 09:55 CT
    expect(formatTimeframe(new Date('2026-08-21T14:55:00.000Z'))).toBe(
      '09:50 - 10:00',
    );
  });

  it('rolls midnight over on the last slot of the day', () => {
    // 04:57 UTC on the 22nd = 23:57 CT on the 21st
    expect(formatTimeframe(new Date('2026-08-22T04:57:00.000Z'))).toBe(
      '23:50 - 00:00',
    );
  });

  it('uses CT, not UTC (CST offset in winter)', () => {
    // America/Chicago is CST (UTC-6) in January → 19:12 UTC = 13:12 CT
    expect(formatTimeframe(new Date('2026-01-14T19:12:00.000Z'))).toBe(
      '13:10 - 13:20',
    );
  });

  it('zero-pads single-digit hours', () => {
    // 13:05 UTC = 08:05 CT
    expect(formatTimeframe(new Date('2026-08-21T13:05:00.000Z'))).toBe(
      '08:00 - 08:10',
    );
  });
});

describe('clampSnapshotValue', () => {
  it('exposes the migration #192 NUMERIC(20,4) ceiling', () => {
    // NUMERIC(20,4) allows 16 integer digits, so the true column ceiling
    // is 9999999999999999.9999 — which is NOT representable as an
    // IEEE-754 double (it rounds UP to 1e16, 17 integer digits, which
    // would overflow the very column it is meant to fit). The constant
    // is therefore the largest double strictly below that ceiling.
    expect(SNAPSHOT_VALUE_MAX).toBe(9999999999999998);
    expect(SNAPSHOT_VALUE_MAX).toBeLessThan(1e16);
    expect(Number.isSafeInteger(SNAPSHOT_VALUE_MAX + 2)).toBe(false);
  });

  it('passes an in-range value through untouched', () => {
    expect(clampSnapshotValue(1234.56)).toBe(1234.56);
    expect(clampSnapshotValue(-1234.56)).toBe(-1234.56);
    expect(clampSnapshotValue(0)).toBe(0);
  });

  it('passes SPX-scale charm (~1e10) through', () => {
    expect(clampSnapshotValue(-6477287668)).toBe(-6477287668);
    expect(clampSnapshotValue(1e10)).toBe(1e10);
  });

  it('passes a full-scale DECIMAL(20,4) source value through (pre-#192 this saturated)', () => {
    // gex_strike_0dte columns are DECIMAL(20,4). Under the old
    // NUMERIC(14,2) target these saturated to 999999999999.99 and then
    // ranked first in every Top-N — a fabricated extreme.
    expect(clampSnapshotValue(1e13)).toBe(1e13);
    expect(clampSnapshotValue(-1e13)).toBe(-1e13);
    expect(clampSnapshotValue(9e15)).toBe(9e15);
  });

  it('passes the exact bounds through', () => {
    expect(clampSnapshotValue(SNAPSHOT_VALUE_MAX)).toBe(SNAPSHOT_VALUE_MAX);
    expect(clampSnapshotValue(-SNAPSHOT_VALUE_MAX)).toBe(-SNAPSHOT_VALUE_MAX);
  });

  it('clamps above the range', () => {
    expect(clampSnapshotValue(1e17)).toBe(SNAPSHOT_VALUE_MAX);
    expect(clampSnapshotValue(Number.POSITIVE_INFINITY)).toBe(
      SNAPSHOT_VALUE_MAX,
    );
  });

  it('clamps below the range', () => {
    expect(clampSnapshotValue(-1e17)).toBe(-SNAPSHOT_VALUE_MAX);
    expect(clampSnapshotValue(Number.NEGATIVE_INFINITY)).toBe(
      -SNAPSHOT_VALUE_MAX,
    );
  });

  it('maps NaN to 0 — unreachable from netValue, retained as a deliberate guard', () => {
    // netValue rejects non-finite legs, so call + put is always finite
    // and the production path never hits this branch. It is kept because
    // clampSnapshotValue is an exported general-purpose guard and
    // Postgres NUMERIC *accepts* the literal NaN: an unguarded NaN would
    // not throw, it would silently land in periscope_snapshots.value and
    // poison every downstream PERCENTILE_CONT / MAX / delta. This test
    // pins that contract so the branch is not "cleaned up" later.
    expect(clampSnapshotValue(Number.NaN)).toBe(0);
  });
});
