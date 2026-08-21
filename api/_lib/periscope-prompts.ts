/**
 * Pure helpers for the periscope-chat handler.
 *
 * Extracted from `api/periscope-chat.ts` so the parsing / formatting
 * primitives can be unit-tested in isolation. The handler imports
 * everything from this module rather than defining the helpers inline.
 *
 * Functions live here when they are:
 *   - pure (no DB, no network, no SDK call)
 *   - no closure dependency on the handler module
 *   - useful to test on their own
 *
 * Phase 5h of docs/superpowers/specs/api-refactor-2026-05-02.md.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { Sentry } from './sentry.js';
import logger from './logger.js';
import { parseTrailingJsonBlock } from './json-fence.js';
import { NO_ALERTS_SENTINEL } from './periscope-flow-context.js';
import type { PeriscopeSnapshotSource } from './periscope-query.js';
import type {
  ParentChainRow,
  PeriscopeBias,
  PeriscopeConfidence,
  PeriscopeKeyLevels,
  PeriscopeMode,
  PeriscopeParentRead,
  PeriscopeStructuredFields,
} from './periscope-db.js';

// ── User message construction ─────────────────────────────────

/**
 * Build the user message content blocks: a small text preamble
 * (mode + linkage) followed by labelled image blocks. Periscope
 * screenshots are PNG/JPEG/GIF/WEBP base64.
 *
 * NOTE — the live auto-playbook runner is DB-driven and always passes
 * `images: []`; the image path survives only for manual/legacy callers.
 * The mode bodies below are therefore written for a no-chart payload
 * (see {@link NO_CHART_PREAMBLE}).
 *
 * In debrief mode, when `parentRead` is supplied the parent's prose +
 * structured fields are inlined into the preamble. Without this Claude
 * sees only `Parent read id: N` (a bare integer) and has no actual open
 * read to score against — the debrief just describes the EOD chart.
 */
export function buildUserContent(args: {
  mode: PeriscopeMode;
  parentId: number | null | undefined;
  parentRead?: PeriscopeParentRead | null;
  /**
   * Oldest-first parent chain (root pre_trade ... immediate parent).
   * Used by `intraday` and `debrief` modes to inject a chain summary
   * block AFTER the mode header and BEFORE the heat-map block.
   * Pre_trade mode ignores this entirely (no parent context).
   */
  parentChain?: ParentChainRow[] | null;
  /**
   * Optional pre-formatted text injected as its own user-content block
   * BEFORE the image blocks. Used by the periscope-chat handler to
   * surface Pass 1B heat-map OCR results so Claude has typed strike
   * values alongside the visual heat maps.
   */
  heatMapBlock?: string | null;
  /**
   * Optional pre-formatted text injected as its own user-content block
   * BETWEEN the heat-map block and the image blocks. Used by the
   * periscope-chat handler to surface ws_flow_alerts informed-flow
   * context (Phase 1.5 of the periscope-chat overhaul spec). Mode-
   * specific framing is built upstream by buildFlowContextBlock().
   */
  flowBlock?: string | null;
  /**
   * Optional pre-formatted text describing the authoritative SPX spot
   * at read time, including its source (db_exact / db_snapped). Built
   * by the periscope-chat handler from {@link fetchSPXSpotAtTimestamp}
   * and injected so Claude binds analysis to the typed value rather
   * than the chart's red dotted line.
   */
  spotDirective?: string | null;
  images: Array<{
    kind: 'chart' | 'gex' | 'charm';
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  }>;
}): Anthropic.Messages.ContentBlockParam[] {
  const {
    mode,
    parentId,
    parentRead,
    parentChain,
    heatMapBlock,
    flowBlock,
    spotDirective,
    images,
  } = args;

  const blocks: Anthropic.Messages.ContentBlockParam[] = [];

  // Mode-specific preamble. The skill's worked examples include hindsight
  // checkmarks and outcome data ("Day rallied... settled 7,209.01") which
  // the model otherwise copies into fresh intraday responses — even when
  // the chart's date matches a worked-example date by coincidence. The
  // pre_trade and intraday overrides below stop that leak. Debrief mode
  // keeps hindsight allowed since scoring IS the point there.
  const headerLines = [`Mode: ${mode}`];
  if (parentId != null) headerLines.push(`Parent read id: ${parentId}`);

  let bodyLines: string[];
  switch (mode) {
    case 'pre_trade': {
      bodyLines = buildPreTradeModeBody();
      break;
    }
    case 'intraday': {
      bodyLines = buildIntradayModeBody();
      break;
    }
    case 'debrief': {
      bodyLines = buildDebriefModeBody(parentRead);
      break;
    }
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown periscope mode: ${String(_exhaustive)}`);
    }
  }

  blocks.push({
    type: 'text',
    text: [...headerLines, '', ...bodyLines].join('\n'),
  });

  // Authoritative spot directive (Phase 6B). The handler computes this
  // from index_candles_1m so Claude binds analysis to the DB-verified
  // price rather than reading the chart's red dotted spot line.
  if (spotDirective != null && spotDirective.length > 0) {
    blocks.push({ type: 'text', text: spotDirective });
  }

  // Parent-chain summary (Phase 6C). Only intraday + debrief see prior
  // reads; pre_trade is forward-looking and has no chain.
  if (mode !== 'pre_trade') {
    const chainBlock = formatParentChainBlock(parentChain ?? null);
    if (chainBlock != null) {
      blocks.push({ type: 'text', text: chainBlock });
    }
  }

  // Heat-map OCR results (Pass 1B) go BEFORE the image blocks so Claude
  // sees the typed values first and uses the visual heat maps as a
  // cross-check rather than the primary signal.
  if (heatMapBlock != null && heatMapBlock.length > 0) {
    blocks.push({ type: 'text', text: heatMapBlock });
  }

  // Flow-alert context (Phase 1.5) sits between the heat-map block and
  // the images so it's read after the structured heat-map values but
  // before Claude attends to the actual screenshots.
  if (flowBlock != null && flowBlock.length > 0) {
    blocks.push({ type: 'text', text: flowBlock });
  }

  // Each image gets a label header + the image block, so Claude knows
  // which view it's looking at.
  for (const img of images) {
    blocks.push({ type: 'text', text: `[${img.kind} screenshot]` });
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

  return blocks;
}

/**
 * Render the oldest-first parent chain as a small headed bullet list.
 * Returns null when the chain is empty so the caller can skip the
 * injection entirely. Each ancestor renders mode + regime + bias + a
 * one-line excerpt of its prose so Claude can reason about the chain
 * without inflating the user content past usefulness.
 */
export function formatParentChainBlock(
  chain: ParentChainRow[] | null,
): string | null {
  if (chain == null || chain.length === 0) return null;

  const lines: string[] = ['## Parent chain (oldest first)'];
  lines.push('');
  lines.push(
    "Earlier reads in today's chain. Read your new bias against this — if you reverse the chain's posture, state the structural reason. Do NOT silently invert.",
  );
  lines.push('');

  for (const row of chain) {
    const meta = [
      `mode=${row.mode}`,
      row.regime_tag ? `regime=${row.regime_tag}` : null,
      row.bias ? `bias=${row.bias}` : null,
    ]
      .filter((s): s is string => s != null)
      .join(' · ');
    lines.push(`- #${row.id} (${meta})`);
    if (row.prose_excerpt.length > 0) {
      lines.push(`  ${row.prose_excerpt}`);
    }
  }

  return lines.join('\n');
}

