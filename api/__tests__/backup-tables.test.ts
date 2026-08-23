// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockRequest, mockResponse } from './helpers';

const { mockSql, mockPut, mockList, mockDel } = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & {
    unsafe: ReturnType<typeof vi.fn>;
  };
  fn.unsafe = vi.fn((raw: string) => raw);
  return {
    mockSql: fn,
    mockPut: vi.fn(),
    mockList: vi.fn(),
    mockDel: vi.fn(),
  };
});

vi.mock('../_lib/db.js', () => ({
  getDb: vi.fn(() => mockSql),
  withDbRetry: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: { setTag: vi.fn(), captureException: vi.fn() },
}));

vi.mock('@vercel/blob', () => ({
  put: mockPut,
  list: mockList,
  del: mockDel,
}));

vi.mock('../_lib/axiom.js', () => ({
  reportCronRun: vi.fn(),
}));

import handler from '../cron/backup-tables.js';
import { Sentry } from '../_lib/sentry.js';
import { reportCronRun } from '../_lib/axiom.js';

// Fixed date: Sunday 5 AM UTC (typical cron run)
const BACKUP_TIME = new Date('2026-03-29T05:00:00.000Z');
const SNAPSHOT = '2026-03-29';

/** Mirrors the module constants under test. */
const SMALL_TABLE_COUNT = 15;
const TAPE_PART_ROWS = 50_000;
const WALL_BUDGET_MS = 265_000;
const UNIT_RESERVE_MS = 60_000;
/** `createWallBudget` admits a unit only at or before this instant. */
const LAST_SAFE_START_MS = WALL_BUDGET_MS - UNIT_RESERVE_MS; // 205_000

type Row = Record<string, unknown>;

interface SqlRouter {
  /** Rows for one `SELECT * FROM <small table> ... LIMIT/OFFSET` page. */
  small?: (table: string, offset: number) => Row[];
  /** Rows for the `GROUP BY date` trading-day census. */
  days?: () => Row[];
  /** Rows for one keyset page of `strike_exposures` for `date`. */
  page?: (date: string, lastId: number) => Row[];
}

/**
 * Route the tagged-template mock by the SQL text the handler builds.
 * The census carries `GROUP BY`, a tape page carries the `id >` keyset
 * predicate, and everything else is a small-table page.
 */
function installSql(router: SqlRouter): void {
  mockSql.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Array.from(strings).join(' ');
      if (text.includes('GROUP BY')) {
        return Promise.resolve(router.days?.() ?? []);
      }
      if (text.includes('id >')) {
        return Promise.resolve(
          router.page?.(String(values[0]), Number(values[1])) ?? [],
        );
      }
      return Promise.resolve(
        router.small?.(String(values[0]), Number(values[2])) ?? [],
      );
    },
  );
}

/** Every `put()` pathname, in call order. */
function putPaths(): string[] {
  return mockPut.mock.calls.map((c) => String(c[0]));
}

/** Row count of a JSONL Buffer body handed to `put()`. */
function bodyRows(call: unknown[]): number {
  return (call[1] as Buffer).toString('utf-8').split('\n').length;
}

/**
 * Clock driver, mirroring the offsets idiom in
 * `api/__tests__/cleanup-ws-option-trades.test.ts`.
 *
 * The handler calls `Date.now()` once for `startedAt` and once per
 * `canStartAnother()` gate. Hard-coding that call index would break every
 * time a table joins SMALL_TABLES, so the clock is driven off observable
 * progress instead: it holds at t=0 until `afterPuts` uploads have landed,
 * then jumps to `jumpTo` and stays there.
 *
 * `jumpTo` is chosen against the budget arithmetic, not by feel: 230_000
 * sits in the gap between LAST_SAFE_START_MS (205_000) and WALL_BUDGET_MS
 * (265_000). `exhausted()` is still false there — a pre-helper
 * `elapsed > budget` check would happily admit another unit — while
 * `canStartAnother()` refuses. That gap is exactly what these tests pin.
 * The jump is permanent, so a regressed implementation that keeps looping
 * still terminates and fails the count assertion instead of hanging.
 */
function driveClock(afterPuts: number, jumpTo = LAST_SAFE_START_MS + 25_000) {
  const startWall = 1_000_000;
  return vi.spyOn(Date, 'now').mockImplementation(() => {
    const past = mockPut.mock.calls.length >= afterPuts;
    return startWall + (past ? jumpTo : 0);
  });
}

