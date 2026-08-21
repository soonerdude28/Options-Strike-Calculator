/**
 * GET /api/cron/periscope-playbook
 *
 * Phase 3 of docs/superpowers/specs/periscope-playbook-revival-2026-08-21.md.
 *
 * The writer for `periscope_analyses`. Every 10 minutes during RTH it
 * picks a `periscope_snapshots` slot for today, derives the lifecycle
 * mode from that slot's CT label, and drives the Claude auto-playbook
 * runner over it — reviving the playbook panel, chat history, grading,
 * retrieval and lesson curation, all of which read rows nothing has
 * written since `f52db025` retired the Playwright scraper that used to
 * POST `/api/periscope-auto-playbook`.
 *
 * What changed vs. that retired webhook trigger:
 *   - Trigger is `CRON_SECRET` + vercel.json, not a scraper Bearer token
 *     (`PERISCOPE_WEBHOOK_SECRET` / `AUTO_PLAYBOOK_ENABLED` are gone).
 *   - The slot is RESOLVED here (`resolveSnapshotSource` +
 *     `fetchAvailableSlots`) instead of arriving in a POST body, so
 *     there is no stale-scrape class of bug to defend against and the
 *     capture-vs-label agreement checks are unnecessary.
 *   - The runner is AWAITED rather than fired through `waitUntil`: a
 *     cron has no client waiting on a response, and `maxDuration: 780`
 *     covers the full Opus thinking budget.
 *
 * Two-phase persistence (lifted from the retired trigger): INSERT a
 * `status='in_progress'` placeholder BEFORE the Claude call, then
 * `completePeriscopeAnalysis` after. A mid-flight timeout therefore
 * leaves a visible in_progress row rather than nothing at all, and the
 * panel can render "Claude reading slot X" while the call is in flight.
 *
 * Idempotency: the unique index on
 * (trading_date, slot_captured_at, auto_generated) NULLS DISTINCT means
 * at most ONE auto row can exist per slot. We probe for it first, and
 * `savePeriscopeAnalysis`'s ON CONFLICT DO NOTHING closes the race
 * window if two invocations overlap. A slot whose row is `complete`,
 * `truncated`, `in_progress`, or failed for a DETERMINISTIC reason is
 * done forever; a slot whose row failed for a TRANSIENT reason is
 * reclaimed in place for one more attempt (see `isRetryableFailure`).
 *
 * Cost control: every path that cannot produce a trustworthy read
 * returns BEFORE `savePeriscopeAnalysis` so no placeholder row and no
 * API spend is incurred — no slots, non-`uw_spot` source, unanalyzable
 * slot label, missing SPX candle, existing row.
 */

import { getDb, withDbRetry } from '../_lib/db.js';
import { isFuturesRthCt } from '../_lib/cron-helpers.js';
import {
  withCronInstrumentation,
  type CronResult,
} from '../_lib/cron-instrumentation.js';
import { getCTTime, getETDateStr } from '../../src/utils/timezone.js';
import { getMarketCloseHourET } from '../../src/data/marketHours.js';
import { Sentry } from '../_lib/sentry.js';
import logger from '../_lib/logger.js';
import { requireEnv } from '../_lib/env.js';
import {
  ctWallClockToUtcMs,
  fetchSPXSpotAtTimestamp,
} from '../_lib/spx-candles.js';
import {
  fetchAvailableSlots,
  resolveSnapshotSource,
} from '../_lib/periscope-query.js';
import { formatTimeframe, SOURCE_UW_SPOT } from '../_lib/periscope-uw.js';
import {
  savePeriscopeAnalysis,
  completePeriscopeAnalysis,
  type PeriscopeMode,
  type PeriscopeStructuredFields,
  type PeriscopeSpotSource,
} from '../_lib/periscope-db.js';
import { runPeriscopeAutoPlaybook } from '../_lib/periscope-playbook-runner.js';

// 780s = the vercel.json ceiling for this function. The runner's SDK
// timeout plus the final UPDATE fit inside it with slack.
export const config = { maxDuration: 780 };

/** CT minutes-of-day of the first analyzable slot's START (08:20 CT). */
const FIRST_ANALYZABLE_MIN = 8 * 60 + 20;