/**
 * Per-source scale note. `periscope_snapshots` carries three series on
 * mutually incompatible scales (migration #191):
 *
 *   - `uw_spot` — RAW DOLLAR exposure, ~1000x LARGER than the scale
 *     every worked example / magnitude band in
 *     `.claude/skills/periscope/SKILL.md` was calibrated on.
 *   - `uw_eod` — UW's NORMALIZED greek exposure, ~1000x smaller than
 *     `uw_spot`, and exactly ONE synthetic 15:00-CT slice per day.
 *   - `gexbot` — the retired legacy feed; normalized, and dead.
 *
 * Without this note Claude reads raw-dollar magnitudes against a
 * normalized mental model and misjudges the whole gamma landscape.
 */
const HEAT_MAP_SCALE_NOTES: Record<PeriscopeSnapshotSource, string> = {
  uw_spot:
    "RAW DOLLAR greek exposure from the Unusual Whales live spot feed — roughly 1000x LARGER than the normalized heat-map scale the periscope skill's worked examples and magnitude bands were calibrated on.",
  uw_eod:
    'Unusual Whales\' NORMALIZED end-of-day greek exposure — roughly 1000x SMALLER than the raw-dollar uw_spot series. This series has exactly ONE synthetic 15:00-CT slice per trading day, so anything you might treat as a "prior slice" is YESTERDAY, not ten minutes ago; make no intraday-momentum claim from it.',
  gexbot:
    'the retired GEXBot normalized series — same normalized scale family as the skill, but the feed is dead so the values may be stale.',
};

/**
 * Units / scale directive that precedes the strike listings.
 *
 * VOLATILE placement, deliberately: this text lives in the per-slot
 * user content (not the cached system prefix) because `source` can
 * change between slots — `resolveSnapshotSource` falls back
 * `uw_spot -> uw_eod` when the expiry has no live rows. Putting it in
 * a static block would either bake in the wrong scale or invalidate
 * the 1h-TTL cached prefix whenever the source changed.
 */
