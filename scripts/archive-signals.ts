/**
 * Append-only archive of the short-retention signal tables.
 *
 * Why this exists: a survey of this database found that every signal table
 * except `periscope_snapshots` holds only four to eight days. They are live
 * operations tables and they are pruned. That is correct for serving the app
 * and fatal for research — a strategy conditioned on dealer gamma or flow
 * cannot be backtested against five days, and every day that passes without
 * capture is a day permanently lost.
 *
 * So this runs nightly and appends whatever is currently in the window to
 * gzipped JSONL, partitioned by session date. It is idempotent: a partition
 * that already exists is never rewritten, so a re-run costs nothing and a
 * missed night is repaired by the next one as long as the gap is inside the
 * retention window.
 *
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/archive-signals.ts
 *
 * On sizing. `strike_exposures` is 833k rows a day across 80 tickers — 59 GB a
 * year raw, which is not an archive anyone keeps. It is filtered to the
 * tickers a strategy here could actually trade. `greek_exposure` is already
 * this table rolled up per expiry, so the aggregate survives in full either
 * way; what the filter drops is per-strike detail for names we do not trade.
 *
 * On point-in-time honesty. Every partition is recorded in a capture ledger
 * with the wall-clock time it was written. A backtest that later reads this
 * archive can therefore establish not just what a signal said, but when it
 * became observable — which is the difference between a research set and a
 * set of numbers that happen to be in date order.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { neon } from '@neondatabase/serverless';

const DEFAULT_OUT =
  '/Users/ceverett/Trading-Bot/v1_ma_crossover/Data/signal_archive';

/** table -> the column that carries its session date. */
const TABLES: Record<string, string> = {
  market_snapshots: 'date',
  zero_gamma_levels: 'ts',
  dark_pool_prints: 'date',
  training_features: 'date',
  spot_exposures: 'date',
  greek_exposure: 'date',
  flow_data: 'date',
  lottery_finder_fires: 'date',
  strike_exposures: 'date',
};

/** Tables filtered to a ticker set, because the full universe is too large. */
const TICKER_FILTERED = new Set(['strike_exposures']);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<number> {
  const out = arg('out', DEFAULT_OUT);
  const tickers = arg('tickers', 'SPY,QQQ,SPX')
    .split(',')
    .map((t) => t.trim().toUpperCase());
  const force = process.argv.includes('--force');

  if (!process.env.DATABASE_URL) {
    console.error(
      'DATABASE_URL is not set — run with: node --env-file=.env.local',
    );
    return 2;
  }
  const sql = neon(process.env.DATABASE_URL);
  const capturedAt = new Date().toISOString();
  const ledgerPath = join(out, '_capture_log.jsonl');
  mkdirSync(out, { recursive: true });

  let written = 0;
  let skipped = 0;
  let rowsTotal = 0;

  for (const [table, dateCol] of Object.entries(TABLES)) {
    let dates: string[];
    try {
      const r = await sql.query(
        `select distinct (${dateCol}::date)::text d from ${table} order by d`,
      );
      dates = (r as { d: string }[]).map((x) => x.d).filter(Boolean);
    } catch (e) {
      console.log(
        `${table.padEnd(22)} skipped — ${(e as Error).message.slice(0, 60)}`,
      );
      continue;
    }
    if (dates.length === 0) {
      console.log(`${table.padEnd(22)} empty`);
      continue;
    }

    for (const date of dates) {
      const partition = join(out, table, `${date}.jsonl.gz`);
      if (existsSync(partition) && !force) {
        skipped++;
        continue;
      }

      const where = TICKER_FILTERED.has(table)
        ? `where ${dateCol}::date = $1 and ticker = any($2)`
        : `where ${dateCol}::date = $1`;
      const params = TICKER_FILTERED.has(table) ? [date, tickers] : [date];

      const rows = await sql.query(`select * from ${table} ${where}`, params);
      if (rows.length === 0) continue;

      // One JSON object per line: survives partial reads, greps, and streams,
      // and needs no schema migration when the source table gains a column.
      const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
      const gz = gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
      mkdirSync(dirname(partition), { recursive: true });
      writeFileSync(partition, gz);

      appendFileSync(
        ledgerPath,
        JSON.stringify({
          captured_at: capturedAt,
          table,
          session_date: date,
          rows: rows.length,
          bytes_gz: gz.length,
          sha256: createHash('sha256').update(gz).digest('hex'),
          tickers: TICKER_FILTERED.has(table) ? tickers : null,
        }) + '\n',
        'utf8',
      );

      written++;
      rowsTotal += rows.length;
      console.log(
        `${table.padEnd(22)} ${date}  ${String(rows.length).padStart(8)} rows  ` +
          `${(gz.length / 1e6).toFixed(2)} MB gz`,
      );
    }
  }

  console.log(
    `\n${written} partition(s) written, ${skipped} already present, ` +
      `${rowsTotal.toLocaleString()} rows archived`,
  );
  console.log(`archive  ${out}`);
  if (existsSync(ledgerPath)) {
    const lines = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    console.log(`ledger   ${ledgerPath} (${lines.length} entries)`);
  }
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
