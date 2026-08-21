/**
 * Periscope auto-playbook runner — cron-triggered Periscope reads.
 *
 * Revived in Phase 1 of
 * docs/superpowers/specs/periscope-playbook-revival-2026-08-21.md from
 * the retired `periscope-chat-runner.ts` (`f52db025^`), repointed onto
 * the Unusual Whales data layer.
 *
 * Key properties:
 *  - **No images / OCR.** The runner always uses `synthesizeFromDb` to
 *    rebuild Pass 1A + Pass 1B equivalents from `periscope_snapshots`.
 *    There is no screenshot path and there never will be again — the
 *    Playwright scraper it was built for is gone.
 *  - Returns a structured outcome instead of streaming NDJSON. The
 *    caller (the `api/cron/periscope-playbook.ts` writer) persists the
 *    result to the pre-inserted `in_progress` row.
 *  - Auth-agnostic — the caller owns CRON_SECRET verification.
 *
 * Two-phase persistence pattern:
 *  1. The caller INSERTs an `in_progress` row before kicking off this
 *     runner — so a panel poll mid-flight can see "Claude thinking on
 *     slot X". Placeholder values for required NOT NULL columns
 *     (prose_text='', full_response='{}', model='pending').
 *  2. After this runner returns, the caller UPDATEs the row via
 *     `completePeriscopeAnalysis` (in periscope-db.ts).
 *
 * ## Scale safety (the reason this file has three guards in it)
 *
 * `.claude/skills/periscope/SKILL.md` calibrates every ABSOLUTE
 * magnitude it quotes ("0DTE charm runs ±60K–120K", the worked
 * examples) against the retired GEXBot / heat-map NORMALIZED scale.
 * `periscope_snapshots` no longer carries that scale. Migration #191
 * left three mutually incompatible series behind:
 *
 *  - `uw_spot` — the live feed. RAW DOLLAR exposure, ~1000x LARGER
 *    than the skill's scale, ~10-minute cadence.
 *  - `uw_eod`  — UW's normalized backfill. ~1000x SMALLER, and exactly
 *    ONE synthetic 15:00-CT slice per trading day, so its "prior slice"
 *    is YESTERDAY, not ten minutes ago.
 *  - `gexbot`  — the dead legacy feed.
 *
 * `resolveSnapshotSource` silently falls back `uw_spot -> uw_eod` when
 * the expiry has no live rows (Monday pre-open, a cron gap, a holiday).
 * Left alone, Claude emits a confident, well-formed, fully-populated
 * `panel_payload` built on magnitudes off by three orders of magnitude
 * and a day-over-day "momentum" read, and NOTHING on the stored row
 * flags it. On a tool that gets traded, that is the failure mode that
 * matters. So:
 *
 *  1. The resolved `source` is stamped into BOTH `full_response` and
 *     `panel_payload` on every row this runner produces.
 *  2. A scale preamble tells the model the magnitudes are raw dollars
 *     and that every absolute-magnitude sanity check in the skill must
 *     be ignored.
 *  3. Anything other than `uw_spot` HARD-REFUSES before a single token
 *     is spent — `status='failed'`, `failure_reason='source_not_uw_spot'`.
 *     Producing nothing beats producing a plausible wrong read.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Sentry } from './sentry.js';
import logger from './logger.js';
import { runCachedAnthropicCall } from './anthropic-call.js';
import { synthesizeFromDb } from './periscope-synthesize.js';
import {
  buildUserContent,
  formatHeatMapBlock,
  parseStructuredFields,
  parseStructuredFieldsFromToolInput,
  STRUCTURED_TOOL,
  STRUCTURED_TOOL_NAME,
} from './periscope-prompts.js';
import { buildCalibrationBlock } from './periscope-calibration.js';
import { buildRetrievalBlock } from './periscope-retrieval.js';
import { fetchActiveLessons, formatLessonsBlock } from './periscope-lessons.js';
import {
  buildFlowContextBlock,
  noAlertsSentinelForMode,
  NO_ALERTS_SENTINEL,
} from './periscope-flow-context.js';
import { generateEmbedding } from './embeddings.js';
import { SOURCE_UW_SPOT } from './periscope-uw.js';
import type { PeriscopeSnapshotSource } from './periscope-query.js';
import {
  buildPeriscopeSummary,
  fetchParentChain,
  fetchPeriscopeAnalysisById,
  type PeriscopeMode,
  type PeriscopeStructuredFields,
} from './periscope-db.js';

// Opus 5 — same $5/$25 pricing as Opus 4.7, thinking ON BY DEFAULT.
// `budget_tokens` is removed on this family (400s if sent); depth is
// controlled purely by `output_config.effort` below.
const MODEL = 'claude-opus-5';
const FALLBACK_MODEL_DEFAULT = 'claude-sonnet-5';

// Anthropic wall-clock budget — sized so the SDK always surfaces a
// clean timeout instead of the function being killed mid-call.
//
// Why that matters: the only thing that closes the pre-inserted
// `in_progress` row out is this module returning (or its catch
// returning a `failed` outcome) so the caller can UPDATE it. A
// platform kill runs neither, and the row stays `in_progress`
// FOREVER with the panel's "Claude reading…" hint pinned on.
//
// The arithmetic. The SDK contract is `timeout × (maxRetries + 1)`
// per call, and `runCachedAnthropicCall` can issue up to THREE calls
// on one invocation: the primary, the Sonnet fallback, and a one-shot
// retry of the fallback on a mid-stream socket close. So:
//
//   worst case = SDK_TIMEOUT_MS × (SDK_MAX_RETRIES + 1) × 3
//              = 240s × 1 × 3
//              = 720s
//   ceiling    = 780s  (vercel.json maxDuration for
//                       api/cron/periscope-playbook.ts)
//   reserve    =  60s  for synthesizeFromDb, the four context
//                       fetches and the retrieval embedding — all of
//                       which run BEFORE the Anthropic clock starts.
//                       The outcome embedding and the caller's UPDATE
//                       only run on paths where Anthropic returned, so
//                       they never stack on top of the 720s worst case.
//
// The previous values (660s × 3 retries) allowed a worst case of
// ~33 MINUTES against a 780s ceiling — i.e. the SDK could never have
// timed out first.
//
// Sizing the single attempt: an `xhigh` Opus 5 read is ~120-150s
// observed, so 240s is ~1.6x expected — long enough not to guillotine
// a dense slot, short enough that three of them still fit.
const SDK_TIMEOUT_MS = 240_000;

// Zero SDK-level retries. The retry budget is spent on the
// Opus → Sonnet fallback inside `runCachedAnthropicCall` instead,
// which is the more useful retry for the failure modes seen here
// (Opus 429 / 529 overload): a transient availability error moves to
// the fallback model immediately rather than re-queueing behind the
// same overloaded pool and burning the wall clock twice.
const SDK_MAX_RETRIES = 0;

// Skill + references load lazily on first invocation. SKILLS_DIR
// resolves to `<repo-root>/.claude/skills` — TWO levels up from
// `api/_lib/`. The vercel.json `includeFiles: ".claude/skills/**/*.md"`
// ships the directory under `/var/task/.claude/skills` for any function
// that imports this runner.
//
// Why lazy (was module-init IIFE before 2026-05-19): module-init
// filesystem access of paths that resolve differently across deploy
// paths (e.g., Vercel's deploy-validation step vs. runtime) is a
// fragility surface. Lazy-loading defers the read until the handler
// actually runs, when `/var/task/` is fully materialized, and isolates
// any future filesystem-availability hiccup to the request that needs
// the skill rather than to module load.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', '..', '.claude', 'skills');

