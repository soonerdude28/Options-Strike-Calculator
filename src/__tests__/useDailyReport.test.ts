/**
 * useDailyReport unit tests — fetch-on-mount, date-change refetch, the
 * 404 empty state, error paths, and the degrade-vs-reject validation
 * policy documented in the hook.
 *
 * The panel test mocks this hook wholesale, so the defensive parsing is
 * only exercised here. That parsing exists because a shapeless body used
 * to be an App-blanking crash class in this repo — these cases pin the
 * boundary: envelope/report identity fields REJECT the payload, every
 * section DEGRADES to null with the report intact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { AccessMode } from '../utils/auth';
import type { DailyReport } from '../hooks/useDailyReport';

vi.mock('../utils/auth', () => ({
  getAccessMode: vi.fn(() => 'owner' as AccessMode),
}));

import { useDailyReport } from '../hooks/useDailyReport';
import { getAccessMode } from '../utils/auth';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A complete, valid report — the shape api/_lib/daily-report.ts emits. */
function makeReport(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    date: '2026-08-27',
    generatedAt: '2026-08-27T22:10:04Z',
    headline: 'SPX 6466 · range 38pts (0.6%) · bias two-sided',
    session: {
      open: 6440.5,
      high: 6470.25,
      low: 6432.5,
      close: 6466.5,
      rangePts: 37.75,
      rangePct: 0.58,
      candleCount: 390,
      cone: { lower: 6420, upper: 6500, closedInside: true },
      coneBreaches: [],
    },
    playbook: {
      mode: 'debrief',
      slotCapturedAt: '2026-08-27T20:50:00Z',
      bias: 'two-sided',
      regime: 'positive gamma',
      confidence: 'medium',
      gammaFloor: 6450,
      gammaCeiling: 6500,
      magnet: 6475,
      charmZero: 6460,
      recommended: ['iron condor'],
      avoid: ['naked long premium'],
      narrative: 'Dealers long gamma into the close; range held.',
      slotsComplete: 40,
      slotsFailed: 0,
    },
    positioning: {
      netGammaMM: -1234.5,
      netCharmMM: 88.25,
      netVannaMM: -12.5,
      spotAtLast: 6466.5,
      zeroGamma: { level: 6455.25, spot: 6466.5, ts: '2026-08-27T19:59:00Z' },
      topStrikes: [{ strike: 6500, netGammaMM: 812.5 }],
    },
    flow: {
      marketTide: { ncp: 1_250_000, npp: 980_000 },
      netFlowClose: { spx: 270_000, spy: -45_000, qqq: 12_500 },
      etfTideDelta: { spy: 51_000_000, qqq: -8_000_000 },
      zeroDteNet: 42_000,
      tape: {
        whaleCount: 12,
        whalePremium: 18_400_000,
        sweepCount: 240,
        topPrints: [
          {
            ticker: 'SPXW',
            optionType: 'C',
            strike: 6500,
            expiry: '2026-08-27',
            premium: 2_400_000,
            side: 'ask',
          },
        ],
      },
    },
    signals: {
      lottery: {
        fires: 3919,
        enriched: 3919,
        wins: 412,
        losses: 3100,
        partial: false,
      },
      periscopeLottery: { fires: 8, locked: 8, wins: 3 },
      gammaSetups: { fires: 5, resolved: 5, wins: 2 },
      silentBoom: { alerts: 120, enriched: 120, wins: 18 },
    },
    dataQuality: {
      spxCandles: 390,
      gexTicks: 385,
      flowRows: 96,
      wsTrades: 1_204_000,
      playbookSlots: { complete: 40, failed: 0 },
      notes: [],
    },
    ...overrides,
  };
}

function envelope(report: DailyReport = makeReport()) {
  return {
    date: report.date,
    report,
    createdAt: '2026-08-27T22:10:05Z',
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  vi.mocked(getAccessMode).mockReturnValue('owner');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useDailyReport', () => {
  it('fetches the latest report on mount and exposes the envelope', async () => {
    mockFetch.mockResolvedValue(jsonResponse(envelope()));

    const { result } = renderHook(() => useDailyReport());

    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(mockFetch).toHaveBeenCalledWith('/api/daily-report', {
      method: 'GET',
    });
    expect(result.current.reportDate).toBe('2026-08-27');
    expect(result.current.createdAt).toBe('2026-08-27T22:10:05Z');
    expect(result.current.report?.headline).toContain('SPX 6466');
    // Sections survive the parse intact — the panel maps over these.
    expect(result.current.report?.session?.close).toBe(6466.5);
    expect(result.current.report?.signals?.lottery.fires).toBe(3919);
    expect(result.current.report?.flow?.tape?.topPrints).toHaveLength(1);
    expect(result.current.notFound).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('treats 404 as an empty state and clears any stale report', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(envelope()));
    const { result } = renderHook(() => useDailyReport());
    await waitFor(() => expect(result.current.report).not.toBeNull());

    // Now ask for a day with no report — day A's numbers must not linger
    // under day B's date.
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'No report available' }, 404),
    );
    act(() => result.current.setSelectedDate('2026-08-26'));

    await waitFor(() => expect(result.current.notFound).toBe(true));
    expect(result.current.report).toBeNull();
    expect(result.current.reportDate).toBeNull();
    expect(result.current.createdAt).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('surfaces a non-OK response as an error', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Internal' }, 500));

    const { result } = renderHook(() => useDailyReport());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain('500');
    expect(result.current.report).toBeNull();
    expect(result.current.notFound).toBe(false);
  });

  it('rejects a payload missing a required identity field', async () => {
    // headline is REQUIRED — without it the panel's banner has nothing
    // to render, so the whole payload is refused rather than degraded.
    const report = makeReport();
    const broken = { ...report } as Record<string, unknown>;
    delete broken.headline;
    mockFetch.mockResolvedValue(
      jsonResponse({ date: '2026-08-27', report: broken, createdAt: 'x' }),
    );

    const { result } = renderHook(() => useDailyReport());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toContain('Unexpected response shape');
    expect(result.current.report).toBeNull();
  });

  it('degrades a malformed section to null and keeps the report', async () => {
    // A NUMERIC that arrived as a string is the repo's classic driver
    // bug — the section drops out, the rest of the report still renders.
    const report = makeReport();
    const withBadSession = {
      ...report,
      session: { ...report.session, open: '6440.5' },
    };
    mockFetch.mockResolvedValue(
      jsonResponse({
        date: '2026-08-27',
        report: withBadSession,
        createdAt: '2026-08-27T22:10:05Z',
      }),
    );

    const { result } = renderHook(() => useDailyReport());

    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report?.session).toBeNull();
    expect(result.current.report?.headline).toContain('SPX 6466');
    expect(result.current.report?.playbook?.bias).toBe('two-sided');
    expect(result.current.error).toBeNull();
  });

  it('refetches with ?date= when the selected date changes', async () => {
    mockFetch.mockResolvedValue(jsonResponse(envelope()));
    const { result } = renderHook(() => useDailyReport());
    await waitFor(() => expect(result.current.report).not.toBeNull());

    act(() => result.current.setSelectedDate('2026-08-26'));

    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/daily-report?date=2026-08-26',
        {
          method: 'GET',
        },
      ),
    );
    expect(result.current.selectedDate).toBe('2026-08-26');
  });

  it('does not fetch for a public visitor', async () => {
    vi.mocked(getAccessMode).mockReturnValue('public');

    const { result } = renderHook(() => useDailyReport());

    await Promise.resolve();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.report).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
