/**
 * PeriscopePanel unit tests — pragmatic smoke + state-routing coverage.
 * The trade-plan computation is exercised via a populated-view smoke
 * test; the heavier `computeTradePlan` math has dedicated unit coverage
 * in `periscope-trade-plan.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PeriscopeView } from '../hooks/usePeriscopeExposure';
import type {
  PlaybookPanelPayload,
  PlaybookRow,
  UsePeriscopePlaybookReturn,
} from '../hooks/usePeriscopePlaybook';
import { PeriscopePanel } from '../components/Periscope/PeriscopePanel';

// ── Fixture factory ───────────────────────────────────────────────────

function makeView(overrides: Partial<PeriscopeView> = {}): PeriscopeView {
  return {
    capturedAt: '2026-05-08T13:30:00Z',
    priorCapturedAt: '2026-05-08T13:20:00Z',
    expiry: '2026-05-08',
    spot: 5800.25,
    gamma: {
      ceiling: { strike: 5825, value: 5_000_000, ptsFromSpot: 25 },
      floor: { strike: 5775, value: 4_000_000, ptsFromSpot: -25 },
      accelTop: [
        { strike: 5750, value: -3_000_000, ptsFromSpot: -50 },
        { strike: 5740, value: -2_500_000, ptsFromSpot: -60 },
      ],
      topByAbsNear: [],
    },
    charm: {
      tallyNear50: 1_500_000,
      tallyWide100: 2_500_000,
      topByAbs: [{ strike: 5800, value: 800_000 }],
      charmZeroStrike: 5810,
    },
    vanna: {
      topByAbs: [{ strike: 5800, value: 600_000 }],
    },
    signFlips: [{ strike: 5790, from: -1_000_000, to: 500_000 }],
    cone: {
      coneUpper: 5850,
      coneLower: 5750,
      coneWidth: 100,
      asymmetryPts: 5,
      spotAtCalc: 5800,
    },
    breaches: [],
    ...overrides,
  };
}

const baseProps = {
  view: null as PeriscopeView | null,
  emptyReason: null as 'no_spot' | 'no_slot' | null,
  asOf: null as string | null,
  loading: false,
  error: null as string | null,
  onRefresh: vi.fn(),
  availableSlots: [] as string[],
  selectedSlot: null as { date: string; time: string } | null,
  onSelectSlot: vi.fn(),
};

// ============================================================
// SMOKE
// ============================================================

describe('PeriscopePanel: smoke', () => {
  it('renders the section heading', () => {
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByRole('heading', { name: /periscope mm exposure/i }),
    ).toBeInTheDocument();
  });

  it('renders the MM Exposure Map with the level ladder + setups + spot when given a populated view', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    // New layout — one map box replaces the old per-Greek sections.
    expect(screen.getByText(/MM Exposure Map/i)).toBeInTheDocument();
    // Level ladder rows
    expect(screen.getByText(/CEILING/)).toBeInTheDocument();
    expect(screen.getByText(/SPOT/)).toBeInTheDocument();
    expect(screen.getByText(/FLOOR/)).toBeInTheDocument();
    // LONG / SHORT / WAIT setup rows
    expect(screen.getByText(/^LONG$/)).toBeInTheDocument();
    expect(screen.getByText(/^SHORT$/)).toBeInTheDocument();
    // Header spot value
    expect(screen.getByText(/spot 5800\.25/)).toBeInTheDocument();
  });

  it('renders the regime tag on the map header', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    // Regime tag is one of the enum values; baseView produces drift-and-cap.
    const regimeText = screen.queryByText(
      /pin|drift-and-cap|chop|cone-breach-(up|down)|no-data/,
    );
    expect(regimeText).not.toBeNull();
  });
});

// ============================================================
// STATE ROUTING — error / empty / loading
// ============================================================

describe('PeriscopePanel: states', () => {
  it('renders the error string when error is set', () => {
    render(<PeriscopePanel {...baseProps} error="HTTP 500" />);
    expect(screen.getByText('HTTP 500')).toBeInTheDocument();
  });

  it('renders the no_slot empty-state copy', () => {
    render(<PeriscopePanel {...baseProps} emptyReason="no_slot" />);
    expect(
      screen.getByText(/No GEXBot capture for today yet/i),
    ).toBeInTheDocument();
  });

  it('renders the no_spot empty-state copy (distinct from no_slot)', () => {
    render(<PeriscopePanel {...baseProps} emptyReason="no_spot" />);
    expect(
      screen.getByText(/Waiting for SPX spot from index_candles_1m/i),
    ).toBeInTheDocument();
  });

  it('falls back to no_slot copy when emptyReason is null and view is null', () => {
    // Default null/null state still produces a sensible message rather
    // than a blank panel.
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByText(/No GEXBot capture for today yet/i),
    ).toBeInTheDocument();
  });
});

// ============================================================
// HEADER — refresh button + asOf timestamp
// ============================================================

describe('PeriscopePanel: header controls', () => {
  it('renders the asOf timestamp in CT when provided', () => {
    render(<PeriscopePanel {...baseProps} asOf="2026-05-08T19:30:00Z" />);
    // Just assert the CT suffix is present (locale-safe — content is
    // formatted by Intl.DateTimeFormat which varies test-runner timezone).
    expect(screen.getByText(/CT$/)).toBeInTheDocument();
  });

  it('disables refresh button while loading and shows ellipsis', () => {
    const onRefresh = vi.fn();
    render(
      <PeriscopePanel {...baseProps} loading={true} onRefresh={onRefresh} />,
    );
    const btn = screen.getByRole('button', { name: '…' });
    expect(btn).toBeDisabled();
  });

  it('invokes onRefresh when the refresh button is clicked', () => {
    const onRefresh = vi.fn();
    render(<PeriscopePanel {...baseProps} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// TIME-TRAVEL NAVIGATION
// ============================================================

describe('PeriscopePanel: time-travel nav', () => {
  it('renders the date picker and prev/next/live controls', () => {
    render(<PeriscopePanel {...baseProps} />);
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /return to live/i }),
    ).toBeInTheDocument();
    // The "live" button is highlighted (filled dot) when selectedSlot is null.
    expect(
      screen.getByRole('button', { name: /return to live/i }),
    ).toBeDisabled();
  });

  it('disables prev/next at the ends of availableSlots', () => {
    const view = makeView({
      capturedAt: '2026-05-08T14:00:00Z',
    });
    const slots = [
      '2026-05-08T13:50:00Z',
      '2026-05-08T14:00:00Z',
      '2026-05-08T14:10:00Z',
    ];
    render(
      <PeriscopePanel {...baseProps} view={view} availableSlots={slots} />,
    );
    // Middle slot — both buttons enabled.
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).not.toBeDisabled();
  });

  it('disables prev when on the first slot', () => {
    const view = makeView({ capturedAt: '2026-05-08T13:50:00Z' });
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={['2026-05-08T13:50:00Z', '2026-05-08T14:00:00Z']}
      />,
    );
    expect(
      screen.getByRole('button', { name: /previous slot/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /next slot/i }),
    ).not.toBeDisabled();
  });

  it('calls onSelectSlot with the prior slot on prev click', () => {
    const onSelectSlot = vi.fn();
    const view = makeView({ capturedAt: '2026-05-08T14:00:00Z' });
    render(
      <PeriscopePanel
        {...baseProps}
        view={view}
        availableSlots={['2026-05-08T13:50:00Z', '2026-05-08T14:00:00Z']}
        onSelectSlot={onSelectSlot}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /previous slot/i }));
    expect(onSelectSlot).toHaveBeenCalledTimes(1);
    const arg = onSelectSlot.mock.calls[0]?.[0] as {
      date: string;
      time: string;
    };
    expect(arg.date).toBe('2026-05-08');
    // Time is CT — depends on DST. 13:50Z in CDT (UTC-5) is 08:50.
    // Just assert it parses as HH:MM.
    expect(arg.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('calls onSelectSlot(null) when Live is clicked while on a historical slot', () => {
    const onSelectSlot = vi.fn();
    render(
      <PeriscopePanel
        {...baseProps}
        selectedSlot={{ date: '2026-05-07', time: '13:30' }}
        onSelectSlot={onSelectSlot}
      />,
    );
    const liveBtn = screen.getByRole('button', { name: /return to live/i });
    expect(liveBtn).not.toBeDisabled();
    fireEvent.click(liveBtn);
    expect(onSelectSlot).toHaveBeenCalledWith(null);
  });

  it('jumps to end-of-day when the date picker is changed', () => {
    const onSelectSlot = vi.fn();
    render(<PeriscopePanel {...baseProps} onSelectSlot={onSelectSlot} />);
    const dateInput = screen.getByLabelText(
      /periscope slot date/i,
    ) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: '2026-05-07' } });
    expect(onSelectSlot).toHaveBeenCalledWith({
      date: '2026-05-07',
      time: '23:59',
    });
  });
});

// ============================================================
// SPOT HEADER
// ============================================================
//
// The Claude auto-playbook (which used to override the header spot
// with the DB-resolved SPX cash close at read_time) has been retired
// 2026-05-26. The panel header now always shows the snapshot's
// recorded UW spot.

describe('PeriscopePanel: spot header', () => {
  it('header shows the snapshot spot', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    // Default view spot is 5800.25.
    expect(screen.getByText(/spot 5800\.25/)).toBeInTheDocument();
  });
});

// ============================================================
// CLAUDE PLAYBOOK (revived 2026-08-21)
// ============================================================

function makePanelPayload(
  overrides: Partial<PlaybookPanelPayload> = {},
): PlaybookPanelPayload {
  return {
    spot: 5800,
    cone: { lower: 5780, upper: 5820 },
    longTrigger: 5810,
    shortTrigger: 5790,
    regime: 'drift-and-cap',
    bias: 'two-sided',
    recommended: ['debit_call_spread'],
    avoid: ['iron_condor'],
    futuresPlan: 'LONG: SAFE above 5810',
    gammaFloor: 5780,
    gammaCeiling: 5820,
    magnet: 5800,
    charmZero: 5805,
    expectedDealerBehavior: 'sell rallies into 5820',
    confidence: 'medium',
    confidenceBasis: 'clean +gamma shelf',
    narrative: 'two-sided regime',
    source: 'uw_spot',
    ...overrides,
  };
}

function makePlaybookRow(
  payload: PlaybookPanelPayload | null,
  overrides: Partial<PlaybookRow> = {},
): PlaybookRow {
  return {
    id: 1,
    mode: 'intraday',
    status: 'complete',
    // Same instant as the fixture view's capturedAt so the staleness
    // chip is deterministic relative to the rendered slot.
    slotCapturedAt: '2026-05-08T13:30:00Z',
    readTime: '2026-05-08T13:30:00Z',
    spot: 5800,
    panelPayload: payload,
    parentId: null,
    model: 'claude-opus-5',
    failureReason: null,
    durationMs: 1234,
    createdAt: '2026-05-08T13:30:30Z',
    ...overrides,
  };
}

function makePlaybook(
  overrides: Partial<UsePeriscopePlaybookReturn> = {},
): UsePeriscopePlaybookReturn {
  return {
    data: makePlaybookRow(makePanelPayload()),
    latestInProgress: false,
    asOf: '2026-05-08T13:31:00Z',
    emptyReason: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    ...overrides,
  };
}

describe('PeriscopePanel: Claude playbook section', () => {
  it('omits the playbook entirely when no playbook prop is passed', () => {
    render(<PeriscopePanel {...baseProps} view={makeView()} />);
    expect(screen.queryByTestId('playbook-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-empty')).not.toBeInTheDocument();
  });

  it('renders the playbook body above the deterministic map', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook()}
      />,
    );
    expect(screen.getByTestId('playbook-section')).toBeInTheDocument();
    expect(screen.getByText(/Claude Playbook/i)).toBeInTheDocument();
    expect(screen.getByText('INTRADAY')).toBeInTheDocument();
    expect(screen.getByText('LONG TRIGGER')).toBeInTheDocument();
    // Deterministic map is NOT hidden by the playbook — it is the
    // comparison surface.
    expect(screen.getByText(/MM Exposure Map/i)).toBeInTheDocument();
  });

  it('renders the in-progress hint when a newer slot is mid-flight', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ latestInProgress: true })}
      />,
    );
    expect(
      screen.getByLabelText(/newer slot claude is reading/i),
    ).toBeInTheDocument();
  });

  it('renders a staleness chip for the slot age', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook()}
      />,
    );
    // Fixture slot is well in the past relative to any real run clock,
    // so the chip degrades to the prior-session badge.
    expect(screen.getByLabelText(/prior trading session/i)).toBeInTheDocument();
  });

  it('renders the empty state when no completed row exists yet', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: null, emptyReason: 'no_playbook' })}
      />,
    );
    expect(screen.getByTestId('playbook-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('playbook-section')).not.toBeInTheDocument();
  });

  it('renders the empty state when the row exists but panelPayload failed validation', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: makePlaybookRow(null) })}
      />,
    );
    expect(screen.getByTestId('playbook-empty')).toBeInTheDocument();
  });

  it('hides the playbook entirely on hook error, leaving the deterministic map', () => {
    render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ error: 'HTTP 503' })}
      />,
    );
    expect(screen.queryByTestId('playbook-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-empty')).not.toBeInTheDocument();
    expect(screen.getByText(/MM Exposure Map/i)).toBeInTheDocument();
  });
});

// ============================================================
// DATA-SOURCE WARNING
// ============================================================
//
// `panel_payload.source` records which periscope_snapshots series the
// read was built from. Only `uw_spot` is the live raw-dollar intraday
// series; `uw_eod` is a once-daily 15:00-CT normalized slice ~1000x
// smaller in magnitude. A well-formed read on the wrong scale is
// indistinguishable from a good one at a glance, so anything that is
// not provably `uw_spot` must shout.

describe('PeriscopePanel: playbook data-source warning', () => {
  function renderWithSource(source: string | undefined) {
    const payload = makePanelPayload();
    if (source === undefined) delete payload.source;
    else payload.source = source;
    return render(
      <PeriscopePanel
        {...baseProps}
        view={makeView()}
        playbook={makePlaybook({ data: makePlaybookRow(payload) })}
      />,
    );
  }

  it('renders NO warning on a live uw_spot read, and confirms it with a live chip', () => {
    renderWithSource('uw_spot');
    expect(
      screen.queryByTestId('playbook-source-warning'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('playbook-source-live')).toBeInTheDocument();
  });

  it('renders a visible alert on a uw_eod read explaining the scale mismatch', () => {
    renderWithSource('uw_eod');
    const warning = screen.getByTestId('playbook-source-warning');
    expect(warning).toBeInTheDocument();
    // role=alert so screen readers announce it rather than the trader
    // having to hunt for a tooltip.
    expect(warning).toHaveAttribute('role', 'alert');
    expect(warning).toHaveTextContent(/not a live read/i);
    expect(warning).toHaveTextContent(/end-of-day/i);
    expect(warning).toHaveTextContent(/1000x smaller/i);
    expect(screen.getByTestId('playbook-source-stamp')).toHaveTextContent(
      /uw_eod/,
    );
    // The live-confirmation chip must be gone.
    expect(
      screen.queryByTestId('playbook-source-live'),
    ).not.toBeInTheDocument();
  });

  it('renders a visible alert on a retired gexbot read', () => {
    renderWithSource('gexbot');
    const warning = screen.getByTestId('playbook-source-warning');
    expect(warning).toHaveTextContent(/not a live read/i);
    expect(warning).toHaveTextContent(/gexbot/i);
  });

  it('warns as NOT VERIFIED (not "live") when source is absent on an older row', () => {
    renderWithSource(undefined);
    const warning = screen.getByTestId('playbook-source-warning');
    expect(warning).toHaveTextContent(/data source not verified/i);
    expect(screen.getByTestId('playbook-source-stamp')).toHaveTextContent(
      /missing/i,
    );
    expect(
      screen.queryByTestId('playbook-source-live'),
    ).not.toBeInTheDocument();
  });

  it('still renders the rest of the playbook body alongside the warning', () => {
    renderWithSource('uw_eod');
    // Degrade loudly, not silently — the numbers stay visible so the
    // user can compare them against the deterministic map, but they
    // are unmistakably flagged.
    expect(screen.getByTestId('playbook-section')).toBeInTheDocument();
    expect(screen.getByText('LONG TRIGGER')).toBeInTheDocument();
  });

  it('warns on an unrecognized source vocabulary rather than assuming it is live', () => {
    renderWithSource('some_future_feed');
    const warning = screen.getByTestId('playbook-source-warning');
    expect(warning).toHaveTextContent(/data source not verified/i);
    expect(screen.getByTestId('playbook-source-stamp')).toHaveTextContent(
      /some_future_feed/,
    );
  });
});
