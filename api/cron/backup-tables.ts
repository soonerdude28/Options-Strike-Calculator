/**
 * GET /api/cron/backup-tables
 *
 * Weekly logical backup of every database table to Vercel Blob as JSONL,
 * with a rolling 4-week retention window.
 *
 * ## Blob layout
 *
 *   backups/{snapshot}/{table}.jsonl                                  ← small tables
 *   backups/{snapshot}/strike_exposures/{tradingDate}/part-{NNNN}.jsonl
 *   backups/{snapshot}/strike_exposures/{tradingDate}/_done.jsonl     ← day complete marker
 *
 * `{snapshot}` is always the FIRST path segment, however deep the rest
 * nests, so `pruneOldBackups()`'s date regex keeps matching every object
 * and retention never leaks.
 *
 * ## Why strike_exposures gets its own strategy
 *
 * Measured in production on 2026-08-21:
 *
 *   15 small tables combined:      31,427 rows /    ~9 MB
 *   strike_exposures alone:     4,163,527 rows / 2,988 MB of JSONL
 *
 * One table is 99.25% of the rows and ~330× the bytes of everything else
 * put together. The old implementation ran `SELECT *` in LIMIT/OFFSET
 * pages, appended every page to one array, and `Buffer.concat`ed the lot
 * before calling `put()` — roughly 3 GB of fragments plus a 3 GB concat
 * destination against a 2 GB function. It was killed by the OOM reaper on
 * every single run since it shipped (Sentry "Cron failure: backup-tables",
 * last successful check-in: never). The kill happens before any `catch`
 * or `finally`, which is why the check-in opened at entry never closed and
 * Sentry reported it as a timeout.
 *
 * **Chosen strategy: per-trading-day, part-chunked files that resume
 * across runs.** `strike_exposures` is append-only by trading day, has an
 * indexed `date` column (`idx_strike_exp_date_ticker`) and a monotonic
 * `id SERIAL PRIMARY KEY` that is contiguous within a day, so the table
 * partitions cleanly with no migration. Each unit of work is one keyset
 * page — `TAPE_PART_ROWS` rows, ~33 MB of JSONL — uploaded as its own
 * blob and then dropped. Peak memory is bounded by ONE page, not by the
 * table. The alternative (dropping the table from the backup) was
 * rejected: it is 99% of the data, and the only other archive of it
 * (`scripts/archive-signals.ts`) is a manual local script that filters to
 * three tickers.
 *
 * Keyset, not OFFSET: measured page latency at OFFSET 4,000,000 was
 * 6.8 s vs 0.84 s for `WHERE id > $1`. 84 OFFSET pages alone exceeded
 * `maxDuration` before a byte was uploaded.
 *
 * Days are exported newest-first: if the run truncates, the snapshot
 * holds the freshest sessions, which is what a restore actually wants.
 *
 * ## Honest partial completion
 *
 * Every unit is admitted through `createWallBudget().canStartAnother()`,
 * so the handler never starts a page it cannot finish and always returns
 * a 200 with its counts — which is what lets `withCronCheckin` close the
 * Sentry check-in. `stopReason` is `'drained'` or `'wall_budget'`, and
 * `strikeExposures.days[]` names every trading day with the status it
 * actually reached (`exported` / `already_present` / `wall_budget` /
 * `failed`). Nothing is ever silently dropped.
 *
 * ## Restore notes (no restore script exists in this repo yet)
 *
 * A day is restorable only if its `_done.jsonl` marker is present — that
 * marker is written after the last part and records the row/part counts.
 * A day directory without it is a truncated attempt. Parts sort
 * lexicographically in keyset order. `strike_exposures` has
 * `UNIQUE(date, timestamp, ticker, strike, expiry)`, so a restore can
 * `INSERT ... ON CONFLICT DO NOTHING` and be resumed safely; `id` is
 * dumped verbatim, so any restore that inserts it must `setval` the
 * sequence afterwards. DECIMAL columns round-trip as JSON strings — do
 * not `Number.parseFloat` them back or precision is lost.
 *
 * Designed to run weekly on Sundays at 5 AM UTC via Vercel Cron.
 *
 * Environment: CRON_SECRET, BLOB_READ_WRITE_TOKEN (auto-provisioned by Vercel Blob)
 */