function formatScaleDirective(
  source: PeriscopeSnapshotSource | null,
): string[] {
  const note =
    source == null
      ? 'of an UNRESOLVED source series — treat every magnitude as unverified.'
      : HEAT_MAP_SCALE_NOTES[source];
  return [
    `UNITS / SCALE — source=${source ?? 'unknown'}. These values are ${note}`,
    'CONSEQUENCE: IGNORE every absolute-magnitude sanity check in the periscope skill, including the "0DTE charm runs ±60K–120K" band and the magnitudes in its worked examples. Do NOT judge a number as "too big" or "too small" against them, and do NOT rescale or convert the values yourself. What REMAINS VALID is relative structure only: signs (+γ vs −γ), strike-to-strike rankings, ratios between strikes, and where the clusters sit relative to spot. Quote magnitudes exactly as printed below.',
  ];
}

/**
 * Format a heat-map extraction result as a user-content text block.
 * Returns null when both metric arrays are empty so the caller can
 * skip the injection entirely.
 *
 * The block is labeled clearly so Claude knows the values are MM-
 * attributed Net GEX / Net Charm from UW (not naive). Color is
 * implied by the value's sign and elided to keep the block compact.
 *
 * `source` is REQUIRED (nullable, never omittable) so a caller cannot
 * silently ship magnitudes with no units attached — see
 * {@link formatScaleDirective}.
 */
export function formatHeatMapBlock(args: {
  gex: Array<{ strike: number; value: number }>;
  charm: Array<{ strike: number; value: number }>;
  source: PeriscopeSnapshotSource | null;
}): string | null {
  const { gex, charm, source } = args;
  if (gex.length === 0 && charm.length === 0) return null;

  const lines: string[] = [
    '[Heat-map extracted strikes (MM-attributed Net GEX / Net Charm from UW)]',
    '',
    ...formatScaleDirective(source),
  ];

  if (gex.length > 0) {
    lines.push('');
    lines.push('Net GEX (top strikes by absolute value):');
    for (const cell of gex) {
      lines.push(`  ${cell.strike}: ${formatSigned(cell.value)}`);
    }
  }
  if (charm.length > 0) {
    lines.push('');
    lines.push('Net Charm (top strikes by absolute value):');
    for (const cell of charm) {
      lines.push(`  ${cell.strike}: ${formatSigned(cell.value)}`);
    }
  }

  return lines.join('\n');
}

/** Format a number with explicit sign so green/red is unambiguous. */
function formatSigned(n: number): string {
  if (n > 0) return `+${n.toLocaleString('en-US')}`;
  return n.toLocaleString('en-US');
}

/**
 * Data-provenance preamble shared by all three modes.
 *
 * The auto-playbook runner calls with `images: []` — it is entirely
 * DB-driven via `synthesizeFromDb`. The prior wording ("the chart in
 * front of you", "positions levels") was written for the retired
 * screenshot/OCR era and, with no image blocks present, is a direct
 * invitation to hallucinate Positions bars, prior-slice dots and
 * candle-chart price action that are not in the payload.
 *
 * The Positions panel is PERMANENTLY unavailable: no Unusual Whales
 * exposure endpoint serves one and `PanelName` is only
 * 'gamma' | 'charm' | 'vanna'. So requests for it are removed rather
 * than softened.
 *
 * VOLATILE placement: this rides in the per-read user content, not the
 * static system blocks, so it costs nothing against the 1h-TTL cached
 * prefix (~33-70K tokens) and stays byte-identical for cache purposes.
 */
const NO_CHART_PREAMBLE: readonly string[] = [
  'THERE IS NO CHART AND NO SCREENSHOT IN THIS REQUEST. You are reading headless off the database: every figure available to you appears as typed text in the blocks below (spot directive, heat-map extracted strikes, flow context, parent chain). Do not describe, cite, or infer anything visual — no bars, no dots, no colors, no candle chart, no drawn cone.',
  'The Positions panel is NOT available and never will be — the data source serves no positions series. Do NOT report Positions levels or clusters, and do NOT attempt the Positions-vs-Gamma cross-check the skill describes. Prior-slice dots are likewise unavailable: any momentum or sign-flip claim must be sourced from the parent-chain block, not from an imagined dot.',
  'Only Net GEX (gamma) and Net Charm strikes are supplied. Vanna is NOT supplied — do not invent vanna readings; treat vol-shock exposure as unknown.',
];

/**
 * Confidence cap for criteria that cannot be checked against the data
 * actually supplied. SKILL.md's `high` bar (SKILL.md:469-472) requires
 * twin-strike confluence cross-checked against Positions, the
 * `key_levels.magnet` rule (SKILL.md:218) cross-checks Positions, and
 * the self-igniting-expiry-unwind read (SKILL.md:288-300) needs both
 * Positions bars and prior-slice dots. None of that exists here.
 *
 * VOLATILE placement, for the same reason as NO_CHART_PREAMBLE — and
 * specifically NOT in `STRUCTURED_TOOL`, because `tools` renders before
 * `system` and any schema edit would invalidate the entire cached
 * prefix.
 */
