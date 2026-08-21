#!/usr/bin/env node

/**
 * Seed the `uw_spot` Periscope series in `periscope_snapshots` from the
 * `gex_strike_0dte` rows already sitting in this database.
 *
 * Companion to `backfill-periscope-from-uw.mjs`, which loads the
 * `uw_eod` series. Read that script first — this one mirrors its CLI
 * contract, minus everything network-shaped.
 *
 * # Why
 *
 * `periscope_snapshots.source` (migration #191) carries three mutually
 * incomparable scales: `gexbot` (dead), `uw_eod` (normalized units,
 * ~731 days loaded) and `uw_spot` (RAW DOLLAR units). Every detector
 * and the live map endpoint is pinned to `uw_spot` — and `uw_spot` is
 * EMPTY, because its forward cron `populate-periscope-from-uw` has
 * never run in production. `uw_eod` cannot stand in for it: it is one
 * synthetic 15:00 CT slice per day, and a one-slice-per-day series
 * cannot drive an intraday delta at any scale.
 *
 * The forward cron's own upstream — `gex_strike_0dte` — has however
 * been filling at ~1-min cadence the whole time. This script replays
 * it into `uw_spot`, giving the detectors and panels real intraday
 * history and validating the cron's exact row mapping before it fires
 * in production for the first time.
 *
 * # The 10-minute downsample (the load-bearing design decision)
 *
 * `gex_strike_0dte` is ~1-min cadence. `populate-periscope-from-uw`
 * runs on a 10-MINUTE RTH schedule and writes whatever the single
 * latest tick happens to be when it fires. Seeded rows must be
 * INDISTINGUISHABLE from what that cron would have written, so this
 * script downsamples: for each 10-minute grid boundary, the LAST tick
 * at or before it — exactly the tick `MAX(timestamp)` would have
 * returned. Buckets with no tick are omitted rather than filled by
 * carrying a value forward.
 *
 * Writing all ~170 daily ticks instead would give the historical
 * stretch of `uw_spot` 1-minute slice-over-slice delta semantics while
 * everything the cron writes afterwards has 10-minute ones — silently
 * corrupting every delta that straddles the seam. The bucketing lives
 * in `selectTenMinuteSlices` and is unit-tested; it is not inlined here
 * precisely because it is the part that must not quietly drift.
 *
 * # Usage
 *
 *   # what it WOULD write, touching nothing
 *   node scripts/backfill-periscope-uw-spot.mjs --dry-run
 *
 *   # seed everything gex_strike_0dte holds
 *   node scripts/backfill-periscope-uw-spot.mjs
 *
 *   # bounded / repeat runs
 *   node scripts/backfill-periscope-uw-spot.mjs --from=2026-08-18 --limit=2
 *   node scripts/backfill-periscope-uw-spot.mjs --force --to=2026-08-21
 *
 * Flags:
 *   --from=YYYY-MM-DD  skip source days before this date
 *   --to=YYYY-MM-DD    skip source days after this date
 *   --limit=N          cap the number of days actually PROCESSED (days
 *                      skipped as already-seeded don't count, so a
 *                      resumed run makes real progress)
 *   --force            re-process days that already have uw_spot rows
 *   --dry-run          report what would be written, write nothing
 *
 * Env: `DATABASE_URL` only. There is NO network call and no UW API key
 * — every byte read comes from the local database, so a full run is
 * seconds, not minutes.
 *
 * # Row mapping
 *
 * Mirrors `api/cron/populate-periscope-from-uw.ts` field for field:
 *
 *   source      = 'uw_spot'
 *   captured_at = the tick's OWN `timestamp` (a real observation — NOT
 *                 synthesized the way `uw_eod`'s 15:00 CT close is)
 *   expiry      = the row's `date` (gex_strike_0dte is 0DTE by
 *                 construction, so expiry == date)
 *   timeframe   = formatTimeframe(captured_at)  — the CT 10-min label
 *   panel/strike/value via `mapSliceRows`, which reuses `netValue` and
 *                 `clampSnapshotValue` from the shared mapper.
 *
 * Note the deliberate asymmetry with the EOD backfill documented on
 * `mapSliceRows`: all-zero strikes are KEPT here, because the cron
 * keeps them.
 *
 * Expect the occasional REPEATED `timeframe` label — roughly one per
 * few sessions. `formatTimeframe` FLOORS the tick's own time, while the
 * slice grid buckets it by the boundary at or after it, so a tick
 * landing exactly on a boundary (e.g. 15:20:00.000Z) gets the label of
 * the window that boundary OPENS ("10:20 - 10:30") and collides with
 * the next slice's label. `timeframe` is not part of the unique
 * constraint, so both rows persist with distinct `captured_at`. This is
 * not a seed artifact: the live cron produces exactly the same label
 * for exactly the same tick, and diverging from it here to "fix" the
 * duplicate would be the actual bug.
 *
 * # Idempotency / resumability
 *
 * Writes go through `ON CONFLICT (captured_at, expiry, panel, strike,
 * source) DO NOTHING` (the 5-column constraint from migration #191).
 * Every date that already has `uw_spot` rows is loaded in ONE query up
 * front and skipped without work. A whole day's slices are written in a
 * SINGLE `sql.transaction`, so an interrupted run can never leave a
 * half-written day and the date-level resume check stays trustworthy.
 *
 * The one case needing `--force`: seeding the CURRENT session, which is
 * still accumulating ticks. Those rows are real and correct, but the
 * day is now "present" and later ticks will be skipped until you re-run
 * with `--force` (which is a no-op on the slices already written).
 *
 * # Where the logic lives
 *
 * `selectTenMinuteSlices` / `mapSliceRows` / `sliceBoundaryMs` are in
 * `api/_lib/periscope-spot-seed.ts`, covered by
 * `api/__tests__/periscope-spot-seed.test.ts`. This file keeps only the
 * CLI and DB machinery. Same split as `backfill-periscope-from-uw.mjs`
 * ↔ `api/_lib/periscope-backfill-mapper.ts`.
 *
 * NOTE ON IMPORT EXTENSIONS: `api/_lib/*` is imported with `.ts`, not
 * `.js`. Node 24 type-stripping does NOT map a `.js` specifier onto a
 * `.ts` file (`ERR_MODULE_NOT_FOUND`). Same as the sibling backfill.
 */