import { put, list, del } from '@vercel/blob';
import { getDb, withDbRetry } from '../_lib/db.js';
import { createWallBudget, type WallBudget } from '../_lib/wall-budget.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { cronGuard } from '../_lib/api-helpers.js';
import { reportCronRun } from '../_lib/axiom.js';
import { withCronCheckin } from '../_lib/cron-instrumentation.js';

export const config = { maxDuration: 300 };

/**
 * Every table except the tape table, in dependency order (parents before
 * children). 31k rows / ~9 MB combined — each is exported whole.
 */
const SMALL_TABLES = [
  'market_snapshots',
  'analyses',
  'outcomes',
  'positions',
  'lessons',
  'lesson_reports',
  'flow_data',
  'greek_exposure',
  'spot_exposures',
  'training_features',
  'day_labels',
  'economic_events',
  'es_bars',
  'es_overnight_summaries',
  'schema_migrations',
] as const;

/** The one table too large to export whole. See the header comment. */
const TAPE_TABLE = 'strike_exposures';
const TAPE_STRATEGY = 'per-trading-day-parts';
const DONE_MARKER = '_done.jsonl';

const RETENTION_WEEKS = 4;

// Neon's serverless HTTP driver caps responses at 64 MiB (67,108,864
// bytes). One unbounded SELECT * on a table that has grown past ~50 MB
// overruns the cap and the whole backup row aborts with HTTP 507. Chunk
// via LIMIT/OFFSET; 50k rows × ~1 KB/row = ~50 MB per round-trip,
// comfortably under the limit. See SENTRY-EMERALD-DESERT-6V.
const EXPORT_CHUNK_ROWS = 50_000;

/**
 * Rows per `strike_exposures` blob part. 50k rows of this table measured
 * ~33 MB of JSONL — half of Neon's 64 MiB HTTP cap, and ~350 MB of peak
 * RSS for the rows + the serialised body, so a 2 GB function holds one
 * comfortably. Raising this trades headroom on both limits for fewer
 * round-trips; do not exceed 50k.
 */
const TAPE_PART_ROWS = 50_000;

/** Per-attempt timeout for a tape page. Measured latency is ~0.9 s. */
const TAPE_READ_TIMEOUT_MS = 15_000;
/** One retry (2 attempts) — see UNIT_RESERVE_MS for why not more. */
const TAPE_READ_RETRIES = 1;

/**
 * Wall allowance inside `maxDuration: 300`. The remaining ~35 s covers
 * `reportCronRun` and the JSON response — the run must always answer, or
 * `withCronCheckin` never closes its Sentry check-in and the job looks
 * like a timeout even when it did useful work.
 */
const WALL_BUDGET_MS = 265_000;

/**
 * Worst case of ONE unit of work, which is what `canStartAnother()`
 * reserves. The two unit kinds both fit under it:
 *   - one tape part: 2 attempts × 15 s read + 1 s backoff + a 33 MB
 *     upload ≈ 51 s.
 *   - one small table: `withDbRetry(_, 2, 10_000)` worst case 33 s plus
 *     a sub-megabyte upload.
 * Understating this is exactly the bug `wall-budget.ts` exists to
 * prevent, so it is deliberately sized off the retry arithmetic rather
 * than off observed latency.
 */
const UNIT_RESERVE_MS = 60_000;

/** Blob `list()` page size, and the batch size for `del()`. */
const BLOB_LIST_LIMIT = 1000;
const BLOB_DELETE_BATCH = 100;

/**
 * Upload ceiling, in ms.
 *
 * UNIT_RESERVE_MS budgets one unit of work as "DB read + upload". The read
 * half is genuinely bounded (withDbRetry's attempt timeout × retries); the
 * upload half was not — `put()` has no default timeout and @vercel/blob
 * retries internally with backoff on 5xx. A 30 MB part that hits those
 * retries could outlast the reserve, overrun the budget into the response
 * margin, and re-create the never-closing check-in this rewrite exists to
 * fix. Measured throughput is 18.0–18.5 MB/s, so a 30 MB part is ~1.7s;
 * 25s is ~15× that and still comfortably inside the 60s reserve alongside
 * the read's 31s worst case.
 */