const CONFIDENCE_CAP_GUIDANCE: readonly string[] = [
  'CONFIDENCE CAP. Do NOT claim "high" confidence on any criterion you cannot actually verify with the data supplied above. In particular the skill\'s "high" bar (twin-strike +γ confluence cross-checked against Positions) and its self-igniting expiry-unwind read both require the Positions panel and prior-slice dots, neither of which is available — so those checks are UNAVAILABLE, not "passed". When a required check is unavailable, cap at "medium" (or "low" when structure is fragile) and name the missing check explicitly in confidence_basis, e.g. "Positions cross-check unavailable — panel not served by this data source". Silently treating an unverifiable criterion as satisfied is a verification failure.',
];

/**
 * Debrief-only instruction that closes the lessons loop.
 *
 * `periscope-lessons.ts` extracts curation candidates by keying on a
 * `## What to add to the model` heading in the debrief prose
 * (HEADING_REGEX at periscope-lessons.ts:125). No live prompt has ever
 * asked for that heading, which is why `curate-periscope-lessons` has
 * always been a no-op. The heading below is emitted on its OWN LINE and
 * must stay character-for-character compatible with that regex —
 * `api/__tests__/periscope-prompts.test.ts` asserts it by running the
 * real extractor over this instruction's heading rather than a copied
 * literal, so the two cannot drift.
 *
 * ## The ordering is load-bearing
 *
 * The section must be written in PROSE and BEFORE the
 * {@link STRUCTURED_TOOL_NAME} tool call. A `tool_use` block TERMINATES
 * the assistant turn (`stop_reason: 'tool_use'`) and
 * `runCachedAnthropicCall` is single-shot — it concatenates the text
 * blocks of ONE `finalMessage()` and never continues the turn. So an
 * instruction to write the lessons "after the required structured
 * output" (what this said until 2026-08-21) generates nothing at all:
 * `prose_text` never carries the heading, `extractCandidatesViaRegex`
 * finds no candidates, and `curate-periscope-lessons` stays the exact
 * no-op this instruction exists to fix.
 *
 * A function rather than a `const` array so it can interpolate
 * {@link STRUCTURED_TOOL_NAME} — declared further down this module —
 * without a temporal-dead-zone error at module init. Naming the tool
 * from the constant means a rename cannot silently desynchronise the
 * ordering rule from the tool it is about.
 *
 * VOLATILE placement: debrief-only, so it must not enter the static
 * system prefix shared by all three modes.
 */
function buildLessonsSectionInstruction(): string[] {
  return [
    `LESSONS SECTION — REQUIRED. Write it in your PROSE, and write it BEFORE you call the \`${STRUCTURED_TOOL_NAME}\` tool.`,
    `WHY THE ORDER MATTERS: calling \`${STRUCTURED_TOOL_NAME}\` ENDS YOUR TURN. Nothing you intend to write after that tool call is ever generated, so a lessons section placed after it is silently lost and the curation pipeline receives nothing. This ordering overrides any placement the skill or its worked examples imply.`,
    'Required response order: (1) the scoring narrative, (2) the lessons section described here — the LAST prose you write, (3) the tool call, with nothing after it.',
    '',
    'Open the lessons section with this heading verbatim, on its own line:',
    '',
    '## What to add to the model',
    '',
    'Under that heading, write 1-4 `-` bullets. Each bullet must be ONE self-contained, reusable lesson stated so it is useful on a future day with different numbers — the mechanism and the condition it fires under, not today\'s price. Bad: "7,250 held". Good: "A +γ cluster that survives two consecutive slices without shrinking held as an intraday floor; a cluster that halved between slices did not." If the session produced nothing transferable, still emit the heading and say so in a single bullet.',
  ];
}

/**
 * Pre-trade preamble. No parent context — this is the day's first read,
 * forward-looking, prior to any intraday price action. Hindsight is
 * forbidden in the same way as intraday; only data timestamped at or
 * before read_time counts.
 */
function buildPreTradeModeBody(): string[] {
  return [
    `YOU ARE IN PRE-TRADE MODE. Produce the day playbook BEFORE the open: setup → structural map → charm flow tally → trade thesis with bilateral triggers (long + short, stops, targets, R:R, no-trade zone) → regime label. Then call the \`${STRUCTURED_TOOL_NAME}\` tool LAST — that call ends your turn, so write every part of the prose above before it.`,
    '',
    ...NO_CHART_PREAMBLE,
    '',
    'No prior intraday reads exist for today — there is no chain to reconcile against. Treat this as a fresh forward-looking read.',
    '',
    ...CONFIDENCE_CAP_GUIDANCE,
    '',
    `DO NOT include any worked-example outcomes, "the day delivered", settlement values, ✓ check-marks, "what triggered", "what actually happened", or any hindsight scoring. The \`${STRUCTURED_TOOL_NAME}\` tool call is the last thing you emit; nothing after it is generated.`,
    '',
    "If today's date or structure resembles a worked example in the skill, treat this as a fresh real-time read. The user already knows the worked-example outcomes — do not repeat them.",
  ];
}

