#!/usr/bin/env node

/**
 * Backfill `periscope_snapshots` with the deepest per-strike SPX
 * gamma / charm / vanna history Unusual Whales will serve.
 *
 * Phase 5 of docs/superpowers/specs/periscope-uw-repoint-2026-08-21.md.
 *
 * # Why this endpoint
 *
 * `periscope_snapshots` has sat at 0 rows since the GEXBot trial
 * expired (HTTP 401), which darkens every Periscope consumer. Of the
 * two UW per-strike sources, only
 * `/stock/SPX/greek-exposure/strike-expiry` carries multi-year history
 * (a rolling 730-TRADING-DAY window vs ~400 days for
 * `spot-exposures/expiry-strike`), so it drives the history load.
 *
 * The catch: it is EOD-only and returns NORMALIZED units — gamma is
 * ~1000x smaller than the live `spot-exposures` feed on the same strike
 * in the same session. Every row written here is therefore tagged
 * `source='uw_eod'` and must never share a slice-over-slice delta
 * series with `uw_spot` rows. The `source` column (migration #191) and
 * the source-pinned read paths are what enforce that.
 *
 * # Usage
 *
 *   # smoke test — hits the API, writes nothing
 *   node scripts/backfill-periscope-from-uw.mjs --dry-run --limit=3
 *
 *   # full backfill: today back to the UW floor (~730 trading days)
 *   node scripts/backfill-periscope-from-uw.mjs
 *
 *   # bounded runs
 *   node scripts/backfill-periscope-from-uw.mjs --from=2026-01-01
 *   node scripts/backfill-periscope-from-uw.mjs --to=2026-06-30 --limit=20
 *   node scripts/backfill-periscope-from-uw.mjs --force --from=2026-08-19
 *
 * Flags:
 *   --from=YYYY-MM-DD  stop walking once the cursor goes below this date
 *   --to=YYYY-MM-DD    start walking backward from this date (default: today CT)
 *   --limit=N          cap the number of days actually FETCHED from the API
 *                      (days skipped as already-present don't count, so a
 *                      resumed run makes real progress)
 *   --force            re-fetch days that already have uw_eod rows
 *   --dry-run          fetch and report counts, write nothing
 *   --sleep=MS         inter-day delay (default 200)
 *
 * Env: `UW_API_KEY`, `DATABASE_URL`. Auto-loaded from `.env.local` when
 * present; an already-exported shell env wins nothing/loses nothing —
 * `loadEnvFile` does not clobber existing vars.
 *
 * # Verified API contract (probed live 2026-08-21)
 *
 *   GET /api/stock/SPX/greek-exposure/strike-expiry?date=D&expiry=D
 *   Authorization: Bearer $UW_API_KEY
 *
 * -> `{"data":[{date, expiry, strike, call_gex, put_gex, call_delta,
 *     put_delta, call_charm, put_charm, call_vanna, put_vanna, dte}]}`
 *    with every numeric field serialized as a STRING.
 *
 * There is NO `time` field — only `date`. `captured_at` is therefore
 * SYNTHESIZED as that trading day's 15:00 CT regular-session close
 * converted to UTC (DST-correct via `eodCapturedAtIso`), so EOD rows
 * sort correctly against live intraday `uw_spot` rows. `timeframe` is
 * the literal `'EOD'` rather than a fabricated 10-min slot label.
 *
 * Out-of-window dates return HTTP 403 with a machine-readable body:
 *   {"code":"historic_data_access_missing",
 *    "message":"The earliest date currently available to you is
 *               2023-09-21 (730 trading days) ..."}
 * That code is the authoritative end-of-history signal. The floor moves
 * forward every day, so it is never hardcoded. A 403 WITHOUT that code
 * is a genuine auth failure and aborts the run non-zero.
 *
 * # Idempotency / resumability
 *
 * Writes go through `ON CONFLICT (captured_at, expiry, panel, strike,
 * source) DO NOTHING` (the constraint migration #191 widened to include
 * `source`). Before the walk starts, every date that already has
 * `uw_eod` rows is loaded into a Set in ONE query and those days are
 * skipped without an API call. A whole day is written by a SINGLE
 * INSERT statement (all three panels zipped through `unnest`), so an
 * interrupted run can never leave a half-written day.
 *
 * `--force` re-fetches an existing day but still does not overwrite:
 * DO NOTHING is deliberate, because re-deriving a value from the same
 * immutable EOD source should be a no-op.
 *
 * # Where the logic lives
 *
 * The payload-only decisions — row mapping (`mapDayRows`), the 403
 * classification (`classifyForbidden`) and the `captured_at` synthesis
 * (`eodCapturedAtIso`) — live in `api/_lib/periscope-backfill-mapper.ts`
 * and are covered by `api/__tests__/periscope-backfill-mapper.test.ts`.
 * This file keeps only the network / retry / DB machinery. Same split as
 * `backfill-takeit-scores.mjs` ↔ `api/_lib/takeit-backfill-mapper.ts`.
 */

