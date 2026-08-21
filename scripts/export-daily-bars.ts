/**
 * Export daily OHLCV bars for the trading bot's data contract.
 *
 * Runs inside this repo on purpose. The Schwab session lives here — tokens in
 * Redis, refreshed under a mutex, with a seven-day deadline this codebase
 * already tracks. The bot has no Schwab credentials of its own and should not
 * get any: a second OAuth registration would mean a second refresh token to
 * keep alive, and the whole point is that the calculator already solved that.
 *
 * Writes the CSV + meta pair that `v1_ma_crossover/core/data.py` accepts. The
 * bot then loads it through its own 28 contract checks, which is where the
 * data is actually validated — this script only has to write it honestly.
 *
 *   node --env-file=.env.local node_modules/.bin/tsx \
 *     scripts/export-daily-bars.ts --symbol SPY --start 2015-01-01
 *
 * Read-only. Price history only. No account, position or order call.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { uwFetch } from '../api/_lib/uw-fetch.js';

/**
 * Source note, and it matters.
 *
 * The obvious route — this repo's own `schwabFetch('/pricehistory')` — does
 * NOT return Schwab daily bars. `historyAdapter` rebuilds them by fetching UW
 * minute candles one day at a time and aggregating, and caps the window at
 * MAX_HISTORY_DATES = 66 sessions. Correct for the intraday overlay it was
 * written for; useless for a 302-row daily backtest.
 *
 * So this goes to the same underlying vendor directly, at its daily
 * resolution: UW `/stock/{t}/ohlc/1d`, up to 2500 bars in one call. The data
 * is Unusual Whales', not Schwab's, and the meta file says so — mislabelling
 * the vendor is exactly the kind of quiet drift the bot's data contract
 * exists to catch.
 */

/** UW daily candle. `start_time` is absent on 1d, `date` carries the session. */
interface UwDailyCandle {
  date?: string;
  start_time?: string;
  /** 'pr' pre-market | 'r' regular session | 'po' post-market. */
  market_time?: string;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume: number | string;
}

const DEFAULT_OUT =
  '/Users/ceverett/Trading-Bot/v1_ma_crossover/Data/spy_daily.csv';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return v;
}

/**
 * The session date for an epoch stamp, in New York.
 *
 * Not the machine's timezone. Whether a daily bar's stamp is midnight Eastern
 * or midnight UTC decides whether the series is dated correctly or shifted
 * back a day — invisible in the numbers, and fatal to a strategy whose whole
 * discipline is a one-session execution lag. The bot re-checks this
 * independently on load; both sides refusing is the point.
 */
function sessionDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function weekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 Sun .. 6 Sat
}