/**
 * Intraday preamble. Has a parent chain (today's pre_trade plus any
 * earlier intraday reads). Must reconcile against the chain rather
 * than silently inverting a prior bias.
 */
function buildIntradayModeBody(): string[] {
  return [
    'YOU ARE IN INTRADAY MODE. Produce a forward-looking thesis-maintenance read of the slice supplied below. Output ONLY:',
    '  - Setup at slice end (current spot + immediate context)',
    '  - Structural map (gamma + charm levels from the supplied heat-map strikes)',
    '  - Charm flow tally → directional bias',
    '  - Trade thesis with bilateral triggers (long + short), stops, targets, R:R, no-trade zone',
    '  - Regime label',
    `  - Then the \`${STRUCTURED_TOOL_NAME}\` tool call, LAST — it ends your turn`,
    '',
    ...NO_CHART_PREAMBLE,
    '',
    "Reconcile against the parent chain. If you reverse the chain's bias, state the structural reason explicitly (a specific gamma or charm change in this slice versus the chain). Do NOT silently invert.",
    '',
    ...CONFIDENCE_CAP_GUIDANCE,
    '',
    `DO NOT include any "## Debrief", "what triggered", "what actually happened", "the day delivered", settlement values, ✓ check-marks, or any hindsight scoring. The \`${STRUCTURED_TOOL_NAME}\` tool call is the last thing you emit; nothing after it is generated.`,
    '',
    "If today's date or structure resembles a worked example in the skill, treat this as a fresh real-time read. The user already knows the worked-example outcomes — do not repeat them.",
  ];
}

/**
 * Render the parent read as a labelled prose section that Claude can score
 * against. Structured fields go first as a compact summary, then the full
 * prose. Both are needed: structured fields give Claude the exact trigger
 * levels for an unambiguous score; prose carries the thesis / regime
 * reasoning so the debrief can reference *why* the read called what it
 * called, not just whether the price hit a number.
 */
function buildDebriefModeBody(
  parent: PeriscopeParentRead | null | undefined,
): string[] {
  const head = [
    'YOU ARE IN DEBRIEF MODE. Score the open read below against the actual session outcome recorded in the database — the authoritative spot in the spot directive block, the end-of-day heat-map strikes, and the parent chain. Honest facts only — no retroactive justification.',
    '',
    ...NO_CHART_PREAMBLE,
    '',
    ...CONFIDENCE_CAP_GUIDANCE,
    '',
    ...buildLessonsSectionInstruction(),
  ];
  if (parent == null) return head;

  const s = parent.structured;
  const fmt = (n: number | null) => (n == null ? 'n/a' : n.toString());
  return [
    ...head,
    '',
    `## Open read to score (id ${parent.id}, ${parent.tradingDate})`,
    '',
    'Structured fields from the open read:',
    `- spot: ${fmt(s.spot)}`,
    `- cone: ${fmt(s.cone_lower)} – ${fmt(s.cone_upper)}`,
    `- long trigger: ${fmt(s.long_trigger)}`,
    `- short trigger: ${fmt(s.short_trigger)}`,
    `- regime: ${s.regime_tag ?? 'n/a'}`,
    '',
    'Full prose of the open read:',
    '',
    parent.proseText.length > 0 ? parent.proseText : '(no prose recorded)',
  ];
}

// ── Structured-output extraction ──────────────────────────────

/**
 * Result of `parseStructuredFields`. `parseOk` is true iff a JSON block
 * was found AND JSON.parse succeeded. We surface it as a sibling field
 * (rather than mixing it into `PeriscopeStructuredFields`) because the
 * structured shape models the model's typed output; `parseOk` is parser
 * metadata. Phase 6A migration adds the DB column; for Phase 1 the
 * caller propagates it through the response payload only.
 */
export interface ParsedStructuredOutput {
  prose: string;
  structured: PeriscopeStructuredFields;
  parseOk: boolean;
}

/**
 * Extract the LAST fenced ```json...``` block from the response. Returns
 * { prose, structured, parseOk }. On any parse failure: prose is the full
 * text unchanged, structured is all-null, parseOk is false, and a Sentry
 * event is recorded for JSON.parse errors.
 *
 * Why "last" block: Claude may include illustrative JSON snippets earlier
 * in the prose (e.g. quoting a sample column shape). The structured-output
 * block is appended at the very end per the skill instruction, so we
 * always pick the last match.
 *
 * Block-finding is delegated to `parseTrailingJsonBlock` (json-fence.ts);
 * this function owns field coercion + Sentry reporting only.
 */
