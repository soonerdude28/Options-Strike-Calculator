// @vitest-environment node

/**
 * Unit tests for api/_lib/periscope-playbook-runner.ts.
 *
 * Strategy: mock every collaborator (DB fetchers, prompt builders, the
 * Anthropic-call wrapper, embeddings, fs) so the orchestration logic in
 * `runPeriscopeAutoPlaybook` is exercised in isolation. The Anthropic
 * SDK constructor is mocked too — not to stub behaviour (the runner
 * only builds the client and hands it to the mocked
 * `runCachedAnthropicCall`) but so the wall-clock budget it is
 * constructed with can be asserted; see the
 * `describe('Anthropic wall-clock budget', ...)` block. No test in this
 * file may reach the real Anthropic API or the database.
 *
 * Module-init concerns: the runner reads SKILL.md (mandatory) and the
 * references file (optional) at import time. We hoist `vi.mock('node:fs')`
 * so both reads return canned bytes regardless of the host filesystem.
 *
 * The `describe('scale safety', ...)` block at the bottom covers the
 * three mandatory mitigations from
 * docs/superpowers/specs/periscope-playbook-revival-2026-08-21.md:
 * source stamping, the raw-dollar scale preamble, and the hard refuse
 * on any series other than `uw_spot`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    readFileSync: vi.fn((path: string) => {
      if (path.endsWith('SKILL.md')) return '# Periscope skill body';
      if (path.endsWith('vol-signals-mm-heuristics.md'))
        return '# vol signals body';
      // Passed through, not stubbed: the wall-clock-budget block at the
      // bottom reads the REAL vercel.json so the SDK timeout and the
      // function's maxDuration cannot drift apart (they already had
      // once — the constant's comment claimed a 720s ceiling against a
      // vercel.json that says 780).
      if (path.endsWith('vercel.json'))
        return actual.readFileSync(path, 'utf8');
      throw new Error(`unexpected readFileSync path: ${path}`);
    }),
  };
});

// The runner's only use of the SDK is `new Anthropic({ timeout,
// maxRetries })`; the resulting client is handed straight to the mocked
// `runCachedAnthropicCall`. Mocking the constructor captures those two
// numbers, which is what the wall-clock-budget invariant is asserted on.
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}));

vi.mock('../_lib/sentry.js', () => ({
  Sentry: {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  },
}));

vi.mock('../_lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../_lib/anthropic-call.js', () => ({
  runCachedAnthropicCall: vi.fn(),
}));

vi.mock('../_lib/periscope-synthesize.js', () => ({
  synthesizeFromDb: vi.fn(),
}));

vi.mock('../_lib/periscope-prompts.js', () => ({
  buildUserContent: vi.fn(() => [{ type: 'text', text: 'user content' }]),
  formatHeatMapBlock: vi.fn(() => 'heat-map block'),
  parseStructuredFields: vi.fn(),
  parseStructuredFieldsFromToolInput: vi.fn(),
  STRUCTURED_TOOL: { name: 'emit_playbook_structured', input_schema: {} },
  STRUCTURED_TOOL_NAME: 'emit_playbook_structured',
}));

vi.mock('../_lib/periscope-calibration.js', () => ({
  buildCalibrationBlock: vi.fn(),
}));

vi.mock('../_lib/periscope-retrieval.js', () => ({
  buildRetrievalBlock: vi.fn(),
}));

vi.mock('../_lib/periscope-lessons.js', () => ({
  fetchActiveLessons: vi.fn(),
  formatLessonsBlock: vi.fn(),
}));

vi.mock('../_lib/periscope-flow-context.js', () => ({
  buildFlowContextBlock: vi.fn(),
  noAlertsSentinelForMode: vi.fn((mode: string) => `__sentinel_${mode}__`),
  NO_ALERTS_SENTINEL: 'NO_ALERTS_IN_WINDOW',
}));

vi.mock('../_lib/embeddings.js', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../_lib/periscope-db.js', () => ({
  buildPeriscopeSummary: vi.fn(() => 'summary text'),
  fetchParentChain: vi.fn(),
  fetchPeriscopeAnalysisById: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { runPeriscopeAutoPlaybook } from '../_lib/periscope-playbook-runner.js';
import { runCachedAnthropicCall } from '../_lib/anthropic-call.js';
import { synthesizeFromDb } from '../_lib/periscope-synthesize.js';
import {
  buildUserContent,
  formatHeatMapBlock,
  parseStructuredFieldsFromToolInput,
} from '../_lib/periscope-prompts.js';
import { buildCalibrationBlock } from '../_lib/periscope-calibration.js';
import { buildRetrievalBlock } from '../_lib/periscope-retrieval.js';
import {
  fetchActiveLessons,
  formatLessonsBlock,
} from '../_lib/periscope-lessons.js';
import { buildFlowContextBlock } from '../_lib/periscope-flow-context.js';
import { generateEmbedding } from '../_lib/embeddings.js';
import {
  fetchParentChain,
  fetchPeriscopeAnalysisById,
  type PeriscopeStructuredFields,
} from '../_lib/periscope-db.js';
import { Sentry } from '../_lib/sentry.js';

const baseInput = {
  mode: 'intraday' as const,
  parentId: 42,
  tradingDate: '2026-05-08',
  readTimeIso: '2026-05-08T18:30:00Z',
  spotAtReadTime: 5912.34,
};

const structuredFixture: PeriscopeStructuredFields = {
  spot: 5912.34,
  cone_lower: 5880,
  cone_upper: 5945,
  long_trigger: 5920,
  short_trigger: 5900,
  regime_tag: 'pinning',
  bias: 'two-sided',
  trade_types_recommended: ['IC'],
  trade_types_avoided: ['naked-call'],
  key_levels: {
    gamma_floor: 5895,
    gamma_ceiling: 5925,
    magnet: 5910,
    charm_zero: 5905,
  },
  expected_dealer_behavior: 'suppressive',
  confidence: 'medium',
  confidence_basis: 'cone width small, OI clustered',
  futures_plan: null,
};

const synthFixture = {
  // `source` is load-bearing: anything other than 'uw_spot' trips the
  // hard refuse before Anthropic is ever called.
  source: 'uw_spot' as const,
  heatMaps: { gex: [], charm: [] } as Record<string, unknown>,
  charmZeroStrike: 5905,
  extraction: {
    structured: {
      ...structuredFixture,
      cone_lower: 5880,
      cone_upper: 5945,
    },
  },
};

const okAnthropic = {
  text: 'narrative prose',
  toolUseBlocks: [
    { name: 'emit_playbook_structured', input: structuredFixture },
  ],
  usage: { input: 1000, output: 250, cacheRead: 800, cacheWrite: 200 },
  modelUsed: 'claude-opus-5',
  cacheHit: true,
  stopReason: 'end_turn',
};

beforeEach(() => {
  vi.clearAllMocks();

  // Defaults — happy path. Tests override per-case.
  vi.mocked(synthesizeFromDb).mockResolvedValue(
    synthFixture as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>,
  );
  vi.mocked(buildCalibrationBlock).mockResolvedValue('cal block');
  vi.mocked(buildRetrievalBlock).mockResolvedValue('retr block');
  vi.mocked(fetchActiveLessons).mockResolvedValue([]);
  vi.mocked(formatLessonsBlock).mockReturnValue('');
  vi.mocked(buildFlowContextBlock).mockResolvedValue('flow block');
  vi.mocked(fetchPeriscopeAnalysisById).mockResolvedValue(null);
  vi.mocked(fetchParentChain).mockResolvedValue([]);
  vi.mocked(generateEmbedding).mockResolvedValue([0.1, 0.2, 0.3]);
  vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
    prose: 'narrative prose',
    structured: structuredFixture,
    parseOk: true,
  });
  vi.mocked(runCachedAnthropicCall).mockResolvedValue(okAnthropic);
});

describe('runPeriscopeAutoPlaybook', () => {
  it('happy path: returns complete with prose, structured, embedding, panelPayload', async () => {
    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(out.prose).toBe('narrative prose');
    expect(out.structured.spot).toBe(5912.34);
    expect(out.parseOk).toBe(true);
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(out.panelPayload).not.toBeNull();
    expect(out.panelPayload).toMatchObject({
      spot: 5912.34,
      source: 'uw_spot',
      cone: { lower: 5880, upper: 5945 },
      gammaFloor: 5895,
      gammaCeiling: 5925,
      charmZero: 5905,
      narrative: 'narrative prose',
    });
    expect(out.modelUsed).toBe('claude-opus-5');
    expect(out.inputTokens).toBe(1000);
    expect(out.cacheReadTokens).toBe(800);
  });

  it('panel_payload.spot uses DB-resolved spotAtReadTime, NOT Claude-echoed structured.spot', async () => {
    // Override structured.spot so it disagrees with spotAtReadTime.
    // The 2026-05-06/07 grading run found that Claude's structured
    // output sometimes drifts 30-50pt from actual SPX cash. The panel
    // payload must reflect the DB truth, not Claude's echo.
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: { ...structuredFixture, spot: 9999.99 }, // garbage
      parseOk: true,
    });
    const out = await runPeriscopeAutoPlaybook({
      ...baseInput,
      spotAtReadTime: 5912.34,
    });
    expect(out.panelPayload).not.toBeNull();
    expect(out.panelPayload?.spot).toBe(5912.34);
    expect(out.structured.spot).toBe(9999.99); // raw structured untouched
    expect(out.failureReason).toBeNull();
  });

  it('returns failed with no_periscope_snapshots_for_slot when synth returns null', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue(null);

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('no_periscope_snapshots_for_slot');
    expect(out.prose).toBe('');
    expect(out.embedding).toBeNull();
    expect(out.panelPayload).toBeNull();
    expect(out.modelUsed).toBeNull();
    // Anthropic must never be called when synth is empty.
    expect(runCachedAnthropicCall).not.toHaveBeenCalled();
  });

  it('synth throw is caught, Sentry captured, returns failed', async () => {
    vi.mocked(synthesizeFromDb).mockRejectedValue(new Error('db down'));

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('no_periscope_snapshots_for_slot');
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('Anthropic call throw returns failed with anthropic_call_failed and error message', async () => {
    vi.mocked(runCachedAnthropicCall).mockRejectedValue(
      new Error('Overloaded after fallback'),
    );

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toMatch(/anthropic_call_failed/);
    expect(out.failureReason).toMatch(/Overloaded after fallback/);
    expect(out.fullResponse).toEqual({
      error: 'Overloaded after fallback',
      source: 'uw_spot',
    });
    expect(out.embedding).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('stop_reason refusal returns failed with claude_refusal and captureMessage', async () => {
    vi.mocked(runCachedAnthropicCall).mockResolvedValue({
      ...okAnthropic,
      stopReason: 'refusal',
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('claude_refusal');
    expect(out.prose).toBe('');
    expect(out.embedding).toBeNull();
    expect(out.panelPayload).toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'periscope auto-playbook refused by Claude',
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'refusal' }),
      }),
    );
  });

  it('stop_reason max_tokens returns truncated with best-effort embedding', async () => {
    vi.mocked(runCachedAnthropicCall).mockResolvedValue({
      ...okAnthropic,
      stopReason: 'max_tokens',
      text: 'partial prose...',
    });
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'partial prose...',
      structured: structuredFixture,
      parseOk: true,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('truncated');
    expect(out.failureReason).toMatch(/truncated_at_max_tokens/);
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    // panelPayload populated when parseOk on truncated output.
    expect(out.panelPayload).not.toBeNull();
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'periscope auto-playbook truncated at max_tokens',
      expect.any(Object),
    );
  });

  it('truncated with parseOk=false leaves panelPayload null', async () => {
    vi.mocked(runCachedAnthropicCall).mockResolvedValue({
      ...okAnthropic,
      stopReason: 'max_tokens',
    });
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'partial',
      structured: structuredFixture,
      parseOk: false,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('truncated');
    expect(out.panelPayload).toBeNull();
  });

  it('embedding failure does NOT fail the read — returns null embedding, status complete', async () => {
    vi.mocked(generateEmbedding).mockRejectedValue(new Error('OpenAI 429'));

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(out.embedding).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('calibration / parent / retrieval / flow failures degrade gracefully', async () => {
    vi.mocked(buildCalibrationBlock).mockRejectedValue(new Error('cal-fail'));
    vi.mocked(fetchPeriscopeAnalysisById).mockRejectedValue(
      new Error('parent-fail'),
    );
    vi.mocked(fetchParentChain).mockRejectedValue(new Error('chain-fail'));
    vi.mocked(buildFlowContextBlock).mockRejectedValue(new Error('flow-fail'));
    vi.mocked(buildRetrievalBlock).mockRejectedValue(new Error('retr-fail'));

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(Sentry.captureException).toHaveBeenCalledTimes(5);
    // Each failed collaborator captured exactly once.
  });

  it('substitutes NO_ALERTS sentinel into the prompt when buildFlowContextBlock throws', async () => {
    // Anti-hallucination guard (see periscope-flow-hallucination-fix-2026-05-16):
    // when the flow-context fetch throws, the runner must coalesce the
    // error into the mode-specific NO_ALERTS sentinel rather than null —
    // otherwise the model receives no flow context at all and fabricates
    // citations to satisfy the prompt's REQUIRED FLOW-STRUCTURE check.
    vi.mocked(buildFlowContextBlock).mockRejectedValue(new Error('flow-fail'));

    await runPeriscopeAutoPlaybook(baseInput); // baseInput.mode === 'intraday'

    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.flowBlock).toBe('__sentinel_intraday__');
  });

  // Phase 3 drift check: when the prompt carried the NO_ALERTS sentinel
  // but the model's expected_dealer_behavior did NOT declare
  // INSUFFICIENT_DATA, Sentry warning fires so the regression is
  // observable without waiting for the next periscope audit.
  it('captures Sentry warning when sentinel in prompt but output missing INSUFFICIENT_DATA', async () => {
    vi.mocked(buildFlowContextBlock).mockResolvedValue(
      'Fresh SPXW flow alerts ...\nNO_ALERTS_IN_WINDOW\n\nNo alerts ...',
    );
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: {
        ...structuredFixture,
        // Drift: model invented an AGREEMENT despite the sentinel.
        expected_dealer_behavior:
          'FLOW-STRUCTURE: AGREEMENT — 14:30 CT PUT 7400 rule=RepeatedHits. Passive bid expected.',
      },
      parseOk: true,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('NO_ALERTS sentinel present'),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          stage: 'flow_structure_drift_check',
        }),
      }),
    );
  });

  it('does NOT capture Sentry warning when sentinel in prompt AND output declares INSUFFICIENT_DATA', async () => {
    vi.mocked(buildFlowContextBlock).mockResolvedValue(
      'Fresh SPXW flow alerts ...\nNO_ALERTS_IN_WINDOW\n\nNo alerts ...',
    );
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: {
        ...structuredFixture,
        expected_dealer_behavior:
          'FLOW-STRUCTURE: INSUFFICIENT_DATA. Passive bid expected below 5895, passive offer above 5925.',
      },
      parseOk: true,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    // captureMessage may still be called for OTHER reasons (refusal,
    // truncation) — assert specifically that the drift-check call did
    // NOT fire.
    const driftCalls = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.filter((call) =>
        String(call[0]).includes('NO_ALERTS sentinel present'),
      );
    expect(driftCalls).toHaveLength(0);
  });

  it('does NOT capture Sentry warning when prompt has no sentinel (real flow context)', async () => {
    vi.mocked(buildFlowContextBlock).mockResolvedValue(
      'Fresh SPXW flow alerts placed in the last 15 min ...\n  - 14:30 CT CALL 5900 rule="RepeatedHits"',
    );
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: {
        ...structuredFixture,
        // No INSUFFICIENT_DATA needed when real alerts are present.
        expected_dealer_behavior:
          'FLOW-STRUCTURE: AGREEMENT — 14:30 CT CALL 5900 rule="RepeatedHits". Passive bid expected.',
      },
      parseOk: true,
    });

    await runPeriscopeAutoPlaybook(baseInput);

    const driftCalls = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.filter((call) =>
        String(call[0]).includes('NO_ALERTS sentinel present'),
      );
    expect(driftCalls).toHaveLength(0);
  });

  // Phase 4 symmetric drift check: confidence='high' must be backed by
  // a literal "FLOW-STRUCTURE: AGREEMENT" cite in
  // expected_dealer_behavior. If the model paraphrases or drops the
  // prefix, the structural gate silently misses.
  it('captures Sentry warning when confidence=high but no AGREEMENT cite', async () => {
    vi.mocked(buildFlowContextBlock).mockResolvedValue(
      'Fresh SPXW flow alerts placed in the last 15 min ...\n  - 14:30 CT CALL 5900 rule="RepeatedHits"',
    );
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: {
        ...structuredFixture,
        confidence: 'high',
        // Model paraphrased — missing the literal "FLOW-STRUCTURE: AGREEMENT"
        // prefix. Phase 4 gate misses this; the watchdog catches it.
        expected_dealer_behavior:
          'Flow agrees with structural bias — 14:30 CT CALL 5900. Passive bid expected.',
      },
      parseOk: true,
    });

    await runPeriscopeAutoPlaybook(baseInput);

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        'HIGH confidence awarded without FLOW-STRUCTURE: AGREEMENT',
      ),
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          stage: 'high_confidence_without_agreement',
        }),
      }),
    );
  });

  it('does NOT capture HIGH-without-AGREEMENT warning when cite is properly formatted', async () => {
    vi.mocked(buildFlowContextBlock).mockResolvedValue(
      'Fresh SPXW flow alerts placed in the last 15 min ...\n  - 14:30 CT CALL 5900 rule="RepeatedHits"',
    );
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: {
        ...structuredFixture,
        confidence: 'high',
        expected_dealer_behavior:
          'FLOW-STRUCTURE: AGREEMENT — 14:30 CT CALL 5900 rule="RepeatedHits". Passive bid expected.',
      },
      parseOk: true,
    });

    await runPeriscopeAutoPlaybook(baseInput);

    const highConfCalls = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.filter((call) =>
        String(call[0]).includes(
          'HIGH confidence awarded without FLOW-STRUCTURE: AGREEMENT',
        ),
      );
    expect(highConfCalls).toHaveLength(0);
  });

  it('does NOT capture HIGH-without-AGREEMENT warning when confidence is not high', async () => {
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: {
        ...structuredFixture,
        confidence: 'medium',
        // No AGREEMENT cite — but doesn't matter, confidence isn't high.
        expected_dealer_behavior:
          'Mixed signals. Passive bid expected below 5890.',
      },
      parseOk: true,
    });

    await runPeriscopeAutoPlaybook(baseInput);

    const highConfCalls = vi
      .mocked(Sentry.captureMessage)
      .mock.calls.filter((call) =>
        String(call[0]).includes(
          'HIGH confidence awarded without FLOW-STRUCTURE: AGREEMENT',
        ),
      );
    expect(highConfCalls).toHaveLength(0);
  });

  it('pre_trade mode skips parent + parent chain fetches', async () => {
    await runPeriscopeAutoPlaybook({
      ...baseInput,
      mode: 'pre_trade',
      parentId: null,
    });

    expect(fetchPeriscopeAnalysisById).not.toHaveBeenCalled();
    expect(fetchParentChain).not.toHaveBeenCalled();
  });

  it('intraday mode with null parentId skips parent fetches', async () => {
    await runPeriscopeAutoPlaybook({
      ...baseInput,
      mode: 'intraday',
      parentId: null,
    });

    expect(fetchPeriscopeAnalysisById).not.toHaveBeenCalled();
    expect(fetchParentChain).not.toHaveBeenCalled();
  });

  it('intraday mode with parentId fetches parent + chain', async () => {
    await runPeriscopeAutoPlaybook({ ...baseInput, parentId: 99 });

    expect(fetchPeriscopeAnalysisById).toHaveBeenCalledWith(99);
    expect(fetchParentChain).toHaveBeenCalledWith(99);
  });

  it('lessons fetch failure logs to Sentry but does not throw', async () => {
    vi.mocked(fetchActiveLessons).mockRejectedValue(
      new Error('lessons db gone'),
    );

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.status).toBe('complete');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ stage: 'lessons_fetch' }),
      }),
    );
  });

  it('lessons present are appended to references block', async () => {
    vi.mocked(fetchActiveLessons).mockResolvedValue([
      { id: 1, content: 'lesson body' } as never,
    ]);
    vi.mocked(formatLessonsBlock).mockReturnValue('=== LESSONS ===\nlesson');

    await runPeriscopeAutoPlaybook(baseInput);

    expect(formatLessonsBlock).toHaveBeenCalledTimes(1);
  });

  it('cone null in synth yields panelPayload.cone === null', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue({
      ...synthFixture,
      extraction: {
        structured: {
          ...structuredFixture,
          cone_lower: null,
          cone_upper: null,
        },
      },
    } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);
    vi.mocked(parseStructuredFieldsFromToolInput).mockReturnValue({
      prose: 'narrative prose',
      structured: { ...structuredFixture, cone_lower: null, cone_upper: null },
      parseOk: true,
    });

    const out = await runPeriscopeAutoPlaybook(baseInput);

    expect(out.panelPayload).not.toBeNull();
    expect(out.panelPayload?.cone).toBeNull();
  });

  it('user content builder receives heatMapBlock and spotDirective', async () => {
    await runPeriscopeAutoPlaybook(baseInput);

    expect(buildUserContent).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.heatMapBlock).toBe('heat-map block');
    expect(arg?.spotDirective).toMatch(/5912\.34/);
    expect(arg?.spotDirective).toMatch(/Charm-zero strike.*5905/);
    expect(arg?.spotDirective).toMatch(/cone.*5880/);
  });

  it('null cone in synth omits cone line from spotDirective', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue({
      ...synthFixture,
      extraction: {
        structured: {
          ...structuredFixture,
          cone_lower: null,
          cone_upper: null,
        },
      },
    } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

    await runPeriscopeAutoPlaybook(baseInput);

    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.spotDirective).not.toMatch(/Straddle cone bounds/);
  });

  it('null charmZeroStrike omits charm-zero line from spotDirective', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue({
      ...synthFixture,
      charmZeroStrike: null,
    } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

    await runPeriscopeAutoPlaybook(baseInput);

    const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
    expect(arg?.spotDirective).not.toMatch(/Charm-zero strike/);
  });

  it('fallbackModel override is forwarded to runCachedAnthropicCall', async () => {
    await runPeriscopeAutoPlaybook({
      ...baseInput,
      fallbackModel: 'claude-haiku-4-5',
    });

    expect(runCachedAnthropicCall).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryModel: 'claude-opus-5',
        fallbackModel: 'claude-haiku-4-5',
        fallbackEffort: 'high',
        effort: 'xhigh',
        maxTokens: 128_000,
        fallbackMetric: 'periscope_auto_playbook.opus_fallback',
      }),
    );
  });

  it('default fallbackModel is claude-sonnet-5 when not provided', async () => {
    await runPeriscopeAutoPlaybook(baseInput);

    expect(runCachedAnthropicCall).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackModel: 'claude-sonnet-5' }),
    );
  });

  it('systemBlocks include skill, references+lessons, calibration, retrieval (all 4 cached)', async () => {
    await runPeriscopeAutoPlaybook(baseInput);

    const call = vi.mocked(runCachedAnthropicCall).mock.calls[0]?.[0];
    expect(call?.systemBlocks).toHaveLength(4);
    expect(call?.systemBlocks?.[0]?.text).toMatch(/Periscope skill body/);
    expect(call?.systemBlocks?.[1]?.text).toMatch(/vol signals/);
    // All blocks have ephemeral cache_control with 1h TTL.
    for (const block of call?.systemBlocks ?? []) {
      expect(block.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    }
  });

  it('durationMs is non-negative even on failed-no-snapshot fast-exit', async () => {
    vi.mocked(synthesizeFromDb).mockResolvedValue(null);
    const out = await runPeriscopeAutoPlaybook(baseInput);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/**
 * The three mandatory scale mitigations. SKILL.md's absolute magnitudes
 * are calibrated on the retired GEXBot/heat-map NORMALIZED scale; the
 * live `uw_spot` series is RAW DOLLAR exposure ~1000x larger and
 * `uw_eod` is normalized, ~1000x smaller, and one 15:00-CT slice per
 * day. `resolveSnapshotSource` falls back between them silently, so
 * without these guards a wrong-scale read is indistinguishable from a
 * correct one on the stored row.
 */
