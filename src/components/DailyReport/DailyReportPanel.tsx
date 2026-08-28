/**
 * DailyReportPanel — end-of-day Periscope Daily Report card.
 *
 * Renders the report the 22:10 UTC cron assembled into `daily_reports`:
 * headline, session OHLC + cone verdict, the post-close playbook read,
 * dealer positioning, flow closes + tape, the signal scoreboards, and a
 * muted data-quality footer. Every section is nullable server-side (a
 * broken table nulls just that section), so each block degrades to a
 * quiet "no data" placeholder — never a crash, never a blank panel.
 *
 * A native date input in the header re-reads past reports; clearing it
 * returns to the latest. Data comes from `useDailyReport` (owner or
 * guest; the App-level GatedSection hides the panel from public
 * visitors entirely).
 *
 * Spec: docs/superpowers/specs/periscope-daily-report-2026-08-27.md
 */

import { useMemo } from 'react';
import { SectionBox } from '../ui';
import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import { getETToday } from '../../utils/timezone';
import { colorForValue } from '../../utils/periscope-formatting';
import {
  useDailyReport,
  type DailyReport,
  type DailyReportSession,
} from '../../hooks/useDailyReport';

// ── Formatting ──────────────────────────────────────────────────────

/** Raw dollars → compact signed string, e.g. -1.23e9 → "-$1.2B". */
function fmtDollars(raw: number): string {
  const sign = raw < 0 ? '-' : '';
  const abs = Math.abs(raw);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** Dollars given in $M (the positioning-greek unit) → compact string. */
function fmtMM(mm: number): string {
  return fmtDollars(mm * 1e6);
}

/** Nullable dollar value (raw dollars). */
function fmtMaybeDollars(v: number | null): string {
  return v == null ? '—' : fmtDollars(v);
}

/** Nullable price level → whole-point string. */
function fmtLevel(v: number | null): string {
  return v == null ? '—' : v.toFixed(0);
}

// ── Layout primitives (mirror Periscope/shared.tsx styling) ─────────

function BlockHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
      style={{ color: theme.textTertiary }}
    >
      {children}
    </h3>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span
        className="font-mono text-[11px]"
        style={{ color: theme.textSecondary }}
      >
        {label}
      </span>
      <span className="text-right font-mono text-[12px]">{value}</span>
    </div>
  );
}

/** Titled block; renders the quiet placeholder when `empty`. */
function Block({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <BlockHeader>{title}</BlockHeader>
      {empty ? (
        <p className="font-mono text-[11px]" style={{ color: theme.textMuted }}>
          no data
        </p>
      ) : (
        children
      )}
    </div>
  );
}

/** Small colored chip, matching the SectionBox badgeColor treatment. */
function Chip({ text, color }: { text: string; color: string }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      {text}
    </span>
  );
}

// ── Section bodies ──────────────────────────────────────────────────

function ConeVerdict({ session }: { session: DailyReportSession }) {
  const cone = session.cone;
  if (cone == null) {
    return <span style={{ color: theme.textMuted }}>no cone</span>;
  }
  if (session.coneBreaches.length === 0) {
    return <span style={{ color: theme.green }}>held</span>;
  }
  const breaches = session.coneBreaches
    .map((b) => {
      const arrow = b.direction === 'upper' ? '↑' : '↓';
      const at = formatTimeCT(b.breachTime, { fallback: b.breachTime });
      return `${arrow} ${at} CT (+${b.ptsPastBound.toFixed(1)}pts)`;
    })
    .join(', ');
  return <span style={{ color: theme.red }}>breached {breaches}</span>;
}

function SessionBlock({ session }: { session: DailyReportSession }) {
  const stats: [string, string][] = [
    ['O', session.open.toFixed(2)],
    ['H', session.high.toFixed(2)],
    ['L', session.low.toFixed(2)],
    ['C', session.close.toFixed(2)],
    [
      'Range',
      `${session.rangePts.toFixed(1)}pts (${session.rangePct.toFixed(2)}%)`,
    ],
  ];
  return (
    <>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        {stats.map(([label, value]) => (
          <span key={label}>
            <span style={{ color: theme.textMuted }}>{label} </span>
            <span style={{ color: theme.text }}>{value}</span>
          </span>
        ))}
      </div>
      <Row
        label={
          session.cone != null
            ? `Cone ${session.cone.lower.toFixed(0)}–${session.cone.upper.toFixed(0)}`
            : 'Cone'
        }
        value={<ConeVerdict session={session} />}
      />
    </>
  );
}