/** Empty / null payload used when no JSON block was found or parsed. */
function emptyStructured(): PeriscopeStructuredFields {
  return {
    spot: null,
    cone_lower: null,
    cone_upper: null,
    long_trigger: null,
    short_trigger: null,
    regime_tag: null,
    bias: null,
    trade_types_recommended: [],
    trade_types_avoided: [],
    key_levels: null,
    expected_dealer_behavior: null,
    confidence: null,
    confidence_basis: null,
    futures_plan: null,
  };
}

const BIAS_VALUES = new Set<PeriscopeBias>([
  'long-only',
  'short-only',
  'fade-only',
  'two-sided',
  'no-trade',
]);

const CONFIDENCE_VALUES = new Set<PeriscopeConfidence>([
  'low',
  'medium',
  'high',
]);

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function coerceKeyLevels(raw: unknown): PeriscopeKeyLevels | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  // Only emit a key_levels object if at least ONE field came back numeric;
  // otherwise the column would carry an all-null shape that's no more
  // informative than NULL.
  const out: PeriscopeKeyLevels = {
    gamma_floor: num(o.gamma_floor),
    gamma_ceiling: num(o.gamma_ceiling),
    magnet: num(o.magnet),
    charm_zero: num(o.charm_zero),
  };
  if (
    out.gamma_floor == null &&
    out.gamma_ceiling == null &&
    out.magnet == null &&
    out.charm_zero == null
  ) {
    return null;
  }
  return out;
}

/**
 * Anthropic tool definition for the structured playbook fields.
 *
 * Forced via `tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME }`
 * so Claude is required to emit a valid `tool_use` block on every
 * call. Anthropic constrains generation against the `input_schema`,
 * which eliminates the JSON.parse failure mode that occurred when
 * free-text prose fields contained unescaped control characters
 * (Sentry: "Bad control character in string literal in JSON" — fixed
 * 2026-05-11 by migrating away from fenced ```json blocks).
 *
 * Field descriptions act as implicit prompt instructions per the
 * llm-structured-output skill — keep them prescriptive.
 */
export const STRUCTURED_TOOL_NAME = 'emit_playbook_structured';

