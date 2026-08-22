# Cron wall-budget reserve — stop starting work we can't finish

**Date:** 2026-08-21
**Status:** in progress

## Goal

Eliminate the `Vercel Runtime Timeout Error`s on three crons by making every
wall-clock budget reserve enough time for the unit of work it is about to
admit, instead of only checking whether the budget has already elapsed.

## The bug

Every budgeted cron uses the same shape:

```ts
const deadlineMs = startMs + WALL_BUDGET_MS;
const pastDeadline = () => Date.now() > deadlineMs;
for (const item of items) {
  if (pastDeadline()) break; // gates ENTRY
  await doExpensiveWork(item); // …but nothing reserves time for THIS
}
```

The check gates _entry_ to a unit of work and reserves nothing for that unit
to _complete_. A unit admitted just under the deadline runs its full duration
on top, so the function overruns its hard `maxDuration` and Vercel kills it —
losing the whole response, including the partial-result reporting the budget
existed to produce.

Observed over 7 days (`get_runtime_errors`): 3 timeouts across exactly the
three routes below.

| cron                       | maxDuration | budget   | margin   | worst-case unit                                             |
| -------------------------- | ----------- | -------- | -------- | ----------------------------------------------------------- |
| `cleanup-ws-option-trades` | 300 s       | 295 s    | **5 s**  | one 50 000-row DELETE                                       |
| `detect-lottery-fires`     | 60 s        | 45 s     | **15 s** | fire hot path: macro + candles + multileg + gexbot + INSERT |
| `detect-silent-boom`       | 60 s        | **none** | —        | per-fire path incl. multileg                                |

`detect-lottery-fires` is the clearest arithmetic: the multileg client's
`DEFAULT_TIMEOUT_MS` is 15 s, so a fire admitted at 44.9 s cannot finish
before 59.9 s even before the DB writes — 45 + 15 = 60, exactly the limit,
with zero margin for the rest of the hot path or response serialization.

## Design

New `api/_lib/wall-budget.ts`:

```ts
createWallBudget({ startMs, budgetMs, reserveMs, now? }): WallBudget
  canStartAnother(): boolean  // now + reserveMs <= startMs + budgetMs
  exhausted(): boolean        // now > startMs + budgetMs
  elapsedMs(): number
  remainingMs(): number
```

`now` is injectable so tests drive the clock instead of sleeping.

The invariant: **the last unit admitted starts no later than
`budget - reserve`, so it finishes by `budget` even in its worst case, leaving
`maxDuration - budget` for the response.**

Deferred work is not lost in any of the three — each cron's un-processed
remainder rolls to its next run by existing design.

## Constants

| cron                       | maxDuration       | budget           | reserve               | last unit starts by |
| -------------------------- | ----------------- | ---------------- | --------------------- | ------------------- |
| `cleanup-ws-option-trades` | 300 s (unchanged) | 295 s            | 30 s                  | 265 s               |
| `detect-lottery-fires`     | 60 s (unchanged)  | 45 s (unchanged) | 20 s fire / 5 s group | 25 s                |
| `detect-silent-boom`       | 60 s (unchanged)  | TBD — see below  | TBD                   | —                   |

**Correction (mid-implementation).** The plan first proposed raising
`detect-lottery-fires`' budget 45 → 55 s. That is wrong. `detect-lottery-fires`
already carries a pinning test asserting
`DETECT_WALL_BUDGET_MS <= maxDuration*1000 - 10_000`, written when the same
timeout was seen on 2026-08-19 — a deliberate 10 s-minimum headroom rule.
Raising the budget would violate it and _reduce_ safety. The budget stays at
45 s; the reserve is what fixes the bug, since headroom alone provably cannot
(15 s of headroom against a 15 s classifier timeout leaves zero for the fire's
other awaits). Last fire now starts by 25 s and finishes by 45 s worst case,
leaving 15 s to the 60 s limit.

Reserve rationale: any unit containing a classify call inherits the multileg
client's 15 s timeout, plus DB work → 20 s. A 50 000-row DELETE is unmeasured
in production → 30 s, deliberately generous; it rarely binds because daily
steady state drains in 2–3 min.

`detect-lottery-fires` trades throughput for reliability: it stops admitting
fires at 25 s instead of 45 s. That is the correct trade — a timeout loses the
entire run and its partial-result reporting, while a deferred fire is
re-detected by the next minute's run with no cooldown seed.

## Files

**Create**

- `api/_lib/wall-budget.ts`
- `api/__tests__/wall-budget.test.ts`

**Modify**

- `api/cron/cleanup-ws-option-trades.ts` — adopt helper, add reserve
- `api/cron/detect-lottery-fires.ts` — adopt helper, add per-loop reserves (budget unchanged)
- `api/cron/detect-silent-boom.ts` — add budget + reserve (currently none), pending the
  safety check that truncating its fire loop defers rather than drops work
- the three crons' existing test files — budget-behaviour cases

## Out of scope

`enrich-lottery-outcomes` has the same `pastDeadline` shape (240 s budget /
300 s limit). Its 60 s margin has not produced a timeout, so it is left alone
here and noted as a follow-up migration to the helper.

## Open questions

None blocking. The reserve values are engineering judgment, not measurements;
if timeouts persist the reserves are the first dial to turn.
