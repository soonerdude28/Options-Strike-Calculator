/**
 * PlaybookSection — renders Claude's auto-playbook payload at the top
 * of the PeriscopePanel when the latest cron tick has produced a
 * complete `panel_payload` row.
 *
 * Originally Phase 4b of
 * docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md; revived
 * in Phase 5 of docs/superpowers/specs/periscope-playbook-revival-2026-08-21.md
 * on top of the Unusual Whales data layer.
 *
 * Layout: regime + bias chips on top-right, SPOT line, LONG/SHORT
 * TRIGGER rows, gamma floor/ceiling/magnet, futures plan body,
 * narrative footer.
 *
 * Distinct UX cues:
 *  - "CLAUDE" badge in the header so the user can tell at a glance
 *    whether they're looking at Claude's read or the deterministic
 *    client computation in `MMExposureMap`.
 *  - Staleness chip (green/yellow/red) based on minutes since the
 *    slot's `slotCapturedAt`. Surfaces the "no fresh tick" failure
 *    mode visually rather than letting the user act on stale data.
 *  - "Claude reading…" hint when `latestInProgress` is true — a newer
 *    slot is mid-flight and an updated payload will arrive within
 *    the 5–9 min Opus thinking budget.
 *  - SOURCE BANNER (2026-08-21). Each row records which
 *    `periscope_snapshots.source` series it was built from. Only
 *    `uw_spot` is the live raw-dollar intraday series; `uw_eod` is a
 *    once-daily 15:00-CT normalized slice ~1000x smaller in magnitude
 *    whose "prior slice" is yesterday. Anything that is not `uw_spot`
 *    — including a missing stamp on an older row — gets a loud,
 *    unmissable banner, because a well-formed read on the wrong scale
 *    is indistinguishable from a good one at a glance.
 */

import { theme } from '../../themes';
import { formatTimeCT } from '../../utils/component-formatters';
import {
  LIVE_PLAYBOOK_SOURCE,
  type PlaybookRow,
  type PlaybookPanelPayload,
  type UsePeriscopePlaybookReturn,
} from '../../hooks/usePeriscopePlaybook';

interface PlaybookSectionProps {
  playbook: UsePeriscopePlaybookReturn;
}

/** Compute minutes elapsed since `slotCapturedAt`. Bounded to [0, ∞). */
function minutesSinceSlot(slotCapturedAt: string): number {
  const slotMs = new Date(slotCapturedAt).getTime();
  if (!Number.isFinite(slotMs)) return Number.POSITIVE_INFINITY;
  const diffMin = (Date.now() - slotMs) / 60_000;
  return Math.max(diffMin, 0);
}

/** CT date (YYYY-MM-DD) of an ISO timestamp via Intl. */
function ctDateOf(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date(iso));
}

/** True when the slot's CT date is older than today's CT date. */
function isPriorSession(slotCapturedAt: string): boolean {
  const slotDate = ctDateOf(slotCapturedAt);
  const todayDate = ctDateOf(new Date().toISOString());
  return slotDate < todayDate;
}

/** Staleness threshold colors per spec — green <12 min, yellow 12-25, red >25. */
function stalenessColor(minutes: number): string {
  if (minutes < 12) return theme.green;
  if (minutes < 25) return theme.caution;
  return theme.red;
}

// ─────────────────────────────────────────────────────────────────────
// Data-source verification
// ─────────────────────────────────────────────────────────────────────

interface SourceVerdict {
  /** True only when the row is provably built on the live intraday series. */
  live: boolean;
  /** Short uppercase headline for the banner. */
  headline: string;
  /** Full explanation of what the trader is actually looking at. */
  detail: string;
  /** Raw stamp for display; null when the row predates source stamping. */
  raw: string | null;
}

/**
 * Classify a `panel_payload.source` stamp.
 *
 * Kept module-private (rather than exported for direct unit test) so
 * the file stays fast-refresh-clean — it is covered end-to-end through
 * the rendered banner in PeriscopePanel.test.tsx.
 *
 * Deliberately fails LOUD: anything that is not exactly `uw_spot` —
 * including `undefined`, `null`, an empty string, or a vocabulary the
 * frontend has never seen — is reported as not-live. Silently treating
 * an unknown stamp as live is the failure mode this whole banner
 * exists to prevent.
 */