describe('runPeriscopeAutoPlaybook — scale safety', () => {
  describe('mitigation 1: source stamping', () => {
    it('stamps the resolved source into full_response on the success path', async () => {
      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.status).toBe('complete');
      expect(out.fullResponse).toMatchObject({ source: 'uw_spot' });
    });

    it('stamps the resolved source into panel_payload on the success path', async () => {
      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.panelPayload).not.toBeNull();
      expect(out.panelPayload?.source).toBe('uw_spot');
    });

    it('stamps the resolved source into the truncated panel_payload too', async () => {
      vi.mocked(runCachedAnthropicCall).mockResolvedValue({
        ...okAnthropic,
        stopReason: 'max_tokens',
      });

      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.status).toBe('truncated');
      expect(out.fullResponse).toMatchObject({ source: 'uw_spot' });
      expect(out.panelPayload?.source).toBe('uw_spot');
    });

    it('stamps the resolved source even when the Anthropic call throws', async () => {
      vi.mocked(runCachedAnthropicCall).mockRejectedValue(
        new Error('Overloaded after fallback'),
      );

      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.status).toBe('failed');
      expect(out.fullResponse).toEqual({
        error: 'Overloaded after fallback',
        source: 'uw_spot',
      });
    });

    it('threads the resolved source into formatHeatMapBlock so it can emit its units line', async () => {
      await runPeriscopeAutoPlaybook(baseInput);

      expect(formatHeatMapBlock).toHaveBeenCalledTimes(1);
      expect(formatHeatMapBlock).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'uw_spot' }),
      );
    });
  });

  describe('mitigation 2: raw-dollar scale preamble', () => {
    it('injects the raw-dollar scale preamble into the user content', async () => {
      await runPeriscopeAutoPlaybook(baseInput);

      const arg = vi.mocked(buildUserContent).mock.calls[0]?.[0];
      expect(arg?.spotDirective).toMatch(/RAW DOLLAR exposure/);
      expect(arg?.spotDirective).toMatch(/UNITS — READ THIS/);
    });

    it('tells the model to ignore the skill absolute-magnitude checks, incl. the charm band', async () => {
      await runPeriscopeAutoPlaybook(baseInput);

      const directive =
        vi.mocked(buildUserContent).mock.calls[0]?.[0]?.spotDirective ?? '';
      expect(directive).toMatch(/IGNORE every absolute-magnitude sanity check/);
      expect(directive).toMatch(/±60K–120K/);
    });

    it('preserves relative structure, signs and rankings as still-valid', async () => {
      await runPeriscopeAutoPlaybook(baseInput);

      const directive =
        vi.mocked(buildUserContent).mock.calls[0]?.[0]?.spotDirective ?? '';
      expect(directive).toMatch(/SIGN of each cell/);
      expect(directive).toMatch(/RELATIVE RANKING/);
    });

    it('keeps the authoritative-spot directive alongside the preamble', async () => {
      await runPeriscopeAutoPlaybook(baseInput);

      const directive =
        vi.mocked(buildUserContent).mock.calls[0]?.[0]?.spotDirective ?? '';
      // The preamble is appended, not substituted — the spot anchor and
      // the cone/charm-zero lines must survive.
      expect(directive).toMatch(/Authoritative SPX spot at read time/);
      expect(directive).toMatch(/5912\.34/);
      expect(directive).toMatch(/Charm-zero strike.*5905/);
    });
  });

  describe('mitigation 3: hard refuse on non-uw_spot sources', () => {
    it('refuses on uw_eod WITHOUT calling Anthropic', async () => {
      vi.mocked(synthesizeFromDb).mockResolvedValue({
        ...synthFixture,
        source: 'uw_eod',
      } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.status).toBe('failed');
      expect(out.failureReason).toMatch(/^source_not_uw_spot/);
      // The actual resolved source rides along so the row is diagnosable.
      expect(out.failureReason).toContain('uw_eod');
      // The whole point: zero API spend on a wrong-scale slot.
      expect(runCachedAnthropicCall).not.toHaveBeenCalled();
    });

    it('refuses on the dead gexbot series WITHOUT calling Anthropic', async () => {
      vi.mocked(synthesizeFromDb).mockResolvedValue({
        ...synthFixture,
        source: 'gexbot',
      } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.status).toBe('failed');
      expect(out.failureReason).toContain('gexbot');
      expect(runCachedAnthropicCall).not.toHaveBeenCalled();
    });

    it('refuses on a null source WITHOUT calling Anthropic', async () => {
      vi.mocked(synthesizeFromDb).mockResolvedValue({
        ...synthFixture,
        source: null,
      } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.status).toBe('failed');
      expect(out.failureReason).toBe('source_not_uw_spot: null');
      expect(runCachedAnthropicCall).not.toHaveBeenCalled();
    });

    it('refusal returns an empty, unusable outcome — no prose, payload or embedding', async () => {
      vi.mocked(synthesizeFromDb).mockResolvedValue({
        ...synthFixture,
        source: 'uw_eod',
      } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

      const out = await runPeriscopeAutoPlaybook(baseInput);

      expect(out.prose).toBe('');
      expect(out.parseOk).toBe(false);
      expect(out.panelPayload).toBeNull();
      expect(out.embedding).toBeNull();
      expect(out.modelUsed).toBeNull();
      expect(out.inputTokens).toBeNull();
      expect(out.outputTokens).toBeNull();
      // Still records what it saw, so the panel can explain itself.
      expect(out.fullResponse).toEqual({ source: 'uw_eod' });
      expect(out.durationMs).toBeGreaterThanOrEqual(0);
      // No embedding call either — the refusal exits before that too.
      expect(generateEmbedding).not.toHaveBeenCalled();
    });

    it('refusal short-circuits before the prompt is assembled at all', async () => {
      vi.mocked(synthesizeFromDb).mockResolvedValue({
        ...synthFixture,
        source: 'uw_eod',
      } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

      await runPeriscopeAutoPlaybook(baseInput);

      expect(buildUserContent).not.toHaveBeenCalled();
      expect(buildRetrievalBlock).not.toHaveBeenCalled();
      expect(buildFlowContextBlock).not.toHaveBeenCalled();
    });

    it('refusal is reported to Sentry with the resolved source tagged', async () => {
      vi.mocked(synthesizeFromDb).mockResolvedValue({
        ...synthFixture,
        source: 'uw_eod',
      } as unknown as Awaited<ReturnType<typeof synthesizeFromDb>>);

      await runPeriscopeAutoPlaybook(baseInput);

      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        expect.stringContaining('snapshot source is not uw_spot'),
        expect.objectContaining({
          level: 'warning',
          tags: expect.objectContaining({
            stage: 'source_gate',
            resolvedSource: 'uw_eod',
          }),
        }),
      );
    });
  });
});

