/**
 * Pure logic for the `periscope_snapshots` EOD backfill
 * (`scripts/backfill-periscope-from-uw.mjs`).
 *
 * Same split as `takeit-backfill-mapper.ts` / `backfill-takeit-scores.mjs`:
 * everything decidable from a payload alone lives here so it can be unit
 * tested, while the network, retry, sleep and DB machinery stays in the
 * script. There is exactly ONE copy of each rule — the script imports
 * from this module rather than re-implementing it.
 *
 * NOTE ON IMPORT EXTENSIONS: the relative imports below use `.ts`, not
 * `.js`. That is deliberate and load-bearing — the `.mjs` backfill runs
 * on Node 24 type-stripping, whose ESM resolver does NOT map a `.js`
 * specifier onto a `.ts` file (verified: `ERR_MODULE_NOT_FOUND`). The
 * script itself imports `../api/_lib/*.ts` for the same reason. tsc
 * accepts it via `allowImportingTsExtensions`, and this module is
 * backfill-only — no Vercel Function imports it.
 */

import { ctWallClockToUtcIso } from '../../src/utils/timezone.ts';
import {
  PANEL_SOURCE_COLUMNS,
  SOURCE_UW_EOD,
  clampSnapshotValue,
  netValue,
  type PanelName,
  type UwStrikeRow,
} from './periscope-uw.ts';

/**
 * Panels the EOD endpoint can fill — derived from the shared column map
 * so a new panel appears here automatically instead of being re-listed.
 */
export const EOD_PANELS = Object.keys(
  PANEL_SOURCE_COLUMNS[SOURCE_UW_EOD],
) as PanelName[];

/** 15:00 CT = SPX regular-session close, as minutes past CT midnight. */
export const EOD_CT_MINUTES = 15 * 60;

/**
 * UW's machine-readable "you are past your history window" code. The
 * ONLY 403 body that means end-of-history.
 */
export const HISTORY_FLOOR_CODE = 'historic_data_access_missing';

/** First YYYY-MM-DD found in the 403 message ("The earliest date ..."). */
const DATE_IN_TEXT_RE = /\d{4}-\d{2}-\d{2}/;

/**
 * Per-day accounting, surfaced in the per-day log line and the totals.
 *
 * Invariant, useful as a sanity check on any payload:
 * `fetched === malformed + merged + kept + zeroSkipped + nullSkipped`.
 * Every row is either malformed, the first appearance of a strike (and
 * that strike ends up in exactly one of kept / zeroSkipped /
 * nullSkipped), or a repeat folded into an earlier strike.
 */
export interface MapDayStats {
  /** Rows UW returned for the day (`rows.length`, always). */
  fetched: number;
  /** DISTINCT strikes that produced at least one written row. */
  kept: number;
  /** Distinct strikes whose AGGREGATED gamma, charm and vanna are all 0. */
  zeroSkipped: number;
  /** Distinct strikes where no contributing row yielded any usable panel. */
  nullSkipped: number;
  /** Rows whose `strike` could not be parsed as a finite number. */
  malformed: number;
  /** Repeat rows folded (summed) into a strike already seen this payload. */
  merged: number;
  /** Aggregated values saturated by `clampSnapshotValue`. */
  clamped: number;
}

/** Flat, `unnest`-ready column arrays plus the accounting. */
export interface MappedDay {
  panels: PanelName[];
  strikes: number[];
  values: number[];
  stats: MapDayStats;
}