export const STRUCTURED_TOOL: Anthropic.Messages.Tool = {
  name: STRUCTURED_TOOL_NAME,
  description:
    'Emit the structured fields of the playbook (typed parallel to the prose narrative). Call this exactly once per read with all fields populated to the best of your ability; use null / empty arrays when a field is genuinely unavailable for the current read.',
  input_schema: {
    type: 'object',
    properties: {
      spot: {
        type: ['number', 'null'],
        description:
          'SPX cash spot at read time. The system overwrites this with the authoritative DB-resolved spot; emit your best read of the panel here for prose consistency.',
      },
      cone_lower: {
        type: ['number', 'null'],
        description:
          'Lower bound of the 0DTE straddle breakeven cone (cone.lower).',
      },
      cone_upper: {
        type: ['number', 'null'],
        description:
          'Upper bound of the 0DTE straddle breakeven cone (cone.upper).',
      },
      long_trigger: {
        type: ['number', 'null'],
        description:
          'Long-side trigger price. MUST be strictly below gamma_ceiling (the structural target). If the chart has no clean upside structural target above the trigger zone, emit null.',
      },
      short_trigger: {
        type: ['number', 'null'],
        description:
          'Short-side trigger price. MUST be strictly above gamma_floor (the structural target). If the chart has no clean downside structural target below the trigger zone, emit null.',
      },
      regime_tag: {
        type: ['string', 'null'],
        description:
          'Regime label. Common values: pin, drift-and-cap, cone-breach, cone-breach-up, cone-breach-down, chop, gap-and-rip, trap.',
      },
      bias: {
        type: ['string', 'null'],
        enum: [
          'long-only',
          'short-only',
          'fade-only',
          'two-sided',
          'no-trade',
          null,
        ],
        description: 'Directional bias for the read.',
      },
      trade_types_recommended: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REQUIRED non-empty array (unless bias = no-trade). Recommended structures, e.g. iron_condor, debit_call_spread, broken_wing_butterfly. For iron_condor / iron_butterfly the wings are gamma_floor / gamma_ceiling — NOT the cone bounds.',
      },
      trade_types_avoided: {
        type: 'array',
        items: { type: 'string' },
        description:
          'REQUIRED non-empty array. Structures explicitly to avoid given the current read.',
      },
      key_levels: {
        type: ['object', 'null'],
        properties: {
          gamma_floor: { type: ['number', 'null'] },
          gamma_ceiling: { type: ['number', 'null'] },
          magnet: { type: ['number', 'null'] },
          charm_zero: { type: ['number', 'null'] },
        },
        description: 'Structural level map. Floor / ceiling are the IC wings.',
      },
      // NOTE — field-overload: expected_dealer_behavior carries BOTH the
      // FLOW-STRUCTURE check AND the dealer-behavior forecast. The
      // SKILL.md contract describes it as a single-sentence forecast
      // only. Splitting into a dedicated `flow_structure` enum field
      // (requires schema + DB migration + runner panel-payload mapping)
      // is tracked as Phase 5 follow-up in:
      // docs/superpowers/specs/periscope-flow-hallucination-fix-2026-05-16.md
      expected_dealer_behavior: {
        type: ['string', 'null'],
        description:
          'REQUIRED prose field carrying two things, in order: (1) FLOW-STRUCTURE check on a dedicated line, formatted EXACTLY as one of "FLOW-STRUCTURE: AGREEMENT — <verbatim cite>", "FLOW-STRUCTURE: DISAGREEMENT — <verbatim cite>", or "FLOW-STRUCTURE: INSUFFICIENT_DATA". (2) One-sentence dealer-behavior forecast (e.g. "passive bid below 7,250, passive offer above 7,275"). ' +
          'CITATION RULES: <verbatim cite> MUST quote an alert from the supplied [Flow context] block as "HH:MM CT TYPE STRIKE rule=NAME". DO NOT cite an alert (timestamp, strike, rule, premium) that does not appear verbatim in the supplied [Flow context] block — fabricated citations are a verification failure. ' +
          `LABEL RESOLUTION: if the [Flow context] block contains "${NO_ALERTS_SENTINEL}", the only valid label is INSUFFICIENT_DATA — emitting AGREEMENT or DISAGREEMENT in that case is a verification failure. Mixed flow (call/put within 2:1 by premium) → INSUFFICIENT_DATA. Side-dominant flow matching structural bias → AGREEMENT. Side-dominant flow opposing structural bias → DISAGREEMENT (state whether the conflict makes the slot NO-TRADE).`,
      },
      confidence: {
        type: ['string', 'null'],
        enum: ['low', 'medium', 'high', null],
        description:
          'Conviction level. STRUCTURAL GATING (enforced; emitting "high" outside these conditions is a verification failure): ' +
          '"high" REQUIRES BOTH (a) the FLOW-STRUCTURE check in expected_dealer_behavior resolved to AGREEMENT with side-dominant flow ≥2:1 by premium, AND (b) twin-strike +γ floor + matching charm sign + intraday parent-chain agreement. ' +
          'If expected_dealer_behavior contains "FLOW-STRUCTURE: INSUFFICIENT_DATA", "high" is FORBIDDEN — drop to "medium" or "low" instead (the 2026-05-15 audit identified 3 of 19 historical HIGH reads were issued on empty flow windows; this gate closes that loophole). ' +
          'If expected_dealer_behavior contains "FLOW-STRUCTURE: DISAGREEMENT", "high" is FORBIDDEN unless the disagreement makes the slot NO-TRADE (no directional conviction to be high about). ' +
          '"medium" is the DEFAULT — appropriate for AGREEMENT without twin-strike confluence, for INSUFFICIENT_DATA when the structural read is twin-confirmed, or for DISAGREEMENT that lands on NO-TRADE. ' +
          '"low" is appropriate when structure is fragile (no nearby +γ floor, contradicting orange bars, or cone-breach in the first hour) regardless of flow state. ' +
          'NEVER emit "high" without filling confidence_basis.',
      },
      confidence_basis: {
        type: ['string', 'null'],
        description:
          "REQUIRED whenever confidence != null. State the specific structural fact that justifies the conviction level — a fact, not a feeling. For \"high\", you MUST cite BOTH the FLOW-STRUCTURE AGREEMENT (re-quote the verbatim alert from expected_dealer_behavior) AND the twin-strike +γ structural confluence, AND state the dominant-side premium share (e.g. 'calls 78% of window premium' or 'call:put ≈ 3.6:1') so the ≥2:1 dominance gate is checkable from the prose alone. Bad: 'levels look clean'. Good: 'twin-strike +γ at 7,380 (+1,107) and 7,350 (+1,235); FLOW-STRUCTURE: AGREEMENT — 14:30 CT PUT 7350 rule=RepeatedHits ($420K, ask 78%); put-side premium 3.6:1 dominant in the window'. Multi-sentence allowed.",
      },
      futures_plan: {
        type: ['string', 'null'],
        description:
          "REQUIRED prose field (multi-paragraph). MUST contain the explicit IF-THEN setups from your prose narrative verbatim. Format:\\n\\nSETUP A — IF [price condition], [direction] to [target], stop [stop]. R:R [ratio]. DISQUALIFIER: [condition].\\n\\nSETUP B — IF [opposite condition], [direction] to [target], stop [stop]. R:R [ratio]. DISQUALIFIER: [condition].\\n\\nNO-TRADE WHILE: [chop range / spread / event window].\\n\\nDo NOT submit empty or a generic 'go long/short' string — the trader uses this field directly. Mirror the prose verbatim so the panel UI shows the actionable plan.",
      },
    },
    required: [],
  },
};