import process from 'node:process';

import { neon } from '@neondatabase/serverless';

import {
  SLICE_INTERVAL_MS,
  mapSliceRows,
  selectTenMinuteSlices,
  sliceBoundaryMs,
} from '../api/_lib/periscope-spot-seed.ts';
import { STALENESS_CUTOFF_MS } from '../api/_lib/periscope-gexbot.ts';
import { SOURCE_UW_SPOT, formatTimeframe } from '../api/_lib/periscope-uw.ts';
import { ctDateStr } from './_lib/trading-days.mjs';

// ── Constants ───────────────────────────────────────────────

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
 * at module scope makes `--help` (and every bad-flag message) exit 1
 * with "missing required env var" on any machine without a
 * `.env.local`. Usage text must never depend on credentials.
 */
let sql;

function initEnv() {
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
  'Usage: node scripts/backfill-periscope-uw-spot.mjs [flags]',
  '',
  '  --from=YYYY-MM-DD  skip source days before this date',
  '  --to=YYYY-MM-DD    skip source days after this date',
  '  --limit=N          cap the number of days PROCESSED',
  '  --force            re-process days that already have uw_spot rows',
  '  --dry-run          report what would be written, write nothing',
  '  --help, -h         show this message',
  '',
  'Default (no flags): seed every gex_strike_0dte day not already seeded.',
  'Reads the local DB only — no network, no UW API key.',
].join('\n');