let _periscopeSkillCache: string | null = null;

function loadPeriscopeSkill(): string {
  if (_periscopeSkillCache !== null) return _periscopeSkillCache;
  try {
    _periscopeSkillCache = readFileSync(
      join(SKILLS_DIR, 'periscope', 'SKILL.md'),
      'utf8',
    );
    return _periscopeSkillCache;
  } catch (err) {
    Sentry.captureException(err, {
      tags: { module: 'periscope-playbook-runner', stage: 'skill_load' },
    });
    // Skill is mandatory; fail loudly so the caller sees a 500 and
    // Sentry pages the failure rather than silently producing
    // skill-less reads.
    throw new Error('periscope-playbook-runner: SKILL.md failed to load', {
      cause: err,
    });
  }
}

let _periscopeReferencesCache: string | null = null;
let _periscopeReferencesLoaded = false;

function loadPeriscopeReferences(): string | null {
  if (_periscopeReferencesLoaded) return _periscopeReferencesCache;
  _periscopeReferencesLoaded = true;
  try {
    _periscopeReferencesCache = readFileSync(
      join(
        SKILLS_DIR,
        'periscope',
        'references',
        'vol-signals-mm-heuristics.md',
      ),
      'utf8',
    );
  } catch (err) {
    // References are optional augmentation. Log to Sentry + proceed
    // without; subsequent reads simply skip the references block.
    Sentry.captureException(err, {
      tags: { module: 'periscope-playbook-runner', stage: 'references_load' },
    });
    _periscopeReferencesCache = null;
  }
  return _periscopeReferencesCache;
}

