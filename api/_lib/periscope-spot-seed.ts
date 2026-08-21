/**
 * Pure logic for the `uw_spot` seed backfill
 * (`scripts/backfill-periscope-uw-spot.mjs`).
 *
 * `periscope_snapshots` gained a `source` column in migration #191 and
 * the historical `uw_eod` series is loaded, but `uw_spot` — the RAW
 * DOLLAR series every detector and `/api/periscope-map` is pinned to —
 * is empty, because its forward cron (`populate-periscope-from-uw`)
 * has never run. This module backs the script that seeds that series
 * from the `gex_strike_0dte` rows already sitting in the database, so
 * the detectors have real intraday history and the cron's mapping is
 * validated before it first fires in production.
 *
 * Same split as `periscope-backfill-mapper.ts` /
 * `backfill-periscope-from-uw.mjs`: everything decidable from the data
 * alone lives here so it is unit-testable, while the DB machinery
 * stays in the `.mjs` script.
 *
 * NOTE ON IMPORT EXTENSIONS: the relative imports below use `.ts`, not
 * `.js`. That is deliberate and load-bearing — the `.mjs` backfill runs
 * on Node 24 type-stripping, whose ESM resolver does NOT map a `.js`
 * specifier onto a `.ts` file (verified: `ERR_MODULE_NOT_FOUND`). tsc
 * accepts it via `allowImportingTsExtensions`, and this module is
 * backfill-only — no Vercel Function imports it.
 */

import { PANELS, type PanelName } from './periscope-gexbot.ts';
import {
  SOURCE_UW_SPOT,
  clampSnapshotValue,
  netValue,
  type UwStrikeRow,
} from './periscope-uw.ts';

/**
 * The cadence `populate-periscope-from-uw` is scheduled on in
 * `vercel.json` — every 10 minutes across the RTH window. Every seeded
 * `captured_at` must land on the same 10-minute grid the live cron
 * writes on — see `selectTenMinuteSlices`.
 */
export const SLICE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * The 10-minute grid boundary a tick belongs to: the first grid point
 * at or after `ms`. A tick landing exactly ON a boundary belongs to
 * that boundary, not the next one — that is the instant the cron would
 * have read it.
 *
 * Buckets are therefore half-open on the left: `(B - 10min, B]`.
 */
export function sliceBoundaryMs(ms: number): number {
  return Math.ceil(ms / SLICE_INTERVAL_MS) * SLICE_INTERVAL_MS;
}

/** Anything the DB driver or a test might hand us for a timestamp. */
export type TimestampInput = Date | string | number;

function toEpochMs(value: TimestampInput): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Downsample a dense tick series onto the live cron's 10-minute grid.
 *
 * # Why this exists (the whole point of the seed)
 *
 * `gex_strike_0dte` lands at ~1-minute cadence, but
 * `populate-periscope-from-uw` fires every 10 minutes and writes
 * whatever the single latest tick is at that moment. If the seed wrote
 * all ~170 daily ticks, the historical stretch of `uw_spot` would have
 * 1-minute slice-over-slice delta semantics while everything the cron
 * writes afterwards has 10-minute ones — silently corrupting every
 * delta that straddles the seam, and every percentile pooled across it.
 * So the seed reproduces the cron's sampling exactly: for each grid
 * boundary, the LAST tick at or before it.
 *
 * # Rules
 *
 * - Bucket `(B - 10min, B]` → the newest tick inside it. That is the
 *   tick `MAX(timestamp)` would have returned had the cron fired at B.
 * - A bucket containing no ticks is OMITTED. No slice is fabricated by
 *   carrying a stale tick forward onto a boundary it never covered —
 *   a hole in the series is honest; a duplicated value at a new
 *   timestamp would read as "the board did not move" and would emit a
 *   zero delta that never happened.
 * - Output is ascending and duplicate-free by construction (one entry
 *   per bucket, keyed on the boundary).
 * - Unparseable / non-finite inputs are dropped.
 *
 * Pure: the input array is never mutated and the returned `Date`s are
 * fresh objects, so a caller mutating them cannot reach back into the
 * input.
 *
 * NOT modelled here: the cron's `STALENESS_CUTOFF_MS` (5 min) early
 * return. A bucket whose newest tick is 5–10 minutes old would have
 * made the live cron log "stale" and write nothing, whereas the seed
 * writes it. That is deliberate — the tick is real data carrying its
 * own real `captured_at`, so a seeded slice is a true observation of a
 * lagging feed rather than a fabricated one, and a hole would cost the
 * detectors a slice for no correctness gain. The script counts these
 * and reports them so the divergence is visible rather than implied.
 */
