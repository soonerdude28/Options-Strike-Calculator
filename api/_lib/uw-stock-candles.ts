/**
 * Thin UW client + session-range computation for stock 1-min OHLC.
 *
 * Used by `detect-lottery-fires` and `scripts/backfill-range-pos.mjs`
 * to compute each lottery fire's position within its underlying's
 * session range at trigger time — the "Range Kill" signal from the
 * 2026-05-15 cross-section EDA.
 *
 * UW endpoint: GET /stock/{ticker}/ohlc/1m?date=YYYY-MM-DD
 */

import { uwFetch } from './api-helpers.js';
import logger from './logger.js';

export interface UWStockCandle {
  /** ISO timestamp at the start of the 1-min bucket. */
  start_time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: number;
}

/**
 * Fetch 1-min OHLC for one stock × date.
 *
 * Fails OPEN — returns [] so a UW outage can never break fire detection, and
 * callers treat empty as "no data; leave range_pos NULL on the row". But it
 * fails LOUDLY: the previous `catch { return [] }` swallowed everything, and
 * uwFetch only logs/metrics 429s — a 401 is thrown, not logged. That combination
 * hid a total outage: detect-lottery-fires passed ctx.apiKey, which is hardcoded
 * `''` under `requireApiKey: false` (cron-helpers.ts:221), so every call 401'd
 * and range_pos_at_trigger was NULL on 20,698 of 20,698 fires with no log, no
 * Sentry event and no failing cron.
 *
 * The empty-key check is not just defensive. uwFetch calls acquireUWSlot()
 * BEFORE issuing the request, so a request that can only 401 still consumes
 * shared UW rate-limit budget against the 115/min cap. Never spend a slot on a
 * call that cannot succeed.
 */
export async function fetchStockCandles1m(
  apiKey: string,
  ticker: string,
  date: string,
): Promise<UWStockCandle[]> {
  if (!apiKey) {
    logger.warn(
      { ticker, date },
      'fetchStockCandles1m: no UW API key — skipping request, range_pos stays null',
    );
    return [];
  }
  try {
    return await uwFetch<UWStockCandle>(
      apiKey,
      `/stock/${ticker}/ohlc/1m?date=${date}`,
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, ticker, date },
      'fetchStockCandles1m: UW fetch failed — range_pos stays null',
    );
    return [];
  }
}

/**
 * Compute (spot − low) / (high − low) over the prefix of candles
 * whose `start_time` is at or before `triggerTimeIso`. Returns null
 * when:
 *   - candles is empty
 *   - no candle's start_time is at or before the trigger time
 *   - session high ≤ session low (degenerate single-bar case)
 *
 * Clamped to [0, 1] — a spike print can briefly punch outside the
 * bar range, in which case range_pos saturates at 0 or 1 rather
 * than going negative or >1.
 */
export function computeRangePos(
  candles: UWStockCandle[],
  triggerTimeIso: string | Date,
  spotAtFirst: number,
): number | null {
  const triggerMs =
    triggerTimeIso instanceof Date
      ? triggerTimeIso.getTime()
      : new Date(triggerTimeIso).getTime();
  if (!Number.isFinite(triggerMs)) return null;

  let high = -Infinity;
  let low = Infinity;
  let sawCandle = false;
  for (const c of candles) {
    const ms = new Date(c.start_time).getTime();
    if (!Number.isFinite(ms) || ms > triggerMs) continue;
    sawCandle = true;
    const h = Number.parseFloat(c.high);
    const l = Number.parseFloat(c.low);
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
  }
  if (!sawCandle) return null;
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) {
    return null;
  }
  const pos = (spotAtFirst - low) / (high - low);
  if (!Number.isFinite(pos)) return null;
  return Math.max(0, Math.min(1, pos));
}