function classifyPlaybookSource(
  source: string | null | undefined,
): SourceVerdict {
  if (source === LIVE_PLAYBOOK_SOURCE) {
    return {
      live: true,
      headline: 'Live intraday series',
      detail:
        'Built from the live raw-dollar intraday exposure series (uw_spot).',
      raw: LIVE_PLAYBOOK_SOURCE,
    };
  }
  if (source === 'uw_eod') {
    return {
      live: false,
      headline: 'Not a live read — end-of-day slice',
      detail:
        'This read was built from the once-daily 15:00 CT end-of-day ' +
        'exposure slice (uw_eod), NOT the live intraday series. Its ' +
        'magnitudes are on a normalized scale roughly 1000x smaller than ' +
        'the live raw-dollar feed, and the "prior slice" it compares ' +
        'against is yesterday — not ten minutes ago. Every level, ' +
        'trigger and momentum call below is therefore unreliable for ' +
        'intraday trading.',
      raw: 'uw_eod',
    };
  }
  if (source === 'gexbot') {
    return {
      live: false,
      headline: 'Not a live read — retired GEXBot capture',
      detail:
        'This read was built from the retired GEXBot capture (gexbot), ' +
        'NOT the live Unusual Whales intraday series. That feed is no ' +
        'longer updating and its magnitudes are on a different scale. ' +
        'Do not trade the levels below.',
      raw: 'gexbot',
    };
  }
  return {
    live: false,
    headline: 'Data source not verified',
    detail:
      'This row carries no recognized data-source stamp, so it CANNOT be ' +
      'confirmed to come from the live intraday series (uw_spot). It may ' +
      'predate source stamping or come from a feed on a different scale. ' +
      'Treat its magnitudes and its slice-over-slice momentum read as ' +
      'unverified.',
    raw:
      typeof source === 'string' && source.trim() !== '' ? source.trim() : null,
  };
}

/**
 * Loud banner rendered above the playbook body whenever the read is not
 * provably built on the live `uw_spot` series. Renders nothing on a
 * verified live read so the normal case stays visually quiet.
 */
function SourceWarningBanner({
  source,
}: {
  source: string | null | undefined;
}) {
  const verdict = classifyPlaybookSource(source);
  if (verdict.live) return null;

  const stampLabel = verdict.raw ?? 'missing';
  return (
    <div
      role="alert"
      data-testid="playbook-source-warning"
      className="flex flex-col gap-1 rounded-md border-2 p-2.5"
      style={{
        borderColor: theme.red,
        backgroundColor: `color-mix(in srgb, ${theme.red} 18%, transparent)`,
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="font-sans text-[11px] font-bold tracking-[0.12em] uppercase"
          style={{ color: theme.red }}
        >
          ⚠ {verdict.headline}
        </span>
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase"
          style={{ color: theme.text, backgroundColor: theme.chipBg }}
          data-testid="playbook-source-stamp"
        >
          source: {stampLabel}
        </span>
      </div>
      <p
        className="font-mono text-[11px] leading-relaxed"
        style={{ color: theme.text }}
      >
        {verdict.detail}
      </p>
    </div>
  );
}

/** Small confirmation chip shown in the header on a verified live read. */
function SourceChip({ source }: { source: string | null | undefined }) {
  const verdict = classifyPlaybookSource(source);
  if (!verdict.live) return null;
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase"
      style={{
        color: theme.green,
        backgroundColor: `color-mix(in srgb, ${theme.green} 15%, transparent)`,
      }}
      data-testid="playbook-source-live"
      aria-label="Built from the live intraday exposure series"
    >
      live uw_spot
    </span>
  );
}

function StalenessChip({ slotCapturedAt }: { slotCapturedAt: string }) {
  // Prior-session slots (e.g. yesterday's debrief showing Tuesday
  // morning) shouldn't render a ticking "23h ago" red chip — that
  // implies the writer has fallen behind when really the data is
  // intentionally yesterday's last read. Show a static muted "PRIOR
  // SESSION" badge so the user knows it's last session's data without
  // alarm bells.
  if (isPriorSession(slotCapturedAt)) {
    return (
      <span
        className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase"
        style={{
          color: theme.textMuted,
          backgroundColor: theme.chipBg,
        }}
        aria-label="Prior trading session"
      >
        prior session
      </span>
    );
  }

  const minutes = minutesSinceSlot(slotCapturedAt);
  const color = stalenessColor(minutes);
  const label =
    minutes < 1
      ? '< 1m'
      : minutes < 60
        ? `${Math.floor(minutes)}m ago`
        : `${(minutes / 60).toFixed(1)}h ago`;
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-[10px]"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
      aria-label={`Slot age ${label}`}
    >
      {label}
    </span>
  );
}

function fmtLevel(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(0);
}

function modeLabel(mode: PlaybookRow['mode']): string {
  if (mode === 'pre_trade') return 'PRE-TRADE';
  if (mode === 'debrief') return 'DEBRIEF';
  return 'INTRADAY';
}