function parseArgs(argv) {
  const opts = {
    from: null,
    to: null,
    limit: null,
    force: false,
    dryRun: false,
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
function validatePositiveInt(value, label) {
  const parsed = INT_RE.test(value) ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    console.error(
      `ERROR: ${label} requires a positive integer, got "${value}"`,
    );
    process.exit(1);
  }
  return parsed;
}

// ── DB reads ────────────────────────────────────────────────

/**
 * Every date already carrying `uw_spot` rows, in one query.
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
      WHERE source = ${SOURCE_UW_SPOT}
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

/** Source days present in `gex_strike_0dte`, newest first. */
async function loadSourceDays() {
  return await sql`
    SELECT to_char(date, 'YYYY-MM-DD') AS date,
           COUNT(*)::int               AS rows,
           COUNT(DISTINCT timestamp)::int AS ticks
    FROM gex_strike_0dte
    GROUP BY date
    ORDER BY date DESC
  `;
}

/** Distinct tick timestamps for one source day, ascending. */
async function loadTicks(date) {
  const rows = await sql`
    SELECT DISTINCT timestamp
    FROM gex_strike_0dte
    WHERE date = ${date}::date
    ORDER BY timestamp ASC
  `;
  return rows.map((r) => r.timestamp);
}

/**
 * Every strike row belonging to the selected slices, in one query.
 *
 * Only the six greek columns the three panels need are selected — the
 * `_vol` / `_ask` / `_bid` variants and `price` are not part of any
 * panel and would just be bytes over the wire.
 */
async function loadSliceRows(date, isoTimestamps) {
  return await sql`
    SELECT timestamp, strike,
           call_gamma_oi, put_gamma_oi,
           call_charm_oi, put_charm_oi,
           call_vanna_oi, put_vanna_oi
    FROM gex_strike_0dte
    WHERE date = ${date}::date
      AND timestamp = ANY(${isoTimestamps}::timestamptz[])
    ORDER BY timestamp ASC, strike ASC
  `;
}

// ── DB write ────────────────────────────────────────────────

/**
 * One INSERT per slice, all of a day's slices in ONE transaction.
 *
 * Per-slice (rather than one giant per-day statement) keeps each
 * statement the same shape the cron emits and keeps the array
 * parameters small; the enclosing transaction is what makes the day
 * atomic, which is what the date-level resume check relies on.
 *
 * Arrays are bound as three parameters regardless of strike count, so
 * there is no bind-parameter ceiling to chunk around.
 */
async function insertDay(date, plans) {
  const statements = plans.map(
    (plan) => sql`
      INSERT INTO periscope_snapshots
        (captured_at, expiry, panel, strike, value, timeframe, source)
      SELECT
        ${plan.capturedAtIso}::timestamptz,
        ${date}::date,
        t.panel,
        t.strike,
        t.value,
        ${plan.timeframe},
        ${SOURCE_UW_SPOT}
      FROM unnest(
        ${plan.mapped.panels}::text[],
        ${plan.mapped.strikes}::int[],
        ${plan.mapped.values}::numeric[]
      ) AS t(panel, strike, value)
      ON CONFLICT (captured_at, expiry, panel, strike, source) DO NOTHING
      RETURNING id
    `,
  );

  const results = await sql.transaction(statements);
  return results.reduce((sum, rows) => sum + rows.length, 0);
}

// ── Per-day planning ────────────────────────────────────────

/**
 * Turn one source day into the list of slice inserts it implies.
 *
 * Returns `{ plans, stats }` and performs no writes, so `--dry-run`
 * exercises this whole path — the downsample, the row mapping and the
 * candidate row count are all real in a dry run; only `insertDay` is
 * skipped.
 */
async function planDay(date) {
  const ticks = await loadTicks(date);
  const slices = selectTenMinuteSlices(ticks);

  const stats = {
    ticks: ticks.length,
    slices: slices.length,
    sourceRows: 0,
    strikeRows: 0,
    emptySlices: 0,
    malformed: 0,
    nullSkipped: 0,
    clamped: 0,
    staleSlices: 0,
  };

  if (slices.length === 0) return { plans: [], stats };

  const isoTimestamps = slices.map((d) => d.toISOString());
  const rows = await loadSliceRows(date, isoTimestamps);
  stats.sourceRows = rows.length;

  // Group by tick. `timestamp` comes back as a Date from the driver;
  // key on epoch ms so it joins to the selected slices exactly.
  const byTick = new Map();
  for (const row of rows) {
    const key = new Date(row.timestamp).getTime();
    const bucket = byTick.get(key);
    if (bucket == null) byTick.set(key, [row]);
    else bucket.push(row);
  }

  const plans = [];
  for (const slice of slices) {
    const ms = slice.getTime();

    // Purely diagnostic. The live cron refuses to write when its latest
    // tick is older than STALENESS_CUTOFF_MS; a seeded slice whose tick
    // lags its grid boundary by more than that is one the cron would
    // have skipped. We still seed it (the tick is real data at its own
    // real timestamp — see the note on `selectTenMinuteSlices`), but the
    // count is reported so the divergence is visible, not implied.
    if (sliceBoundaryMs(ms) - ms > STALENESS_CUTOFF_MS) stats.staleSlices += 1;

    const mapped = mapSliceRows(byTick.get(ms) ?? []);
    stats.malformed += mapped.stats.malformed;
    stats.nullSkipped += mapped.stats.nullSkipped;
    stats.clamped += mapped.stats.clamped;

    if (mapped.panels.length === 0) {
      stats.emptySlices += 1;
      continue;
    }
    stats.strikeRows += mapped.panels.length;

    plans.push({
      capturedAtIso: slice.toISOString(),
      timeframe: formatTimeframe(slice),
      mapped,
    });
  }

  return { plans, stats };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  initEnv();
  const startedAt = Date.now();
  const todayCt = ctDateStr();

  console.log(
    `Seeding gex_strike_0dte → periscope_snapshots ` +
      `(source=${SOURCE_UW_SPOT}, ${SLICE_INTERVAL_MS / 60_000}-min slices)`,
  );
  const bounds =
    opts.from || opts.to
      ? `  ${opts.from ?? 'earliest'} .. ${opts.to ?? 'latest'}`
      : '  all available days';
  const cap = opts.limit ? `, max ${opts.limit} day(s)` : '';
  const forceNote = opts.force ? ', --force' : '';
  const dryNote = opts.dryRun ? ', DRY RUN (no writes)' : '';
  console.log(`${bounds}${cap}${forceNote}${dryNote}`);

  const existing = await loadExistingDates();
  const allDays = await loadSourceDays();
  const days = allDays.filter(
    (d) =>
      (opts.from == null || d.date >= opts.from) &&
      (opts.to == null || d.date <= opts.to),
  );

  console.log(
    `  ${allDays.length} day(s) in gex_strike_0dte, ${days.length} in range; ` +
      `${existing.size} already seeded — ` +
      `${opts.force ? 're-processing them (--force)' : 'skipping them'}\n`,
  );

  const totals = {
    daysProcessed: 0,
    daysSkipped: 0,
    daysEmpty: 0,
    daysFailed: 0,
    ticks: 0,
    slices: 0,
    sourceRows: 0,
    emptySlices: 0,
    malformed: 0,
    nullSkipped: 0,
    clamped: 0,
    staleSlices: 0,
    rowsCandidate: 0,
    rowsInserted: 0,
  };
  const failures = [];

  for (const day of days) {
    if (opts.limit != null && totals.daysProcessed >= opts.limit) {
      console.log(`  stopping — hit --limit=${opts.limit}`);
      break;
    }

    if (!opts.force && existing.has(day.date)) {
      totals.daysSkipped += 1;
      console.log(`  ${day.date}  skipped (already seeded)`);
      continue;
    }

    let planned;
    try {
      planned = await planDay(day.date);
    } catch (err) {
      totals.daysFailed += 1;
      failures.push(`${day.date}: ${err.message}`);
      console.warn(`  ${day.date}  FAILED — ${err.message}`);
      continue;
    }

    totals.daysProcessed += 1;
    const { plans, stats } = planned;

    let insertedRows = 0;
    if (!opts.dryRun && plans.length > 0) {
      try {
        insertedRows = await insertDay(day.date, plans);
      } catch (err) {
        totals.daysFailed += 1;
        failures.push(`${day.date}: insert failed — ${err.message}`);
        console.warn(`  ${day.date}  INSERT FAILED — ${err.message}`);
        continue;
      }
    }

    totals.ticks += stats.ticks;
    totals.slices += stats.slices;
    totals.sourceRows += stats.sourceRows;
    totals.emptySlices += stats.emptySlices;
    totals.malformed += stats.malformed;
    totals.nullSkipped += stats.nullSkipped;
    totals.clamped += stats.clamped;
    totals.staleSlices += stats.staleSlices;
    totals.rowsCandidate += stats.strikeRows;
    totals.rowsInserted += insertedRows;

    if (stats.slices === 0) totals.daysEmpty += 1;

    const extras = [
      stats.emptySlices > 0 ? `empty-slices=${stats.emptySlices}` : null,
      stats.malformed > 0 ? `bad=${stats.malformed}` : null,
      stats.nullSkipped > 0 ? `null=${stats.nullSkipped}` : null,
      stats.clamped > 0 ? `clamped=${stats.clamped}` : null,
      stats.staleSlices > 0 ? `stale=${stats.staleSlices}` : null,
      day.date === todayCt ? 'LIVE SESSION (re-run --force later)' : null,
    ].filter(Boolean);
    const extrasNote = extras.length > 0 ? `  [${extras.join(' ')}]` : '';
    const insertedNote = opts.dryRun
      ? 'inserted=(dry-run)'
      : `inserted=${insertedRows}`;

    console.log(
      `  ${day.date}  ticks=${stats.ticks} slices=${stats.slices} ` +
        `strike-rows=${stats.sourceRows} rows=${stats.strikeRows} ` +
        `${insertedNote}${extrasNote}`,
    );
  }

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  const downsample =
    totals.ticks > 0
      ? ` (${((totals.slices / totals.ticks) * 100).toFixed(1)}% of ticks kept)`
      : '';

  console.log(`\nDone${opts.dryRun ? ' (dry run — nothing written)' : ''}.`);
  console.log(`  Days processed:       ${totals.daysProcessed}`);
  console.log(`  Days skipped:         ${totals.daysSkipped} (already seeded)`);
  console.log(`  Days with no ticks:   ${totals.daysEmpty}`);
  console.log(`  Days failed:          ${totals.daysFailed}`);
  console.log(`  Ticks available:      ${totals.ticks}`);
  console.log(`  Slices selected:      ${totals.slices}${downsample}`);
  console.log(
    `  Slices empty:         ${totals.emptySlices} (no usable strike)`,
  );
  console.log(
    `  Slices stale-at-grid: ${totals.staleSlices} ` +
      `(tick >${STALENESS_CUTOFF_MS / 60_000}min before its boundary; ` +
      `the live cron would have skipped these — seeded anyway, see script header)`,
  );
  console.log(`  Strike rows read:     ${totals.sourceRows}`);
  console.log(`  Rows malformed:       ${totals.malformed}`);
  console.log(`  Panels unusable:      ${totals.nullSkipped} (null netValue)`);
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
    console.error('\nSeed failed:', err);
  }
  process.exit(1);
}