const PERISCOPE_REFERENCES_HEADER = `# Companion reference — VolSignals MM heuristics

Below are distilled heuristics from former-MM commentary (Imran Lakha / VolSignals). Use them as INFORMED-PRIOR for dealer-flow reasoning when relevant to the read in front of you. Each entry has a verification tag — \`[verified]\` (first-principles math), \`[plausible]\` (Imran's framing, internally consistent), \`[era-specific]\` (pre-2024 / low-VIX-regime context, may not apply today), \`[contested]\` (conflicts with other framings — flag explicitly when citing). Quote tags in parentheses when you cite. The skill body in the prior system block remains the source of truth on Periscope mechanics; these heuristics layer on top, they don't override.

---

`;

/**
 * Mitigation 2 of the scale-safety trio documented in the file header.
 *
 * The hard refuse below guarantees this text is only ever emitted
 * alongside `uw_spot` rows, so it can speak in absolutes: raw dollar
 * exposure, NOT the normalized heat-map scale the skill's worked
 * examples are written against.
 *
 * The point is narrow and must stay narrow: kill the model's absolute-
 * magnitude priors, keep everything else. Signs, rankings, relative
 * structure and slice-over-slice deltas all survive the rescale
 * untouched — they are what the read is actually built on.
 */
function buildScalePreamble(source: PeriscopeSnapshotSource | null): string {
  // Derived from the RESOLVED source, never assumed. The source gate above
  // means only `SOURCE_UW_SPOT` reaches here today, but hardcoding the
  // raw-dollar claim would silently contradict `formatHeatMapBlock` —
  // which labels the units correctly for every source — the moment that
  // gate is relaxed.
  // Two opposite scale instructions in one request is exactly the silent
  // corruption this whole layer exists to prevent, so make it structurally
  // impossible instead of relying on the gate staying put.
  if (source !== SOURCE_UW_SPOT) {
    return [
      'UNITS — READ THIS BEFORE INTERPRETING ANY MAGNITUDE.',
      `The magnitudes below come from the \`${source ?? 'unknown'}\` series, NOT the live raw-dollar \`uw_spot\` series this read is normally built on. Their absolute scale is unverified.`,
      'Reason ONLY from sign, relative ranking, profile shape, and the location of sign changes. Do not assert any conclusion that depends on an absolute magnitude, and do not compare these figures against any numeric band in the skill.',
    ].join('\n');
  }
  return SCALE_PREAMBLE_UW_SPOT;
}

const SCALE_PREAMBLE_UW_SPOT = [
  'UNITS — READ THIS BEFORE INTERPRETING ANY MAGNITUDE.',
  'Every gamma and charm figure below is RAW DOLLAR exposure from the live Unusual Whales `uw_spot` series. These are NOT on the normalized heat-map scale that the periscope skill and all of its worked examples are calibrated against — raw-dollar values run roughly THREE ORDERS OF MAGNITUDE larger.',
  'Therefore: IGNORE every absolute-magnitude sanity check, threshold and reference band in the skill. That explicitly includes the "0DTE charm runs ±60K–120K" band and every numeric magnitude quoted in the skill\'s worked examples. A charm cell in the tens of millions here is ORDINARY, not extraordinary; do not call it an outlier, a record, or evidence of anything on magnitude grounds alone.',
  'What DOES survive the rescale, and is what you must reason from: the SIGN of each cell (positive vs negative gamma / charm), the RELATIVE RANKING of strikes against each other, the SHAPE of the per-strike profile, the location of sign changes, and slice-over-slice CHANGE. Judge size only in relative terms — "the largest charm cell on the board", "roughly twice the next strike" — never against a remembered absolute band.',
  'If a conclusion in your read depends on an absolute magnitude threshold you cannot restate in relative terms, drop that conclusion rather than asserting it.',
].join('\n');

/**
 * Inputs from the cron writer. The caller resolves spot, derives mode,
 * and inserts the in_progress row before invoking the runner — the
 * runner consumes those resolved values.
 */
export interface RunPeriscopeAutoPlaybookInput {
  mode: PeriscopeMode;
  parentId: number | null;
  /** YYYY-MM-DD CT — the trading day the read is for. */
  tradingDate: string;
  /** ISO 8601 — TIMESTAMPTZ the row's `read_time` should anchor to. */
  readTimeIso: string;
  /** Authoritative SPX spot looked up at `readTimeIso`. */
  spotAtReadTime: number;
  /**
   * Optional fallback model. Defaults to Sonnet 5 (matches
   * `analyze.ts` Opus → Sonnet pattern).
   */
  fallbackModel?: string;
}

/**
 * Outcome the caller persists via `completePeriscopeAnalysis`. Split
 * fields rather than nested object so the SQL UPDATE is straightforward
 * and matches the existing schema column order.
 */