import process from 'node:process';

import { neon } from '@neondatabase/serverless';

import {
  EOD_PANELS,
  classifyForbidden,
  eodCapturedAtIso,
  mapDayRows,
} from '../api/_lib/periscope-backfill-mapper.ts';
import { SOURCE_UW_EOD } from '../api/_lib/periscope-uw.ts';
import { ctDateStr } from './_lib/trading-days.mjs';

// ── Constants ───────────────────────────────────────────────

const UW_BASE = 'https://api.unusualwhales.com/api';
const TICKER = 'SPX';

/** Literal label; NOT a 10-min slot — these rows are daily closes. */
const TIMEFRAME = 'EOD';

const DEFAULT_SLEEP_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Strict integer form — rejects "5abc", "5.5", "1e3", "" and " 5". */
const INT_RE = /^\d+$/;

/** Thrown for conditions where continuing would be dishonest. */
class FatalError extends Error {}

// ── Env ─────────────────────────────────────────────────────

try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local (CI, Railway, `source`d shell) — env must already be set.
}

/**
 * Resolved by `initEnv()` AFTER argument parsing, deliberately: reading
 * them at module scope made `--help` (and every bad-flag message) exit 1
 * with "missing required env var UW_API_KEY" on any machine without a
 * `.env.local`. Usage text must never depend on credentials.
 */
let uwApiKey = '';
let sql;

function initEnv() {
  uwApiKey = requiredEnv('UW_API_KEY');
  sql = neon(requiredEnv('DATABASE_URL'));
}

function requiredEnv(name) {
  const value = process.env[name];
  if (value == null || value.trim() === '') {
    console.error(
      `ERROR: missing required env var ${name} (source .env.local first)`,
    );
    process.exit(1);
  }
  return value.trim();
}

// ── Args ────────────────────────────────────────────────────

const USAGE = [
  'Usage: node scripts/backfill-periscope-from-uw.mjs [flags]',
  '',
  '  --from=YYYY-MM-DD  stop once the backward cursor goes below this date',
  '  --to=YYYY-MM-DD    start walking backward here (default: today in CT)',
  '  --limit=N          cap the number of days FETCHED from the API',
  '  --force            re-fetch days that already have uw_eod rows',
  '  --dry-run          fetch and report counts, write nothing',
  `  --sleep=MS         inter-day delay (default ${DEFAULT_SLEEP_MS})`,
  '  --help, -h         show this message',
  '',
  'Default (no flags): full backfill from today back to the UW history floor.',
].join('\n');

