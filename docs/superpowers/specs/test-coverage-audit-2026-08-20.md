# Test Coverage Audit — 2026-08-20

Full-suite audit of test coverage across the repo: what the numbers say, where
the real risk hides, and a prioritized list of improvements. All numbers below
were measured on this date from a fresh clone (`vitest run --coverage` with
`CI=true`, plus fresh pytest runs for `uw-stream/` and `classifier/`).

## Headline numbers

| Suite | Files | Result |
| --- | --- | --- |
| Vitest (src + api + scripts/\_lib) | 635 test files | 12,978 passed, 3 skipped, ~4.8 min |
| Playwright e2e | 39 specs × 3 browsers | not run in this audit (CI-gated) |
| ml/ pytest | 53 test files | CI-gated (70% floor on library modules) |
| sidecar/ pytest | 22 test files | CI-gated |
| uw-stream/ pytest | 25 test files | **all pass, 92% line coverage — never runs in CI** |
| classifier/ pytest | 8 test files | **148 pass, 98% coverage (95% floor) — never runs in CI** |

Vitest coverage totals (thresholds in `vite.config.ts`: 90/80/90/90):

| Metric | Measured | vs. 2026-06-11 note |
| --- | --- | --- |
| Statements | 94.63% (34,640/36,603) | 94.8% → slight drift down |
| Branches | 87.24% (23,635/27,090) | 87.4% → slight drift down |
| Functions | 95.71% | 95.7% → flat |
| Lines | 96.33% | 96.5% → slight drift down |

By area:

| Area | Files | Stmt % | Branch % |
| --- | --- | --- | --- |
| api/ endpoints | 92 | 94.6 | 87.8 |
| api/\_lib | 176 | 96.2 | 89.4 |
| api/cron | 77 | 94.9 | **83.7** |
| src/components | 296 | **92.4** | **85.6** |
| src/hooks | 83 | 94.0 | 85.9 |
| src/utils | 58 | 97.1 | 93.3 |

The suite is in excellent shape overall — the "tests ship with the feature"
policy is clearly working, the math core (`src/utils/`) is the best-covered
area, auth surfaces have dedicated suites, and there are no 0%-covered files
of any size. The findings below are about what a healthy line-coverage number
still hides.

## Findings (prioritized)

### P1a — `uw-stream/` and `classifier/` test suites never run in CI

`.github/workflows/ci.yml` gates **app**, **ml**, **sidecar**, and **e2e** via
`dorny/paths-filter` — there is no filter entry and no job for `uw-stream/`
or `classifier/`, and neither is in `package.json`'s `review:python`. Both
suites are healthy (verified green on this fresh clone), which makes this
pure process risk: a change to either Railway service ships with zero
automated verification, and green-but-unrun suites rot silently.

Also: `uw-stream/pyproject.toml` has no coverage configuration at all
(classifier bakes `--cov --cov-fail-under=95` into its addopts; uw-stream
measures nothing).

**Proposal (small, mechanical):**

1. Add `uw-stream:` and `classifier:` path filters + quality-gate jobs to
   `ci.yml`, mirroring the sidecar job (Python 3.13 — note the code uses
   PEP 695 generics, so 3.12+ is required).
2. Add `--cov=src --cov-report=term-missing --cov-fail-under=85` to
   uw-stream's pytest addopts (it measures 92% today; floor a few points
   below, per the repo's existing convention).
3. Add `review:uw-stream` / `review:classifier` scripts and fold them into
   `review:python`.

### P1b — the TakeIt scorer (`api/_lib/takeit-score.ts`) is effectively untested in CI

Worst file in the repo: **9.2% statements / 6.5% branches** (79 of 87
statements unexecuted) under `CI=true`. Reason: its only meaningful test is
`takeit-score.parity.test.ts`, which (by design) skips when the
Python-generated bundles under `ml/data/takeit/` are absent — and `ml/data/`
is gitignored, so it *always* skips in CI and on fresh clones. The
skip-in-CI design is documented and sensible for the parity test itself, but
the net effect is that live alert-scoring logic has near-zero automated
verification anywhere.

**Proposal:**

1. Commit a small **frozen test-only bundle** (a few trees / handful of
   features, checked into `api/__tests__/fixtures/`) and add a plain
   behavior test for `takeit-score.ts` that always runs: monotonicity on a
   known feature, missing-feature handling, output range, tie-breaks. Keep
   the full TS↔Python parity test as-is for machines with real bundles.