function PlaybookBlock({
  playbook,
}: {
  playbook: NonNullable<DailyReport['playbook']>;
}) {
  const chips: [string, string][] = [];
  if (playbook.bias != null)
    chips.push([`bias ${playbook.bias}`, theme.accent]);
  if (playbook.regime != null) chips.push([playbook.regime, theme.text]);
  if (playbook.confidence != null) {
    chips.push([`conf ${playbook.confidence}`, theme.textSecondary]);
  }
  return (
    <>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map(([text, color]) => (
            <Chip key={text} text={text} color={color} />
          ))}
        </div>
      )}
      <Row
        label="Gamma floor / ceiling"
        value={`${fmtLevel(playbook.gammaFloor)} / ${fmtLevel(playbook.gammaCeiling)}`}
      />
      <Row
        label="Magnet · charm zero"
        value={`${fmtLevel(playbook.magnet)} · ${fmtLevel(playbook.charmZero)}`}
      />
      {playbook.recommended.length > 0 && (
        <Row
          label="Take"
          value={
            <span style={{ color: theme.green }}>
              {playbook.recommended.join(', ')}
            </span>
          }
        />
      )}
      {playbook.avoid.length > 0 && (
        <Row
          label="Avoid"
          value={
            <span style={{ color: theme.red }}>
              {playbook.avoid.join(', ')}
            </span>
          }
        />
      )}
      {playbook.narrative != null && (
        <p
          className="font-mono text-[11px] leading-relaxed"
          style={{ color: theme.textSecondary }}
        >
          {playbook.narrative}
        </p>
      )}
    </>
  );
}