function parseArgs(argv) {
  const opts = {
    from: null,
    to: null,
    limit: null,
    force: false,
    dryRun: false,
    sleepMs: DEFAULT_SLEEP_MS,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg.startsWith('--from=')) {
      opts.from = validateDate(arg.slice('--from='.length), '--from');
    } else if (arg.startsWith('--to=')) {
      opts.to = validateDate(arg.slice('--to='.length), '--to');
    } else if (arg.startsWith('--limit=')) {
      opts.limit = validatePositiveInt(arg.slice('--limit='.length), '--limit');
    } else if (arg.startsWith('--sleep=')) {
      opts.sleepMs = validateNonNegativeInt(
        arg.slice('--sleep='.length),
        '--sleep',
      );
    } else {
      console.error(`ERROR: unknown argument "${arg}"`);
      console.error(USAGE);
      process.exit(1);
    }
  }

  if (opts.from != null && opts.to != null && opts.from > opts.to) {
    console.error(`ERROR: --from (${opts.from}) is after --to (${opts.to})`);
    process.exit(1);
  }

  return opts;
}

function validateDate(value, label) {
  if (!DATE_RE.test(value)) {
    console.error(`ERROR: ${label} requires YYYY-MM-DD, got "${value}"`);
    process.exit(1);
  }
  return value;
}

/**
 * `Number.parseInt` alone is too permissive for CLI input: it stops at
 * the first non-digit, so `--limit=5abc` would silently become 5 and the
 * run would quietly do the wrong amount of work. Require the whole
 * argument to be digits before parsing.
 */
function validateIntAtLeast(value, label, min, description) {
  const parsed = INT_RE.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    console.error(`ERROR: ${label} requires ${description}, got "${value}"`);
    process.exit(1);
  }
  return parsed;
}

function validatePositiveInt(value, label) {
  return validateIntAtLeast(value, label, 1, 'a positive integer');
}

function validateNonNegativeInt(value, label) {
  return validateIntAtLeast(value, label, 0, 'a non-negative integer');
}

// ── Calendar helpers ────────────────────────────────────────
//
// Pure YYYY-MM-DD string arithmetic anchored at midday UTC, so neither
// the local timezone nor a DST transition can shift a step across a day
// boundary (the AUD-C4 bug that `_lib/trading-days.mjs` documents).

