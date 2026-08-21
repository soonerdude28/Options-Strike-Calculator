// @vitest-environment node

/**
 * Tests for the shared Periscope query primitives — specifically the
 * migration #191 `source` resolution that keeps the three
 * `periscope_snapshots` series (live `uw_spot` dollars, normalized
 * `uw_eod` backfill, dead `gexbot`) out of each other's result sets.
 */

import { vi, beforeEach, describe, it, expect } from 'vitest';

const mockSql = vi.fn();
vi.mock('../_lib/db.js', () => ({
  getDb: () => mockSql,
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

import {
  SNAPSHOT_SOURCE_PRIORITY,
  fetchAvailableSlots,
  resolveSnapshotSource,
} from '../_lib/periscope-query.js';

beforeEach(() => {
  mockSql.mockReset();
});

/** Flatten the tagged-template call into (sqlText, params). */
function lastCall(): { text: string; params: unknown[] } {
  const call = mockSql.mock.calls.at(-1) as [string[], ...unknown[]];
  return { text: (call[0] ?? []).join('?'), params: call.slice(1) };
}

describe('SNAPSHOT_SOURCE_PRIORITY', () => {
  it('prefers the live series, then the EOD backfill, then legacy', () => {
    expect([...SNAPSHOT_SOURCE_PRIORITY]).toEqual([
      'uw_spot',
      'uw_eod',
      'gexbot',
    ]);
  });
});

describe('resolveSnapshotSource', () => {
  it('picks uw_spot when the live feed has rows for the expiry', async () => {
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: true, has_uw_eod: false, has_gexbot: false },
    ]);
    await expect(resolveSnapshotSource('2026-08-21')).resolves.toBe('uw_spot');
  });

  it('prefers uw_spot over uw_eod when BOTH exist for the same day', async () => {
    // The critical case: the EOD backfill also wrote today. Returning
    // both would blend a ~1000x scale gap into one series.
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: true, has_uw_eod: true, has_gexbot: true },
    ]);
    await expect(resolveSnapshotSource('2026-08-21')).resolves.toBe('uw_spot');
  });

  it('falls back to uw_eod for a date that predates the live feed', async () => {
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: false, has_uw_eod: true, has_gexbot: false },
    ]);
    await expect(resolveSnapshotSource('2025-03-14')).resolves.toBe('uw_eod');
  });

  it('falls back to legacy gexbot rows when neither UW series exists', async () => {
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: false, has_uw_eod: false, has_gexbot: true },
    ]);
    await expect(resolveSnapshotSource('2026-05-08')).resolves.toBe('gexbot');
  });

  it('returns null when the expiry has no rows in any series', async () => {
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: false, has_uw_eod: false, has_gexbot: false },
    ]);
    await expect(resolveSnapshotSource('2026-08-22')).resolves.toBeNull();
  });

  it('returns null when the driver hands back no row at all', async () => {
    mockSql.mockResolvedValueOnce([]);
    await expect(resolveSnapshotSource('2026-08-22')).resolves.toBeNull();
  });

  it("accepts the 't' wire form for booleans", async () => {
    // Guards against a driver change silently blanking every panel by
    // making every EXISTS probe look false.
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: 'f', has_uw_eod: 't', has_gexbot: 'f' },
    ]);
    await expect(resolveSnapshotSource('2025-03-14')).resolves.toBe('uw_eod');
  });

  it('probes all three sources for the requested expiry in one round-trip', async () => {
    mockSql.mockResolvedValueOnce([
      { has_uw_spot: true, has_uw_eod: false, has_gexbot: false },
    ]);
    await resolveSnapshotSource('2026-08-21');
    expect(mockSql).toHaveBeenCalledOnce();
    const { text, params } = lastCall();
    expect(text).toContain('EXISTS');
    expect(params).toEqual([
      '2026-08-21',
      'uw_spot',
      '2026-08-21',
      'uw_eod',
      '2026-08-21',
      'gexbot',
    ]);
  });
});

describe('fetchAvailableSlots', () => {
  it('pins the slot list to the given source', async () => {
    mockSql.mockResolvedValueOnce([
      { captured_at: '2026-08-21T14:30:00Z' },
      { captured_at: '2026-08-21T14:40:00Z' },
    ]);
    const slots = await fetchAvailableSlots('2026-08-21', 'uw_spot');
    expect(slots).toEqual(['2026-08-21T14:30:00Z', '2026-08-21T14:40:00Z']);
    const { text, params } = lastCall();
    expect(text).toContain('source =');
    expect(params).toEqual(['2026-08-21', 'uw_spot']);
  });

  it('lists the EOD backfill slot when the day resolved to uw_eod', async () => {
    mockSql.mockResolvedValueOnce([
      { captured_at: new Date('2025-03-14T20:00:00Z') },
    ]);
    const slots = await fetchAvailableSlots('2025-03-14', 'uw_eod');
    expect(slots).toEqual(['2025-03-14T20:00:00.000Z']);
    expect(lastCall().params).toEqual(['2025-03-14', 'uw_eod']);
  });

  it('returns an empty list without querying when the source is null', async () => {
    // null means `resolveSnapshotSource` found no rows for the date in
    // ANY series, so there is nothing to list. Never fall back to an
    // unpinned query: every slot returned here is clicked straight into
    // a source-pinned read, so an unpinned list would advertise slots
    // those reads can't resolve.
    await expect(fetchAvailableSlots('2026-08-21', null)).resolves.toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