export interface RunPeriscopeAutoPlaybookOutcome {
  status: 'complete' | 'failed' | 'truncated';
  prose: string;
  structured: PeriscopeStructuredFields;
  parseOk: boolean;
  fullResponse: Record<string, unknown>;
  embedding: number[] | null;
  panelPayload: Record<string, unknown> | null;
  failureReason: string | null;
  modelUsed: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/**
 * Map the parsed structured fields to the panel-payload JSONB the
 * frontend renders. Keeps every panel-rendered field at a stable key
 * regardless of whether Claude provided it (null shows as a placeholder
 * in the UI rather than a missing key throwing TypeScript errors).
 *
 * `source` is mitigation 1 of the scale-safety trio (file header): every
 * stored payload records which `periscope_snapshots` series it was built
 * from, so a row can never be re-read later without its units.
 */
function mapStructuredToPanelPayload(
  structured: PeriscopeStructuredFields,
  prose: string,
  spotAtReadTime: number,
  source: PeriscopeSnapshotSource | null,
): Record<string, unknown> {
  // ALWAYS use the DB-resolved spot for the panel payload. Claude's
  // `structured.spot` echoes the value from its prompt context (often
  // the UW heat-map's own price reading), which on some days drifts
  // 30-50pt from actual SPX cash. The cron writer already queries
  // index_candles_1m for the slot's authoritative SPX close
  // and passes it in as `spotAtReadTime` — that's the value the
  // panel renders and the grader compares against, so it has to be
  // the SPX-cash truth, not Claude's echo.
  return {
    spot: spotAtReadTime,
    source,
    cone:
      structured.cone_lower != null && structured.cone_upper != null
        ? { lower: structured.cone_lower, upper: structured.cone_upper }
        : null,
    longTrigger: structured.long_trigger,
    shortTrigger: structured.short_trigger,
    regime: structured.regime_tag,
    bias: structured.bias,
    recommended: structured.trade_types_recommended,
    avoid: structured.trade_types_avoided,
    futuresPlan: structured.futures_plan,
    gammaFloor: structured.key_levels?.gamma_floor ?? null,
    gammaCeiling: structured.key_levels?.gamma_ceiling ?? null,
    magnet: structured.key_levels?.magnet ?? null,
    charmZero: structured.key_levels?.charm_zero ?? null,
    expectedDealerBehavior: structured.expected_dealer_behavior,
    confidence: structured.confidence,
    confidenceBasis: structured.confidence_basis,
    narrative: prose,
  };
}

/**
 * Build the 4-block cached system prompt used by the auto-playbook call.
 * Mirrors the periscope-chat handler's callModel() block construction —
 * skill, references + lessons, calibration, retrieval — preserving cache
 * stability ordering (most-stable first).
 */
async function buildSystemBlocks(args: {
  mode: PeriscopeMode;
  calibrationBlock: string | null;
  retrievalBlock: string | null;
}): Promise<Anthropic.Messages.TextBlockParam[]> {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: loadPeriscopeSkill(),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];

