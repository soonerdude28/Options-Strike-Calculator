#!/usr/bin/env node

/**
 * Local backfill script for SPX Greek Exposure by Strike+Expiry.
 * Fetches 0DTE per-strike greek exposure from the UW strike-expiry endpoint.
 *
 * For 0DTE backfill: date=expiry=<trading_date>, so dte=0 for all rows.
 *
 * Walks history, so it meets the monthly-OPEX collision on every third Friday
 * it touches: UW merges the AM- and PM-settled series with no discriminator,
 * and `ON CONFLICT (date, expiry, strike) DO UPDATE` used to keep whichever
 * arrived last. The same failure was found independently in the Periscope
 * backfill, which measured it at 35 of 760 days. Rows are deduped by the same
 * named rule the cron uses — see api/_lib/gex-strike-integrity.ts — so a
 * re-run repairs those days rather than re-inflicting the loss on them.
 *
 * Usage:
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-exposure-strike.mjs
 *   UW_API_KEY=your_key DATABASE_URL="postgresql://..." node scripts/backfill-greek-exposure-strike.mjs 5
 */

import { neon } from '@neondatabase/serverless';

import {
  GEX_STRIKE_SPEC_VERSION,
  NEAR_IDENTICAL_REL_DIFF,
  dedupeStrikeRows,
  isOpexExpiry,
} from '../api/_lib/gex-strike-integrity.ts';
import { getTradingDays } from './_lib/trading-days.mjs';

/** Recorded on every row so a backfilled value is attributable to a build. */
const SOURCE_COMMIT = process.env.SOURCE_COMMIT ?? 'backfill-script';

