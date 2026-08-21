# Periscope: revive the Claude auto-playbook on the repaired UW data

**Date:** 2026-08-21
**Status:** Plan
**Branch:** `feat/periscope-uw-repoint`
**Predecessor:** `periscope-uw-repoint-2026-08-21.md` (the data-layer repair this builds on)

## Goal

Restore a writer for `periscope_analyses` so the Periscope Claude layer —
playbook panel, chat history, grading, retrieval, lessons — runs again, fed
by the repaired Unusual Whales data instead of the retired Playwright
scraper and screenshot OCR.

**Decisions (owner, 2026-08-21):** 10-minute RTH cadence; full
`pre_trade` / `intraday` / `debrief` lifecycle.

## Why this is cheap

`api/_lib/periscope-chat-runner.ts` (821 lines, recoverable at
`f52db025^`) was **already 100% DB-driven** — its header reads "No images /
OCR. The runner always uses `synthesizeFromDb`." It was retired for UI
reasons, not data reasons. Every module it imports still exists unchanged:
`anthropic-call`, `periscope-synthesize`, `periscope-prompts`,
`periscope-calibration`, `periscope-retrieval`, `periscope-flow-context`,
`embeddings`, `periscope-db`. `savePeriscopeAnalysis` and
`completePeriscopeAnalysis` were never deleted and are still unit-tested.
`/api/periscope-playbook` is alive and correct — it serves rows nothing
writes. `PeriscopeChatHistory` / `PeriscopeChatDetail` need **zero changes**.

Net: 1 new cron, 2 restored backend files, 1 `vercel.json` entry, 3
restored/edited frontend files, prompt fixes. **Zero migrations.**

## The central risk: silent scale corruption

Every absolute magnitude in `.claude/skills/periscope/SKILL.md` is
calibrated on the retired GEXBot/heat-map **normalized** scale — e.g.
"0DTE charm runs ±60K–120K" (SKILL.md:381), the worked example at
SKILL.md:28. The live series is now:

- `uw_spot` — **raw dollar** exposure, ~1000x LARGER than that scale
- `uw_eod` — normalized, ~1000x SMALLER, and only ONE 15:00-CT slice/day

`resolveSnapshotSource` silently falls back `uw_spot -> uw_eod` when the
expiry has no live rows (Monday pre-open, a cron gap, a holiday). Verified:
a `uw_eod` day returns 0 rows for any read before 15:00 CT, so its "prior
slice" is *yesterday*, not ten minutes ago.

Left alone, Claude emits a confident, well-formed, fully-populated
`panel_payload` built on magnitudes off by three orders of magnitude and a
day-over-day "momentum" read. Nothing on the row — `parse_ok`, `status`,
`confidence` — flags it. This is the failure mode that matters on a tool
that gets traded.

**Mandatory mitigations (Phase 2), all three:**
1. Stamp the resolved `source` into `full_response` AND `panel_payload`.
2. Inject a scale preamble: magnitudes are raw-dollar, NOT the skill's
   heat-map scale; ignore every absolute-magnitude sanity check in the
   skill, including the ±60K–120K charm band.
3. **Hard-refuse** to run when the resolved source is not `uw_spot` during
   RTH — write `status='failed'`, `failure_reason='source_not_uw_spot'`
   rather than producing a plausible wrong read.

## Phases

### Phase 1 — restore the runner
`api/_lib/periscope-playbook-runner.ts` from
`git show f52db025^:api/_lib/periscope-chat-runner.ts`, plus its test from
`f52db025^:api/__tests__/periscope-chat-runner.test.ts` (711 lines).
Changes on restore:
- Model IDs are hardcoded at `:61-62` as `claude-opus-4-7` /
  `claude-sonnet-4-6`. Move to `claude-opus-5` primary (same $5/$25
  pricing, thinking on by default) / `claude-sonnet-5` fallback.
- Thread `synth.source` through to `formatHeatMapBlock` (currently dropped
  at `:434-435`) so the units line can be emitted.
- Apply the three scale mitigations above.
- Keep: 4 cache breakpoints at `ttl:'1h'` most-stable-first, streaming,
  `toolChoice:'auto'` (forced choice is rejected alongside adaptive
  thinking), `effort:'xhigh'`, the two drift watchdogs.

