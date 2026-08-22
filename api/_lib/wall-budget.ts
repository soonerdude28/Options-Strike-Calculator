/**
 * Wall-clock budget that reserves time for the work it admits.
 *
 * Several crons loop over units of work under a wall budget so they can
 * return a partial result instead of being killed at `maxDuration`. The
 * pattern they all used was:
 *
 * ```ts
 * const pastDeadline = () => Date.now() > startMs + WALL_BUDGET_MS;
 * for (const item of items) {
 *   if (pastDeadline()) break;   // gates ENTRY
 *   await doExpensiveWork(item); // …but nothing reserves time for THIS
 * }
 * ```
 *
 * That check gates *entry* to a unit and reserves nothing for the unit to
 * *complete*, so a unit admitted just under the deadline runs its full
 * duration on top and overruns the hard limit — losing the whole response,
 * including the partial-result reporting the budget existed to produce.
 * Three crons timed out this way (see
 * docs/superpowers/specs/cron-wall-budget-reserve-2026-08-21.md);
 * `detect-lottery-fires` was the clearest: a 45 s budget admitting a fire
 * whose multileg call alone can take 15 s, under a 60 s limit.
 *
 * `canStartAnother()` encodes the missing invariant: **the last unit admitted
 * starts no later than `budget - reserve`, so it finishes by `budget` even in
 * its worst case, leaving `maxDuration - budget` for the response.**
 *
 * Pick `reserveMs` as the worst-case duration of ONE unit — for anything
 * containing a classify call that is at least the multileg client's
 * `DEFAULT_TIMEOUT_MS`, plus its DB work.
 */

export interface WallBudget {
  /**
   * True when a full `reserveMs` still fits before the deadline — i.e. it is
   * safe to begin one more unit of work. This is the check loops should use.
   */
  canStartAnother(): boolean;
  /**
   * True once the budget itself has elapsed. Distinct from
   * `!canStartAnother()`, which trips `reserveMs` earlier — that gap is the
   * whole point, so report the two separately when logging.
   */
  exhausted(): boolean;
  /** Milliseconds since `startMs`. Not clamped to the budget. */
  elapsedMs(): number;
  /** Milliseconds left in the budget, clamped at 0. */
  remainingMs(): number;
}

export interface WallBudgetOptions {
  /** Anchor for the budget — normally the handler's own start timestamp. */
  startMs: number;
  /** Total wall-clock allowance, comfortably inside `maxDuration`. */
  budgetMs: number;
  /** Worst-case duration of a single unit of work. */
  reserveMs: number;
  /** Injectable clock; tests drive this instead of sleeping. */
  now?: () => number;
}

export function createWallBudget({
  startMs,
  budgetMs,
  reserveMs,
  now = Date.now,
}: WallBudgetOptions): WallBudget {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new Error(`createWallBudget: budgetMs must be >= 0, got ${budgetMs}`);
  }
  if (!Number.isFinite(reserveMs) || reserveMs < 0) {
    throw new Error(
      `createWallBudget: reserveMs must be >= 0, got ${reserveMs}`,
    );
  }

  const deadlineMs = startMs + budgetMs;
  // The latest instant a unit may begin and still be expected to finish
  // inside the budget. When reserveMs > budgetMs this lands before startMs,
  // so nothing is ever admitted — the safe reading of that misconfiguration,
  // since any admitted unit would be guaranteed to overrun.
  const lastSafeStartMs = deadlineMs - reserveMs;

  return {
    canStartAnother: () => now() <= lastSafeStartMs,
    exhausted: () => now() > deadlineMs,
    elapsedMs: () => now() - startMs,
    remainingMs: () => Math.max(0, deadlineMs - now()),
  };
}