async function main(): Promise<number> {
  const symbol = arg('symbol', 'SPY').toUpperCase();
  const start = arg('start', '2015-01-01');
  const end = arg('end', sessionDate(Date.now()));
  const out = resolve(arg('out', DEFAULT_OUT));

  const startMs = Date.parse(`${start}T00:00:00-05:00`);
  const endMs = Date.parse(`${end}T23:59:59-05:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    console.error(`bad range: ${start} .. ${end}`);
    return 2;
  }

  const apiKey = process.env.UW_API_KEY ?? '';
  if (!apiKey) {
    console.error('UW_API_KEY is not set — run with: node --env-file=.env.local');
    return 2;
  }

  const params = new URLSearchParams({
    timeframe: arg('timeframe', '10Y'),
    limit: '2500',
    end_date: end,
  });

  console.log(`requesting  ${symbol} 1d candles, timeframe=${params.get('timeframe')}`);
  const candles = await uwFetch<UwDailyCandle>(
    apiKey,
    `/stock/${encodeURIComponent(symbol)}/ohlc/1d?${params.toString()}`,
  );

  if (!Array.isArray(candles) || candles.length === 0) {
    console.error('no candles returned for that symbol and range');
    return 3;
  }

  const num = (v: number | string): number =>
    typeof v === 'number' ? v : Number.parseFloat(v);

  // UW returns up to THREE rows per session — pre-market, regular and
  // post-market — all carrying the same `date`. Taking the wrong one would
  // put a pre-market bar into a daily backtest: same shape, same date, wrong
  // prices, and nothing downstream could tell. Regular session only, matching
  // this repo's own filter in market-data-adapters.ts and Schwab's
  // needExtendedHoursData=false.
  const regular = candles.filter((c) => (c.market_time ?? 'r') === 'r');
  if (regular.length === 0) {
    console.error('no regular-session candles in the response');
    return 3;
  }

  const rows = regular
    .map((c) => {
      // 1d candles carry `date`; fall back to the epoch path for safety.
      const date = c.date ?? (c.start_time ? sessionDate(Date.parse(c.start_time)) : '');
      return {
        date,
        open: num(c.open),
        high: num(c.high),
        low: num(c.low),
        close: num(c.close),
        volume: num(c.volume),
      };
    })
    .filter((r) => r.date >= start && r.date <= end)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (rows.length === 0) {
    console.error(`no candles fell inside ${start} .. ${end}`);
    return 3;
  }
  const bad = rows.find(
    (r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
      ![r.open, r.high, r.low, r.close, r.volume].every(Number.isFinite),
  );
  if (bad) {
    console.error(`malformed candle: ${JSON.stringify(bad)}. Refusing to write.`);
    return 4;
  }

  // Two independent signatures of a shifted series. The bot checks these too;
  // catching it here means we never write a bad file in the first place.
  const weekendRows = rows.filter((r) => weekday(r.date) === 0 || weekday(r.date) === 6);
  if (weekendRows.length > 0) {
    console.error(
      `${weekendRows.length} bar(s) landed on a weekend (first ${weekendRows[0]!.date}). ` +
        `Epoch stamps are not midnight America/New_York; the series is shifted. Refusing to write.`,
    );
    return 4;
  }
  if (rows.length >= 15) {
    const present = new Set(rows.map((r) => weekday(r.date)));
    const missing = [1, 2, 3, 4, 5].filter((d) => !present.has(d));
    if (missing.length > 0) {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      console.error(
        `${rows.length} sessions contain no ${missing.map((d) => names[d]).join(', ')}. ` +
          `A shift back removes every Friday, forward every Monday. Refusing to write.`,
      );
      return 4;
    }
  }

  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.date)) {
      console.error(`duplicate session ${r.date}. Refusing to write.`);
      return 4;
    }
    seen.add(r.date);
  }

  const csv = [
    'date,open,high,low,close,volume',
    ...rows.map(
      (r) =>
        `${r.date},${r.open.toFixed(6)},${r.high.toFixed(6)},` +
        `${r.low.toFixed(6)},${r.close.toFixed(6)},${Math.round(r.volume)}`,
    ),
  ].join('\n');

  const meta = [
    `symbol: ${symbol}`,
    'frequency: 1d',
    'adjustment_basis: split_only',
    'dividend_column_present: false',
    'dividend_timing: none',
    'source: unusual-whales:/stock/{ticker}/ohlc/1d (via Options-Strike-Calculator uwFetch)',
    'timezone: America/New_York',
    'currency: USD',
    `date_range_start: ${rows[0]!.date}`,
    `date_range_end: ${rows[rows.length - 1]!.date}`,
    `rows: ${rows.length}`,
    'adjustment_provenance: >-',
    '  Source is Unusual Whales /stock/{ticker}/ohlc/1d, reached with this',
    '  calculator\'s UW_API_KEY. NOT Schwab: this repo\'s schwabFetch(/pricehistory)',
    '  rebuilds daily bars from UW minute data and caps at 66 sessions, so it',
    '  cannot serve a daily backtest. The split_only basis above is ASSUMED and',
    '  NOT verified - UW publishes no adjustment-basis field. Verify before any',
    '  result is trusted: compare a close spanning a known SPY dividend against',
    '  a second source. See Trading-Bot docs/schwab-api-audit.md 2.',
    '',
  ].join('\n');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${csv}\n`, 'utf8');
  writeFileSync(out.replace(/\.csv$/, '.meta.yaml'), meta, 'utf8');

  console.log(`received    ${rows.length} bars, ${rows[0]!.date} .. ${rows[rows.length - 1]!.date}`);
  console.log(`wrote       ${out}`);
  console.log(`            ${out.replace(/\.csv$/, '.meta.yaml')}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