export function selectTenMinuteSlices(
  timestamps: readonly TimestampInput[],
): Date[] {
  /** boundary ms → newest tick ms inside that boundary's bucket. */
  const newestPerBucket = new Map<number, number>();

  for (const raw of timestamps) {
    const ms = toEpochMs(raw);
    if (ms == null) continue;
    const boundary = sliceBoundaryMs(ms);
    const current = newestPerBucket.get(boundary);
    if (current == null || ms > current) newestPerBucket.set(boundary, ms);
  }

  return [...newestPerBucket.values()]
    .sort((a, b) => a - b)
    .map((ms) => new Date(ms));
}

/**
 * One `gex_strike_0dte` row as the Neon driver hands it back: NUMERIC
 * columns arrive as strings.
 */
export interface SpotStrikeRow extends UwStrikeRow {
  strike: string | number | null;
}

/** Per-slice accounting, surfaced in the per-day log line and totals. */
export interface MapSliceStats {
  /** Rows in the tick (`rows.length`, always). */
  rows: number;
  /** Rows whose `strike` could not be parsed as a finite number. */
  malformed: number;
  /** (panel, strike) pairs dropped because `netValue` returned null. */
  nullSkipped: number;
  /** Values saturated by `clampSnapshotValue`. */
  clamped: number;
}

/** Flat, `unnest`-ready column arrays plus the accounting. */
export interface MappedSlice {
  panels: PanelName[];
  strikes: number[];
  values: number[];
  stats: MapSliceStats;
}

/**
 * `periscope_snapshots.strike` is INT while `gex_strike_0dte.strike` is
 * DECIMAL(10,2) arriving as a string. Round; drop anything unparseable
 * rather than writing a NaN strike. Byte-for-byte the cron's rule.
 */
function parseStrike(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function isRecord(value: unknown): value is SpotStrikeRow {
  return typeof value === 'object' && value !== null;
}

/**
 * Map one tick's strike rows into flat (panel, strike, value) arrays
 * ready for the `unnest` insert.
 *
 * This mirrors the panel loop in `api/cron/populate-periscope-from-uw.ts`
 * exactly, because seeded rows and live rows land in the same series and
 * any divergence would show up as a discontinuity at the seam:
 *
 * - `PANELS` order (gamma, charm, vanna), panel outer / strike inner.
 * - Unparseable strike → the whole row is skipped.
 * - `netValue` null (a half-sided or non-numeric leg) → that ONE panel
 *   is skipped for that strike; the strike's other panels still emit.
 * - `clampSnapshotValue` on the net.
 *
 * DELIBERATE ASYMMETRY vs. the EOD backfill's `mapDayRows`: there is NO
 * all-zero-strike skip here. `mapDayRows` drops strikes whose gamma,
 * charm and vanna are all exactly 0 because roughly half of what UW's
 * EOD endpoint returns is contract-free deep-wing padding. The forward
 * cron keeps those rows, and the seed's job is to be indistinguishable
 * from the cron — a seeded series that silently omits flat strikes the
 * cron writes would change which strikes exist per slice, and with them
 * every per-slice PERCENTILE_CONT / PERCENT_RANK the lottery finder
 * computes over the slice's own population. Fidelity to the cron beats
 * table size here; do not "optimise" this by adding the skip.
 *
 * A second deliberate non-feature: no repeat-strike merging. That rule
 * exists in `mapDayRows` for the SPX+SPXW pair the EOD endpoint returns
 * as two rows; `gex_strike_0dte` is UNIQUE (date, timestamp, strike)
 * (migration #47) so a tick cannot contain a repeat, and the cron does
 * not merge either.
 */
export function mapSliceRows(rows: readonly unknown[]): MappedSlice {
  const panels: PanelName[] = [];
  const strikes: number[] = [];
  const values: number[] = [];
  const stats: MapSliceStats = {
    rows: rows.length,
    malformed: 0,
    nullSkipped: 0,
    clamped: 0,
  };

  // Parse strikes once up front rather than re-parsing per panel, so a
  // malformed row counts once instead of three times. Output is
  // identical to the cron's inline parse either way.
  const parsed: { strike: number; row: SpotStrikeRow }[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) {
      stats.malformed += 1;
      continue;
    }
    const strike = parseStrike(raw['strike']);
    if (strike == null) {
      stats.malformed += 1;
      continue;
    }
    parsed.push({ strike, row: raw });
  }

  for (const panel of PANELS) {
    for (const { strike, row } of parsed) {
      const net = netValue(row, panel, SOURCE_UW_SPOT);
      if (net == null) {
        stats.nullSkipped += 1;
        continue;
      }
      const value = clampSnapshotValue(net);
      if (value !== net) stats.clamped += 1;
      panels.push(panel);
      strikes.push(strike);
      values.push(value);
    }
  }

  return { panels, strikes, values, stats };
}
