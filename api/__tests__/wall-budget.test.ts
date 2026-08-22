import { describe, expect, it } from 'vitest';

import { createWallBudget } from '../_lib/wall-budget.js';

/**
 * The bug this module exists to prevent: a budget that gates ENTRY to a unit
 * of work but reserves nothing for that unit to COMPLETE. A unit admitted
 * just under the deadline runs its full duration on top and overruns the
 * function's hard maxDuration.
 *
 * The clock is injected so these assert the arithmetic directly rather than
 * sleeping.
 */
describe('createWallBudget', () => {
  const START = 1_000_000;

  /** Budget whose clock we drive by assigning to `clock.t`. */
  function at(t: number, budgetMs = 55_000, reserveMs = 20_000) {
    const clock = { t };
    const budget = createWallBudget({
      startMs: START,
      budgetMs,
      reserveMs,
      now: () => clock.t,
    });
    return { budget, clock };
  }

  it('admits work while a full reserve still fits before the deadline', () => {
    // 30s elapsed of a 55s budget → 25s left, reserve is 20s → fits.
    const { budget } = at(START + 30_000);
    expect(budget.canStartAnother()).toBe(true);
    expect(budget.exhausted()).toBe(false);
  });

  it('refuses work once less than one reserve remains — the whole point', () => {
    // 40s elapsed of a 55s budget → 15s left, reserve is 20s → does NOT fit,
    // even though the budget itself has 15s to run.
    const { budget } = at(START + 40_000);
    expect(budget.canStartAnother()).toBe(false);
    // Critically, the budget is NOT yet exhausted: the old `pastDeadline()`
    // check would have admitted this unit and blown through maxDuration.
    expect(budget.exhausted()).toBe(false);
  });

  it('admits at exactly the last safe instant, refuses one ms later', () => {
    // Boundary: last unit may start at budget - reserve = 35s.
    const { budget, clock } = at(START + 35_000);
    expect(budget.canStartAnother()).toBe(true);
    clock.t = START + 35_001;
    expect(budget.canStartAnother()).toBe(false);
  });

  it('reports exhausted only after the budget itself elapses', () => {
    const { budget, clock } = at(START + 55_000);
    expect(budget.exhausted()).toBe(false);
    clock.t = START + 55_001;
    expect(budget.exhausted()).toBe(true);
    expect(budget.canStartAnother()).toBe(false);
  });

  it('tracks elapsed and remaining against the budget', () => {
    const { budget } = at(START + 12_500);
    expect(budget.elapsedMs()).toBe(12_500);
    expect(budget.remainingMs()).toBe(42_500);
  });

  it('clamps remaining at zero rather than going negative', () => {
    const { budget } = at(START + 90_000);
    expect(budget.remainingMs()).toBe(0);
    expect(budget.elapsedMs()).toBe(90_000);
  });

  it('a zero reserve degrades to the old past-deadline behaviour', () => {
    // Documents the relationship to the pattern being replaced: with no
    // reserve, canStartAnother() is exactly "not past the deadline".
    const { budget, clock } = at(START + 54_999, 55_000, 0);
    expect(budget.canStartAnother()).toBe(true);
    clock.t = START + 55_001;
    expect(budget.canStartAnother()).toBe(false);
  });

  it('refuses immediately when the reserve exceeds the whole budget', () => {
    // Misconfiguration guard: nothing can safely start, so admit nothing
    // rather than admitting one unit that is guaranteed to overrun.
    const { budget } = at(START, 10_000, 20_000);
    expect(budget.canStartAnother()).toBe(false);
    expect(budget.exhausted()).toBe(false);
  });

  it('rejects a negative reserve or budget at construction', () => {
    expect(() =>
      createWallBudget({ startMs: START, budgetMs: -1, reserveMs: 0 }),
    ).toThrow(/budgetMs/);
    expect(() =>
      createWallBudget({ startMs: START, budgetMs: 1000, reserveMs: -1 }),
    ).toThrow(/reserveMs/);
  });

  it('defaults to Date.now when no clock is injected', () => {
    const budget = createWallBudget({
      startMs: Date.now(),
      budgetMs: 60_000,
      reserveMs: 1_000,
    });
    expect(budget.canStartAnother()).toBe(true);
    expect(budget.elapsedMs()).toBeGreaterThanOrEqual(0);
  });
});