const PUT_TIMEOUT_MS = 25_000;

const PUT_OPTS = {
  access: 'private',
  allowOverwrite: true,
  contentType: 'application/x-ndjson',
} as const;

/** `put()` with an explicit ceiling — see PUT_TIMEOUT_MS. */
function putBounded(path: string, body: Buffer): Promise<unknown> {
  return put(path, body, {
    ...PUT_OPTS,
    abortSignal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  });
}

type StopReason = 'drained' | 'wall_budget';
type DayStatus = 'exported' | 'already_present' | 'wall_budget' | 'failed';

/**
 * One trading day of the tape, as reported by the census.
 *
 * `minId`/`maxId` are what let each page be a bounded range scan. Without
 * the upper bound the planner picks the pkey with a `date` filter and the
 * final page of every day scans to the end of the table — measured at
 * ~16.8M discarded row-visits against 4.16M exported, and 650ms vs 11ms on
 * the oldest day's last page.
 */
interface TapeDay {
  date: string;
  rows: number;
  minId: number;
  maxId: number;
}

interface TapeDayResult {
  date: string;
  rows: number;
  bytes: number;
  parts: number;
  status: DayStatus;
}

/**
 * Export one small table as a JSONL `Buffer`.
 * Uses sql.unsafe() for dynamic table names (safe here — names are
 * hardcoded constants).
 *
 * Pages through the table in `EXPORT_CHUNK_ROWS`-sized batches so a table
 * that grows can't trip Neon's 64 MiB HTTP response cap. Buffering the
 * whole result is fine here and only here: these 15 tables total ~9 MB.
 *
 * Returns a `Buffer` rather than a `string` because V8's `String.maxLength`
 * is ~512 MiB — a large enough table would throw `RangeError: Invalid
 * string length` on the final `join` even when the per-chunk reads succeed
 * (see SENTRY-EMERALD-DESERT — RangeError d758f914 on 2026-05-17).
 *
 * Rows are joined by `\n` with no trailing newline. Nothing in this repo
 * reads these files yet, so that layout is a convention, not a contract —
 * a restore should `split('\n').filter(Boolean)` and tolerate either.
 *
 * ORDER BY a stable surrogate key so successive pages don't overlap or
 * skip rows mid-export — most tables have an `id` PK; for the few that
 * don't (schema_migrations) the row count is small enough that a single
 * chunk covers it.
 */
async function exportTable(
  tableName: string,
): Promise<{ body: Buffer; rowCount: number }> {
  const sql = getDb();
  const chunks: Buffer[] = [];
  const NEWLINE = Buffer.from('\n');
  let rowCount = 0;
  let offset = 0;
  while (true) {
    const rows = (await withDbRetry(
      () => sql`
        SELECT * FROM ${sql.unsafe(tableName)}
        ORDER BY 1
        LIMIT ${EXPORT_CHUNK_ROWS}
        OFFSET ${offset}
      `,
      2,
      10_000,
    )) as Record<string, unknown>[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (chunks.length > 0) chunks.push(NEWLINE);
      chunks.push(Buffer.from(JSON.stringify(row)));
    }
    rowCount += rows.length;
    if (rows.length < EXPORT_CHUNK_ROWS) break;
    offset += EXPORT_CHUNK_ROWS;
  }
  return { body: Buffer.concat(chunks), rowCount };
}