  const periscopeReferences = loadPeriscopeReferences();
  if (periscopeReferences != null) {
    let lessonsBlock = '';
    try {
      const activeLessons = await fetchActiveLessons(15);
      if (activeLessons.length > 0) {
        lessonsBlock = formatLessonsBlock(activeLessons);
      }
    } catch (err) {
      Sentry.captureException(err, {
        tags: {
          module: 'periscope-playbook-runner',
          stage: 'lessons_fetch',
          mode: args.mode,
        },
      });
      logger.warn(
        { err, mode: args.mode },
        'auto-playbook: lessons fetch failed — continuing without',
      );
    }
    blocks.push({
      type: 'text',
      text: PERISCOPE_REFERENCES_HEADER + periscopeReferences + lessonsBlock,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }

  if (args.calibrationBlock != null) {
    blocks.push({
      type: 'text',
      text: args.calibrationBlock,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }

  if (args.retrievalBlock != null) {
    blocks.push({
      type: 'text',
      text: args.retrievalBlock,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  }

  return blocks;
}

/**
 * Build the spot directive — the authoritative-spot text that anchors
 * Claude's read to the DB-looked-up SPX value rather than the chart's
 * red-dotted line.
 */
function buildSpotDirective(args: {
  tradingDate: string;
  readTimeIso: string;
  spot: number;
  coneLower: number | null;
  coneUpper: number | null;
  charmZeroStrike: number | null;
}): string {
  const lines = [
    `Read time: ${args.tradingDate} (auto-playbook tick at ${args.readTimeIso}).`,
    `Authoritative SPX spot at read time: ${args.spot.toFixed(2)} (source: db_exact).`,
    'Use this as the current spot for all interpretation; do NOT use the chart red dotted spot line.',
  ];
  if (args.coneLower != null && args.coneUpper != null) {
    const width = args.coneUpper - args.coneLower;
    lines.push(
      `Straddle cone bounds (from cone_levels DB, computed at the 9:31 ET ATM-straddle anchor): lower ${args.coneLower.toFixed(2)}, upper ${args.coneUpper.toFixed(2)}, width ${width.toFixed(2)} pts. Use these as the cone in your structured output (cone_lower, cone_upper) and frame inside-cone vs outside-cone targets against them.`,
    );
  }
  if (args.charmZeroStrike != null) {
    lines.push(
      `Charm-zero strike (cumulative charm sum sign-change, computed deterministically from the full per-strike charm grid for this slot): ${args.charmZeroStrike}. Use this for key_levels.charm_zero in your structured output — the heat-map block only carries top-N positive/negative cells and is insufficient to identify the contiguous sign-change.`,
    );
  }
  lines.push(
    'NOTE: this read is auto-triggered on a cron slot. The heat-map block below carries top positive + top negative gamma + charm strikes from periscope_snapshots for the slot. Treat the heat-map values as the per-strike structural map; no chart visual is available.',
  );
  return lines.join(' ');
}

/**
 * Run the auto-playbook Claude call. Pure orchestration — no DB writes,
 * no res.write. Caller persists the outcome via
 * `completePeriscopeAnalysis(rowId, outcome)`.
 */
export async function runPeriscopeAutoPlaybook(
  input: RunPeriscopeAutoPlaybookInput,
): Promise<RunPeriscopeAutoPlaybookOutcome> {
  const startTs = Date.now();
  const {
    mode,
    parentId,
    tradingDate,
    readTimeIso,
    spotAtReadTime,
    fallbackModel = FALLBACK_MODEL_DEFAULT,
  } = input;

  const anthropic = new Anthropic({
    timeout: SDK_TIMEOUT_MS,
    maxRetries: SDK_MAX_RETRIES,
  });

  // Step 1: synthesize Pass 1A + Pass 1B equivalents from the DB.
  // Returns null if the slot has no periscope_snapshots rows — the
  // ingestion hasn't filled it yet (off-hours, gap, fresh day).
  const synth = await synthesizeFromDb({
    tradingDate,
    readTimeIso,
    spot: spotAtReadTime,
  }).catch((err: unknown) => {
    Sentry.captureException(err);
    logger.error(
      { err, tradingDate, readTimeIso },
      'auto-playbook: synthesizeFromDb threw',
    );
    return null;
  });
  if (synth == null) {
    return {
      status: 'failed',
      prose: '',
      structured: emptyStructured(),
      parseOk: false,
      fullResponse: {},
      embedding: null,
      panelPayload: null,
      failureReason: 'no_periscope_snapshots_for_slot',
      modelUsed: null,
      durationMs: Date.now() - startTs,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  }

  // Step 1b: HARD REFUSE on any series other than the live raw-dollar
  // feed. Mitigation 3 of the scale-safety trio (file header).
  //
  // `resolveSnapshotSource` falls back `uw_spot -> uw_eod -> gexbot`
  // silently, and `uw_eod` is both on a ~1000x-smaller normalized scale
  // AND a single 15:00-CT slice per day, which makes its "prior slice"
  // yesterday. A read built on it would come back well-formed,
  // fully-populated and wrong by three orders of magnitude with nothing
  // on the row to flag it. Refusing outright is strictly better than
  // that, so this returns BEFORE a single token of API spend.
  const resolvedSource = synth.source;
  if (resolvedSource !== SOURCE_UW_SPOT) {
    logger.warn(
      { tradingDate, readTimeIso, mode, resolvedSource },
      'auto-playbook: refusing to run — resolved snapshot source is not uw_spot',
    );
    Sentry.captureMessage(
      'periscope auto-playbook refused: snapshot source is not uw_spot',
      {
        level: 'warning',
        tags: {
          module: 'periscope-playbook-runner',
          stage: 'source_gate',
          mode,
          resolvedSource: resolvedSource ?? 'null',
        },
        extra: { tradingDate, readTimeIso },
      },
    );
    return {
      status: 'failed',
      prose: '',
      structured: emptyStructured(),
      parseOk: false,
      fullResponse: { source: resolvedSource },
      embedding: null,
      panelPayload: null,
      failureReason: `source_not_uw_spot: ${resolvedSource ?? 'null'}`,
      modelUsed: null,
      durationMs: Date.now() - startTs,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  }

  // Step 2: parallel fetches for the rest of the prompt context.
  // Each is wrapped in .catch so a transient DB hiccup degrades to
  // "no calibration / parent / retrieval" rather than failing the call.
  const [calibrationBlock, parentRead, parentChain, flowBlock] =
    await Promise.all([
      buildCalibrationBlock(mode).catch((err: unknown) => {
        Sentry.captureException(err);
        logger.warn(
          { err, mode },
          'auto-playbook: calibration fetch failed — continuing without',
        );
        return null;
      }),
      mode !== 'pre_trade' && parentId != null
        ? fetchPeriscopeAnalysisById(parentId).catch((err: unknown) => {
            Sentry.captureException(err);
            logger.warn(
              { err, parentId },
              'auto-playbook: parent fetch failed — treating as missing',
            );
            return null;
          })
        : Promise.resolve(null),
      mode !== 'pre_trade' && parentId != null
        ? fetchParentChain(parentId).catch((err: unknown) => {
            Sentry.captureException(err);
            logger.warn(
              { err, parentId },
              'auto-playbook: parent chain fetch failed — continuing without chain',
            );
            return [];
          })
        : Promise.resolve([]),
      buildFlowContextBlock({
        mode,
        spot: spotAtReadTime,
        asOf: new Date(readTimeIso),
      }).catch((err: unknown) => {
        Sentry.captureException(err);
        logger.warn(
          { err, mode },
          'auto-playbook: flow-context fetch failed — substituting NO_ALERTS sentinel so model declares INSUFFICIENT_DATA rather than fabricating',
        );
        return noAlertsSentinelForMode(mode);
      }),
    ]);

  // Step 3: build user content + spot directive + heat-map block.
  // `source` is threaded into the heat-map block so it can emit its own
  // units line next to the magnitudes it prints — the old runner
  // dropped it here, which is exactly how the scale corruption stayed
  // invisible.
  const heatMapBlock =
    synth.heatMaps != null
      ? formatHeatMapBlock({ ...synth.heatMaps, source: resolvedSource })
      : null;
  // The scale preamble rides on the spot directive, which is always
  // present and always renders as its own leading text block — ahead of
  // the heat-map magnitudes it governs.
  const spotDirective = `${buildSpotDirective({
    tradingDate,
    readTimeIso,
    spot: spotAtReadTime,
    coneLower: synth.extraction.structured.cone_lower,
    coneUpper: synth.extraction.structured.cone_upper,
    charmZeroStrike: synth.charmZeroStrike,
  })}\n\n${buildScalePreamble(resolvedSource)}`;
  const userContent = buildUserContent({
    mode,
    parentId,
    parentRead,
    parentChain,
    heatMapBlock,
    flowBlock,
    spotDirective,
    images: [],
  });

  // Step 4: build retrieval block from the synthesized structural fingerprint.
  const retrievalBlock = await buildRetrievalBlock({
    mode,
    queryText: buildPeriscopeSummary({
      mode,
      tradingDate,
      structured: synth.extraction.structured,
      proseText: '',
    }),
  }).catch((err: unknown) => {
    Sentry.captureException(err);
    logger.warn(
      { err, mode },
      'auto-playbook: retrieval block build failed — continuing without',
    );
    return null;
  });

  // Step 5: assemble system blocks (skill + references + lessons + cal + retr).
  const systemBlocks = await buildSystemBlocks({
    mode,
    calibrationBlock,
    retrievalBlock,
  });

  // Step 6: call Claude with Opus → Sonnet fallback. Streaming is
  // enforced inside runCachedAnthropicCall.
  let result;
  try {
    result = await runCachedAnthropicCall({
      client: anthropic,
      systemBlocks,
      messages: [{ role: 'user', content: userContent }],
      primaryModel: MODEL,
      fallbackModel,
      // 128K (Opus 5's full output ceiling) gives adaptive thinking
      // breathing room without hitting stop_reason='max_tokens' on
      // dense slots. Real observed output ~5-6K tokens, so the
      // ceiling is only billed if Claude needs it. Streaming is
      // enforced inside runCachedAnthropicCall, which is what makes a
      // ceiling this large safe against the SDK's HTTP timeout.
      maxTokens: 128_000,
      // xhigh is Anthropic's recommended effort for agentic work on
      // Opus 5. Sits between 'high' and 'max'. Roughly doubles wall
      // clock vs 'high' (≈120-150s observed) but still fits under the
      // 240s SDK timeout (see SDK_TIMEOUT_MS). Depth is controlled here
      // and ONLY here — `budget_tokens` is removed on Opus 5 /
      // Sonnet 5 and 400s.
      effort: 'xhigh',
      // Drop to 'high' on the Sonnet fallback so the 529-overload retry
      // path runs a cheaper, faster read rather than compounding the
      // latency that caused the fallback.
      fallbackEffort: 'high',
      fallbackMetric: 'periscope_auto_playbook.opus_fallback',
      // Force the structured-output tool. The `input` field on the
      // resulting `tool_use` block is schema-validated JSON, which
      // eliminates the JSON.parse failure mode that occurred when
      // Claude emitted control characters inside fenced ```json blocks
      // (Sentry "Bad control character in string literal in JSON",
      // fixed 2026-05-11 per llm-structured-output skill guidance).
      tools: [STRUCTURED_TOOL],
      // tool_choice='auto' instead of forced — Anthropic doesn't allow
      // adaptive thinking together with tool_choice={type:'tool'} or
      // {type:'any'}. Auto preserves thinking; the system prompt below
      // and the tool's prescriptive description make Claude reliably
      // call the tool. The runner has a legacy text/JSON fallback for
      // the rare case where Claude emits no tool_use block.
      toolChoice: { type: 'auto' },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: {
        module: 'periscope-playbook-runner',
        stage: 'anthropic_call',
        mode,
      },
    });
    logger.error(
      { err, mode, tradingDate },
      'auto-playbook: Anthropic call threw on both primary and fallback',
    );
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      prose: '',
      structured: emptyStructured(),
      parseOk: false,
      fullResponse: { error: message, source: resolvedSource },
      embedding: null,
      panelPayload: null,
      failureReason: `anthropic_call_failed: ${message}`,
      modelUsed: null,
      durationMs: Date.now() - startTs,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
  }

  const durationMs = Date.now() - startTs;
  const fullResponse: Record<string, unknown> = {
    text: result.text,
    // Mitigation 1: which periscope_snapshots series this read was
    // built from, recorded on the row itself so the units are never
    // ambiguous after the fact.
    source: resolvedSource,
    usage: {
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      cache_read_input_tokens: result.usage.cacheRead,
      cache_creation_input_tokens: result.usage.cacheWrite,
    },
    stop_reason: result.stopReason,
    model: result.modelUsed,
  };

  // Step 7: handle terminal stop reasons distinctly so the panel can
  // surface truncation / refusal rather than silently storing a partial
  // payload.
  if (result.stopReason === 'refusal') {
    logger.warn(
      { model: result.modelUsed, mode },
      'auto-playbook: Claude refused request',
    );
    // Sentry-capture so the refusal is visible in observability — the
    // function instance dies after the response, so a logger.warn alone
    // gives no out-of-process signal. Matches the captureMessage call
    // in the max_tokens branch below.
    Sentry.captureMessage('periscope auto-playbook refused by Claude', {
      tags: {
        module: 'periscope-playbook-runner',
        stage: 'refusal',
        mode,
        model: result.modelUsed,
      },
    });
    return {
      status: 'failed',
      prose: '',
      structured: emptyStructured(),
      parseOk: false,
      fullResponse,
      embedding: null,
      panelPayload: null,
      failureReason: 'claude_refusal',
      modelUsed: result.modelUsed,
      durationMs,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
    };
  }

  // Prefer the tool_use channel — `input` is schema-validated by
  // Anthropic, so we skip JSON.parse and its control-character pitfalls
  // entirely. Fall back to the legacy fenced-JSON parser only if the
  // tool_use block is missing (the model dropped the tool call, which
  // shouldn't happen under `tool_choice: { type: 'tool' }` but is
  // worth a safety net).
  const toolBlock = result.toolUseBlocks.find(
    (b) => b.name === STRUCTURED_TOOL_NAME,
  );
  const { prose, structured, parseOk } =
    toolBlock != null
      ? parseStructuredFieldsFromToolInput(toolBlock.input, result.text)
      : parseStructuredFields(result.text);

  if (result.stopReason === 'max_tokens') {
    logger.error(
      {
        model: result.modelUsed,
        mode,
        outputTokens: result.usage.output,
        textLen: result.text.length,
      },
      'auto-playbook: Claude truncated at max_tokens',
    );
    Sentry.captureMessage('periscope auto-playbook truncated at max_tokens', {
      tags: {
        module: 'periscope-playbook-runner',
        stage: 'truncated',
        mode,
        model: result.modelUsed,
      },
    });
    // Best-effort embedding even on truncated output — partial prose is
    // still searchable and downstream retrieval may benefit. Embed what
    // we have rather than null out.
    const embedding = await buildEmbeddingBestEffort({
      mode,
      tradingDate,
      structured,
      proseText: prose,
    });
    return {
      status: 'truncated',
      prose,
      structured,
      parseOk,
      fullResponse,
      embedding,
      panelPayload: parseOk
        ? mapStructuredToPanelPayload(
            structured,
            prose,
            spotAtReadTime,
            resolvedSource,
          )
        : null,
      failureReason: `truncated_at_max_tokens output=${result.usage.output}`,
      modelUsed: result.modelUsed,
      durationMs,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
    };
  }

  // Step 8: success path — embed + map panel_payload.

  // Observability check (Phase 3 of periscope-flow-hallucination-fix-2026-05-16):
  // when the prompt contained the NO_ALERTS sentinel but the model
  // emitted an expected_dealer_behavior that doesn't declare
  // INSUFFICIENT_DATA, log + capture a Sentry message so the
  // hallucination regression surfaces immediately rather than waiting
  // for the next 8-day audit. Non-blocking — the schema-side citation
  // rule already constrains the model; this is a watchdog for drift.
  if (
    flowBlock.includes(NO_ALERTS_SENTINEL) &&
    structured.expected_dealer_behavior != null &&
    !structured.expected_dealer_behavior.includes(
      'FLOW-STRUCTURE: INSUFFICIENT_DATA',
    )
  ) {
    logger.warn(
      {
        mode,
        tradingDate,
        readTimeIso,
        modelUsed: result.modelUsed,
        expectedDealerBehavior: structured.expected_dealer_behavior.slice(
          0,
          200,
        ),
      },
      'periscope auto-playbook: NO_ALERTS sentinel in prompt but expected_dealer_behavior did not declare INSUFFICIENT_DATA — possible flow-citation drift',
    );
    Sentry.captureMessage(
      'periscope: NO_ALERTS sentinel present but model did not declare INSUFFICIENT_DATA',
      {
        level: 'warning',
        tags: {
          module: 'periscope-playbook-runner',
          stage: 'flow_structure_drift_check',
          mode,
          model: result.modelUsed,
        },
        extra: {
          tradingDate,
          readTimeIso,
          expectedDealerBehaviorPreview:
            structured.expected_dealer_behavior.slice(0, 200),
        },
      },
    );
  }

  // Phase 4 symmetric drift check: HIGH confidence MUST be backed by a
  // "FLOW-STRUCTURE: AGREEMENT" cite in expected_dealer_behavior (per
  // the confidence rubric in periscope-prompts.ts). If the model emits
  // confidence='high' without the literal AGREEMENT label — e.g. it
  // paraphrased the format or dropped the prefix — the structural gate
  // silently misses and the calibration leak we just closed re-opens.
  // Non-blocking watchdog, same pattern as the INSUFFICIENT_DATA check.
  if (
    structured.confidence === 'high' &&
    structured.expected_dealer_behavior != null &&
    !structured.expected_dealer_behavior.includes('FLOW-STRUCTURE: AGREEMENT')
  ) {
    logger.warn(
      {
        mode,
        tradingDate,
        readTimeIso,
        modelUsed: result.modelUsed,
        expectedDealerBehavior: structured.expected_dealer_behavior.slice(
          0,
          200,
        ),
      },
      'periscope auto-playbook: confidence=high without FLOW-STRUCTURE: AGREEMENT cite — Phase 4 rubric violation',
    );
    Sentry.captureMessage(
      'periscope: HIGH confidence awarded without FLOW-STRUCTURE: AGREEMENT cite',
      {
        level: 'warning',
        tags: {
          module: 'periscope-playbook-runner',
          stage: 'high_confidence_without_agreement',
          mode,
          model: result.modelUsed,
        },
        extra: {
          tradingDate,
          readTimeIso,
          expectedDealerBehaviorPreview:
            structured.expected_dealer_behavior.slice(0, 200),
        },
      },
    );
  }

  const embedding = await buildEmbeddingBestEffort({
    mode,
    tradingDate,
    structured,
    proseText: prose,
  });

  return {
    status: 'complete',
    prose,
    structured,
    parseOk,
    fullResponse,
    embedding,
    panelPayload: mapStructuredToPanelPayload(
      structured,
      prose,
      spotAtReadTime,
      resolvedSource,
    ),
    failureReason: null,
    modelUsed: result.modelUsed,
    durationMs,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    cacheReadTokens: result.usage.cacheRead,
    cacheWriteTokens: result.usage.cacheWrite,
  };
}

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

async function buildEmbeddingBestEffort(args: {
  mode: PeriscopeMode;
  tradingDate: string;
  structured: PeriscopeStructuredFields;
  proseText: string;
}): Promise<number[] | null> {
  try {
    const summary = buildPeriscopeSummary(args);
    return await generateEmbedding(summary);
  } catch (err) {
    logger.error(
      { err, mode: args.mode },
      'auto-playbook: embedding generation failed',
    );
    Sentry.captureException(err);
    return null;
  }
}