const UW_API_KEY = process.env.UW_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!UW_API_KEY) {
  console.error('Missing UW_API_KEY');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

const sql = neon(DATABASE_URL);
const UW_BASE = 'https://api.unusualwhales.com/api';

const days = Number.parseInt(process.argv[2] ?? '30', 10);

// ── Fetch strike-expiry rows for one date (0DTE: date=expiry) ──

async function fetchStrikeExpiry(date, counters) {
  const url = `${UW_BASE}/stock/SPX/greek-exposure/strike-expiry?date=${date}&expiry=${date}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.warn(
      `  UW strike-expiry API ${res.status} for ${date}: ${text.slice(0, 100)}`,
    );
    counters.failed++;
    return [];
  }

  const body = await res.json();
  return body.data ?? [];
}

// ── Store strike rows for a date ────────────────────────────

async function storeStrikeRows(rawRows, date, counters) {
  let stored = 0;

  // Drop zero-GEX strikes first, then collapse the AM/PM collision with the
  // same rule the cron runs under. Doing it in this order matters: a zero row
  // summed into a real one would change nothing but would inflate source_rows
  // and make a clean strike look collided.
  const filtered = rawRows.filter(
    (r) => !(r.call_gex === '0.0000' && r.put_gex === '0.0000'),
  );
  const { rows, collisions, rule } = dedupeStrikeRows(
    filtered.map((r) => ({ ...r, date, expiry: date })),
  );
  if (collisions.length > 0) {
    const differing = collisions.filter((c) => !c.identical).length;
    console.warn(
      `  ${date}: ${collisions.length} duplicate (expiry, strike) key(s) ` +
        `(${differing} with differing greeks) combined by rule '${rule}'` +
        (isOpexExpiry(date) ? ' — monthly OPEX' : ''),
    );
    // This script runs the uniform sum rule with no root evidence, so a
    // snapshot-duplicate day (see the lib header) would be silently doubled.
    // Flag the near-identical pairs loudly so a human checks the day rather
    // than trusting the stamp.
    const nearIdentical = collisions.filter(
      (c) => c.maxRelDiff <= NEAR_IDENTICAL_REL_DIFF,
    );
    if (nearIdentical.length > 0) {
      console.warn(
        `  ${date}: WARNING — ${nearIdentical.length} near-identical pair(s) ` +
          "summed without root evidence; the day's gamma may be doubled",
      );
    }
    counters.collisions = (counters.collisions ?? 0) + collisions.length;
  }

  for (const row of rows) {
    // Layer 2 computed columns
    const callGex = Number.parseFloat(row.call_gex);
    const putGex = Number.parseFloat(row.put_gex);
    const netGex = callGex + putGex;
    const netDelta =
      Number.parseFloat(row.call_delta) + Number.parseFloat(row.put_delta);
    const netCharm =
      Number.parseFloat(row.call_charm) + Number.parseFloat(row.put_charm);
    const netVanna =
      Number.parseFloat(row.call_vanna) + Number.parseFloat(row.put_vanna);
    const absGex = Math.abs(callGex) + Math.abs(putGex);
    const callGexFraction = absGex > 0 ? callGex / absGex : null;

    try {
      const result = await sql`
        INSERT INTO greek_exposure_strike (
          date, expiry, strike, dte,
          call_gex, put_gex,
          call_delta, put_delta,
          call_charm, put_charm,
          call_vanna, put_vanna,
          net_gex, net_delta, net_charm, net_vanna,
          abs_gex, call_gex_fraction,
          underlying, source_rows, dedupe_rule, spec_version, source_commit
        )
        VALUES (
          ${date}, ${date}, ${row.strike}, 0,
          ${row.call_gex}, ${row.put_gex},
          ${row.call_delta}, ${row.put_delta},
          ${row.call_charm}, ${row.put_charm},
          ${row.call_vanna}, ${row.put_vanna},
          ${netGex}, ${netDelta}, ${netCharm}, ${netVanna},
          ${absGex}, ${callGexFraction},
          'SPX', ${row.source_rows}, ${rule},
          ${GEX_STRIKE_SPEC_VERSION}, ${SOURCE_COMMIT}
        )
        ON CONFLICT (date, expiry, strike) DO UPDATE SET
          underlying = EXCLUDED.underlying,
          source_rows = EXCLUDED.source_rows,
          dedupe_rule = EXCLUDED.dedupe_rule,
          spec_version = EXCLUDED.spec_version,
          source_commit = EXCLUDED.source_commit,
          dte = EXCLUDED.dte,
          call_gex = EXCLUDED.call_gex,
          put_gex = EXCLUDED.put_gex,
          call_delta = EXCLUDED.call_delta,
          put_delta = EXCLUDED.put_delta,
          call_charm = EXCLUDED.call_charm,
          put_charm = EXCLUDED.put_charm,
          call_vanna = EXCLUDED.call_vanna,
          put_vanna = EXCLUDED.put_vanna,
          net_gex = EXCLUDED.net_gex,
          net_delta = EXCLUDED.net_delta,
          net_charm = EXCLUDED.net_charm,
          net_vanna = EXCLUDED.net_vanna,
          abs_gex = EXCLUDED.abs_gex,
          call_gex_fraction = EXCLUDED.call_gex_fraction
        RETURNING strike
      `;
      if (result.length > 0) stored++;
    } catch (err) {
      console.warn(
        `  Insert error for ${date} strike ${row.strike}: ${err.message}`,
      );
      counters.failed++;
    }
  }

  return stored;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const tradingDays = getTradingDays(days);

  console.log(`Backfilling SPX Greek Exposure by Strike (0DTE)`);
  console.log(
    `Days: ${tradingDays.length} (${tradingDays[0]} to ${tradingDays.at(-1)})\n`,
  );

  let totalStrikes = 0;
  let totalStored = 0;
  const counters = { failed: 0 };

  for (const date of tradingDays) {
    await new Promise((r) => setTimeout(r, 300));

    const rows = await fetchStrikeExpiry(date, counters);

    // Filter zero-GEX rows before logging count
    const nonZero = rows.filter(
      (r) => r.call_gex !== '0.0000' || r.put_gex !== '0.0000',
    );

    const stored = await storeStrikeRows(rows, date, counters);

    totalStrikes += nonZero.length;
    totalStored += stored;

    // Find peak magnitude GEX strike for logging
    let peakStrike = null;
    let peakNetGex = null;
    for (const r of nonZero) {
      const ng = Number.parseFloat(r.call_gex) + Number.parseFloat(r.put_gex);
      if (peakNetGex === null || Math.abs(ng) > Math.abs(peakNetGex)) {
        peakNetGex = ng;
        peakStrike = r.strike;
      }
    }

    const peakStr =
      peakStrike !== null
        ? `Strike ${peakStrike} net GEX: ${Math.round(peakNetGex).toLocaleString()}`
        : 'N/A';

    console.log(
      `  ${date}: ${nonZero.length} strikes (${stored} stored) | Peak: ${peakStr}`,
    );
  }

  console.log(`\nDone!`);
  console.log(`  Total strikes processed: ${totalStrikes}`);
  console.log(`  Total strikes stored: ${totalStored}`);
  console.log(`  Failures: ${counters.failed}`);

  // Surface partial failures to CI/operators via a non-zero exit code.
  if (counters.failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  console.error('Backfill failed:', err);
  process.exit(1);
}