2. Additionally (or alternatively), run the parity test inside
   `ml-pipeline.yml` right after the retrain step — that job already has the
   fresh bundles and a Node toolchain, so parity gets verified nightly even
   though the app CI job can't see the artifacts.

### P2a — 190 migrations / 5,295 lines of SQL verified only by mock-call counting

`api/_lib/db-migrations.ts` now holds **190** migrations (CLAUDE.md still
says 69 — update it). `db.test.ts` (2,356 lines) asserts mock call counts
and migration bookkeeping, not SQL validity — a typo'd column type, bad
`ALTER`, or an index on a dropped column would ship green. The repo already
proved the better pattern: `flow-regime-sql-integration.test.ts` runs the
exact production SQL against **pglite** (real Postgres-in-WASM), and its
header comment is the argument for extending it.

**Proposal:**

1. Add one pglite-backed migration test: run `initDb()` + all of
   `migrateDb()` against a fresh PGlite instance (with the
   `@electric-sql/pglite/vector` extension — migrations use
   `CREATE EXTENSION vector`, `vector(2000)`, HNSW) and assert the final
   `schema_migrations` count. This single test makes every future
   migration's SQL actually execute in CI for ~zero marginal effort.
2. On top of the migrated schema, add smoke queries for the heaviest query
   modules (`db-flow.ts`, `db-snapshots.ts`, `db-strike-helpers.ts`, ...):
   insert 2–3 rows, call the real function, assert shape. This also catches
   drift between migration DDL and query-module column lists, which the
   mock pattern cannot see.
3. Longer term this can shrink `db.test.ts`'s per-migration maintenance
   burden (mock list + expected list + call count per migration, per
   CLAUDE.md) to a single integration assertion.

Caveat: anything Neon-specific or extension-dependent beyond pgvector needs
a skip-list; keep the mock-based bookkeeping tests for those.

### P2b — frontend↔API contract drift is invisible to every layer

Unit tests mock `fetch`/`getDb` on both sides; e2e runs against `npm run dev`
(Vite only, no functions) with `e2e/helpers/mock-fetch.ts`, which serves
hand-written fixtures and — critically — answers **any unmocked `/api/`
route with an empty 200**. So if an endpoint renames a response field, every
suite stays green while the panel silently renders empty state.

**Proposal (pick 1–2, not all):**

1. **Strict mock mode:** make unmocked `/api/` requests fail the e2e spec
   (opt-in flag per spec at first, default later). Cheap, catches "panel
   quietly fetches an endpoint nobody mocked".
2. **Shared response schemas:** Zod schemas for reader-endpoint responses
   (many already exist server-side in `api/_lib/validation/`); handler tests
   assert the real handler output parses, and hook/e2e fixtures are parsed
   through the same schema in test setup. Drift then fails one side or the
   other instead of neither.
3. Where `withDbReader` endpoints are concerned, a table-driven test that
   round-trips each endpoint's fixture through its schema would cover most
   of the read surface in one file.

### P2c — e2e specs cover the 2025-era calculator, not the newer dealer-positioning half

The 39 specs cover calculator/strike/hedge/IC/risk/tracker/alerts flows
well (including a11y). No spec exists for the panels added since:
Periscope (panel, lottery, chat/lessons), SilentBoom, LotteryFinder,
GexLandscape, GexTarget, GexbotSection, GreekFlowPanel, GreekHeatmap,
StrikeBattleMap, ZeroGammaPanel, DealerRegimeTile, IntervalBAFeed,
OpeningFlowSignal, PositionMonitor, BWBCalculator, MLInsights.

This matters more than it usually would, because the same panels are also
the weakest *unit*-covered area (next finding) — they're double-gapped.

**Proposal:** add specs for the 3–4 panels actually used during live
trading first (Periscope + PeriscopeLottery, SilentBoom/LotteryFinder
feeds, GexLandscape), using the existing mock-fetch helper; fold each into
`a11y-automated.spec.ts`'s scan list as they land.

### P3a — concrete branch-coverage lowlights (worst files, measured)

Files worth targeted tests, ranked by absolute uncovered branches:

| File | Stmt % | Branch % | Missed branches |
| --- | --- | --- | --- |
| src/components/SilentBoom/index.tsx | 81.6 | 75.2 | 83 |
| src/components/PositionMonitor/statement-parser/section-parsers.ts | — | 75.1 | 77 |
| src/components/SilentBoom/SilentBoomRow.tsx | 76.6 | 71.4 | 67 |
| src/components/charts/TickerNetFlowChart.tsx | 81.3 | 65.7 | 60 |
| api/cron/refresh-tracker-contracts.ts | 82.9 | 54.2 | 54 |
| src/components/PeriscopeChat/PeriscopeChatHistory.tsx | 76.4 | 61.9 | 53 |
| src/components/LotteryFinder/LotteryRow.tsx | 86.7 | 81.8 | 52 |
| api/lottery-finder.ts | — | 84.5 | 41 |
| api/cron/detect-lottery-fires.ts | 91.4 | 77.0 | 41 |
| api/cron/fetch-strike-iv.ts | 81.3 | 78.6 | 34 |
| src/components/PeriscopeChat/LessonLibrary.tsx | 78.8 | 58.5 | 34 |
| api/_lib/occ.ts | — | 84.9 | 27 |

Two thematic clusters deserve priority inside this list:

- **Parsers** (`statement-parser/section-parsers.ts`, `occ.ts`,
  `uw-occ-parse.ts` at 84.7% br): untested parser branches are the classic
  silent-data-corruption path. Table-driven cases over real-world variants
  close these cheaply.
- **Cron branch gaps** (`refresh-tracker-contracts` at 54% br,
  `fetch-strike-iv` at 79%): the untested branches are mostly error/partial-
  data paths — exactly what fires at 3am.

Also: `useRegimeClassification.ts` (263 lines, feeds `useComputedSignals`)
has no direct test file — it's exercised only incidentally.

### P3b — property-based tests for the money math

`ml/` already uses `hypothesis`; the TS side has no `fast-check` anywhere.
The example-based tests in `src/utils/` are genuinely good (known values,
symmetry, edge cases), but the invariants that example tests can't sweep are
exactly the ones that matter for money math: put-call parity and delta
monotonicity in `black-scholes.ts`, P&L continuity at strikes and max-loss
bounds in `iron-condor.ts`/`bwb.ts`, round-trip stability in
`uw-occ-parse.ts`/`occ.ts`, hedge-size scaling in `hedge/`.

**Proposal:** add `fast-check` as a devDependency and start with 2 files
(`black-scholes.property.test.ts`, `iron-condor.property.test.ts`), ~6
properties each. Low cost, disproportionate assurance for the core the whole
app is built on.

### P3c — coverage-config hygiene

- **Thresholds are global-only.** A new 200-line file at 30% passes CI as
  long as the global average holds. Consider `thresholds: { perFile: true }`
  with modest per-file floors (e.g. 60/50) so new low-coverage files are
  visible at review time without blocking legitimately hard-to-test files.
- **Raise the global floors** to reflect two years of reality: 90→93
  statements, 80→85 branches (still below measured values; per the config
  comment these were always meant to ratchet).
- **Revisit exclusions:** `src/App.tsx` (1,628 lines) is excluded yet has
  real tests (`App.panel-render`, `App.nav-anchors`); including it would
  make the panel-wiring layer visible in reports. Verify
  `api/_lib/validation.ts` and `api-helpers.ts` are still pure re-exports.
- **Stale doc:** CLAUDE.md's "69 numbered migrations" → 190; "40+ tables"
  likewise undercounts.

### P4 — papercuts / optional

- **Fresh-clone red suite:** `takeit-score.parity.test.ts` fails loudly on
  any clone without ML bundles (HANDOFF.md already notes it). With P1b's
  committed fixture in place, downgrade the local hard-fail to a skip with
  warning — a fresh `npm run test:run` should be green.
- **Mutation-testing pilot (optional):** Stryker scoped to `src/utils/`
  only, run on-demand/monthly (not PR CI), to measure whether the 97%
  coverage there actually *asserts*. Skip if it fights the toolchain.
- `scripts/` policy is fine as-is (research one-offs untested by design;
  `scripts/_lib/` is tested) — just keep promoting anything reused into
  `_lib` where the test requirement applies.

## Suggested order of execution

1. CI jobs for uw-stream + classifier (P1a) — one PR, pure config.
2. TakeIt frozen-fixture behavior test + parity-in-ml-pipeline (P1b).
3. pglite migration-runner test (P2a step 1).
4. Strict e2e mock mode + first Periscope/SilentBoom specs (P2b/P2c).
5. Branch-gap passes on the P3a table (one file per PR alongside normal work).
6. fast-check pilot on black-scholes + iron-condor (P3b).
7. Threshold ratchet + exclusion cleanup + CLAUDE.md count fixes (P3c).
