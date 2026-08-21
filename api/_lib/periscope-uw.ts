/**
 * Shared Unusual Whales → `periscope_snapshots` mapper. The UW-sourced
 * sibling of `periscope-gexbot.ts`, used by the forward cron
 * (`populate-periscope-from-uw`), the map endpoint, and the EOD
 * backfill.
 *
 * Two UW per-strike sources feed the same table and they are NOT
 * interchangeable — different endpoints, different column names, and
 * (critically) different units. `spot-exposures/expiry-strike` returns
 * raw dollar exposure; `greek-exposure/strike-expiry` returns
 * normalized values ~1000x smaller for gamma. Rows are therefore tagged
 * with `source` and must never share a slice-over-slice delta series.
 * See docs/superpowers/specs/periscope-uw-repoint-2026-08-21.md.
 *
 * Lives in _lib so the cron, the endpoint and the backfill all read one
 * copy of the column map instead of three drifting ones.
 */

import type { PanelName } from './periscope-gexbot.js';

export type { PanelName };

/**
 * 1-min intraday rows from `gex_strike_0dte`
 * (UW `/stock/SPX/spot-exposures/expiry-strike`). Raw dollar exposure.
 */
export const SOURCE_UW_SPOT = 'uw_spot';

/**
 * Daily EOD rows from UW `/stock/SPX/greek-exposure/strike-expiry` —
 * the only source with multi-year history, used by the backfill.
 * Normalized units; never mixed with `uw_spot` in a delta.
 */
export const SOURCE_UW_EOD = 'uw_eod';

export type UwSource = typeof SOURCE_UW_SPOT | typeof SOURCE_UW_EOD;

/** A column pair whose sum is the panel's net dealer-attributed value. */
export interface PanelColumns {
  call: string;
  put: string;
}

/**
 * panel → (call column, put column), per source.
 *
 * `uw_spot` names are the `gex_strike_0dte` table columns (migration
 * #47); `uw_eod` names are the fields UW returns on
 * `/greek-exposure/strike-expiry` (same spelling as the
 * `greek_exposure_strike` raw columns from migration #53).
 */
export const PANEL_SOURCE_COLUMNS: Record<
  UwSource,
  Record<PanelName, PanelColumns>
> = {
  [SOURCE_UW_SPOT]: {
    gamma: { call: 'call_gamma_oi', put: 'put_gamma_oi' },
    charm: { call: 'call_charm_oi', put: 'put_charm_oi' },
    vanna: { call: 'call_vanna_oi', put: 'put_vanna_oi' },
  },
  [SOURCE_UW_EOD]: {
    gamma: { call: 'call_gex', put: 'put_gex' },
    charm: { call: 'call_charm', put: 'put_charm' },
    vanna: { call: 'call_vanna', put: 'put_vanna' },
  },
};

/**
 * Either a Postgres row (`@neondatabase/serverless` hands NUMERIC back
 * as a string) or a UW JSON row (every greek is a decimal string).
 * Values are `unknown` because both shapes are untrusted at this
 * boundary.
 */
export type UwStrikeRow = Record<string, unknown>;

/**
 * Hard ceiling for `periscope_snapshots.value`, past which an INSERT
 * throws `numeric field overflow`.
 *
 * Migration #192 widened the column from `NUMERIC(14,2)` to
 * `NUMERIC(20,4)` so it matches `gex_strike_0dte`'s `DECIMAL(20,4)`
 * source columns exactly. Under the old 12-integer-digit ceiling a
 * legitimately large UW value saturated to 999999999999.99 and then
 * ranked as the single largest wall on the board — a fabricated extreme
 * is worse than either the real number or no row at all.
 *
 * `NUMERIC(20,4)` = 20 total digits with 4 after the point → 16 integer
 * digits, i.e. a true ceiling of 9999999999999999.9999. That value is
 * NOT representable as an IEEE-754 double: it rounds UP to 1e16, which
 * has 17 integer digits and would overflow the very column it is meant
 * to fit. So the constant is the largest double strictly below the
 * column ceiling (doubles step by 2 in this range, so it lands on
 * 1e16 - 2). SPX charm peaks around ~1e10, six orders of magnitude
 * below, so clamping is now effectively unreachable in production.
 */
export const SNAPSHOT_VALUE_MAX = 9999999999999998;

/**
 * Coerce one raw cell to a finite number. Accepts the string form both
 * sources actually emit and the number form a already-parsed row might
 * carry. Anything null / blank / non-numeric / non-finite → `null`.
 *
 * `Number.parseFloat` (not the global) per the SonarJS rule.
 */
function toFinite(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Net (call + put) value for one panel of one strike row.
 *
 * Returns `null` when either side is missing or non-numeric — the
 * caller skips that strike rather than writing a half-sided value that
 * would look like a real dealer position.
 */
export function netValue(
  row: UwStrikeRow,
  panel: PanelName,
  source: UwSource,
): number | null {
  const cols = PANEL_SOURCE_COLUMNS[source][panel];
  const call = toFinite(row[cols.call]);
  const put = toFinite(row[cols.put]);
  if (call == null || put == null) return null;
  return call + put;
}

/**
 * Build the "HH:MM - HH:MM" CT timeframe label matching the scraper's
 * convention. Floors `capturedAt` to the prior 10-min CT slot, so
 * 09:55 CT → "09:50 - 10:00" and 23:57 CT → "23:50 - 00:00".
 *
 * Moved here from `populate-periscope-from-gexbot.ts` so the gexbot
 * adapter, the UW adapter and the backfill all emit the identical
 * label — the panel groups rows by it.
 */
export function formatTimeframe(capturedAt: Date): string {
  const ctOpts = { timeZone: 'America/Chicago', hour12: false } as const;
  const parts = new Intl.DateTimeFormat('en-US', {
    ...ctOpts,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(capturedAt);
  const hr = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const min = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const slotStart = min - (min % 10);
  const slotEnd = (slotStart + 10) % 60;
  const slotEndHr = slotStart + 10 >= 60 ? (hr + 1) % 24 : hr;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(hr)}:${pad(slotStart)} - ${pad(slotEndHr)}:${pad(slotEnd)}`;
}

/**
 * Clamp a net value into the `NUMERIC(20,4)` range so an out-of-range
 * INSERT can never throw. After migration #192 this is a defensive
 * backstop, not a working part of the pipeline: the target column now
 * matches the source column's precision, so a real UW value cannot
 * exceed it. In-range values (including SPX's ~1e10 charm) pass through
 * bit-identical; ±Infinity saturate at the bounds.
 *
 * The `NaN → 0` branch is deliberately retained even though `netValue`
 * — the only production caller's producer — rejects non-finite legs, so
 * `call + put` is always finite and this branch is unreachable from
 * that path. It stays because `clampSnapshotValue` is an exported
 * general-purpose guard, and because Postgres `NUMERIC` *accepts* the
 * literal `NaN`: an unguarded NaN would not throw, it would silently
 * land in `periscope_snapshots.value` and poison every downstream
 * PERCENTILE_CONT / MAX / delta that touches it. Failing closed at 0 is
 * the cheaper wrong answer.
 *
 * Callers that want to alert on truncation can compare the result to
 * the input — a clamp is always visible as `out !== in`.
 */
export function clampSnapshotValue(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value > SNAPSHOT_VALUE_MAX) return SNAPSHOT_VALUE_MAX;
  if (value < -SNAPSHOT_VALUE_MAX) return -SNAPSHOT_VALUE_MAX;
  return value;
}
