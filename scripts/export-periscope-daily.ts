/**
 * Export daily dealer-Greek exposure as a point-in-time signal series.
 *
 * `periscope_snapshots` is the one table in this database with real history —
 * 731 session days back to 2023-09-21, where every other signal table holds
 * four to eight. It is therefore the only calculator signal that can be
 * backtested rather than merely forward-tested.
 *
 * Shape: SPX 0DTE dealer gamma, charm and vanna by strike, snapshotted at
 * `timeframe='EOD'` between 20:00 and 21:00 UTC — 15:00 to 17:00 ET depending
 * on the season, so at or just after the 16:00 close. On every EOD row the
 * expiry equals the capture date: this is the final state of that session's
 * dealer positioning, not a forecast of the next one.
 *
 * That timing is what makes it usable. A value knowable only after T's close
 * and acted on at T+1's open carries exactly one session of lag — the same
 * discipline the moving average already runs under, and the reason the
 * existing engine can execute this without modification.
 *
 * Aggregation is a plain sum across strikes for one expiry, which is the
 * standard net-exposure figure. Nothing is normalised here: scaling decisions
 * belong in the strategy where they can be frozen into a manifest and
 * hashed, not in the export where they would be invisible.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';

const DEFAULT_OUT =
  '/Users/ceverett/Trading-Bot/v1_ma_crossover/Data/spx_dealer_greeks_daily.csv';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — run with: node --env-file=.env.local');
    return 2;
  }
  const out = resolve(arg('out', DEFAULT_OUT));
  const sql = neon(process.env.DATABASE_URL);

  // One row per session: net exposure per panel, plus the strike count so a
  // thin day is visible rather than silently averaged in.
  const rows = await sql.query(`
    select
      captured_at::date::text                                       as date,
      max(captured_at)::text                                        as observed_at,
      sum(value) filter (where panel = 'gamma')::float              as net_gamma,
      sum(value) filter (where panel = 'charm')::float              as net_charm,
      sum(value) filter (where panel = 'vanna')::float              as net_vanna,
      count(*) filter (where panel = 'gamma')::int                  as gamma_strikes
    from periscope_snapshots
    where timeframe = 'EOD'
    group by captured_at::date
    having count(*) filter (where panel = 'gamma') > 0
    order by 1
  `);

  if (rows.length === 0) {
    console.error('no EOD periscope rows found');
    return 3;
  }

  type Row = {
    date: string;
    /** Named observed_at, not captured_at: the bot's signal contract keys
     *  point-in-time admissibility off observability, and a column that means
     *  "when this became knowable" should say so. */
    observed_at: string;
    net_gamma: number | null;
    net_charm: number | null;
    net_vanna: number | null;
    gamma_strikes: number;
  };
  const data = rows as Row[];

  const bad = data.find(
    (r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.net_gamma ?? NaN),
  );
  if (bad) {
    console.error(`malformed row: ${JSON.stringify(bad)}. Refusing to write.`);
    return 4;
  }

  const csv = [
    'date,observed_at,net_gamma,net_charm,net_vanna,gamma_strikes',
    ...data.map(
      (r) =>
        `${r.date},${r.observed_at},${r.net_gamma},` +
        `${r.net_charm ?? ''},${r.net_vanna ?? ''},${r.gamma_strikes}`,
    ),
  ].join('\n');

  const meta = [
    'signal_id: spx_dealer_greeks_eod',
    'underlying: SPX',
    'frequency: 1d',
    'panels: gamma, charm, vanna',
    'aggregation: sum of per-strike value over the single EOD expiry',
    'source: options-strike-calculator:periscope_snapshots (timeframe=EOD)',
    'timezone: America/New_York',
    'knowable_at: >-',
    '  T close. Captured 20:00-21:00 UTC, i.e. 15:00-17:00 ET depending on the',
    '  season, so at or just after the 16:00 ET close and always before the',
    '  T+1 open. Acting at the T+1 open is exactly one session of lag.',
    `date_range_start: ${data[0]!.date}`,
    `date_range_end: ${data[data.length - 1]!.date}`,
    `rows: ${data.length}`,
    'caveats: >-',
    '  On every EOD row the expiry equals the capture date, so this is the',
    '  closing state of that session 0DTE positioning, not a forecast. The',
    '  underlying is SPX while a strategy here would trade SPY; they track the',
    '  same index but they are not the same instrument, and the manifest must',
    '  say so.',
    '',
  ].join('\n');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${csv}\n`, 'utf8');
  writeFileSync(out.replace(/\.csv$/, '.meta.yaml'), meta, 'utf8');

  const positive = data.filter((r) => (r.net_gamma ?? 0) > 0).length;
  console.log(`sessions    ${data.length}, ${data[0]!.date} .. ${data[data.length - 1]!.date}`);
  console.log(`net gamma   ${positive} positive / ${data.length - positive} negative`);
  console.log(`wrote       ${out}`);
  console.log(`            ${out.replace(/\.csv$/, '.meta.yaml')}`);
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