/** Regular-session equity close hour in ET, used when the calendar is silent. */
const DEFAULT_CLOSE_HOUR_ET = 16;

/**
 * Upper bound (CT minutes) for promoting the day's first analyzable slot
 * to `pre_trade` — see `deriveMode`. 09:00 CT keeps the promotion inside
 * the first half hour of the session; ingestion that only starts at, say,
 * 11:00 after an outage produces `intraday`, not a bogus "pre-trade" read
 * two hours into the day.
 */
const PRE_TRADE_PROMOTION_LATEST_MIN = 9 * 60;

/**
 * Total attempts allowed per slot, including the first. 2 == one retry.
 *
 * The counter lives at `full_response.auto_playbook_attempt` (a free-form
 * JSONB blob — no migration needed) and is threaded through BOTH
 * completion paths so it survives the runner overwriting `full_response`.
 * Without the cap, a slot that fails transiently forever — most
 * dangerously the debrief slot, which stays the newest analyzable slot
 * for the rest of the session — would burn an Opus xhigh call on every
 * remaining tick of the day.
 */
const MAX_SLOT_ATTEMPTS = 2;

/** JSONB key holding the per-slot attempt counter. */
const ATTEMPT_KEY = 'auto_playbook_attempt';

/**
 * `failure_reason` prefixes that describe a TRANSIENT fault — an
 * infrastructure blip that the next tick has a real chance of getting
 * past. Only these earn a retry.
 *
 * Deliberately EXCLUDED, because re-running them is guaranteed-identical
 * spend for a guaranteed-identical result:
 *   - `source_not_uw_spot`  — the resolved series is what it is.
 *   - `claude_refusal`      — the model declined; it will decline again.
 *   - `no_periscope_snapshots_for_slot` — the slot's rows either exist or
 *     they do not; nothing backfills them retroactively.
 *   - `truncated_at_max_tokens` — lands as status `truncated`, not
 *     `failed`, and a rerun would truncate at the same ceiling.
 */
const RETRYABLE_FAILURE_PREFIXES = [
  'anthropic_call_failed',
  'runner_threw',
] as const;

interface ModeDerivation {
  mode: PeriscopeMode;
  /**
   * HH:MM CT — the `read_time` anchor: the slot label's END, CLAMPED to
   * the current CT wall clock so it can never point into the future.
   */
  readTimeCt: string;
}

/**
 * Per-invocation facts every slot decision depends on. Resolved once so
 * mode derivation stays a pure function of (slot label, session, now).
 */
interface SlotContext {
  /**
   * CT minutes-of-day of the START of the day's LAST analyzable slot —
   * the debrief slot. Derived from the session's real close so early-close
   * sessions still get a debrief (see `resolveSlotContext`).
   */
  lastAnalyzableStartMin: number;
  /** CT minutes-of-day right now — the read_time clamp ceiling. */
  nowCtMin: number;
}

