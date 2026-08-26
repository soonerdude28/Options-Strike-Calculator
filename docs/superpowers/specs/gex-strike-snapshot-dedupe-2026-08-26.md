# Snapshot-duplicate protection for per-strike GEX dedupe (2026-08-26)

## Goal

Stop `fetch-greek-exposure-strike` from doubling a day's gamma when the vendor
serves duplicate **intraday snapshots** instead of genuine AM/PM settlement
series: choose the collision rule per expiry from OSI root evidence (sum for
dual-root, mean for single-root), and alert loudly when the anomalous case is
seen or when root evidence is unavailable and the pairs look near-identical.

## Background

`DEFAULT_DEDUPE_RULE='sum'` in `api/_lib/gex-strike-integrity.ts` is correct
for the AM/PM merge (two real series on a monthly OPEX expiry). The
Trading-Bot rebuild (`~/Trading-Bot/research/spx_gamma_rebuild/VERIFICATION.md`,
2025-10-14 section) found a second vendor failure mode: a day where every
strike on **single-root (SPXW-only) expiries** arrived twice as two intraday
snapshots. Summing those pairs doubles the day (~1.56M vs a plausible 785k
gross on 2025-10-14).

The two cases are distinguishable:

- **AM/PM pairs** — structurally different (median ~87% apart on 2025-10-14's
  dual-root pairs), occur only on expiries listed under **both** OSI roots
  (SPX and SPXW) in `/api/stock/SPX/option-chains?date=D`.
- **Snapshot pairs** — near-identical (median 1.53% apart, p95 18.4%), occur
  on **single-root** expiries.

`build.py` in the rebuild uses the archived root evidence to pick the rule per
collision and logs it. This change mirrors that in the live cron.

## Phases

Single phase, one commit. ~4 files.

## Files to modify

1. `api/_lib/gex-strike-integrity.ts`
   - `DedupeRule` gains `'mean'`; `DEFAULT_DEDUPE_RULE` stays `'sum'`.
   - `dedupeStrikeRows(rows, { rule?, dualRootExpiries? })` — new optional
     `dualRootExpiries: ReadonlySet<string>`. When provided (and rule is not
     `'strict'`), the rule is resolved **per collision**: expiry in the set →
     `'sum'`, otherwise → `'mean'`. When absent, the uniform batch rule
     applies exactly as today (`'mean'` is also accepted as a uniform rule).
   - `Collision` gains:
     - `rule: 'sum' | 'mean'` — the rule applied (or that would apply, on the
       strict-throw path) to this collision.
     - `maxRelDiff: number` — max over the SUMMABLE fields of the group's
       relative spread `(hi − lo) / max(|hi|, |lo|)` (0 when the field is 0
       everywhere). Identical rows → 0.
   - Export `NEAR_IDENTICAL_REL_DIFF = 0.05` — "a few percent" threshold for
     flagging probable snapshot duplicates when no root evidence exists.
   - Output rows gain per-row `dedupe_rule: DedupeRule` — the rule actually
     applied to that row (batch rule for untouched rows, preserving today's
     provenance semantics; per-collision rule for combined rows).
   - `GEX_STRIKE_SPEC_VERSION` bumped to **3** (rule now chosen by root
     evidence); `GEX_STRIKE_MIN_TRUSTED_SPEC_VERSION` **stays 2** — the
     snapshot failure mode was never observed during the one-session spec-2
     window, and spec-2 rows are otherwise sound.
2. `api/cron/fetch-greek-exposure-strike.ts`
   - New helper `fetchChainRoots(apiKey, date)`: GET
     `/stock/SPX/option-chains?date=${date}` via `uwFetch<string>`, parse OSI
     symbols with `/^([A-Z]+)(\d{6})[CP]\d{8}$/`, return
     `Map<expiryIso, Set<root>>`, or `null` on failure/empty (log warn, never
     throw). One extra UW call **only on collision days** (~12/year).
   - Handler: probe-dedupe first; if collisions exist, fetch chain roots.
     Evidence is usable only if every collided expiry appears in the map.
     - usable → re-dedupe with `dualRootExpiries` (expiries with ≥2 roots).
       Any `'mean'` collision → `logger.error` + `Sentry.captureException`
       (this is the anomalous vendor failure, observed once in 3 years).
     - unavailable → keep the sum result; collisions with
       `maxRelDiff <= NEAR_IDENTICAL_REL_DIFF` → `logger.error` +
       `Sentry.captureException` warning the day's gamma may be doubled.
     - ALL sum collisions keep the existing `logger.warn` (log object gains
       `rootEvidence`); the error paths escalate, they do not replace it.
   - Store per-row `dedupe_rule` (from the dedupe result) instead of one
     batch-level `prov.dedupeRule`.
   - Cron metadata gains `sumCollisions`, `meanCollisions`,
     `nearIdenticalCollisions`, and
     `rootEvidence: 'not_needed' | 'applied' | 'unavailable'`.
     `nearIdenticalCollisions` is an anomaly signal, not a spread census: it
     counts only pairs summed while evidence was unavailable, so a routine
     OPEX day under applied evidence reports 0.
   - Update the header comment (API calls per invocation: 2, +1 on collision
     days).
3. `api/__tests__/gex-strike-integrity.test.ts` — cover mean rule, per-expiry
   resolution via `dualRootExpiries`, per-collision `rule`, `maxRelDiff`,
   per-row `dedupe_rule`, spec version 3.
4. `api/__tests__/fetch-greek-exposure-strike.test.ts` — cover: no collision →
   no option-chains call; dual-root collision → summed, no Sentry error;
   single-root collision → averaged + Sentry alert; chains fetch fails +
   near-identical pair → summed + Sentry alert; chains fetch fails +
   structurally-different pair → summed, warn only.

## Data dependencies

None new. `dedupe_rule` is `TEXT` with no CHECK (migration in
`db-migrations.ts`), so `'mean'` writes without a migration. No new env vars.

## Thresholds / constants

- `NEAR_IDENTICAL_REL_DIFF = 0.05` — snapshot pairs were median 1.53% apart
  with a heavy tail (p95 18.4%); 5% catches the bulk without tripping on
  genuine AM/PM pairs (median ~87% apart).
- Spec version 3; min trusted stays 2.

## Open questions (defaults picked)

- Backfill script (`scripts/backfill-greek-exposure-strike.mjs`) keeps
  uniform-sum behavior (no `dualRootExpiries` passed), but now emits a loud
  `console.warn` when any collision on a day has
  `maxRelDiff <= NEAR_IDENTICAL_REL_DIFF` — near-identical pairs summed
  without root evidence may double that day's gamma. Wiring root evidence
  into it is a follow-up if historical re-runs are planned.
- `Sentry.captureException(new Error(...))` (not `captureMessage`) — matches
  the cron's existing reconciliation-failure pattern and the test mocks.

## Verification

`npm run build` (API tsconfig is stricter than the root `tsc --noEmit`) AND
`npm run review`. Push to remote `fork`, not `origin`.
