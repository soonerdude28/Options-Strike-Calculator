// @vitest-environment node

/**
 * fetchStockCandles1m's failure behaviour.
 *
 * range_pos_at_trigger was NULL on 20,698 of 20,698 lottery fires. The chain:
 *
 *   detect-lottery-fires.ts:1212  { requireApiKey: false }
 *   cron-helpers.ts:221           apiKey = requireApiKey ? (env ?? '') : ''
 *   detect-lottery-fires.ts:787   fetchStockCandles1m(ctx.apiKey, ...)   // ''
 *   uw-fetch.ts:219               throw new Error('UW API 401: ...')
 *   uw-stock-candles.ts:39        catch { return [] }                    // silent
 *
 * uwFetch only logs/metrics 429s; a 401 is thrown and was swallowed whole —
 * no log, no Sentry, no Vercel error. The column simply stayed null forever.
 *
 * Worse than the missing display badge: uwFetch calls acquireUWSlot() BEFORE
 * issuing the request, so every doomed 401 consumed shared UW rate-limit
 * budget against the 115/min cap (which Sentry shows being exceeded).
 * A call that cannot succeed must not spend a slot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUwFetch, mockWarn } = vi.hoisted(() => ({
  mockUwFetch: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../_lib/api-helpers.js', () => ({ uwFetch: mockUwFetch }));
vi.mock('../_lib/logger.js', () => ({
  default: { warn: mockWarn, info: vi.fn(), error: vi.fn() },
}));

import { fetchStockCandles1m } from '../_lib/uw-stock-candles.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchStockCandles1m', () => {
  it('does not spend a UW slot when the API key is empty', async () => {
    const out = await fetchStockCandles1m('', 'AAPL', '2026-08-24');

    expect(out).toEqual([]);
    // The whole point: a request that can only 401 must not be issued at all,
    // because uwFetch takes a rate-limit slot before it fires.
    expect(mockUwFetch).not.toHaveBeenCalled();
  });

  it('reports the empty-key case instead of failing silently', async () => {
    await fetchStockCandles1m('', 'AAPL', '2026-08-24');
    expect(mockWarn).toHaveBeenCalled();
  });

  it('reports a UW failure instead of failing silently', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('UW API 401: unauthorized'));

    const out = await fetchStockCandles1m('real-key', 'AAPL', '2026-08-24');

    expect(out).toEqual([]);
    expect(mockWarn).toHaveBeenCalled();
  });

  it('still fails open — a UW outage must not break fire detection', async () => {
    mockUwFetch.mockRejectedValueOnce(new Error('network'));
    await expect(
      fetchStockCandles1m('real-key', 'AAPL', '2026-08-24'),
    ).resolves.toEqual([]);
  });

  it('passes the key and path through on the happy path', async () => {
    mockUwFetch.mockResolvedValueOnce([{ start_time: 't' }]);

    const out = await fetchStockCandles1m('real-key', 'AAPL', '2026-08-24');

    expect(out).toEqual([{ start_time: 't' }]);
    expect(mockUwFetch).toHaveBeenCalledWith(
      'real-key',
      '/stock/AAPL/ohlc/1m?date=2026-08-24',
    );
  });
});
