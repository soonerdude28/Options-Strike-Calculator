/**
 * GET /api/cron/fetch-greek-exposure-strike
 *
 * Fetches per-strike Greek Exposure for SPX 0DTE from Unusual Whales API.
 * One call per invocation:
 *   1. By-strike-expiry endpoint → call/put GEX, delta, charm, vanna per strike
 *
 * Computed columns stored alongside raw values:
 *   net_gex   = call_gex + put_gex
 *   net_delta = call_delta + put_delta
 *   net_charm = call_charm + put_charm
 *   net_vanna = call_vanna + put_vanna
 *   abs_gex   = |call_gex| + |put_gex|
 *   call_gex_fraction = abs_gex > 0 ? call_gex / abs_gex : null
 *
 * Strikes with both call_gex = '0.0000' AND put_gex = '0.0000' are
 * filtered (zero-OI, no useful signal).
 *
 * UNIQUE constraint: (date, expiry, strike) — uses ON CONFLICT DO UPDATE.
 *
 * That key is NOT unique in the vendor's own payload on a monthly expiry: UW
 * returns the AM-settled and PM-settled series merged with no discriminator
 * (staff-confirmed 2026-08-21), so the upsert used to discard one series per
 * collided strike without raising anything. Rows are now collapsed before the
 * write by a named, recorded rule — see ../_lib/gex-strike-integrity.ts — and
 * the count of collisions is returned and logged rather than absorbed.
 *
 * Every row carries its provenance: which rule combined it and from how many
 * vendor rows, when it was fetched and computed, the underlying spot with the
 * instant that spot was itself observed, and the spec version and commit that
 * produced it. Premarket gamma is computed by the vendor against a stale spot
 * (also staff-confirmed 2026-08-21) and this endpoint carries neither a spot
 * nor a timestamp, so freshness is established from /spot-exposures/strike —
 * which does return `time` — and recorded as verified / stale / unverified.
 *
 * Total API calls per invocation: 2 (chain + spot preflight)
 *
 * Schedule: 30 13,14 * * 1-5 (DST-safe dual slot). The default
 * isMarketHours() gate opens at 9:25 ET, so a single 13:30 UTC slot runs in
 * EDT (= 9:30 ET) but is gated in EST (= 8:30 ET) — silently writing zero rows
 * all winter while the intentional-skip check-in keeps the monitor green
 * (AUD-H3). The 14:30 UTC slot (= 9:30 ET in EST) closes that gap; in EDT both
 * slots run, which is harmless — the endpoint is a frozen daily snapshot and
 * the write is an idempotent ON CONFLICT upsert. For live intraday GEX, see
 * fetch-strike-exposure.ts (spot-exposures).
 *
 * Environment: UW_API_KEY, CRON_SECRET
 */

import { getDb } from '../_lib/db.js';
import { BUILD_SHA } from '../_lib/build-info.js';
import {
  GEX_STRIKE_SPEC_VERSION,
  assessSpotFreshness,
  dedupeStrikeRows,
  isOpexExpiry,
  reconcileExpiryTotals,
  type DedupeRule,
  type SpotFreshness,
} from '../_lib/gex-strike-integrity.js';
import logger from '../_lib/logger.js';
import { Sentry } from '../_lib/sentry.js';
import { uwFetch, checkDataQuality, withRetry } from '../_lib/api-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';

// ── Types ────────────────────────────────────────────────────

interface StrikeRow {
  date: string;
  expiry: string;
  strike: string;
  dte: number;
  call_gex: string;
  put_gex: string;
  call_delta: string;
  put_delta: string;
  call_charm: string;
  put_charm: string;
  call_vanna: string;
  put_vanna: string;
}

// ── Computed columns ─────────────────────────────────────────

function computeColumns(row: StrikeRow) {
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

  return { netGex, netDelta, netCharm, netVanna, absGex, callGexFraction };
}

// ── Store helper ─────────────────────────────────────────────

interface Provenance {
  underlying: string;
  dedupeRule: DedupeRule;
  observedAt: string;
  calculatedAt: string;
  spot: number | null;
  spotObservedAt: string | null;
  spotFreshness: SpotFreshness;
}