function shiftDays(dateStr, delta) {
  const anchor = new Date(`${dateStr}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() + delta);
  return anchor.toISOString().slice(0, 10);
}

function isWeekday(dateStr) {
  const dow = new Date(`${dateStr}T18:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** Previous Mon–Fri date strictly before `dateStr`. */
function previousWeekday(dateStr) {
  let cursor = shiftDays(dateStr, -1);
  while (!isWeekday(cursor)) cursor = shiftDays(cursor, -1);
  return cursor;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── UW fetch ────────────────────────────────────────────────

/**
 * Fetch one trading day's per-strike EOD exposure.
 *
 * Returns a discriminated result rather than throwing, because the
 * three non-success outcomes mean very different things:
 *   { kind: 'ok',   rows }             — usable payload (possibly empty)
 *   { kind: 'end',  earliest }         — authoritative end of history
 *   { kind: 'fail', reason }           — transient; caller logs + continues
 * A genuine auth failure throws FatalError and aborts the run.
 */
async function fetchDay(date) {
  const url =
    `${UW_BASE}/stock/${TICKER}/greek-exposure/strike-expiry` +
    `?date=${date}&expiry=${date}`;

  let lastReason = 'unknown';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${uwApiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      lastReason = `network error: ${err.message}`;
      await sleep(backoffMs(attempt));
      continue;
    }

    const text = await res.text().catch(() => '');
    const body = safeJson(text);

    if (res.status === 403) {
      const verdict = classifyForbidden(body);
      if (verdict.kind === 'end-of-history') {
        return { kind: 'end', earliest: verdict.earliest };
      }
      // A 403 without that code is a real permission problem — a
      // subscription downgrade or a revoked key. Failing loudly here is
      // the whole point: silently treating it as end-of-history would
      // "successfully" backfill zero days. See `classifyForbidden`, which
      // is unit-tested precisely so this rule cannot be "simplified" away.
      throw new FatalError(
        `UW returned 403 without historic_data_access_missing for ${date}. ` +
          `This is an auth/permission failure, not end-of-history. ` +
          `Body: ${text.slice(0, 300)}`,
      );
    }

    if (res.status === 401) {
      throw new FatalError(
        `UW returned 401 for ${date} — UW_API_KEY is invalid or expired. ` +
          `Body: ${text.slice(0, 300)}`,
      );
    }

    if (res.status === 429) {
      const wait = retryAfterMs(res) ?? backoffMs(attempt);
      lastReason = 'rate limited (429)';
      console.warn(
        `  ${date}: 429 rate limited, backing off ${wait}ms ` +
          `(attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      lastReason = `HTTP ${res.status}: ${text.slice(0, 160)}`;
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { kind: 'fail', reason: lastReason };
    }

    if (!Array.isArray(body?.data)) {
      return {
        kind: 'fail',
        reason: `malformed payload (no data array): ${text.slice(0, 160)}`,
      };
    }

    return { kind: 'ok', rows: body.data };
  }

  return { kind: 'fail', reason: `exhausted retries — ${lastReason}` };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function backoffMs(attempt) {
  // Exponential with jitter, capped. attempt is 1-based.
  const base = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
  return base + Math.floor(Math.random() * 250);
}

function retryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (header == null) return null;
  const seconds = Number.parseFloat(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, RETRY_MAX_MS);
}

// ── Mapping ─────────────────────────────────────────────────
//
// `mapDayRows` (all-zero skip, repeat-strike merging, per-panel null skip,
// clamp accounting) and `eodCapturedAtIso` live in
// `api/_lib/periscope-backfill-mapper.ts` so they are unit-testable —
// see `api/__tests__/periscope-backfill-mapper.test.ts`.

// ── DB ──────────────────────────────────────────────────────

/**
 * Every date already carrying uw_eod rows, in one query.
 *
 * Doubles as the schema preflight: `source` only exists once migration
 * #191 has run, and without it every insert below would fail anyway.
 * Translating Postgres' `42703 undefined_column` into an actionable
 * message beats letting a bare NeonDbError surface after arg parsing.
 */
async function loadExistingDates() {
  let rows;
  try {
    rows = await sql`
      SELECT DISTINCT to_char(expiry, 'YYYY-MM-DD') AS expiry
      FROM periscope_snapshots
      WHERE source = ${SOURCE_UW_EOD}
    `;
  } catch (err) {
    if (err?.code === '42703') {
      throw new FatalError(
        'periscope_snapshots.source does not exist — migration #191 has ' +
          'not been applied to this database. Run `npm run migrate` ' +
          '(or POST /api/journal/init) first, then re-run this backfill.',
      );
    }
    throw err;
  }
  return new Set(rows.map((r) => r.expiry));
}

/**
 * Write one day. All three panels go in a SINGLE statement so a day is
 * atomic — an interrupted run leaves either the whole day or none of
 * it, which is what makes the "already present → skip" resume check
 * trustworthy. Arrays are bound as three parameters regardless of
 * strike count, so there is no bind-parameter ceiling to chunk around.
 */
async function insertDay(date, capturedAtIso, mapped) {
  const inserted = await sql`
    INSERT INTO periscope_snapshots
      (captured_at, expiry, panel, strike, value, timeframe, source)
    SELECT
      ${capturedAtIso}::timestamptz,
      ${date}::date,
      t.panel,
      t.strike,
      t.value,
      ${TIMEFRAME},
      ${SOURCE_UW_EOD}
    FROM unnest(
      ${mapped.panels}::text[],
      ${mapped.strikes}::int[],
      ${mapped.values}::numeric[]
    ) AS t(panel, strike, value)
    ON CONFLICT (captured_at, expiry, panel, strike, source) DO NOTHING
    RETURNING id
  `;
  return inserted.length;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  initEnv();
  const startedAt = Date.now();

  const today = ctDateStr();
  // Never start on the current session. `/greek-exposure/strike-expiry` only
  // settles into one row per strike once the day is complete; queried
  // intraday it returns a partial, mixed series — verified 2026-08-21, which
  // came back with 1090 rows over 590 distinct strikes (500 duplicates,
  // including far-OTM junk like strike 1400 against a ~7645 spot carrying a
  // lone call_delta), versus the completed 2026-08-20 at 261 rows / 261
  // distinct / 0 duplicates. Neither merge rule salvages that: `mapDayRows`
  // SUMS repeat strikes (correct for the SPX+SPXW pair on a settled OPEX
  // day), which across overlapping intraday partials would double-count the
  // same strike instead. The current session is owned by
  // populate-periscope-from-uw, which writes 10-min `uw_spot` slices; this
  // backfill only ever writes settled days.
  const lastSettled = previousWeekday(today);
  let cursor = opts.to ?? lastSettled;
  if (cursor > lastSettled) cursor = lastSettled;
  if (!isWeekday(cursor)) cursor = previousWeekday(cursor);

  console.log(
    `Backfilling ${TICKER} per-strike EOD exposure → periscope_snapshots ` +
      `(source=${SOURCE_UW_EOD}, panels=${EOD_PANELS.join('/')})`,
  );
  // Extracted rather than interpolated inline: sonarjs/no-nested-template-literals.
  const bound = opts.from ? ` to ${opts.from}` : ' to the UW history floor';
  const cap = opts.limit ? `, max ${opts.limit} day(s) fetched` : '';
  const forceNote = opts.force ? ', --force' : '';
  const dryNote = opts.dryRun ? ', DRY RUN (no writes)' : '';
  console.log(
    `  walking backward from ${cursor}${bound}${cap}${forceNote}${dryNote}`,
  );

  const existing = await loadExistingDates();
  console.log(
    `  ${existing.size} day(s) already backfilled; ` +
      `${opts.force ? 're-fetching them (--force)' : 'skipping them'}\n`,
  );

  const totals = {
    fetched: 0,
    daysFetched: 0,
    daysSkipped: 0,
    daysEmpty: 0,
    daysFailed: 0,
    strikesKept: 0,
    zeroSkipped: 0,
    nullSkipped: 0,
    malformed: 0,
    merged: 0,
    clamped: 0,
    rowsCandidate: 0,
    rowsInserted: 0,
  };
  const failures = [];
  let earliestReached = null;
  let uwFloor = null;
  let stopReason = 'reached --from bound';

  while (true) {
    if (opts.from != null && cursor < opts.from) break;
    if (opts.limit != null && totals.daysFetched >= opts.limit) {
      stopReason = `hit --limit=${opts.limit}`;
      break;
    }

    if (!opts.force && existing.has(cursor)) {
      totals.daysSkipped += 1;
      console.log(`  ${cursor}  skipped (already backfilled)`);
      cursor = previousWeekday(cursor);
      continue;
    }

    const result = await fetchDay(cursor);
    totals.daysFetched += 1;

    if (result.kind === 'end') {
      uwFloor = result.earliest;
      stopReason = 'UW history floor (historic_data_access_missing)';
      // The 403 day itself is out of range — don't count it as fetched.
      totals.daysFetched -= 1;
      console.log(
        `  ${cursor}  end of history — UW earliest available: ` +
          `${uwFloor ?? 'unreported'}`,
      );
      break;
    }

    if (result.kind === 'fail') {
      totals.daysFailed += 1;
      failures.push(`${cursor}: ${result.reason}`);
      console.warn(`  ${cursor}  FAILED — ${result.reason}`);
      cursor = previousWeekday(cursor);
      await sleep(opts.sleepMs);
      continue;
    }

    earliestReached = cursor;

    if (result.rows.length === 0) {
      // Market holiday, or today before UW publishes the EOD slice
      // (weekends are never requested). Not an error either way.
      totals.daysEmpty += 1;
      console.log(`  ${cursor}  no data (market holiday / not yet published)`);
      cursor = previousWeekday(cursor);
      await sleep(opts.sleepMs);
      continue;
    }

    const mapped = mapDayRows(result.rows);
    const capturedAtIso = eodCapturedAtIso(cursor);
    if (capturedAtIso == null) {
      throw new FatalError(
        `could not synthesize captured_at for ${cursor} — invalid date`,
      );
    }

    const candidateRows = mapped.panels.length;
    let insertedRows = 0;
    if (!opts.dryRun && candidateRows > 0) {
      insertedRows = await insertDay(cursor, capturedAtIso, mapped);
    }

    totals.fetched += mapped.stats.fetched;
    totals.strikesKept += mapped.stats.kept;
    totals.zeroSkipped += mapped.stats.zeroSkipped;
    totals.nullSkipped += mapped.stats.nullSkipped;
    totals.malformed += mapped.stats.malformed;
    totals.merged += mapped.stats.merged;
    totals.clamped += mapped.stats.clamped;
    totals.rowsCandidate += candidateRows;
    totals.rowsInserted += insertedRows;

    const extras = [
      mapped.stats.nullSkipped > 0 ? `null=${mapped.stats.nullSkipped}` : null,
      mapped.stats.malformed > 0 ? `bad=${mapped.stats.malformed}` : null,
      mapped.stats.merged > 0 ? `merged=${mapped.stats.merged}` : null,
      mapped.stats.clamped > 0 ? `clamped=${mapped.stats.clamped}` : null,
    ].filter(Boolean);

    const insertedNote = opts.dryRun
      ? 'inserted=(dry-run)'
      : `inserted=${insertedRows}`;
    const extrasNote = extras.length > 0 ? `  [${extras.join(' ')}]` : '';

    console.log(
      `  ${cursor}  fetched=${mapped.stats.fetched} ` +
        `kept=${mapped.stats.kept} zero-skipped=${mapped.stats.zeroSkipped} ` +
        `rows=${candidateRows} ${insertedNote}${extrasNote}` +
        `  @ ${capturedAtIso}`,
    );

    cursor = previousWeekday(cursor);
    await sleep(opts.sleepMs);
  }

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nDone${opts.dryRun ? ' (dry run — nothing written)' : ''}.`);
  console.log(`  Stop reason:          ${stopReason}`);
  console.log(`  UW history floor:     ${uwFloor ?? 'not reached'}`);
  console.log(`  Earliest date pulled: ${earliestReached ?? 'none'}`);
  console.log(`  Days fetched:         ${totals.daysFetched}`);
  console.log(
    `  Days skipped:         ${totals.daysSkipped} (already present)`,
  );
  console.log(
    `  Days empty:           ${totals.daysEmpty} (holiday / not yet published)`,
  );
  console.log(`  Days failed:          ${totals.daysFailed}`);
  console.log(`  Rows returned:        ${totals.fetched}`);
  console.log(`  Strikes kept:         ${totals.strikesKept} (distinct)`);
  console.log(`  Strikes all-zero:     ${totals.zeroSkipped} (skipped)`);
  console.log(`  Strikes unusable:     ${totals.nullSkipped} (null netValue)`);
  console.log(`  Rows malformed:       ${totals.malformed}`);
  console.log(
    `  Rows merged:          ${totals.merged} ` +
      `(repeat strikes summed, e.g. SPX+SPXW on monthly OPEX)`,
  );
  console.log(`  Values clamped:       ${totals.clamped}`);
  console.log(`  Rows candidate:       ${totals.rowsCandidate}`);
  console.log(
    `  Rows inserted:        ` +
      `${opts.dryRun ? '0 (dry run)' : totals.rowsInserted}`,
  );
  console.log(`  Elapsed:              ${elapsedS}s`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} day(s) failed:`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
    if (failures.length > 20) {
      console.error(`  ... and ${failures.length - 20} more`);
    }
    // Surface partial failures to operators via a non-zero exit code.
    // Re-running is cheap: completed days are skipped.
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof FatalError) {
    console.error(`\nFATAL: ${err.message}`);
  } else {
    console.error('\nBackfill failed:', err);
  }
  process.exit(1);
}