/** `HH:MM` for a CT minutes-of-day value. */
function toCtLabel(minuteOfDay: number): string {
  const h = Math.floor(minuteOfDay / 60);
  const m = minuteOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Resolve the session-dependent slot bounds.
 *
 * The debrief slot is the 10-minute slot ENDING at the cash close, not a
 * hardcoded `14:50 - 15:00`. On a 12:00 CT early close (Black Friday,
 * Christmas Eve, July 3) that literal label never exists, so hardcoding
 * it means the day's newest analyzable slot is just another `intraday`
 * read: no debrief row, no lessons candidate, and no grading anchor for
 * the session. `getMarketCloseHourET` is the same holiday/early-close
 * calendar the RTH gate already trusts. ET→CT is a fixed 1-hour offset
 * (both zones share US DST rules), so the conversion is a subtraction.
 */
function resolveSlotContext(tradingDate: string, now: Date): SlotContext {
  const closeHourEt =
    getMarketCloseHourET(tradingDate) ?? DEFAULT_CLOSE_HOUR_ET;
  const closeCtMin = (closeHourEt - 1) * 60;
  const { hour, minute } = getCTTime(now);
  return {
    lastAnalyzableStartMin: closeCtMin - 10,
    nowCtMin: hour * 60 + minute,
  };
}

/**
 * Map a slot timeframe label to the auto-playbook mode. Returns null for
 * pre-market and post-close slots, which the ingestion cron records but
 * which are not analyzable.
 *
 * `isFirstAnalyzableOfDay` promotes the day's opening slot to
 * `pre_trade`. `08:20 - 08:30` is the canonical pre-trade label and it
 * DOES get ingested in normal operation — verified against the seeded
 * uw_spot series, where it is the first label on all 5 sessions. The
 * upstream `gex_strike_0dte` fetch runs 13-21 UTC and its first tick
 * lands ~08:24 CT, which floors into the 08:20 slot; it is not gated at
 * 08:30 CT the way the futures-tied crons are.
 *
 * So the promotion is NOT what makes `pre_trade` fire on a normal day —
 * the literal label already does. It is outage resilience: if the feed
 * comes up late and the day's first analyzable slot is, say,
 * `08:50 - 09:00`, that read is still functionally the pre-trade read,
 * and without the promotion the day would produce only `intraday` +
 * `debrief`, leaving the parent chain rooted at the wrong mode. Bounded
 * at 09:00 CT so a post-outage 11:00 restart cannot mint a bogus
 * "pre-trade" read. The mode VALUES are unchanged — only which slot
 * earns `pre_trade` widens.
 */
function deriveMode(
  slotKey: string,
  isFirstAnalyzableOfDay: boolean,
  ctx: SlotContext,
): ModeDerivation | null {
  const m = /^(\d{2}):(\d{2}) - (\d{2}):(\d{2})$/.exec(slotKey);
  if (!m) return null;
  const startHour = Number.parseInt(m[1] ?? '0', 10);
  const startMinute = Number.parseInt(m[2] ?? '0', 10);
  const endHour = Number.parseInt(m[3] ?? '0', 10);
  const endMinute = Number.parseInt(m[4] ?? '0', 10);
  const startMin = startHour * 60 + startMinute;
  const endMin = endHour * 60 + endMinute;

  if (startMin < FIRST_ANALYZABLE_MIN) return null;
  if (startMin > ctx.lastAnalyzableStartMin) return null;

  // Anchor read_time at the END of the timeframe label, not the START.
  // Snapshots are captured within the slot and published for it, so the
  // END is the moment the read is actually "for". Critical for the
  // pre-trade slot: 08:20 CT falls in pre-market and
  // `fetchSPXSpotAtTimestamp` filters to regular-hours candles only,
  // while 08:30 CT lands exactly on the first regular-hours candle.
  //
  // But CLAMP it to now. `populate-periscope-from-uw` stamps
  // `captured_at = MAX(gex_strike_0dte.timestamp)` — a raw 1-minute
  // tick. When that tick's minute is exactly divisible by 10 the derived
  // label is `[M, M+10)` and its END is TEN MINUTES IN THE FUTURE.
  // `fetchSPXSpotAtTimestamp` would then search a ±5 min window lying
  // entirely in the future, find nothing, and the whole tick would be
  // skipped. Rare (~0.3% of 10-min boundaries against live data) but it
  // does NOT self-heal for a non-debrief slot, because the next tick's
  // newest slot is a different one. read_time means "the moment the read
  // is FOR", and a read cannot be for a moment that has not happened, so
  // min(slotEnd, now) is both the fix and the honest value. Anchoring on
  // `captured_at` instead was rejected: it re-breaks the pre-market
  // pre-trade slot the END anchor exists to fix.
  const readTimeCt = toCtLabel(Math.min(endMin, ctx.nowCtMin));

  if (startMin === ctx.lastAnalyzableStartMin)
    return { mode: 'debrief', readTimeCt };
  if (startMin === FIRST_ANALYZABLE_MIN)
    return { mode: 'pre_trade', readTimeCt };
  if (isFirstAnalyzableOfDay && startMin <= PRE_TRADE_PROMOTION_LATEST_MIN)
    return { mode: 'pre_trade', readTimeCt };
  return { mode: 'intraday', readTimeCt };
}

/** All-null structured payload for the in_progress placeholder row. */
function placeholderStructured(): PeriscopeStructuredFields {
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

/** Coerce a Postgres id column to a finite number, or null. */
function toRowId(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The existing auto row for a slot, as far as retry eligibility cares. */
interface SlotRowState {
  id: number;
  status: string | null;
  failureReason: string | null;
  /** 1-based; a row written before the counter existed reads as 1. */
  attempt: number;
}

/** Parse the JSONB attempt counter, defaulting to the first attempt. */
function parseAttempt(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * Existing auto row for this (trading date, slot) — the idempotency probe.
 * Returns the row's lifecycle state, not just its id, so the caller can
 * tell a permanent outcome from a retryable one.
 */
async function findExistingRow(
  tradingDate: string,
  slotCapturedAt: string,
): Promise<SlotRowState | null> {
  const sql = getDb();
  const rows = (await withDbRetry(
    () => sql`
      SELECT id, status, failure_reason,
             -- ::text is load-bearing: an untyped bind parameter leaves
             -- ->> ambiguous between its jsonb/text and jsonb/int forms
             -- and Postgres errors with "operator is not unique".
             full_response->>${ATTEMPT_KEY}::text AS attempt
      FROM periscope_analyses
      WHERE trading_date = ${tradingDate}
        AND slot_captured_at = ${slotCapturedAt}
        AND auto_generated = TRUE
      LIMIT 1
    `,
    2,
    10_000,
  )) as Array<{
    id: unknown;
    status?: unknown;
    failure_reason?: unknown;
    attempt?: unknown;
  }>;
  const row = rows[0];
  if (row == null) return null;
  const id = toRowId(row.id);
  if (id == null) return null;
  return {
    id,
    status: row.status == null ? null : String(row.status),
    failureReason:
      row.failure_reason == null ? null : String(row.failure_reason),
    attempt: parseAttempt(row.attempt),
  };
}

/**
 * True when a slot's existing row represents a TRANSIENT failure worth
 * one more Claude call.
 *
 * `in_progress` deliberately does NOT qualify: `maxDuration` is 780s and
 * the cadence is 600s, so a genuinely in-flight run can still hold the
 * row when the next tick fires, and reclaiming it would double-spend.
 */
function isRetryableFailure(row: SlotRowState): boolean {
  if (row.status !== 'failed') return false;
  const reason = row.failureReason;
  if (reason == null) return false;
  return RETRYABLE_FAILURE_PREFIXES.some((p) => reason.startsWith(p));
}

interface ReclaimArgs {
  rowId: number;
  readTimeIso: string;
  spotPrice: number;
  spotSource: PeriscopeSpotSource;
  mode: PeriscopeMode;
  parentId: number | null;
  attempt: number;
}

/**
 * Reset a transiently-failed row back to `in_progress` for another
 * attempt. The unique index means we cannot insert a second row for the
 * slot, so the retry reuses the row in place.
 *
 * `WHERE ... AND status = 'failed'` makes the reclaim an atomic claim:
 * if an overlapping invocation got there first the UPDATE touches zero
 * rows and we back off instead of racing it into a double Claude call.
 */
async function reclaimRowForRetry(args: ReclaimArgs): Promise<boolean> {
  const sql = getDb();
  const fullResponse = JSON.stringify({
    auto_playbook: 'in_progress',
    [ATTEMPT_KEY]: args.attempt,
  });
  const rows = (await withDbRetry(
    () => sql`
      UPDATE periscope_analyses
      SET status = 'in_progress',
          captured_at = ${new Date().toISOString()},
          read_time = ${args.readTimeIso},
          spot_at_read_time = ${args.spotPrice},
          spot_source = ${args.spotSource},
          mode = ${args.mode},
          parent_id = ${args.parentId},
          prose_text = '',
          full_response = ${fullResponse}::jsonb,
          panel_payload = NULL,
          failure_reason = NULL,
          parse_ok = FALSE,
          model = 'pending',
          input_tokens = NULL,
          output_tokens = NULL,
          cache_read_tokens = NULL,
          cache_write_tokens = NULL,
          duration_ms = 0
      WHERE id = ${args.rowId}
        AND status = 'failed'
      RETURNING id
    `,
    2,
    10_000,
  )) as Array<{ id: unknown }>;
  return rows.length > 0;
}

/**
 * Latest complete non-debrief auto row EARLIER THAN this slot — the
 * parent link the runner walks to build the read chain. A failure here
 * degrades to "no parent" rather than sinking the run.
 *
 * The `slot_captured_at <` bound matters because slots are no longer
 * processed in strict chronological order: backfilling the day's first
 * slot after later reads exist must not hang the day's `pre_trade` root
 * off an `intraday` child and invert the chain.
 */
async function resolveParentId(
  tradingDate: string,
  slotCapturedAt: string,
): Promise<number | null> {
  const sql = getDb();
  try {
    const rows = (await withDbRetry(
      () => sql`
        SELECT id FROM periscope_analyses
        WHERE trading_date = ${tradingDate}
          AND auto_generated = TRUE
          AND mode != 'debrief'
          AND status = 'complete'
          AND slot_captured_at < ${slotCapturedAt}
        ORDER BY slot_captured_at DESC
        LIMIT 1
      `,
      2,
      10_000,
    )) as Array<{ id: unknown }>;
    return toRowId(rows[0]?.id);
  } catch (err) {
    Sentry.captureException(err);
    logger.warn(
      { err, tradingDate },
      'periscope-playbook: parent resolution failed — proceeding without parent',
    );
    return null;
  }
}

interface ResolvedSlot {
  capturedAt: string;
  slotKey: string;
  mode: PeriscopeMode;
  readTimeCt: string;
}

/**
 * Every analyzable slot of the day, oldest first. Ingestion keeps writing
 * past the close (its RTH gate runs to 15:55 CT), so the raw slot list
 * runs past the debrief slot and "newest" alone would step over it.
 */
function analyzableSlots(slots: string[], ctx: SlotContext): ResolvedSlot[] {
  const labelled = slots.map((capturedAt) => ({
    capturedAt,
    slotKey: formatTimeframe(new Date(capturedAt)),
  }));
  const firstAnalyzableIdx = labelled.findIndex(
    (s) => deriveMode(s.slotKey, false, ctx) != null,
  );
  if (firstAnalyzableIdx === -1) return [];

  const out: ResolvedSlot[] = [];
  for (let i = firstAnalyzableIdx; i < labelled.length; i += 1) {
    const cand = labelled[i]!;
    const md = deriveMode(cand.slotKey, i === firstAnalyzableIdx, ctx);
    if (md == null) continue;
    out.push({
      capturedAt: cand.capturedAt,
      slotKey: cand.slotKey,
      mode: md.mode,
      readTimeCt: md.readTimeCt,
    });
  }
  return out;
}

/**
 * Which slots this tick is willing to work on, in priority order.
 *
 * 1. The day's FIRST analyzable slot. `deriveMode` only ever mints
 *    `pre_trade` for that slot, so if the tick that should have written
 *    it was lost — and the 08:30 CT tick loses often, because
 *    `fetch-spx-candles-1m` writes the 08:30 bar roughly a minute after
 *    this cron fires — nothing else in the day can produce one. Without
 *    the backfill the chain roots at `intraday` with `parentId = null`,
 *    the intraday body's "reconcile against the parent chain" has no
 *    chain, and the debrief grades against a mid-morning read instead of
 *    the day's open. It is bounded (exactly one extra slot, checked with
 *    one indexed probe) and idempotent (a completed row disqualifies it,
 *    so it costs one SELECT for the rest of the session).
 * 2. The NEWEST analyzable slot — the live read, and the only candidate
 *    once the pre-trade root exists.
 *
 * Mid-day `intraday` slots are deliberately NOT backfilled: a 10:00 read
 * produced at 14:00 has no trading value and would pollute the chain.
 */
function prioritizeSlots(all: ResolvedSlot[]): ResolvedSlot[] {
  const first = all[0];
  const newest = all.at(-1);
  if (first == null || newest == null) return [];
  return first.capturedAt === newest.capturedAt ? [first] : [first, newest];
}

export default withCronInstrumentation(
  'periscope-playbook',
  async (): Promise<CronResult> => {
    // Fail fast and loudly on misconfiguration. Both keys are
    // `.optional()` in the env schema (the app runs fine without them),
    // so without this check a missing key surfaces as an opaque failure
    // deep inside the Anthropic / OpenAI client AFTER the placeholder
    // row and part of the prompt spend.
    requireEnv('ANTHROPIC_API_KEY');
    requireEnv('OPENAI_API_KEY');

    const tradingDate = getETDateStr(new Date());

    const source = await resolveSnapshotSource(tradingDate);
    // Mitigation 3 of the scale-safety trio, applied one layer earlier
    // than the runner's own gate: `uw_eod` is a normalized, ~1000x
    // smaller, one-slice-per-day series, and `gexbot` is dead. Bailing
    // here avoids writing a placeholder row we know the runner will
    // refuse. The runner keeps its own refusal for the race where the
    // series changes underneath us.
    if (source !== SOURCE_UW_SPOT) {
      const message =
        source == null
          ? `no periscope_snapshots for ${tradingDate}`
          : `resolved snapshot source is ${source}, not ${SOURCE_UW_SPOT}`;
      logger.info({ tradingDate, source }, `periscope-playbook: ${message}`);
      return {
        status: 'skipped',
        rows: 0,
        message,
        metadata: { tradingDate, source },
      };
    }

    const ctx = resolveSlotContext(tradingDate, new Date());
    const slots = await fetchAvailableSlots(tradingDate, source);
    const candidates = analyzableSlots(slots, ctx);
    if (candidates.length === 0) {
      const message = `no analyzable slot among ${slots.length} slot(s) for ${tradingDate}`;
      logger.info(
        { tradingDate, slots: slots.length },
        `periscope-playbook: ${message}`,
      );
      return {
        status: 'skipped',
        rows: 0,
        message,
        metadata: { tradingDate, source, slots: slots.length },
      };
    }

    // Idempotency probe, per candidate. A slot that already owns a
    // finished row must cost nothing — no spot lookup, no insert, no
    // Claude call.
    let slot: ResolvedSlot | null = null;
    let retryRow: SlotRowState | null = null;
    let blocked: { slot: ResolvedSlot; row: SlotRowState } | null = null;
    for (const cand of prioritizeSlots(candidates)) {
      const row = await findExistingRow(tradingDate, cand.capturedAt);
      if (row == null) {
        slot = cand;
        break;
      }
      if (isRetryableFailure(row) && row.attempt < MAX_SLOT_ATTEMPTS) {
        slot = cand;
        retryRow = row;
        break;
      }
      blocked = { slot: cand, row };
    }

    if (slot == null) {
      const existingRowId = blocked?.row.id ?? null;
      const message = `slot ${blocked?.slot.slotKey ?? '?'} already analyzed (row ${existingRowId})`;
      logger.info(
        { tradingDate, slotKey: blocked?.slot.slotKey, existingRowId },
        `periscope-playbook: ${message}`,
      );
      return {
        status: 'skipped',
        rows: 0,
        message,
        metadata: {
          tradingDate,
          source,
          slotKey: blocked?.slot.slotKey,
          mode: blocked?.slot.mode,
          existingRowId,
          existingStatus: blocked?.row.status,
          existingFailureReason: blocked?.row.failureReason,
        },
      };
    }

    const attempt = retryRow == null ? 1 : retryRow.attempt + 1;

    // The DB spot is authoritative — the runner deliberately overwrites
    // Claude's echoed spot with it in the panel payload. 5-min tolerance
    // because this cron races `fetch-spx-candles-1m` for the slot's bar.
    const spot = await fetchSPXSpotAtTimestamp({
      date: tradingDate,
      time: slot.readTimeCt,
      toleranceMin: 5,
      isLiveRead: false,
    }).catch((err: unknown) => {
      Sentry.captureException(err);
      logger.error(
        { err, tradingDate, readTimeCt: slot?.readTimeCt },
        'periscope-playbook: spot lookup threw',
      );
      return null;
    });
    if (spot == null) {
      // The candle has not landed yet. `read_time` is clamped to now, so
      // this is no longer the "the whole ±5 min window is in the future"
      // failure — it means the 1-minute candle feed itself is behind.
      // Self-healing is NOT automatic: only the day's first slot and the
      // debrief slot stay candidates on later ticks. A mid-day intraday
      // slot missed here is simply not read.
      const message = `no SPX candle for ${tradingDate} ${slot.readTimeCt} CT within +/-5 min`;
      logger.warn(
        { tradingDate, readTimeCt: slot.readTimeCt, slotKey: slot.slotKey },
        `periscope-playbook: ${message}`,
      );
      return {
        status: 'skipped',
        rows: 0,
        message,
        metadata: {
          tradingDate,
          source,
          slotKey: slot.slotKey,
          mode: slot.mode,
        },
      };
    }

    const utcMs = ctWallClockToUtcMs(tradingDate, slot.readTimeCt);
    if (utcMs == null) {
      throw new Error(
        `periscope-playbook: could not resolve read_time for ${tradingDate} ${slot.readTimeCt}`,
      );
    }
    const readTimeIso = new Date(utcMs).toISOString();

    const parentId = await resolveParentId(tradingDate, slot.capturedAt);

    // Phase 1 of the two-phase write. NOT NULL columns get placeholders
    // the completion UPDATE overwrites. On a retry the row already
    // exists (the unique index forbids a second one), so it is reclaimed
    // in place instead.
    let rowId: number | null;
    if (retryRow != null) {
      const claimed = await reclaimRowForRetry({
        rowId: retryRow.id,
        readTimeIso,
        spotPrice: spot.price,
        spotSource: spot.source,
        mode: slot.mode,
        parentId,
        attempt,
      });
      if (!claimed) {
        logger.warn(
          { tradingDate, slotKey: slot.slotKey, rowId: retryRow.id },
          'periscope-playbook: retry claim lost — another invocation owns the row',
        );
        return {
          status: 'skipped',
          rows: 0,
          message: `retry claim lost for slot ${slot.slotKey} (row ${retryRow.id})`,
          metadata: {
            tradingDate,
            source,
            slotKey: slot.slotKey,
            mode: slot.mode,
            existingRowId: retryRow.id,
            raceLoser: true,
          },
        };
      }
      rowId = retryRow.id;
    } else {
      rowId = await savePeriscopeAnalysis({
        capturedAt: new Date().toISOString(),
        tradingDate,
        readTime: readTimeIso,
        spotAtReadTime: spot.price,
        spotSource: spot.source,
        mode: slot.mode,
        parentId,
        userContext: null,
        imageUrls: {},
        proseText: '',
        fullResponse: { auto_playbook: 'in_progress', [ATTEMPT_KEY]: attempt },
        embedding: null,
        structured: placeholderStructured(),
        parseOk: false,
        model: 'pending',
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        durationMs: 0,
        autoGenerated: true,
        slotCapturedAt: slot.capturedAt,
        status: 'in_progress',
        failureReason: null,
        panelPayload: null,
      });
    }

    if (rowId == null) {
      // ON CONFLICT DO NOTHING fired and the re-SELECT came back empty,
      // or an overlapping invocation beat us here. Re-probe: if there IS
      // a winner this is an ordinary idempotent no-op; otherwise the
      // insert genuinely failed and should page.
      const winner = await findExistingRow(tradingDate, slot.capturedAt);
      if (winner != null) {
        logger.warn(
          { tradingDate, slotKey: slot.slotKey, winnerId: winner.id },
          'periscope-playbook: unique-index race resolved — deferring to winner',
        );
        return {
          status: 'skipped',
          rows: 0,
          message: `unique-index race — row ${winner.id} already owns slot ${slot.slotKey}`,
          metadata: {
            tradingDate,
            source,
            slotKey: slot.slotKey,
            mode: slot.mode,
            existingRowId: winner.id,
            raceLoser: true,
          },
        };
      }
      throw new Error(
        `periscope-playbook: failed to insert in_progress row for ${tradingDate} ${slot.slotKey}`,
      );
    }

    Sentry.setTag('periscope_playbook.mode', slot.mode);
    Sentry.setTag('periscope_playbook.row_id', String(rowId));
    logger.info(
      {
        rowId,
        tradingDate,
        slotKey: slot.slotKey,
        slotCapturedAt: slot.capturedAt,
        mode: slot.mode,
        parentId,
        spot: spot.price,
        attempt,
      },
      'periscope-playbook: in_progress row inserted, invoking runner',
    );

    // Phase 2. The runner owns the Claude call; it never throws for
    // expected conditions (it returns status:'failed' with a
    // failure_reason instead), so a throw here is a genuine fault.
    let outcome;
    try {
      outcome = await runPeriscopeAutoPlaybook({
        mode: slot.mode,
        parentId,
        tradingDate,
        readTimeIso,
        spotAtReadTime: spot.price,
      });
    } catch (err) {
      // Close the row out rather than leaving an orphaned in_progress
      // placeholder that the panel would render as "Claude thinking…"
      // forever. `runner_threw` is retryable, so the attempt counter has
      // to survive onto the failed row or the cap could never bind.
      const reason = `runner_threw: ${err instanceof Error ? err.message : String(err)}`;
      await completePeriscopeAnalysis(rowId, {
        status: 'failed',
        proseText: '',
        fullResponse: { error: reason, [ATTEMPT_KEY]: attempt },
        embedding: null,
        structured: placeholderStructured(),
        parseOk: false,
        panelPayload: null,
        failureReason: reason,
        model: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        durationMs: 0,
      }).catch((persistErr: unknown) => {
        Sentry.captureException(persistErr);
        return false;
      });
      Sentry.captureException(err, {
        tags: {
          module: 'periscope-playbook',
          stage: 'runner',
          mode: slot.mode,
          row_id: String(rowId),
        },
      });
      logger.error(
        { err, rowId, mode: slot.mode, attempt },
        'periscope-playbook: runner threw — row marked failed',
      );
      return {
        status: 'error',
        rows: 0,
        message: reason,
        metadata: {
          tradingDate,
          source,
          slotKey: slot.slotKey,
          mode: slot.mode,
          rowId,
          attempt,
        },
      };
    }

    const persisted = await completePeriscopeAnalysis(rowId, {
      status: outcome.status,
      proseText: outcome.prose,
      // Merge the attempt counter INTO the runner's payload: the runner
      // owns `full_response`, and losing the counter here would let a
      // repeatedly-failing slot retry without bound.
      fullResponse: { ...outcome.fullResponse, [ATTEMPT_KEY]: attempt },
      embedding: outcome.embedding,
      structured: outcome.structured,
      parseOk: outcome.parseOk,
      panelPayload: outcome.panelPayload,
      failureReason: outcome.failureReason,
      model: outcome.modelUsed,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheReadTokens: outcome.cacheReadTokens,
      cacheWriteTokens: outcome.cacheWriteTokens,
      durationMs: outcome.durationMs,
    });

    // The runner's `source_not_uw_spot` refusal is a NORMAL, expected
    // result — it fires on any day the live series has no rows for the
    // slot yet, and it costs zero Anthropic tokens by design. Report and
    // count it; do NOT alert on it as if it were a fault.
    const refused = outcome.failureReason?.startsWith('source_not_uw_spot');

    const metadata = {
      tradingDate,
      source,
      slotKey: slot.slotKey,
      slotCapturedAt: slot.capturedAt,
      mode: slot.mode,
      rowId,
      parentId,
      attempt,
      persisted,
      outcomeStatus: outcome.status,
      failureReason: outcome.failureReason,
      refused: refused === true,
      modelUsed: outcome.modelUsed,
      parseOk: outcome.parseOk,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      cacheReadTokens: outcome.cacheReadTokens,
      cacheWriteTokens: outcome.cacheWriteTokens,
      runnerDurationMs: outcome.durationMs,
    };

    logger.info(metadata, 'periscope-playbook: runner completed');

    if (refused === true) {
      return {
        status: 'partial',
        rows: 1,
        message: outcome.failureReason ?? 'refused',
        metadata,
      };
    }

    return {
      status: outcome.status === 'complete' ? 'success' : 'partial',
      rows: 1,
      message: outcome.failureReason ?? undefined,
      metadata,
    };
  },
  // Same futures-tied RTH gate (08:30–15:55 CT) as
  // populate-periscope-from-uw — outside it there is no fresh slot to
  // read and every tick would just burn a no-op.
  { requireApiKey: false, timeCheck: isFuturesRthCt },
);