async function storeStrikeRows(
  rows: (StrikeRow & { source_rows: number })[],
  prov: Provenance,
): Promise<{ stored: number; skipped: number }> {
  if (rows.length === 0) return { stored: 0, skipped: 0 };

  const sql = getDb();

  try {
    const results = await sql.transaction((txn) =>
      rows.map((row) => {
        const {
          netGex,
          netDelta,
          netCharm,
          netVanna,
          absGex,
          callGexFraction,
        } = computeColumns(row);

        return txn`
          INSERT INTO greek_exposure_strike (
            date, expiry, strike, dte,
            call_gex, put_gex, call_delta, put_delta,
            call_charm, put_charm, call_vanna, put_vanna,
            net_gex, net_delta, net_charm, net_vanna,
            abs_gex, call_gex_fraction,
            underlying, source_rows, dedupe_rule,
            observed_at, calculated_at,
            spot, spot_observed_at, spot_freshness,
            spec_version, source_commit
          )
          VALUES (
            ${row.date}, ${row.expiry}, ${row.strike}, ${row.dte},
            ${row.call_gex}, ${row.put_gex},
            ${row.call_delta}, ${row.put_delta},
            ${row.call_charm}, ${row.put_charm},
            ${row.call_vanna}, ${row.put_vanna},
            ${netGex}, ${netDelta}, ${netCharm}, ${netVanna},
            ${absGex}, ${callGexFraction},
            ${prov.underlying}, ${row.source_rows}, ${prov.dedupeRule},
            ${prov.observedAt}, ${prov.calculatedAt},
            ${prov.spot}, ${prov.spotObservedAt}, ${prov.spotFreshness},
            ${GEX_STRIKE_SPEC_VERSION}, ${BUILD_SHA}
          )
          ON CONFLICT (date, expiry, strike) DO UPDATE SET
            dte               = EXCLUDED.dte,
            call_gex          = EXCLUDED.call_gex,
            put_gex           = EXCLUDED.put_gex,
            call_delta        = EXCLUDED.call_delta,
            put_delta         = EXCLUDED.put_delta,
            call_charm        = EXCLUDED.call_charm,
            put_charm         = EXCLUDED.put_charm,
            call_vanna        = EXCLUDED.call_vanna,
            put_vanna         = EXCLUDED.put_vanna,
            net_gex           = EXCLUDED.net_gex,
            net_delta         = EXCLUDED.net_delta,
            net_charm         = EXCLUDED.net_charm,
            net_vanna         = EXCLUDED.net_vanna,
            abs_gex           = EXCLUDED.abs_gex,
            call_gex_fraction = EXCLUDED.call_gex_fraction,
            underlying        = EXCLUDED.underlying,
            source_rows       = EXCLUDED.source_rows,
            dedupe_rule       = EXCLUDED.dedupe_rule,
            observed_at       = EXCLUDED.observed_at,
            calculated_at     = EXCLUDED.calculated_at,
            spot              = EXCLUDED.spot,
            spot_observed_at  = EXCLUDED.spot_observed_at,
            spot_freshness    = EXCLUDED.spot_freshness,
            spec_version      = EXCLUDED.spec_version,
            source_commit     = EXCLUDED.source_commit
          RETURNING strike
        `;
      }),
    );

    let stored = 0;
    for (const result of results) {
      if (result.length > 0) stored++;
    }
    return { stored, skipped: rows.length - stored };
  } catch (err) {
    Sentry.captureException(err);
    logger.warn({ err }, 'Batch greek_exposure_strike insert failed');
    return { stored: 0, skipped: rows.length };
  }
}

// ── Spot preflight ───────────────────────────────────────────

/**
 * Spot with the instant it was observed.
 *
 * `/spot-exposures/strike` is the only SPX endpoint here that returns a `time`
 * alongside `price`, which makes it the only one that can answer "was this
 * spot fresh". Returns null on any failure — a missing spot flags the rows
 * `unverified` rather than failing the run, because the chain data is still
 * worth archiving without it.
 */
async function fetchSpotWithTime(
  apiKey: string,
): Promise<{ price: number; time: string } | null> {
  try {
    const rows = await uwFetch<{ price: string; time: string }>(
      apiKey,
      '/stock/SPX/spot-exposures/strike?limit=1',
    );
    const raw = rows[0];
    if (!raw?.price || !raw?.time) return null;
    const price = Number.parseFloat(raw.price);
    return Number.isFinite(price) ? { price, time: raw.time } : null;
  } catch (err) {
    logger.warn({ err }, 'fetch-greek-exposure-strike: spot preflight failed');
    return null;
  }
}

// ── Handler ──────────────────────────────────────────────────