/**
 * Extract structured fields from a `tool_use` block's `input` (already
 * parsed by Anthropic — no JSON.parse needed). Reuses the coercion +
 * enum-validation logic from {@link parseStructuredFields} so the
 * runtime output shape is identical regardless of channel.
 *
 * Use this when the runner forces `tool_choice` on the call. The
 * function returns `parseOk: false` only when the tool input is
 * absent or shape-malformed (e.g. wrong asset name) — never on the
 * control-character-in-string failure mode that plagued JSON.parse.
 */
export function parseStructuredFieldsFromToolInput(
  toolInput: unknown,
  prose: string,
): ParsedStructuredOutput {
  if (toolInput == null || typeof toolInput !== 'object') {
    logger.warn(
      { toolInputType: typeof toolInput },
      'periscope-chat: tool_use block missing or not an object',
    );
    return { prose, structured: emptyStructured(), parseOk: false };
  }
  const structured = coerceStructured(toolInput as Record<string, unknown>);
  return { prose, structured, parseOk: true };
}

/**
 * Shared field coercion. Extracted so both `parseStructuredFields`
 * (legacy JSON-block path, kept for back-compat with periscope-chat
 * manual flows) and `parseStructuredFieldsFromToolInput` (tool_use
 * path, used by the auto-playbook) produce identical typed output.
 */
function coerceStructured(
  parsed: Record<string, unknown>,
): PeriscopeStructuredFields {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null;

  const biasRaw = parsed.bias;
  const bias =
    typeof biasRaw === 'string' && BIAS_VALUES.has(biasRaw as PeriscopeBias)
      ? (biasRaw as PeriscopeBias)
      : null;

  const confidenceRaw = parsed.confidence;
  const confidence =
    typeof confidenceRaw === 'string' &&
    CONFIDENCE_VALUES.has(confidenceRaw as PeriscopeConfidence)
      ? (confidenceRaw as PeriscopeConfidence)
      : null;

  return {
    spot: num(parsed.spot),
    cone_lower: num(parsed.cone_lower),
    cone_upper: num(parsed.cone_upper),
    long_trigger: num(parsed.long_trigger),
    short_trigger: num(parsed.short_trigger),
    regime_tag: str(parsed.regime_tag),
    bias,
    trade_types_recommended: coerceStringArray(parsed.trade_types_recommended),
    trade_types_avoided: coerceStringArray(parsed.trade_types_avoided),
    key_levels: coerceKeyLevels(parsed.key_levels),
    expected_dealer_behavior: str(parsed.expected_dealer_behavior),
    confidence,
    confidence_basis: str(parsed.confidence_basis),
    futures_plan: str(parsed.futures_plan),
  };
}

export function parseStructuredFields(text: string): ParsedStructuredOutput {
  const block = parseTrailingJsonBlock(text);
  if (block == null) {
    logger.warn('periscope-chat: no JSON code block in response');
    return { prose: text, structured: emptyStructured(), parseOk: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(block.body) as Record<string, unknown>;
  } catch (err) {
    logger.error(
      { err, blockBody: block.body.slice(0, 200) },
      'periscope-chat: failed to parse JSON block',
    );
    Sentry.captureException(err);
    return { prose: text, structured: emptyStructured(), parseOk: false };
  }

  const structured = coerceStructured(parsed);

  // Reassemble prose around the stripped block. `before` is the text up
  // to the open fence; `after` is rare trailing prose past the close
  // fence. trimEnd matches the prior behavior so callers don't see
  // dangling whitespace.
  const prose = (block.before + block.after).trimEnd();

  return { prose, structured, parseOk: true };
}

/**
 * Build a short prose-shaped sentence carrying the extracted structural
 * levels. Used as the proseText input to buildPeriscopeSummary when
 * constructing the retrieval query, so the query embedding overlaps
 * semantically with stored rows whose actual prose discusses similar
 * spot / cone levels. Drops fields that came back null to keep the
 * sentence terse and avoid embedding the literal word "null".
 */
export function synthesizeStructuralProse(
  s: PeriscopeStructuredFields,
): string {
  const parts: string[] = [];
  if (s.spot != null) parts.push(`spot at ${s.spot}`);
  if (s.cone_lower != null && s.cone_upper != null) {
    parts.push(
      `the 0DTE straddle cone bounded between ${s.cone_lower} and ${s.cone_upper}`,
    );
  } else if (s.cone_lower != null) {
    parts.push(`cone lower bound at ${s.cone_lower}`);
  } else if (s.cone_upper != null) {
    parts.push(`cone upper bound at ${s.cone_upper}`);
  }
  if (parts.length === 0) return '';
  return `0DTE SPX Periscope read with ${parts.join(' and ')}.`;
}