function PositioningBlock({
  positioning,
}: {
  positioning: NonNullable<DailyReport['positioning']>;
}) {
  const greek = (label: string, mm: number | null) => (
    <Row
      label={label}
      value={
        mm == null ? (
          '—'
        ) : (
          <span style={{ color: colorForValue(mm) }}>{fmtMM(mm)}</span>
        )
      }
    />
  );
  const zg = positioning.zeroGamma;
  return (
    <>
      {greek('Net gamma', positioning.netGammaMM)}
      {greek('Net charm', positioning.netCharmMM)}
      {greek('Net vanna', positioning.netVannaMM)}
      <Row
        label="Zero gamma"
        value={
          zg == null
            ? '—'
            : `${fmtLevel(zg.level)} vs spot ${zg.spot.toFixed(0)}`
        }
      />
      {positioning.topStrikes.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-0.5">
          <span
            className="font-mono text-[10px]"
            style={{ color: theme.textMuted }}
          >
            Top strikes by |net γ|
          </span>
          {positioning.topStrikes.map((s) => (
            <Row
              key={s.strike}
              label={s.strike.toFixed(0)}
              value={
                <span style={{ color: colorForValue(s.netGammaMM) }}>
                  {fmtMM(s.netGammaMM)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

function FlowBlock({ flow }: { flow: NonNullable<DailyReport['flow']> }) {
  const signedDollars = (v: number | null) =>
    v == null ? (
      '—'
    ) : (
      <span style={{ color: colorForValue(v) }}>{fmtDollars(v)}</span>
    );
  const tape = flow.tape;
  return (
    <>
      <Row
        label="Market tide close (calls · puts)"
        value={
          flow.marketTide == null
            ? '—'
            : `${fmtDollars(flow.marketTide.ncp)} · ${fmtDollars(flow.marketTide.npp)}`
        }
      />
      <Row label="SPX net flow" value={signedDollars(flow.netFlowClose.spx)} />
      <Row label="SPY net flow" value={signedDollars(flow.netFlowClose.spy)} />
      <Row label="QQQ net flow" value={signedDollars(flow.netFlowClose.qqq)} />
      <Row
        label="ETF tide Δ (SPY · QQQ)"
        value={`${fmtMaybeDollars(flow.etfTideDelta.spy)} · ${fmtMaybeDollars(flow.etfTideDelta.qqq)}`}
      />
      <Row label="0DTE index net" value={signedDollars(flow.zeroDteNet)} />
      {tape != null && (
        <>
          <Row
            label="Whales ≥$500K"
            value={`${tape.whaleCount} (${fmtDollars(tape.whalePremium)})`}
          />
          <Row label="Sweeps" value={String(tape.sweepCount)} />
          {tape.topPrints.length > 0 && (
            <div className="mt-0.5 flex flex-col gap-0.5">
              <span
                className="font-mono text-[10px]"
                style={{ color: theme.textMuted }}
              >
                Top prints
              </span>
              {tape.topPrints.map((p, i) => {
                const side = p.side ? ` · ${p.side}` : '';
                return (
                  <Row
                    key={`${p.ticker}-${p.strike}-${i}`}
                    label={`${p.ticker} ${p.optionType} ${p.strike.toFixed(0)} ${p.expiry}`}
                    value={`${fmtDollars(p.premium)}${side}`}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </>
  );
}

function SignalsBlock({
  signals,
}: {
  signals: NonNullable<DailyReport['signals']>;
}) {
  const { lottery, periscopeLottery, gammaSetups, silentBoom } = signals;
  return (
    <>
      <Row
        label="Lottery Finder"
        value={
          <span className="inline-flex items-center gap-1.5">
            {`${lottery.fires} fires · ${lottery.wins}W / ${lottery.losses}L`}
            {lottery.partial && (
              <Chip text="partial until ~6pm CT" color={theme.caution} />
            )}
          </span>
        }
      />
      <Row
        label="Periscope lottery"
        value={`${periscopeLottery.fires} fires · ${periscopeLottery.wins}W of ${periscopeLottery.locked} locked`}
      />
      <Row
        label="Gamma setups"
        value={`${gammaSetups.fires} fires · ${gammaSetups.wins}W of ${gammaSetups.resolved} resolved`}
      />
      <Row
        label="Silent boom"
        value={`${silentBoom.alerts} alerts · ${silentBoom.wins}W of ${silentBoom.enriched} enriched`}
      />
    </>
  );
}

function DataQualityFooter({
  report,
  createdAt,
}: {
  report: DailyReport;
  createdAt: string | null;
}) {
  const dq = report.dataQuality;
  const counts = [
    `candles ${dq.spxCandles}`,
    `gex ticks ${dq.gexTicks}`,
    `flow rows ${dq.flowRows}`,
    `prints ${dq.wsTrades}`,
    `playbook ${dq.playbookSlots.complete} ok / ${dq.playbookSlots.failed} failed`,
  ].join(' · ');
  const generatedAt = formatTimeCT(createdAt ?? report.generatedAt);
  return (
    <div
      className="border-edge flex flex-col gap-0.5 border-t pt-2 font-mono text-[10px]"
      style={{ color: theme.textMuted }}
    >
      <span>
        {counts}
        {generatedAt !== '' && ` · generated ${generatedAt} CT`}
      </span>
      {dq.notes.map((note) => (
        <span key={note}>⚠ {note}</span>
      ))}
    </div>
  );
}

function ReportBody({
  report,
  createdAt,
}: {
  report: DailyReport;
  createdAt: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div
        className="bg-accent-bg border-accent rounded-md border-l-2 px-3 py-2 font-mono text-[12px]"
        style={{ color: theme.text }}
      >
        {report.headline}
      </div>
      <Block title="Session" empty={report.session == null}>
        {report.session != null && <SessionBlock session={report.session} />}
      </Block>
      <Block title="Playbook" empty={report.playbook == null}>
        {report.playbook != null && (
          <PlaybookBlock playbook={report.playbook} />
        )}
      </Block>
      <Block title="Positioning" empty={report.positioning == null}>
        {report.positioning != null && (
          <PositioningBlock positioning={report.positioning} />
        )}
      </Block>
      <Block title="Flow" empty={report.flow == null}>
        {report.flow != null && <FlowBlock flow={report.flow} />}
      </Block>
      <Block title="Signals" empty={report.signals == null}>
        {report.signals != null && <SignalsBlock signals={report.signals} />}
      </Block>
      <DataQualityFooter report={report} createdAt={createdAt} />
    </div>
  );
}

// ── Panel ───────────────────────────────────────────────────────────

export function DailyReportPanel(): React.ReactElement {
  const {
    report,
    reportDate,
    createdAt,
    loading,
    error,
    notFound,
    selectedDate,
    setSelectedDate,
  } = useDailyReport();
  const today = useMemo(() => getETToday(), []);

  const headerRight = (
    <div className="flex items-center gap-2">
      <label
        className="text-muted font-sans text-[10px]"
        htmlFor="daily-report-date"
      >
        Date
      </label>
      <input
        id="daily-report-date"
        type="date"
        value={selectedDate ?? reportDate ?? ''}
        max={today}
        onChange={(e) => setSelectedDate(e.target.value || null)}
        className="border-edge bg-input text-primary rounded-md border px-2 py-0.5 font-mono text-[11px]"
        aria-label="Pick a date to view a past daily report"
      />
    </div>
  );

  let body: React.ReactNode;
  if (error) {
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.red }}>
        {error}
      </p>
    );
  } else if (notFound) {
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.textMuted }}>
        {selectedDate != null
          ? `No report for ${selectedDate}.`
          : 'No daily report yet — the first one lands shortly after the close (~17:10 ET).'}
      </p>
    );
  } else if (report == null) {
    body = (
      <p className="font-mono text-[12px]" style={{ color: theme.textMuted }}>
        {loading ? 'Loading…' : 'No report loaded.'}
      </p>
    );
  } else {
    body = <ReportBody report={report} createdAt={createdAt} />;
  }

  return (
    <SectionBox
      label="Daily Report"
      badge={reportDate}
      headerRight={headerRight}
      collapsible
    >
      {body}
    </SectionBox>
  );
}