/**
 * Header strip rendered above the playbook body. Carries the CLAUDE
 * badge, mode chip, staleness chip, source chip, and in-progress hint.
 */
function PlaybookHeader({
  row,
  latestInProgress,
}: {
  row: PlaybookRow;
  latestInProgress: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px]">
      <span
        className="rounded px-1.5 py-0.5 font-mono tracking-wider uppercase"
        style={{
          color: theme.accent,
          backgroundColor: theme.accentBg,
        }}
      >
        Claude
      </span>
      <span
        className="rounded px-1.5 py-0.5 font-mono tracking-wider uppercase"
        style={{
          color: theme.text,
          backgroundColor: theme.chipBg,
        }}
      >
        {modeLabel(row.mode)}
      </span>
      <StalenessChip slotCapturedAt={row.slotCapturedAt} />
      <SourceChip source={row.panelPayload?.source} />
      <span
        className="font-mono text-[10px]"
        style={{ color: theme.textMuted }}
      >
        slot {formatTimeCT(row.slotCapturedAt)} CT
      </span>
      {latestInProgress && (
        <span
          className="rounded px-1.5 py-0.5 font-mono tracking-wider uppercase"
          style={{
            color: theme.caution,
            backgroundColor: `color-mix(in srgb, ${theme.caution} 15%, transparent)`,
          }}
          aria-label="Newer slot Claude is reading"
        >
          ⚡ Claude reading newer slot…
        </span>
      )}
    </div>
  );
}

/**
 * Triggers + regime row. Mirrors the row shape from the deterministic
 * MM exposure map so the muscle memory transfers.
 */
function TriggersRow({ payload }: { payload: PlaybookPanelPayload }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="SPOT" value={fmtLevel(payload.spot)} />
      <Stat
        label="REGIME"
        value={payload.regime ?? '—'}
        valueColor={theme.text}
      />
      <Stat
        label="LONG TRIGGER"
        value={fmtLevel(payload.longTrigger)}
        valueColor={theme.green}
      />
      <Stat
        label="SHORT TRIGGER"
        value={fmtLevel(payload.shortTrigger)}
        valueColor={theme.red}
      />
    </div>
  );
}

function GammaRow({ payload }: { payload: PlaybookPanelPayload }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat
        label="Γ FLOOR"
        value={fmtLevel(payload.gammaFloor)}
        valueColor={theme.green}
      />
      <Stat
        label="Γ CEILING"
        value={fmtLevel(payload.gammaCeiling)}
        valueColor={theme.red}
      />
      <Stat label="MAGNET" value={fmtLevel(payload.magnet)} />
      <Stat label="CHARM ZERO" value={fmtLevel(payload.charmZero)} />
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        {label}
      </span>
      <span
        className="font-mono text-[14px]"
        style={{ color: valueColor ?? theme.text }}
      >
        {value}
      </span>
    </div>
  );
}

function StructuresRow({ payload }: { payload: PlaybookPanelPayload }) {
  if (payload.recommended.length === 0 && payload.avoid.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {payload.recommended.length > 0 && (
        <ChipList
          label="RECOMMENDED"
          items={payload.recommended}
          color={theme.green}
        />
      )}
      {payload.avoid.length > 0 && (
        <ChipList label="AVOID" items={payload.avoid} color={theme.red} />
      )}
    </div>
  );
}

