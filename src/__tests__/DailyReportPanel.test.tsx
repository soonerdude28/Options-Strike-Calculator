/**
 * DailyReportPanel smoke tests — mocks useDailyReport (the
 * PeriscopeLotteryPanel convention) and asserts the three contract
 * states: a full report renders every block, an all-sections-null
 * report degrades to quiet placeholders, and the lottery partial flag
 * surfaces the "partial until ~6pm CT" badge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type {
  DailyReport,
  UseDailyReportReturn,
} from '../hooks/useDailyReport';
import { DailyReportPanel } from '../components/DailyReport/DailyReportPanel';

const mockHook = vi.fn<() => UseDailyReportReturn>();
vi.mock('../hooks/useDailyReport', () => ({
  useDailyReport: () => mockHook(),
}));

beforeEach(() => {
  mockHook.mockReset();
});

// ── Fixtures ────────────────────────────────────────────────────────

function makeReport(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    date: '2026-08-27',
    generatedAt: '2026-08-27T22:10:05Z',
    headline:
      'SPX 6467 · range 38pts (0.6%) · bias two-sided · net GEX -$1.2B · cone held · 3919 fires',
    session: {
      open: 6450.12,
      high: 6480.5,
      low: 6442.25,
      close: 6467.0,
      rangePts: 38.25,
      rangePct: 0.59,
      candleCount: 390,
      cone: { lower: 6440, upper: 6490, closedInside: true },
      coneBreaches: [],
    },
    playbook: {
      mode: 'debrief',
      slotCapturedAt: '2026-08-27T20:00:00Z',
      bias: 'two-sided',
      regime: 'drift-and-cap',
      confidence: 'medium',
      gammaFloor: 6440,
      gammaCeiling: 6490,
      magnet: 6465,
      charmZero: 6470,
      recommended: ['debit_call_spread'],
      avoid: ['iron_condor'],
      narrative: 'Two-sided regime pinned between the walls.',
      slotsComplete: 6,
      slotsFailed: 1,
    },
    positioning: {
      netGammaMM: -1200,
      netCharmMM: 350,
      netVannaMM: -80,
      spotAtLast: 6467,
      zeroGamma: { level: 6470, spot: 6467, ts: '2026-08-27T19:59:00Z' },
      topStrikes: [
        { strike: 6470, netGammaMM: 820 },
        { strike: 6450, netGammaMM: -640 },
      ],
    },
    flow: {
      marketTide: { ncp: 1_200_000_000, npp: -800_000_000 },
      netFlowClose: { spx: 250_000_000, spy: -120_000_000, qqq: null },
      etfTideDelta: { spy: 90_000_000, qqq: -45_000_000 },
      zeroDteNet: 60_000_000,
      tape: {
        whaleCount: 42,
        whalePremium: 61_000_000,
        sweepCount: 913,
        topPrints: [
          {
            ticker: 'TSLA',
            optionType: 'C',
            strike: 250,
            expiry: '2026-09-18',
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
        wins: 88,
        losses: 3801,
        partial: false,
      },
      periscopeLottery: { fires: 12, locked: 12, wins: 5 },
      gammaSetups: { fires: 7, resolved: 7, wins: 4 },
      silentBoom: { alerts: 120, enriched: 120, wins: 9 },
    },
    dataQuality: {
      spxCandles: 390,
      gexTicks: 78,
      flowRows: 412,
      wsTrades: 25_000,
      playbookSlots: { complete: 6, failed: 1 },
      notes: ['tape: relation missing'],
    },
    ...overrides,
  };
}

function makeHookReturn(
  overrides: Partial<UseDailyReportReturn> = {},
): UseDailyReportReturn {
  const report =
    overrides.report !== undefined ? overrides.report : makeReport();
  return {
    report,
    reportDate: report?.date ?? null,
    createdAt: '2026-08-27T22:10:06Z',
    loading: false,
    error: null,
    notFound: false,
    selectedDate: null,
    setSelectedDate: vi.fn(),
    ...overrides,
  };
}

// ── Smoke ───────────────────────────────────────────────────────────

describe('DailyReportPanel: full report', () => {
  it('renders the heading, headline banner, and every section block', () => {
    mockHook.mockReturnValue(makeHookReturn());
    render(<DailyReportPanel />);

    expect(
      screen.getByRole('heading', { name: /daily report/i }),
    ).toBeInTheDocument();
    // Headline banner
    expect(screen.getByText(/SPX 6467 · range 38pts/)).toBeInTheDocument();
    // Session stats + cone verdict
    expect(screen.getByText('6450.12')).toBeInTheDocument();
    expect(screen.getByText('held')).toBeInTheDocument();
    // Playbook chips + levels + lists + narrative
    expect(screen.getByText('bias two-sided')).toBeInTheDocument();
    expect(screen.getByText('drift-and-cap')).toBeInTheDocument();
    expect(screen.getByText('6440 / 6490')).toBeInTheDocument();
    expect(screen.getByText('debit_call_spread')).toBeInTheDocument();
    expect(screen.getByText('iron_condor')).toBeInTheDocument();
    expect(
      screen.getByText(/Two-sided regime pinned between the walls/),
    ).toBeInTheDocument();
    // Positioning greeks ($M input → compact dollars) + top strikes
    expect(screen.getByText('-$1.2B')).toBeInTheDocument();
    expect(screen.getByText(/6470 vs spot 6467/)).toBeInTheDocument();
    expect(screen.getByText('$820.0M')).toBeInTheDocument();
    // Flow closes + tape
    expect(screen.getByText(/\$1\.2B · -\$800\.0M/)).toBeInTheDocument();
    expect(screen.getByText(/42 \(\$61\.0M\)/)).toBeInTheDocument();
    expect(screen.getByText(/TSLA C 250 2026-09-18/)).toBeInTheDocument();
    // Signals scoreboards
    expect(screen.getByText(/3919 fires · 88W \/ 3801L/)).toBeInTheDocument();
    expect(screen.getByText(/12 fires · 5W of 12 locked/)).toBeInTheDocument();
    // Data-quality footer counts + note
    expect(screen.getByText(/candles 390 · gex ticks 78/)).toBeInTheDocument();
    expect(screen.getByText(/tape: relation missing/)).toBeInTheDocument();
    // No partial badge when enrichment is complete
    expect(screen.queryByText(/partial until/i)).not.toBeInTheDocument();
    // Date input present in the header
    expect(
      screen.getByLabelText(/pick a date to view a past daily report/i),
    ).toBeInTheDocument();
  });
});

describe('DailyReportPanel: nullable sections', () => {
  it('renders a quiet placeholder per section when all sections are null', () => {
    mockHook.mockReturnValue(
      makeHookReturn({
        report: makeReport({
          session: null,
          playbook: null,
          positioning: null,
          flow: null,
          signals: null,
        }),
      }),
    );
    render(<DailyReportPanel />);

    // Headline still renders; each of the 5 blocks degrades quietly.
    expect(screen.getByText(/SPX 6467 · range 38pts/)).toBeInTheDocument();
    expect(screen.getAllByText('no data')).toHaveLength(5);
    // Footer still renders from the always-present dataQuality section.
    expect(screen.getByText(/candles 390/)).toBeInTheDocument();
  });

  it('renders the notFound empty state instead of crashing on 404', () => {
    mockHook.mockReturnValue(
      makeHookReturn({ report: null, reportDate: null, notFound: true }),
    );
    render(<DailyReportPanel />);
    expect(screen.getByText(/No daily report yet/i)).toBeInTheDocument();
  });
});

describe('DailyReportPanel: partial enrichment badge', () => {
  it('shows the "partial until ~6pm CT" badge when lottery.partial is true', () => {
    const report = makeReport();
    report.signals!.lottery.partial = true;
    report.signals!.lottery.enriched = 2100;
    mockHook.mockReturnValue(makeHookReturn({ report }));
    render(<DailyReportPanel />);
    expect(screen.getByText('partial until ~6pm CT')).toBeInTheDocument();
  });
});