/**
 * Finding 5 of the 2026-08-21 review: the Anthropic time budget must
 * stay under the function ceiling.
 *
 * Nothing closes the pre-inserted `in_progress` row out except this
 * runner returning — a platform kill mid-call runs neither the success
 * path nor the catch, so the row is stranded `in_progress` forever and
 * the panel's "Claude reading…" hint never clears. The SDK therefore
 * has to be the thing that gives up first, on every path.
 */
describe('Anthropic wall-clock budget', () => {
  /**
   * Read from the real vercel.json rather than hardcoded — the whole
   * point of this block is that the two numbers stay in agreement, so
   * a maxDuration cut (or a dropped entry, which silently reverts the
   * function to the much lower platform default) has to fail here.
   */
  const FUNCTION_MAX_DURATION_MS = (() => {
    const cfg = JSON.parse(
      readFileSync(join(process.cwd(), 'vercel.json'), 'utf8'),
    ) as { functions?: Record<string, { maxDuration?: number } | undefined> };
    const seconds =
      cfg.functions?.['api/cron/periscope-playbook.ts']?.maxDuration;
    if (typeof seconds !== 'number') {
      throw new Error(
        'vercel.json has no maxDuration for api/cron/periscope-playbook.ts — the SDK timeout budget below is calibrated against it',
      );
    }
    return seconds * 1000;
  })();
  /**
   * `runCachedAnthropicCall` can issue up to three calls per
   * invocation: the primary, the fallback model, and a one-shot retry
   * of the fallback on a mid-stream socket close.
   */
  const MAX_CALLS_PER_INVOCATION = 3;
  /**
   * Reserved for everything that is not the Anthropic call:
   * synthesizeFromDb, the four context fetches, the retrieval +
   * outcome embeddings, and the caller's two-phase UPDATE.
   */
  const NON_ANTHROPIC_RESERVE_MS = 60_000;

  async function clientOptions() {
    await runPeriscopeAutoPlaybook(baseInput);
    const call = vi.mocked(Anthropic).mock.calls[0];
    expect(call).toBeDefined();
    const opts = call?.[0] ?? {};
    expect(typeof opts.timeout).toBe('number');
    expect(typeof opts.maxRetries).toBe('number');
    return {
      timeout: opts.timeout as number,
      maxRetries: opts.maxRetries as number,
    };
  }

  it('worst-case SDK wall clock fits under the function ceiling with reserve', async () => {
    const { timeout, maxRetries } = await clientOptions();
    // SDK contract: wall clock per call can reach timeout × (maxRetries + 1).
    const worstCaseMs = timeout * (maxRetries + 1) * MAX_CALLS_PER_INVOCATION;
    expect(worstCaseMs).toBeLessThanOrEqual(
      FUNCTION_MAX_DURATION_MS - NON_ANTHROPIC_RESERVE_MS,
    );
  });

  it('still leaves a single xhigh read room to finish (~120-150s observed)', async () => {
    const { timeout } = await clientOptions();
    expect(timeout).toBeGreaterThanOrEqual(180_000);
  });

  it('a single SDK call cannot outlive the function on its own', async () => {
    const { timeout, maxRetries } = await clientOptions();
    expect(timeout * (maxRetries + 1)).toBeLessThan(FUNCTION_MAX_DURATION_MS);
  });
});