function isRecord(value: unknown): value is UwStrikeRow {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse a raw `strike` cell. UW serializes every numeric as a string,
 * but a pre-parsed row may carry a number. Anything non-finite → null.
 */
function parseStrike(raw: unknown): number | null {
  if (raw == null) return null;
  const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Map one day's UW rows into flat (panel, strike, value) arrays ready
 * for the `unnest` insert.
 *
 * # Repeat strikes are SUMMED, not discarded
 *
 * On a monthly OPEX Friday (the third Friday) SPX has BOTH the
 * AM-settled monthly (SPX) and the PM-settled weekly (SPXW) expiring on
 * the same date, and `/greek-exposure/strike-expiry` returns each series
 * as its OWN row for the same strike. Nothing in the payload
 * distinguishes them — the response keys are exactly date, expiry,
 * strike, call_gex, put_gex, call_delta, put_delta, call_charm,
 * put_charm, call_vanna, put_vanna, dte.
 *
 * Verified live on 2026-07-17, strike 7005: two rows, both substantial
 * and materially different (put_charm 337,722.98 vs 4,125,389.12). The
 * previous keep-first-seen behaviour silently dropped roughly half the
 * dealer exposure at every such strike, across 35 of 760 backfilled days.
 *
 * Summing is the economically correct merge: the panel value is already
 * a net (call + put), exposures are additive, and dealers hedge their
 * TOTAL exposure at a strike regardless of which expiring series it came
 * from.
 *
 * # Order of operations
 *
 * 1. Rows are accumulated into `strike → panel → running total`, in
 *    first-appearance order for strikes.
 * 2. A panel whose `netValue` is null (one-sided / non-numeric leg)
 *    contributes NOTHING — it neither zeroes nor creates the
 *    accumulator, so a panel present in row A and null in row B still
 *    emits row A's contribution.
 * 3. Each strike is then judged on its AGGREGATE:
 *    - no panel accumulated anything → `nullSkipped` (no usable side in
 *      any contributing row).
 *    - every accumulated panel totals exactly 0 → `zeroSkipped`. Roughly
 *      half of what UW returns is the deep-wing tail where no contracts
 *      exist; those rows carry no information and only bloat the table.
 *      Two rows that individually carry value but cancel to exactly zero
 *      are genuinely flat and get skipped too.
 *    - otherwise emitted, panels in `EOD_PANELS` order.
 * 4. `clampSnapshotValue` is applied to the FINAL SUM, never to an
 *    addend — clamping the parts and then adding them could exceed the
 *    column bound the clamp exists to enforce.
 *
 * Output ordering is fully deterministic (strike first-appearance ×
 * `EOD_PANELS`), so the emitted arrays are stable across runs.
 */
export function mapDayRows(rows: readonly unknown[]): MappedDay {
  const panels: PanelName[] = [];
  const strikes: number[] = [];
  const values: number[] = [];
  const stats: MapDayStats = {
    fetched: rows.length,
    kept: 0,
    zeroSkipped: 0,
    nullSkipped: 0,
    malformed: 0,
    merged: 0,
    clamped: 0,
  };

  // Insertion-ordered: strike → panel → running (unclamped) total.
  // A Map preserves first-appearance order, which is the emit order.
  const totals = new Map<number, Map<PanelName, number>>();

  for (const raw of rows) {
    if (!isRecord(raw)) {
      stats.malformed += 1;
      continue;
    }
    const rawStrike = parseStrike(raw['strike']);
    if (rawStrike == null) {
      stats.malformed += 1;
      continue;
    }
    // `periscope_snapshots.strike` is INT. Two source strikes that
    // collide only after rounding are the same wall and merge too.
    const strike = Math.round(rawStrike);

    let byPanel = totals.get(strike);
    if (byPanel == null) {
      byPanel = new Map<PanelName, number>();
      totals.set(strike, byPanel);
    } else {
      stats.merged += 1;
    }

    for (const panel of EOD_PANELS) {
      const net = netValue(raw, panel, SOURCE_UW_EOD);
      // null = this row has no usable value for this panel. Skipping
      // (rather than adding 0) keeps another row's contribution intact.
      if (net == null) continue;
      // Seeding from 0 also normalises a lone -0 addend to +0.
      byPanel.set(panel, (byPanel.get(panel) ?? 0) + net);
    }
  }

  for (const [strike, byPanel] of totals) {
    if (byPanel.size === 0) {
      stats.nullSkipped += 1;
      continue;
    }
    let anyNonZero = false;
    for (const total of byPanel.values()) {
      if (total !== 0) {
        anyNonZero = true;
        break;
      }
    }
    if (!anyNonZero) {
      stats.zeroSkipped += 1;
      continue;
    }
    stats.kept += 1;

    // EOD_PANELS order, not accumulation order — deterministic output.
    for (const panel of EOD_PANELS) {
      const total = byPanel.get(panel);
      if (total == null) continue;
      const clamped = clampSnapshotValue(total);
      if (clamped !== total) stats.clamped += 1;
      panels.push(panel);
      strikes.push(strike);
      values.push(clamped);
    }
  }

  return { panels, strikes, values, stats };
}

/**
 * What a 403 from `/greek-exposure/strike-expiry` actually means.
 *
 * `end-of-history` is the authoritative "you have walked past your
 * subscription's rolling window" signal and terminates the walk
 * cleanly. `auth-failure` is everything else — a revoked key, a
 * downgraded plan, an IP block — and MUST abort the run non-zero.
 */
export type ForbiddenVerdict =
  | { kind: 'end-of-history'; earliest: string | null }
  | { kind: 'auth-failure' };

/**
 * Classify a 403 response body.
 *
 * SAFETY-CRITICAL: end-of-history is recognised ONLY by the exact
 * `historic_data_access_missing` code. Do NOT relax this to "any 403 is
 * the end" — that would make the backfill "succeed" while writing zero
 * days against a revoked key, and nothing would fail. `body` is
 * `unknown` because the response may not even be JSON.
 */
export function classifyForbidden(body: unknown): ForbiddenVerdict {
  if (!isRecord(body)) return { kind: 'auth-failure' };
  if (body['code'] !== HISTORY_FLOOR_CODE) return { kind: 'auth-failure' };
  const message = body['message'];
  const earliest =
    typeof message === 'string'
      ? (DATE_IN_TEXT_RE.exec(message)?.[0] ?? null)
      : null;
  return { kind: 'end-of-history', earliest };
}

/**
 * Synthesize `captured_at` for a trading day.
 *
 * The EOD endpoint has no `time` field, only `date`, so the timestamp is
 * that day's 15:00 CT regular-session close in UTC — DST-correct, so a
 * CST day lands at 21:00Z and a CDT day at 20:00Z. Getting this wrong
 * would mis-sort EOD rows against live intraday `uw_spot` rows.
 *
 * Returns `null` for a malformed or non-existent date.
 */
export function eodCapturedAtIso(dateStr: string): string | null {
  return ctWallClockToUtcIso(dateStr, EOD_CT_MINUTES);
}