/** Normalise whatever the driver hands back for a DATE column. */
function toDateStr(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Census of the trading days present in the tape table, newest first.
 * `date` is the leading column of `idx_strike_exp_date_ticker`, so this
 * is an index-only scan and the counts come free — they let the summary
 * report a resumed (already-uploaded) day's size without re-reading it.
 */
async function listTapeDays(): Promise<TapeDay[]> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT date, COUNT(*)::int AS row_count,
             MIN(id)::bigint AS min_id, MAX(id)::bigint AS max_id
      FROM strike_exposures
      GROUP BY date
      ORDER BY COUNT(*) ASC
    `,
    TAPE_READ_RETRIES,
    TAPE_READ_TIMEOUT_MS,
  )) as Record<string, unknown>[];
  return rows.map((r) => ({
    date: toDateStr(r.date),
    rows: Number(r.row_count) || 0,
    minId: Number(r.min_id) || 0,
    maxId: Number(r.max_id) || 0,
  }));
}

/**
 * Every blob under `prefix`, following the SDK's cursor.
 *
 * `list()` defaults to 1000 results and returns `hasMore`/`cursor`; the
 * previous implementation read only the first page. With one blob per
 * table that was invisible, but per-day parts multiply the object count
 * and an unpaginated prune would silently stop deleting the oldest
 * snapshots — retention failing quietly is worse than failing loudly.
 */
async function listAllBlobs(
  prefix: string,
): Promise<{ pathname: string; url: string }[]> {
  const out: { pathname: string; url: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: BLOB_LIST_LIMIT });
    for (const blob of page.blobs) {
      out.push({ pathname: blob.pathname, url: blob.url });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** `backups/{snapshot}/strike_exposures/{day}/` */
function tapeDayPrefix(snapshot: string, day: string): string {
  return `backups/${snapshot}/${TAPE_TABLE}/${day}/`;
}

function tapePartName(index: number, endId: number): string {
  return `part-${String(index).padStart(4, '0')}-to-${endId}.jsonl`;
}

/**
 * Recover a truncated day's keyset cursor from the parts already uploaded.
 *
 * Day-granular resume (marker present / absent) is not enough. The newest
 * trading day is ~2.96M rows = ~60 parts and cannot finish in one budget,
 * so it never writes a marker — and a resume that restarts at `lastId = 0`
 * re-walks the same parts forever, making forward progress impossible. That
 * is a permanent `daysExported: 0`, which is worse than the timeout this
 * rewrite replaced.
 *
 * The part name carries its own end id, so the blob listing we already
 * fetch for the marker check doubles as the cursor store — no extra
 * request, no migration, no state table.
 */
function resumeCursor(
  paths: Iterable<string>,
  prefix: string,
): { lastId: number; parts: number; rows: number } {
  let lastId = 0;
  let parts = 0;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const m = /part-(\d{4})-to-(\d+)\.jsonl$/.exec(path);
    if (!m) continue;
    parts = Math.max(parts, Number(m[1]) + 1);
    lastId = Math.max(lastId, Number(m[2]));
  }
  // Every completed part is exactly TAPE_PART_ROWS rows — a short page ends
  // the walk, so only the final part can be smaller and it is never resumed
  // past. This is what lets the completeness check below be exact.
  return { lastId, parts, rows: parts * TAPE_PART_ROWS };
}

/**
 * Export one trading day of the tape table as a sequence of bounded
 * parts, walking a keyset cursor on `id`.
 *
 * The budget gate is the first statement of the loop, strictly before the
 * page read — gating on "has the budget elapsed" instead would admit a
 * page with 0.1 s left and lose the whole response. Stopping early leaves
 * the day's `_done.jsonl` unwritten, which is precisely how a restore
 * tells a truncated day from a complete one.
 */
async function exportTapeDay(
  snapshot: string,
  day: TapeDay,
  budget: WallBudget,
  existingPaths: Iterable<string>,
): Promise<{ rows: number; bytes: number; parts: number; status: DayStatus }> {
  const sql = getDb();
  const prefix = tapeDayPrefix(snapshot, day.date);
  const maxId = day.maxId;
  // Resume where a previous run stopped rather than at 0 — see resumeCursor.
  const resumed = resumeCursor(existingPaths, prefix);
  let lastId = resumed.lastId;
  let rows = 0;
  let bytes = 0;
  let parts = resumed.parts;

  while (true) {
    if (!budget.canStartAnother()) {
      return { rows, bytes, parts, status: 'wall_budget' };
    }

    // Uncast bind: `date = ${day}` lets Postgres coerce the literal to
    // DATE. An explicit `::text` cast here raises "operator does not
    // exist: date = text".
    const page = (await withDbRetry(
      () => sql`
        SELECT * FROM strike_exposures
        WHERE date = ${day.date} AND id > ${lastId} AND id <= ${maxId}
        ORDER BY id
        LIMIT ${TAPE_PART_ROWS}
      `,
      TAPE_READ_RETRIES,
      TAPE_READ_TIMEOUT_MS,
    )) as Record<string, unknown>[];
    if (page.length === 0) break;

    const nextId = Number(page.at(-1)?.id);
    if (!Number.isFinite(nextId) || nextId <= lastId) {
      throw new Error(
        `${TAPE_TABLE} ${day}: cannot advance the keyset cursor past id ${lastId}`,
      );
    }

    // One page → one body → one blob → dropped. This is the whole memory
    // fix: nothing accumulates across parts.
    const body = Buffer.from(
      page.map((row) => JSON.stringify(row)).join('\n'),
      'utf-8',
    );
    await putBounded(`${prefix}${tapePartName(parts, nextId)}`, body);

    rows += page.length;
    bytes += body.byteLength;
    parts += 1;
    lastId = nextId;

    if (page.length < TAPE_PART_ROWS) break;
  }

  // Only claim completeness if the census row count was actually reached.
  // Writing the marker unconditionally means an empty first page (a lost
  // connection, a mid-run DELETE) yields `rows: 0, parts: 0` stamped
  // "complete" — and resume then skips that day forever, so the snapshot
  // asserts a day it does not contain. A backup that quietly lies is worse
  // than one that fails, so short exports report `failed` and are retried.
  const expected = resumed.rows + rows;
  if (day.rows > 0 && expected < day.rows) {
    logger.error(
      {
        table: TAPE_TABLE,
        date: day.date,
        exported: expected,
        expected: day.rows,
      },
      'Tape day short of census count — not marking complete',
    );
    return { rows, bytes, parts, status: 'failed' };
  }

  // Completion marker. Non-empty by construction — put() rejects empty
  // bodies with "body is required" (SENTRY-EMERALD-DESERT-6T).
  const marker = Buffer.from(
    JSON.stringify({
      table: TAPE_TABLE,
      snapshot,
      date: day.date,
      rows: expected,
      parts,
    }),
    'utf-8',
  );
  await putBounded(`${prefix}${DONE_MARKER}`, marker);

  return { rows, bytes, parts, status: 'exported' };
}

/**
 * Delete backup folders older than the retention window.
 * The date regex reads the FIRST path segment, so nested tape parts prune
 * with their snapshot.
 */
async function pruneOldBackups(currentDate: string): Promise<string[]> {
  const cutoff = new Date(currentDate);
  cutoff.setDate(cutoff.getDate() - RETENTION_WEEKS * 7);

  const blobs = await listAllBlobs('backups/');
  const toDelete: string[] = [];

  for (const blob of blobs) {
    // Extract date from path: backups/2026-03-21/table.jsonl → 2026-03-21
    const datePattern = /^backups\/(\d{4}-\d{2}-\d{2})\//;
    const match = datePattern.exec(blob.pathname);
    if (!match) continue;

    const blobDate = new Date(match[1]!);
    if (blobDate < cutoff) {
      toDelete.push(blob.url);
    }
  }

  // Batch the delete: a pruned snapshot now holds ~90 parts per trading
  // day, so a single call could carry thousands of URLs.
  for (let i = 0; i < toDelete.length; i += BLOB_DELETE_BATCH) {
    await del(toDelete.slice(i, i + BLOB_DELETE_BATCH));
  }

  return toDelete;
}

/** Aggregated outcome of the whole tape-table section. */
interface TapeSummary {
  strategy: string;
  stopReason: StopReason;
  daysTotal: number;
  daysExported: number;
  daysAlreadyPresent: number;
  daysIncomplete: number;
  daysFailed: number;
  rows: number;
  bytes: number;
  parts: number;
  days: TapeDayResult[];
}

function emptyTapeSummary(): TapeSummary {
  return {
    strategy: TAPE_STRATEGY,
    stopReason: 'drained',
    daysTotal: 0,
    daysExported: 0,
    daysAlreadyPresent: 0,
    daysIncomplete: 0,
    daysFailed: 0,
    rows: 0,
    bytes: 0,
    parts: 0,
    days: [],
  };
}

/**
 * Back up the tape table day by day, resuming whatever an earlier
 * invocation of the same snapshot already finished.
 *
 * Resumption is by `_done.jsonl` marker rather than stored cursor state:
 * the blob store is the only durable thing this cron owns, and a marker
 * needs no migration. A day whose marker is missing is re-exported from
 * part 0 with `allowOverwrite`, which is safe because a closed trading
 * day is immutable — the same keyset walk produces the same parts.
 */
async function backupTapeTable(
  snapshot: string,
  budget: WallBudget,
  errors: string[],
): Promise<TapeSummary> {
  const summary = emptyTapeSummary();

  if (!budget.canStartAnother()) {
    summary.stopReason = 'wall_budget';
    return summary;
  }

  const days = await listTapeDays();
  // One listing serves BOTH the marker check and the per-day keyset resume:
  // part names carry their end id, so this doubles as the cursor store.
  const existingPaths = (
    await listAllBlobs(`backups/${snapshot}/${TAPE_TABLE}/`)
  ).map((b) => b.pathname);
  const donePaths = new Set(existingPaths);
  summary.daysTotal = days.length;

  for (const day of days) {
    const prefix = tapeDayPrefix(snapshot, day.date);

    if (donePaths.has(`${prefix}${DONE_MARKER}`)) {
      summary.daysAlreadyPresent += 1;
      summary.days.push({
        date: day.date,
        rows: day.rows,
        bytes: 0,
        parts: 0,
        status: 'already_present',
      });
      continue;
    }

    // Record every remaining day rather than breaking, so the response
    // names the exact gap instead of just ending.
    if (!budget.canStartAnother()) {
      summary.stopReason = 'wall_budget';
      summary.daysIncomplete += 1;
      summary.days.push({
        date: day.date,
        rows: 0,
        bytes: 0,
        parts: 0,
        status: 'wall_budget',
      });
      continue;
    }

    try {
      const result = await exportTapeDay(snapshot, day, budget, existingPaths);
      summary.rows += result.rows;
      summary.bytes += result.bytes;
      summary.parts += result.parts;
      summary.days.push({ date: day.date, ...result });
      if (result.status === 'wall_budget') {
        // A day the budget cut short is incomplete, not exported, even
        // though some of its parts did land — its `_done.jsonl` is absent.
        summary.stopReason = 'wall_budget';
        summary.daysIncomplete += 1;
      } else if (result.status === 'failed') {
        // Short of the census count: parts landed but the day is NOT
        // complete and carries no marker. Counting it as exported would
        // let the summary claim coverage the snapshot does not have.
        summary.daysFailed += 1;
      } else {
        summary.daysExported += 1;
      }
      logger.info(
        { table: TAPE_TABLE, date: day.date, ...result },
        'Tape day backed up',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`${TAPE_TABLE} ${day.date}: ${msg}`);
      Sentry.captureException(err);
      logger.error(
        { table: TAPE_TABLE, date: day.date, err },
        'Tape day failed',
      );
      summary.daysFailed += 1;
      summary.days.push({
        date: day.date,
        rows: 0,
        bytes: 0,
        parts: 0,
        status: 'failed',
      });
    }
  }

  return summary;
}

export default withCronCheckin('backup-tables', async (req, res) => {
  const guard = cronGuard(req, res, {
    marketHours: false,
    requireApiKey: false,
  });
  if (!guard) return;
  const { today } = guard;
  Sentry.setTag('cron.job', 'backup-tables');

  const startedAt = Date.now();
  const results: Record<string, { rows: number; bytes: number }> = {};
  const errors: string[] = [];
  let stopReason: StopReason = 'drained';

  const budget = createWallBudget({
    startMs: startedAt,
    budgetMs: WALL_BUDGET_MS,
    reserveMs: UNIT_RESERVE_MS,
  });

  logger.info(
    { date: today, tables: SMALL_TABLES.length + 1 },
    'Starting weekly backup',
  );

  // Retention first: a long tape export must never starve it, or storage
  // grows without bound while the backup itself looks healthy.
  let pruned: string[] = [];
  try {
    pruned = await pruneOldBackups(today);
    if (pruned.length > 0) {
      logger.info({ count: pruned.length }, 'Pruned old backups');
    }
  } catch (err) {
    Sentry.captureException(err);
    logger.error({ err }, 'Backup pruning failed');
    errors.push(`pruning: ${err instanceof Error ? err.message : 'Unknown'}`);
  }

  // Small tables next: 31k rows / ~9 MB combined, and they are the ones
  // most worth restoring, so they get the budget before the tape does.
  for (const table of SMALL_TABLES) {
    if (!budget.canStartAnother()) {
      stopReason = 'wall_budget';
      break;
    }
    try {
      const { body, rowCount } = await exportTable(table);

      // Vercel Blob's put() rejects empty bodies with "body is required"
      // (SENTRY-EMERALD-DESERT-6T). Skip the upload for empty tables but
      // still record them in results so the cron summary lists every
      // intended table — a downstream consumer can tell "table absent
      // from snapshot because empty" vs "table missing because failed."
      if (rowCount === 0) {
        results[table] = { rows: 0, bytes: 0 };
        logger.info({ table }, 'Table empty — skipping blob upload');
        continue;
      }

      await put(`backups/${today}/${table}.jsonl`, body, PUT_OPTS);

      results[table] = { rows: rowCount, bytes: body.byteLength };
      logger.info(
        { table, rows: rowCount, bytes: body.byteLength },
        'Table backed up',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      errors.push(`${table}: ${msg}`);
      Sentry.captureException(err);
      logger.error({ table, err }, 'Table backup failed');
    }
  }

  let tape = emptyTapeSummary();
  try {
    tape = await backupTapeTable(today, budget, errors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    errors.push(`${TAPE_TABLE}: ${msg}`);
    Sentry.captureException(err);
    logger.error({ table: TAPE_TABLE, err }, 'Tape table backup failed');
  }
  if (tape.stopReason === 'wall_budget') stopReason = 'wall_budget';

  // Roll the tape up into the flat table map so `totalRows` / `totalBytes`
  // stay whole-database figures; the per-day detail lives in `tape`.
  results[TAPE_TABLE] = { rows: tape.rows, bytes: tape.bytes };

  const totalRows = Object.values(results).reduce((s, r) => s + r.rows, 0);
  const totalBytes = Object.values(results).reduce((s, r) => s + r.bytes, 0);
  const durationMs = Date.now() - startedAt;
  const complete = stopReason === 'drained' && errors.length === 0;

  logger.info(
    {
      tables: Object.keys(results).length,
      totalRows,
      totalBytes,
      stopReason,
      tapeDays: tape.daysTotal,
      tapeParts: tape.parts,
      errors: errors.length,
      durationMs,
    },
    'Weekly backup complete',
  );

  await reportCronRun('backup-tables', {
    status: complete ? 'ok' : 'partial',
    date: today,
    tables: Object.keys(results).length,
    totalRows,
    totalBytes,
    pruned: pruned.length,
    errors: errors.length,
    stopReason,
    complete,
    strikeExposureStrategy: TAPE_STRATEGY,
    strikeExposureDays: tape.daysExported,
    strikeExposureRows: tape.rows,
    strikeExposureIncompleteDays: tape.daysIncomplete,
    durationMs,
  });

  res.status(200).json({
    date: today,
    tables: results,
    strikeExposures: tape,
    totalRows,
    totalBytes,
    pruned: pruned.length,
    stopReason,
    durationMs,
    errors: errors.length > 0 ? errors : undefined,
  });
});