export default withCronInstrumentation(
  'fetch-greek-exposure-strike',
  async (ctx): Promise<CronResult> => {
    const { apiKey, today } = ctx;

    const observedAt = new Date();
    const path = `/stock/SPX/greek-exposure/strike-expiry?date=${today}&expiry=${today}`;
    const allRows = await withRetry(() =>
      uwFetch<StrikeRow>(apiKey, path, (body) => body.data as StrikeRow[]),
    );

    // Filter zero-OI strikes (no useful signal)
    const filtered = allRows.filter(
      (r) => !(r.call_gex === '0.0000' && r.put_gex === '0.0000'),
    );

    const skippedZero = allRows.length - filtered.length;

    // Collapse the AM/PM collision before it reaches a key that cannot hold
    // both. See ../_lib/gex-strike-integrity.ts for why the rule is named.
    const { rows, collisions, rule } = dedupeStrikeRows(filtered);
    if (collisions.length > 0) {
      const differing = collisions.filter((c) => !c.identical).length;
      logger.warn(
        {
          date: today,
          collisions: collisions.length,
          differingGreeks: differing,
          rule,
          opexExpiries: [
            ...new Set(
              collisions
                .filter((c) => isOpexExpiry(c.expiry))
                .map((c) => c.expiry),
            ),
          ],
          sample: collisions.slice(0, 3),
        },
        'greek_exposure_strike: duplicate (underlying, expiry, strike) collision ' +
          'resolved by named rule — the vendor merges AM/PM settled series',
      );
    }

    // Spot with the instant it was itself observed. The chain endpoint
    // supplies neither, and premarket gamma is computed against a stale spot.
    const spotSample = await fetchSpotWithTime(apiKey);
    const { freshness: spotFreshness, ageSeconds: spotAgeSeconds } =
      assessSpotFreshness({
        spot: spotSample?.price ?? null,
        spotObservedAt: spotSample?.time ?? null,
        now: observedAt,
      });
    if (spotFreshness !== 'verified') {
      logger.warn(
        { date: today, spotFreshness, spotAgeSeconds },
        'greek_exposure_strike: spot freshness could not be verified — rows flagged',
      );
    }

    ctx.logger.info(
      {
        fetched: allRows.length,
        afterFilter: filtered.length,
        afterDedupe: rows.length,
        skippedZero,
        collisions: collisions.length,
        rule,
        spotFreshness,
      },
      'fetch-greek-exposure-strike: rows fetched',
    );

    const { stored, skipped } = await withRetry(() =>
      storeStrikeRows(rows, {
        underlying: 'SPX',
        dedupeRule: rule,
        observedAt: observedAt.toISOString(),
        calculatedAt: new Date().toISOString(),
        spot: spotSample?.price ?? null,
        spotObservedAt: spotSample?.time ?? null,
        spotFreshness,
      }),
    );

    // Reconciliation: the per-expiry totals must add up to the aggregate.
    const perExpiry = new Map<string, number>();
    for (const r of rows) {
      const { netGex } = computeColumns(r);
      perExpiry.set(r.expiry, (perExpiry.get(r.expiry) ?? 0) + netGex);
    }
    const aggregate = rows.reduce((t, r) => t + computeColumns(r).netGex, 0);
    const reconciliation = reconcileExpiryTotals(perExpiry.values(), aggregate);
    if (!reconciliation.ok) {
      logger.error(
        { date: today, ...reconciliation },
        'greek_exposure_strike: expiry totals do not reconcile with the aggregate',
      );
      Sentry.captureException(
        new Error(
          `greek_exposure_strike reconciliation failed: ` +
            `${reconciliation.difference} > ${reconciliation.tolerance}`,
        ),
      );
    }

    // Sanity check: log net GEX at largest absolute GEX strike
    if (rows.length > 0) {
      const largest = rows.reduce((best, r) => {
        const a =
          Math.abs(Number.parseFloat(r.call_gex)) +
          Math.abs(Number.parseFloat(r.put_gex));
        const b =
          Math.abs(Number.parseFloat(best.call_gex)) +
          Math.abs(Number.parseFloat(best.put_gex));
        return a > b ? r : best;
      }, rows[0]!);
      const { netGex } = computeColumns(largest);
      ctx.logger.info(
        { strike: largest.strike, netGex: Math.round(netGex) },
        'Largest-magnitude strike net GEX',
      );
    }

    ctx.logger.info(
      { fetched: allRows.length, stored, skipped },
      'fetch-greek-exposure-strike completed',
    );

    // Data quality check
    const qcRows = await getDb()`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (
               WHERE net_gex IS NOT NULL AND net_gex != 0
             ) AS nonzero
      FROM greek_exposure_strike
      WHERE date = ${today} AND expiry = ${today}
    `;
    const { total: qcTotal, nonzero: qcNonzero } = qcRows[0]!;
    await checkDataQuality({
      job: 'fetch-greek-exposure-strike',
      table: 'greek_exposure_strike',
      date: today,
      total: Number(qcTotal),
      nonzero: Number(qcNonzero),
      minRows: 10,
    });

    return {
      status: 'success',
      metadata: {
        fetched: allRows.length,
        stored,
        skipped,
        // Surfaced, not absorbed: a caller reading the cron result can tell a
        // clean session from one where two series were combined.
        collisions: collisions.length,
        dedupeRule: rule,
        spotFreshness,
        specVersion: GEX_STRIKE_SPEC_VERSION,
        reconciled: reconciliation.ok,
      },
    };
  },
);