### Phase 2 — prompt fixes (`api/_lib/periscope-prompts.ts`)
- `formatHeatMapBlock` takes a `source` and emits an explicit units line.
- `buildIntradayModeBody:284` still asks for "positions levels" and
  ":282" says "the chart in front of you" — with `images: []` that invites
  hallucinated Positions bars and dots. Remove/replace; add an explicit
  "there is no chart; all figures below are from the database" preamble.
- Cap `confidence` guidance: the `positions` panel is permanently
  unavailable from UW, so the expiry-unwind section (SKILL.md:288-300) and
  the `magnet` cross-check cannot be verified. Instruct the model not to
  claim `high` on criteria it cannot check.
- Add the `## What to add to the model` heading instruction to
  `buildDebriefModeBody` — `periscope-lessons.ts:125` keys its extraction
  on that heading and no live code has ever asked for it, which is why
  `curate-periscope-lessons` is a no-op.

### Phase 3 — the cron writer
`api/cron/periscope-playbook.ts`, lifting mode derivation, spot resolution
and the two-phase insert from
`f52db025^:api/periscope-auto-playbook.ts:93-160,398-440`.
- Trigger: `vercel.json` cron + `CRON_SECRET` (the old webhook auth and
  `PERISCOPE_WEBHOOK_SECRET` / `AUTO_PLAYBOOK_ENABLED` env vars are gone).
- Mode from the CT slot label: `08:20 - 08:30` -> `pre_trade`,
  `14:50 - 15:00` -> `debrief`, otherwise `intraday`.
- Drive off `fetchAvailableSlots` + `resolveSnapshotSource`, not a POST.
- `requireEnv` `ANTHROPIC_API_KEY` (currently `.optional()` in
  `api/_lib/env.ts:50`) and `OPENAI_API_KEY` for the embedding.

### Phase 4 — `vercel.json`
- Three cron entries matching `populate-periscope-from-uw`:
  `30,40,50 13`, `*/10 14-20`, `*/10 21` (Mon-Fri).
- `"api/cron/periscope-playbook.ts": { "maxDuration": 780,
  "includeFiles": ".claude/skills/**/*.md" }`.
- **`includeFiles` is not optional.** `f52db025` deleted it along with the
  endpoint. `loadPeriscopeSkill()` `readFileSync`s SKILL.md and throws by
  design; without the directive Vercel's tracer will not bundle it and
  every call 500s in production while passing locally.

### Phase 5 — frontend
- Restore `src/hooks/usePeriscopePlaybook.ts` (209 lines) and
  `src/components/Periscope/PlaybookSection.tsx` (516 lines, at
  `cf70bcba^`), plus `src/__tests__/usePeriscopePlaybook.test.ts` (394).
- Re-add the `playbook` prop to `PeriscopePanel` (stripped by f52db025).
- Register the playbook panel in `src/constants/panel-registry.ts`.
- `/api/periscope-playbook` and its `initBotId` entry are already correct.

## Data dependencies
- No migrations. No new tables or columns.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (both already in env schema).
- `cone_levels` (live, `compute-cone` at 13:32 UTC) — when null the cone
  and vol-shock layers go dark; degrade, don't fail.
- `ws_flow_alerts` via the live `uw-stream` Railway service.

## Cost
~39 reads/session at `effort:'xhigh'`, ~5-6K output tokens each. On
`claude-opus-5` ($5/$25 per MTok) with the ~33-70K prefix cached at 1h TTL:
roughly **$0.17/read, ~$6.60/session, ~$145/month**. Output tokens
dominate; cadence and effort are the levers if that needs to come down.
Token accounting already exists on the row (`input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `duration_ms`)
so real cost is measurable after one session.

## Open questions
1. **The skill text itself is still on the old scale.** Phase 2 papers over
   it with a preamble. The durable fix is recalibrating SKILL.md's worked
   magnitudes to raw dollars — larger, separate, and best done after a
   session of real reads shows the actual ranges.
2. **`positions` is permanently gone.** No UW endpoint serves it. The
   expiry-unwind read is structurally weaker forever; capping confidence is
   a mitigation, not a fix.
3. **Retrieval corpus starts empty**, so `buildRetrievalBlock` contributes
   nothing until rows accumulate. Harmless — it degrades to an empty block.