function authedReq() {
  return mockRequest({
    method: 'GET',
    headers: { authorization: 'Bearer test-secret' },
  });
}

interface TapeSummary {
  strategy: string;
  stopReason: string;
  daysTotal: number;
  daysExported: number;
  daysAlreadyPresent: number;
  daysIncomplete: number;
  daysFailed: number;
  rows: number;
  bytes: number;
  parts: number;
  days: {
    date: string;
    rows: number;
    bytes: number;
    parts: number;
    status: string;
  }[];
}

function tapeOf(json: Record<string, unknown>): TapeSummary {
  return json.strikeExposures as unknown as TapeSummary;
}

describe('backup-tables handler', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql.unsafe = vi.fn((raw: string) => raw);
    installSql({});
    mockPut.mockResolvedValue({ url: 'https://blob.test/file' });
    mockList.mockResolvedValue({ blobs: [], hasMore: false });
    mockDel.mockResolvedValue(undefined);
    process.env = { ...originalEnv };
    process.env.CRON_SECRET = 'test-secret';
    vi.setSystemTime(BACKUP_TIME);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── Method guard ──────────────────────────────────────────

  it('returns 405 for non-GET requests', async () => {
    const req = mockRequest({ method: 'POST' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
    expect(res._json).toMatchObject({ error: 'GET only' });
  });

  it('returns 405 for PUT requests', async () => {
    const req = mockRequest({ method: 'PUT' });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  // ── Auth guard ────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({ method: 'GET', headers: {} });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when authorization header is wrong', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer wrongsecret' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('returns 401 when CRON_SECRET is not set', async () => {
    delete process.env.CRON_SECRET;
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer anything' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ error: 'Unauthorized' });
  });

  it('passes auth when CRON_SECRET matches', async () => {
    process.env.CRON_SECRET = 'secret123';
    const req = mockRequest({
      method: 'GET',
      headers: { authorization: 'Bearer secret123' },
    });
    const res = mockResponse();
    await handler(req, res);
    expect(res._status).not.toBe(401);
  });

  // ── Small tables: unchanged whole-table export ─────────────

  it('exports all 15 small tables in full and reports 16 table keys', async () => {
    installSql({ small: () => [{ id: 1, name: 'test' }] });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe(SNAPSHOT);
    expect(json.errors).toBeUndefined();

    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    // 15 small tables + the strike_exposures aggregate roll-up.
    expect(Object.keys(tables)).toHaveLength(16);
    expect(tables.market_snapshots).toEqual({
      rows: 1,
      bytes: expect.any(Number),
    });
    expect(tables.schema_migrations).toEqual({
      rows: 1,
      bytes: expect.any(Number),
    });
    expect(tables.strike_exposures).toEqual({ rows: 0, bytes: 0 });
    expect(json.totalRows).toBe(SMALL_TABLE_COUNT);
  });

  it('calls sql.unsafe once per small table and never for the tape table', async () => {
    installSql({});
    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockSql.unsafe).toHaveBeenCalledTimes(SMALL_TABLE_COUNT);
    expect(mockSql.unsafe).toHaveBeenCalledWith('market_snapshots');
    expect(mockSql.unsafe).toHaveBeenCalledWith('schema_migrations');
    expect(mockSql.unsafe).not.toHaveBeenCalledWith('strike_exposures');
  });

  it('calls put() with correct path, options, and JSONL content', async () => {
    const rows = [
      { id: 1, value: 'alpha' },
      { id: 2, value: 'beta' },
    ];
    installSql({ small: () => rows });

    const res = mockResponse();
    await handler(authedReq(), res);

    const firstCall = mockPut.mock.calls[0]!;
    expect(firstCall[0]).toBe(`backups/${SNAPSHOT}/market_snapshots.jsonl`);

    // Body is a Buffer to dodge V8's ~512 MiB String.maxLength on large
    // tables (RangeError d758f914 fix). Decode for byte-exact comparison.
    const expectedJsonl =
      JSON.stringify(rows[0]) + '\n' + JSON.stringify(rows[1]);
    expect(Buffer.isBuffer(firstCall[1])).toBe(true);
    expect((firstCall[1] as Buffer).toString('utf-8')).toBe(expectedJsonl);
    expect(firstCall[2]).toEqual({
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/x-ndjson',
    });

    expect(mockPut).toHaveBeenCalledTimes(SMALL_TABLE_COUNT);
  });

  it('computes totalBytes from small-table JSONL plus tape parts', async () => {
    const row = { id: 1 };
    installSql({ small: () => [row] });

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Record<string, unknown>;
    const expectedPerTable = Buffer.byteLength(JSON.stringify(row));
    expect(json.totalBytes).toBe(expectedPerTable * SMALL_TABLE_COUNT);
  });

  // SENTRY-EMERALD-DESERT-6T: Vercel Blob's put() rejects empty bodies.
  it('skips put() for empty tables but still records them in results', async () => {
    installSql({});

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.totalRows).toBe(0);
    expect(json.totalBytes).toBe(0);
    expect(json.errors).toBeUndefined();
    expect(mockPut).not.toHaveBeenCalled();

    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    expect(Object.keys(tables)).toHaveLength(16);
    expect(tables.market_snapshots).toEqual({ rows: 0, bytes: 0 });

    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'ok', errors: 0 }),
    );
  });

  // SENTRY-EMERALD-DESERT-6V: Neon's HTTP driver caps responses at 64 MiB.
  it('pages large small tables via LIMIT/OFFSET chunks', async () => {
    const bigTable: Row[] = Array.from({ length: TAPE_PART_ROWS }, (_, i) => ({
      id: i,
    }));
    const tail: Row[] = [{ id: TAPE_PART_ROWS }];

    installSql({
      small: (table, offset) => {
        if (table !== 'market_snapshots') return [{ id: 1 }];
        return offset === 0 ? bigTable : tail;
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    expect(tables.market_snapshots!.rows).toBe(TAPE_PART_ROWS + 1);
    // 50_001 + 14 other small tables × 1 row each.
    expect(json.totalRows).toBe(TAPE_PART_ROWS + 1 + (SMALL_TABLE_COUNT - 1));
  });

  // ── strike_exposures: per-trading-day parts ────────────────

  it('resumes a truncated day from its uploaded parts, not from id 0', async () => {
    // THE bug that made day-granular resume useless. The newest trading day
    // is ~2.96M rows (~60 parts) and cannot finish inside one budget, so it
    // never writes a _done marker. Restarting at lastId=0 re-walks the same
    // parts on every run — forward progress is impossible and daysExported
    // stays 0 forever, which is worse than the timeout this replaced.
    //
    // The cursor is recovered from the part FILENAME (part-NNNN-to-<endId>),
    // so the blob listing already fetched for the marker check doubles as
    // the cursor store: no extra request, no state table, no migration.
    mockList.mockResolvedValue({
      blobs: [
        {
          pathname: `backups/${SNAPSHOT}/strike_exposures/2026-03-27/part-0000-to-777.jsonl`,
          url: 'u',
        },
      ],
      hasMore: false,
    });
    const seenLastIds: number[] = [];
    installSql({
      days: () => [{ date: '2026-03-27', row_count: 2 }],
      page: (date, lastId) => {
        seenLastIds.push(lastId);
        return lastId >= 778 ? [] : [{ id: 778, date, strike: 5000 }];
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    // Resumed at 777 — never re-read from 0.
    expect(seenLastIds[0]).toBe(777);
    expect(seenLastIds).not.toContain(0);
    // And the next part is numbered 0001, not a duplicate 0000.
    expect(putPaths()).toContain(
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/part-0001-to-778.jsonl`,
    );
  });

  it('bounds every page by the day max id so the scan cannot run past the day', async () => {
    // Without an upper bound the planner picks the pkey with a `date` filter
    // and the LIMIT is never satisfied on a day's final page, so the scan
    // runs to the end of the table: measured ~16.8M discarded row-visits
    // against 4.16M exported, and 650ms vs 11ms on the oldest day's last
    // page. The census supplies MIN/MAX(id) precisely to bound this.
    const texts: string[] = [];
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = Array.from(strings).join(' ');
        texts.push(text);
        if (text.includes('GROUP BY')) {
          return Promise.resolve([
            { date: '2026-03-27', row_count: 1, min_id: 5, max_id: 9 },
          ]);
        }
        if (text.includes('id >')) {
          return Promise.resolve(
            Number(values[1]) > 0 ? [] : [{ id: 9, date: '2026-03-27' }],
          );
        }
        return Promise.resolve([]);
      },
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const census = texts.find((x) => x.includes('GROUP BY'));
    expect(census).toMatch(/MIN\(id\)/);
    expect(census).toMatch(/MAX\(id\)/);
    // Smallest day first: a truncated run still completes whole small days
    // instead of stalling forever inside the 60-part monolith.
    expect(census).toMatch(/ORDER BY COUNT\(\*\) ASC/);
    const page = texts.find((x) => x.includes('id >'));
    expect(page).toMatch(/id <=/);
  });

  it('refuses to mark a day complete when the export is short of the census', async () => {
    // Writing _done unconditionally means an empty first page — a dropped
    // connection, a mid-run DELETE — stamps `rows: 0` as "complete", and
    // resume then skips that day permanently. The snapshot would assert a
    // day it does not contain. A backup that quietly lies is worse than one
    // that fails loudly.
    installSql({
      days: () => [{ date: '2026-03-27', row_count: 5000 }],
      page: () => [],
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(putPaths()).not.toContain(
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/_done.jsonl`,
    );
    const tape = (res._json as Record<string, unknown>).strikeExposures as {
      days: { status: string }[];
      daysExported: number;
      daysFailed: number;
    };
    expect(tape.days[0]!.status).toBe('failed');
    expect(tape.daysExported).toBe(0);
    expect(tape.daysFailed).toBe(1);
  });

  it('exports strike_exposures as per-trading-day parts with a _done marker', async () => {
    installSql({
      days: () => [
        { date: '2026-03-27', row_count: 2 },
        { date: '2026-03-26', row_count: 1 },
      ],
      page: (date, lastId) => {
        if (lastId > 0) return [];
        return date === '2026-03-27'
          ? [
              { id: 10, date, strike: 5000 },
              { id: 11, date, strike: 5010 },
            ]
          : [{ id: 1, date, strike: 4900 }];
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const tapePaths = putPaths().filter((p) => p.includes('strike_exposures'));
    expect(tapePaths).toEqual([
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/part-0000-to-11.jsonl`,
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/_done.jsonl`,
      `backups/${SNAPSHOT}/strike_exposures/2026-03-26/part-0000-to-1.jsonl`,
      `backups/${SNAPSHOT}/strike_exposures/2026-03-26/_done.jsonl`,
    ]);

    const json = res._json as Record<string, unknown>;
    const tape = tapeOf(json);
    expect(tape.strategy).toBe('per-trading-day-parts');
    expect(tape.stopReason).toBe('drained');
    expect(tape.daysTotal).toBe(2);
    expect(tape.daysExported).toBe(2);
    expect(tape.daysIncomplete).toBe(0);
    expect(tape.rows).toBe(3);
    expect(tape.parts).toBe(2);
    expect(tape.days.map((d) => d.status)).toEqual(['exported', 'exported']);

    // The aggregate rolls up into the flat table map so totalRows stays honest.
    const tables = json.tables as Record<
      string,
      { rows: number; bytes: number }
    >;
    expect(tables.strike_exposures!.rows).toBe(3);
    expect(json.totalRows).toBe(3);
  });

  it('splits one trading day into bounded parts and advances by keyset id', async () => {
    const first: Row[] = Array.from({ length: TAPE_PART_ROWS }, (_, i) => ({
      id: i + 1,
    }));
    const second: Row[] = [{ id: TAPE_PART_ROWS + 1 }];
    const seenCursors: number[] = [];

    installSql({
      days: () => [{ date: '2026-03-27', row_count: TAPE_PART_ROWS + 1 }],
      page: (_date, lastId) => {
        seenCursors.push(lastId);
        if (lastId === 0) return first;
        if (lastId === TAPE_PART_ROWS) return second;
        return [];
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    // Keyset, not OFFSET: each cursor is the previous page's last id. A
    // short page ends the walk, so no third round-trip is spent proving
    // the day is drained.
    expect(seenCursors).toEqual([0, TAPE_PART_ROWS]);

    const tapeCalls = mockPut.mock.calls.filter((c) =>
      String(c[0]).includes('/strike_exposures/'),
    );
    expect(tapeCalls.map((c) => String(c[0]))).toEqual([
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/part-0000-to-50000.jsonl`,
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/part-0001-to-50001.jsonl`,
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/_done.jsonl`,
    ]);

    // No single body may hold more than one page — this is the OOM guard.
    expect(bodyRows(tapeCalls[0]!)).toBe(TAPE_PART_ROWS);
    expect(bodyRows(tapeCalls[1]!)).toBe(1);

    const tape = tapeOf(res._json as Record<string, unknown>);
    expect(tape.rows).toBe(TAPE_PART_ROWS + 1);
    expect(tape.parts).toBe(2);
  });

  it('never queries strike_exposures with OFFSET', async () => {
    const texts: string[] = [];
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = Array.from(strings).join(' ');
        texts.push(text);
        if (text.includes('GROUP BY')) {
          return Promise.resolve([{ date: '2026-03-27', row_count: 1 }]);
        }
        if (text.includes('id >')) {
          return Promise.resolve(Number(values[1]) === 0 ? [{ id: 7 }] : []);
        }
        return Promise.resolve([]);
      },
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    const tapeQueries = texts.filter((t) => t.includes('strike_exposures'));
    expect(tapeQueries.length).toBeGreaterThan(0);
    for (const q of tapeQueries) {
      expect(q).not.toContain('OFFSET');
    }
  });

  it('writes a _done marker recording the day summary', async () => {
    installSql({
      days: () => [{ date: '2026-03-27', row_count: 1 }],
      page: (_d, lastId) => (lastId === 0 ? [{ id: 9 }] : []),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    const done = mockPut.mock.calls.find((c) =>
      String(c[0]).endsWith('_done.jsonl'),
    )!;
    expect(done[0]).toBe(
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/_done.jsonl`,
    );
    const marker = JSON.parse((done[1] as Buffer).toString('utf-8')) as Record<
      string,
      unknown
    >;
    expect(marker).toMatchObject({
      table: 'strike_exposures',
      date: '2026-03-27',
      snapshot: SNAPSHOT,
      rows: 1,
      parts: 1,
    });
  });

  it('resumes across runs: days already marked done are not re-exported', async () => {
    mockList.mockImplementation(({ prefix }: { prefix: string }) => {
      if (prefix === 'backups/') {
        return Promise.resolve({ blobs: [], hasMore: false });
      }
      return Promise.resolve({
        blobs: [
          {
            pathname: `backups/${SNAPSHOT}/strike_exposures/2026-03-27/_done.jsonl`,
            url: 'https://blob.test/done',
          },
        ],
        hasMore: false,
      });
    });

    installSql({
      days: () => [
        { date: '2026-03-27', row_count: 4 },
        { date: '2026-03-26', row_count: 1 },
      ],
      page: (date, lastId) =>
        lastId === 0 && date === '2026-03-26' ? [{ id: 1 }] : [],
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    const tapePaths = putPaths().filter((p) =>
      p.includes('/strike_exposures/'),
    );
    expect(tapePaths.every((p) => !p.includes('2026-03-27'))).toBe(true);

    const tape = tapeOf(res._json as Record<string, unknown>);
    expect(tape.daysAlreadyPresent).toBe(1);
    expect(tape.daysExported).toBe(1);
    const resumed = tape.days.find((d) => d.date === '2026-03-27')!;
    expect(resumed.status).toBe('already_present');
    // Row count comes from the census so the summary stays complete.
    expect(resumed.rows).toBe(4);
  });

  // ── Wall budget ───────────────────────────────────────────

  it('refuses a tape part it cannot finish and reports stopReason wall_budget', async () => {
    // Every page is full, so the day never drains — only the budget can
    // stop the loop.
    const fullPage: Row[] = Array.from({ length: TAPE_PART_ROWS }, (_, i) => ({
      id: i + 1,
    }));
    let cursor = 0;
    installSql({
      small: () => [{ id: 1 }],
      days: () => [{ date: '2026-03-27', row_count: 10_000_000 }],
      page: () => {
        cursor += TAPE_PART_ROWS;
        return fullPage.map((r) => ({ id: cursor + Number(r.id) }));
      },
    });

    // 15 small-table uploads, then one tape part, then the clock jumps.
    const clock = driveClock(SMALL_TABLE_COUNT + 1);
    const res = mockResponse();
    await handler(authedReq(), res);
    clock.mockRestore();

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    expect(json.stopReason).toBe('wall_budget');

    const tape = tapeOf(json);
    expect(tape.stopReason).toBe('wall_budget');
    expect(tape.parts).toBe(1);
    expect(tape.rows).toBe(TAPE_PART_ROWS);
    expect(tape.days[0]!.status).toBe('wall_budget');

    // Exactly one tape part uploaded — proves the refusal happened before
    // the second page was ever awaited. No _done marker: the day is
    // incomplete and must not look finished to a restore.
    const tapePaths = putPaths().filter((p) =>
      p.includes('/strike_exposures/'),
    );
    expect(tapePaths).toEqual([
      `backups/${SNAPSHOT}/strike_exposures/2026-03-27/part-0000-to-100000.jsonl`,
    ]);

    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({
        status: 'partial',
        stopReason: 'wall_budget',
        complete: false,
      }),
    );
  });

  it('records every un-exported day so the gap is visible', async () => {
    const fullPage: Row[] = Array.from({ length: TAPE_PART_ROWS }, (_, i) => ({
      id: i + 1,
    }));
    let cursor = 0;
    installSql({
      small: () => [{ id: 1 }],
      days: () => [
        { date: '2026-03-27', row_count: 10_000_000 },
        { date: '2026-03-26', row_count: 12 },
        { date: '2026-03-25', row_count: 7 },
      ],
      page: () => {
        cursor += TAPE_PART_ROWS;
        return fullPage.map((r) => ({ id: cursor + Number(r.id) }));
      },
    });

    const clock = driveClock(SMALL_TABLE_COUNT + 1);
    const res = mockResponse();
    await handler(authedReq(), res);
    clock.mockRestore();

    const tape = tapeOf(res._json as Record<string, unknown>);
    expect(tape.daysTotal).toBe(3);
    // The first day landed one part but never its _done marker, so it is
    // incomplete too — all three days are unrestorable and say so.
    expect(tape.daysExported).toBe(0);
    expect(tape.daysIncomplete).toBe(3);
    expect(tape.days.map((d) => `${d.date}:${d.status}`)).toEqual([
      '2026-03-27:wall_budget',
      '2026-03-26:wall_budget',
      '2026-03-25:wall_budget',
    ]);
  });

  it('keeps the small tables intact when the tape export is budget-starved', async () => {
    const fullPage: Row[] = Array.from({ length: TAPE_PART_ROWS }, (_, i) => ({
      id: i + 1,
    }));
    let cursor = 0;
    installSql({
      small: () => [{ id: 1 }],
      days: () => [{ date: '2026-03-27', row_count: 10_000_000 }],
      page: () => {
        cursor += TAPE_PART_ROWS;
        return fullPage.map((r) => ({ id: cursor + Number(r.id) }));
      },
    });

    const clock = driveClock(SMALL_TABLE_COUNT + 1);
    const res = mockResponse();
    await handler(authedReq(), res);
    clock.mockRestore();

    const json = res._json as Record<string, unknown>;
    const tables = json.tables as Record<string, { rows: number }>;
    // All 15 small tables backed up in full despite the tape starving.
    for (const key of Object.keys(tables)) {
      if (key === 'strike_exposures') continue;
      expect(tables[key]!.rows).toBe(1);
    }
    expect(json.stopReason).toBe('wall_budget');
  });

  // ── Failure isolation ─────────────────────────────────────

  it('continues when a single small-table export fails', async () => {
    installSql({
      small: (table) => {
        if (table === 'outcomes') {
          throw new Error('relation "outcomes" does not exist');
        }
        return [{ id: 1 }];
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const tables = json.tables as Record<string, unknown>;
    // 14 successful small tables + strike_exposures aggregate.
    expect(Object.keys(tables)).toHaveLength(15);
    expect(tables.outcomes).toBeUndefined();

    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('outcomes');

    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledTimes(SMALL_TABLE_COUNT - 1);

    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({ status: 'partial', errors: 1 }),
    );
  });

  it('continues when put() fails for a table', async () => {
    installSql({ small: () => [{ id: 1 }] });
    let putCallCount = 0;
    mockPut.mockImplementation(async () => {
      putCallCount++;
      if (putCallCount === 2) throw new Error('Blob upload failed');
      return { url: 'https://blob.test/file' };
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Blob upload failed');
  });

  it('handles non-Error throws in table export', async () => {
    installSql({
      small: (table) => {
        if (table === 'market_snapshots') throw 'string error';
        return [];
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Unknown error');
  });

  it('isolates a tape-day failure from the other days and the small tables', async () => {
    installSql({
      small: () => [{ id: 1 }],
      days: () => [
        { date: '2026-03-27', row_count: 1 },
        { date: '2026-03-26', row_count: 1 },
      ],
      page: (date, lastId) => {
        if (date === '2026-03-27') throw new Error('page read exploded');
        return lastId === 0 ? [{ id: 1 }] : [];
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('strike_exposures 2026-03-27');
    expect(errors[0]).toContain('page read exploded');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);

    const tape = tapeOf(json);
    expect(tape.days.find((d) => d.date === '2026-03-27')!.status).toBe(
      'failed',
    );
    expect(tape.days.find((d) => d.date === '2026-03-26')!.status).toBe(
      'exported',
    );
    expect(tape.daysExported).toBe(1);
    expect(tape.daysFailed).toBe(1);

    // Small tables untouched by the tape failure.
    const tables = json.tables as Record<string, { rows: number }>;
    expect(tables.market_snapshots!.rows).toBe(1);
  });

  it('records a census failure without killing the small-table backup', async () => {
    installSql({
      small: () => [{ id: 1 }],
      days: () => {
        throw new Error('census failed');
      },
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors.some((e) => e.includes('census failed'))).toBe(true);
    const tables = json.tables as Record<string, { rows: number }>;
    expect(tables.market_snapshots!.rows).toBe(1);
  });

  it('rejects a tape page whose last row has no numeric id', async () => {
    installSql({
      days: () => [{ date: '2026-03-27', row_count: 1 }],
      page: () => [{ nope: true }],
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('keyset cursor');
  });

  // ── Pruning ───────────────────────────────────────────────

  it('prunes blobs older than 4 weeks, nested tape parts included', async () => {
    mockList.mockImplementation(({ prefix }: { prefix: string }) => {
      if (prefix !== 'backups/') {
        return Promise.resolve({ blobs: [], hasMore: false });
      }
      return Promise.resolve({
        blobs: [
          {
            pathname: 'backups/2026-02-15/market_snapshots.jsonl',
            url: 'https://blob.test/old1',
          },
          {
            pathname:
              'backups/2026-02-28/strike_exposures/2026-02-27/part-0003.jsonl',
            url: 'https://blob.test/old2',
          },
          {
            pathname: 'backups/2026-03-22/analyses.jsonl',
            url: 'https://blob.test/recent',
          },
        ],
        hasMore: false,
      });
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(mockDel).toHaveBeenCalledWith([
      'https://blob.test/old1',
      'https://blob.test/old2',
    ]);
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(2);
  });

  it('paginates the prune listing so old blobs past page 1 are still seen', async () => {
    const page1 = {
      blobs: [
        {
          pathname: 'backups/2026-03-22/analyses.jsonl',
          url: 'https://blob.test/recent',
        },
      ],
      cursor: 'cursor-1',
      hasMore: true,
    };
    const page2 = {
      blobs: [
        {
          pathname:
            'backups/2026-01-04/strike_exposures/2026-01-02/part-0000.jsonl',
          url: 'https://blob.test/ancient',
        },
      ],
      hasMore: false,
    };

    mockList.mockImplementation(
      ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
        if (prefix !== 'backups/') {
          return Promise.resolve({ blobs: [], hasMore: false });
        }
        return Promise.resolve(cursor === 'cursor-1' ? page2 : page1);
      },
    );

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'backups/', cursor: 'cursor-1' }),
    );
    expect(mockDel).toHaveBeenCalledWith(['https://blob.test/ancient']);
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(1);
  });

  it('batches the delete list so one prune cannot send thousands of URLs', async () => {
    // A pruned snapshot now holds ~90 tape parts per trading day, so the
    // URL list is no longer bounded by the table count.
    const stale = Array.from({ length: 150 }, (_, i) => ({
      pathname: `backups/2026-01-04/strike_exposures/2026-01-02/part-${String(i).padStart(4, '0')}.jsonl`,
      url: `https://blob.test/stale-${i}`,
    }));
    mockList.mockImplementation(({ prefix }: { prefix: string }) => {
      if (prefix !== 'backups/') {
        return Promise.resolve({ blobs: [], hasMore: false });
      }
      return Promise.resolve({ blobs: stale, hasMore: false });
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockDel).toHaveBeenCalledTimes(2);
    expect((mockDel.mock.calls[0]![0] as string[]).length).toBe(100);
    expect((mockDel.mock.calls[1]![0] as string[]).length).toBe(50);
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(150);
  });

  it('does not delete blobs within retention window', async () => {
    mockList.mockImplementation(({ prefix }: { prefix: string }) => {
      if (prefix !== 'backups/') {
        return Promise.resolve({ blobs: [], hasMore: false });
      }
      return Promise.resolve({
        blobs: [
          {
            pathname: 'backups/2026-03-08/analyses.jsonl',
            url: 'https://blob.test/keep1',
          },
          {
            pathname: 'backups/2026-03-22/analyses.jsonl',
            url: 'https://blob.test/keep3',
          },
        ],
        hasMore: false,
      });
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
  });

  it('skips blobs with non-matching pathname format', async () => {
    mockList.mockImplementation(({ prefix }: { prefix: string }) => {
      if (prefix !== 'backups/') {
        return Promise.resolve({ blobs: [], hasMore: false });
      }
      return Promise.resolve({
        blobs: [
          {
            pathname: 'backups/not-a-date/file.jsonl',
            url: 'https://blob.test/weird',
          },
          {
            pathname: 'other-prefix/2020-01-01/file.jsonl',
            url: 'https://blob.test/other',
          },
        ],
        hasMore: false,
      });
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(mockDel).not.toHaveBeenCalled();
    const json = res._json as Record<string, unknown>;
    expect(json.pruned).toBe(0);
  });

  it('handles pruning failure without crashing the backup', async () => {
    mockList.mockRejectedValue(new Error('Blob list failed'));
    installSql({ small: () => [{ id: 1 }] });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors.some((e) => e.includes('pruning'))).toBe(true);
    expect(errors.some((e) => e.includes('Blob list failed'))).toBe(true);
    expect(Sentry.setTag).toHaveBeenCalledWith('cron.job', 'backup-tables');
    expect(json.totalRows).toBeDefined();
    expect(json.pruned).toBe(0);
  });

  it('handles non-Error throws in pruning', async () => {
    mockList.mockRejectedValue('blob service down');

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Record<string, unknown>;
    const errors = json.errors as string[];
    expect(errors.some((e) => e.includes('pruning'))).toBe(true);
    expect(errors.some((e) => e.includes('Unknown'))).toBe(true);
  });

  // ── Response shape ────────────────────────────────────────

  it('uses the current date in the backup path', async () => {
    vi.setSystemTime(new Date('2026-12-25T05:00:00.000Z'));
    installSql({ small: () => [{ id: 1 }] });

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Record<string, unknown>;
    expect(json.date).toBe('2026-12-25');
    expect(String(mockPut.mock.calls[0]![0])).toMatch(/^backups\/2026-12-25\//);
  });

  it('returns all required fields in the response', async () => {
    installSql({ small: () => [{ id: 1 }] });

    const res = mockResponse();
    await handler(authedReq(), res);

    const json = res._json as Record<string, unknown>;
    expect(json).toHaveProperty('date');
    expect(json).toHaveProperty('tables');
    expect(json).toHaveProperty('totalRows');
    expect(json).toHaveProperty('totalBytes');
    expect(json).toHaveProperty('pruned');
    expect(json).toHaveProperty('stopReason');
    expect(json).toHaveProperty('durationMs');
    expect(json).toHaveProperty('strikeExposures');
    expect(json.errors).toBeUndefined();
    expect(json.stopReason).toBe('drained');
  });

  it('includes errors field only when there are errors', async () => {
    installSql({});
    const res1 = mockResponse();
    await handler(authedReq(), res1);
    expect((res1._json as Record<string, unknown>).errors).toBeUndefined();

    vi.resetAllMocks();
    mockSql.unsafe = vi.fn((raw: string) => raw);
    mockSql.mockRejectedValue(new Error('DB down'));
    mockList.mockResolvedValue({ blobs: [], hasMore: false });
    mockPut.mockResolvedValue({ url: 'https://blob.test/file' });
    const res2 = mockResponse();
    await handler(authedReq(), res2);
    expect((res2._json as Record<string, unknown>).errors).toBeDefined();
  });

  it('reports the tape strategy to Axiom on a clean run', async () => {
    installSql({
      days: () => [{ date: '2026-03-27', row_count: 1 }],
      page: (_d, lastId) => (lastId === 0 ? [{ id: 3 }] : []),
    });

    const res = mockResponse();
    await handler(authedReq(), res);

    expect(res._status).toBe(200);
    expect(reportCronRun).toHaveBeenCalledWith(
      'backup-tables',
      expect.objectContaining({
        status: 'ok',
        stopReason: 'drained',
        complete: true,
        strikeExposureStrategy: 'per-trading-day-parts',
        strikeExposureDays: 1,
        strikeExposureRows: 1,
        strikeExposureIncompleteDays: 0,
      }),
    );
  });
});