function ChipList({
  label,
  items,
  color,
}: {
  label: string;
  items: string[];
  color: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className="rounded px-1.5 py-0.5 font-mono text-[11px]"
            style={{
              color,
              backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
            }}
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function FuturesPlanBlock({ plan }: { plan: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        Futures Plan
      </span>
      <pre
        className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        style={{ color: theme.textSecondary }}
      >
        {plan}
      </pre>
    </div>
  );
}

/**
 * Concise italic line. Reserved for SHORT summaries (≤ 200 chars).
 * Long structured prose uses `LabeledProseBlock` below — italics at
 * small font are unreadable beyond a couple sentences. The lessons
 * (2026-05-11) made `confidenceBasis` and `expectedDealerBehavior`
 * multi-sentence prose; gating on length keeps each rendering style
 * matched to its content.
 */
function ItalicSummaryLine({ text }: { text: string | null }) {
  if (!text || text.trim() === '') return null;
  return (
    <p
      className="font-mono text-[11px] leading-snug italic"
      style={{ color: theme.textSecondary }}
    >
      {text}
    </p>
  );
}

/**
 * Labeled, non-italic, paragraph-friendly prose block for the richer
 * fields that Claude now writes under the IF-THEN / disqualifier /
 * flow-structure-check lessons. Mirrors `FuturesPlanBlock` shape so
 * the visual rhythm stays consistent.
 */
function LabeledProseBlock({
  label,
  text,
}: {
  label: string;
  text: string | null;
}) {
  if (!text || text.trim() === '') return null;
  return (
    <div className="flex flex-col gap-1">
      <span
        className="font-sans text-[9px] font-bold tracking-[0.12em] uppercase"
        style={{ color: theme.textTertiary }}
      >
        {label}
      </span>
      <p
        className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        style={{ color: theme.textSecondary }}
      >
        {text}
      </p>
    </div>
  );
}

/**
 * Choose the right renderer based on text length. Short summary
 * fits in an italic 1-liner; multi-sentence prose gets a labeled
 * paragraph block.
 */
function ProseField({
  label,
  text,
  longThreshold = 200,
}: {
  label: string;
  text: string | null;
  longThreshold?: number;
}) {
  if (!text || text.trim() === '') return null;
  if (text.length <= longThreshold) return <ItalicSummaryLine text={text} />;
  return <LabeledProseBlock label={label} text={text} />;
}

/** Empty-state body when no playbook has been produced for the picked date. */
function PlaybookEmpty({ inProgress }: { inProgress: boolean }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
      data-testid="playbook-empty"
    >
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase"
          style={{
            color: theme.accent,
            backgroundColor: theme.accentBg,
          }}
        >
          Claude
        </span>
        <span
          className="font-mono text-[10px]"
          style={{ color: theme.textMuted }}
        >
          {inProgress
            ? 'reading the first slot of the day…'
            : 'waiting for the first playbook run of the day'}
        </span>
      </div>
    </div>
  );
}

export function PlaybookSection({ playbook }: PlaybookSectionProps) {
  // Hook produced an error — let the caller fall through to the
  // deterministic render. Don't show a broken playbook box.
  if (playbook.error != null) return null;

  const row = playbook.data;
  if (row == null || row.panelPayload == null) {
    // No completed row yet for this date. Show a small in-progress hint
    // when the cron has fired and Claude is reading; otherwise show a
    // "waiting for the first run" hint. Either way, return non-null so
    // the panel still surfaces Claude as a section, not just the
    // deterministic block.
    return <PlaybookEmpty inProgress={playbook.latestInProgress} />;
  }

  const payload = row.panelPayload;

  return (
    <div
      className="flex flex-col gap-3 rounded-md border p-3"
      style={{
        borderColor: theme.border,
        backgroundColor: theme.surfaceAlt,
      }}
      data-testid="playbook-section"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          className="font-sans text-[10px] font-bold tracking-[0.12em] uppercase"
          style={{ color: theme.textTertiary }}
        >
          Claude Playbook
        </h3>
        <PlaybookHeader
          row={row}
          latestInProgress={playbook.latestInProgress}
        />
      </div>

      {/* Scale/provenance guard — must sit ABOVE every number so a
          non-live read is impossible to mistake for a normal one. */}
      <SourceWarningBanner source={payload.source} />

      <TriggersRow payload={payload} />

      {/* Top: confidence_basis. Italic 1-liner when short, labeled
          paragraph block when the new lessons (2026-05-11) produce
          multi-sentence basis prose. */}
      <ProseField label="Confidence Basis" text={payload.confidenceBasis} />

      {payload.bias != null && (
        <div className="flex items-center gap-2 text-[11px]">
          <span style={{ color: theme.textTertiary }}>BIAS</span>
          <span
            className="rounded px-1.5 py-0.5 font-mono uppercase"
            style={{
              color: theme.text,
              backgroundColor: theme.chipBg,
            }}
          >
            {payload.bias}
          </span>
          {payload.confidence != null && (
            <>
              <span style={{ color: theme.textTertiary }}>·</span>
              <span style={{ color: theme.textMuted }}>
                {payload.confidence} confidence
              </span>
            </>
          )}
        </div>
      )}

      <StructuresRow payload={payload} />

      {payload.futuresPlan != null && payload.futuresPlan.trim() !== '' && (
        <FuturesPlanBlock plan={payload.futuresPlan} />
      )}

      <GammaRow payload={payload} />

      {/* Bottom: expected_dealer_behavior. Italic line when terse,
          labeled paragraph block when the new lessons produce a
          multi-sentence FLOW-STRUCTURE CHECK. The full prose narrative
          is intentionally NOT rendered in the panel — it lives in
          prose_text for full debrief reads. */}
      <ProseField
        label="Dealer Behavior"
        text={payload.expectedDealerBehavior}
      />
    </div>
  );
}
