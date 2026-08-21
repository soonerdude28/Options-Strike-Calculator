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

/** Per-day accounting, surfaced in the per-day log line and the totals. */
export interface MapDayStats {
  /** Strikes UW returned for the day. */
  fetched: number;
  /** Strikes that produced at least one written row. */
  kept: number;
  /** Strikes where gamma, charm AND vanna were all exactly 0. */
  zeroSkipped: number;
  /** Strikes where every panel's `netValue` was null. */
  nullSkipped: number;
  /** Rows whose `strike` could not be parsed as a finite number. */
  malformed: number;
  /** Repeat strikes within one day's payload. */
  duplicates: number;
  /** Individual values saturated by `clampSnapshotValue`. */
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
 * Skips, in order:
 *  - unparseable strikes (malformed payload row)
 *  - strikes where every panel's `netValue` is null (no usable side)
 *  - ALL-ZERO strikes: gamma, charm AND vanna exactly 0. Roughly half
 *    of what UW returns is the deep-wing tail where no contracts exist;
 *    those rows carry no information and only bloat the table.
 *  - duplicate strikes within the same payload (`ON CONFLICT DO NOTHING`
 *    would drop them silently, so they are counted instead)
 *  - individual panels whose `netValue` is null (one-sided / non-numeric)
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
    duplicates: 0,
    clamped: 0,
  };
  const seen = new Set<number>();

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
    // `periscope_snapshots.strike` is INT.
    const strike = Math.round(rawStrike);

    const nets = new Map<PanelName, number>();
    let anyUsable = false;
    let anyNonZero = false;

    for (const panel of EOD_PANELS) {
      const net = netValue(raw, panel, SOURCE_UW_EOD);
      if (net == null) continue;
      nets.set(panel, net);
      anyUsable = true;
      if (net !== 0) anyNonZero = true;
    }

    if (!anyUsable) {
      stats.nullSkipped += 1;
      continue;
    }
    if (!anyNonZero) {
      stats.zeroSkipped += 1;
      continue;
    }
    if (seen.has(strike)) {
      // ON CONFLICT DO NOTHING would silently drop the second copy;
      // count it so a duplicate-emitting payload is visible.
      stats.duplicates += 1;
      continue;
    }
    seen.add(strike);
    stats.kept += 1;

    for (const [panel, net] of nets) {
      const clamped = clampSnapshotValue(net);
      if (clamped !== net) stats.clamped += 1;
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
