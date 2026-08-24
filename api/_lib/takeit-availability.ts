/**
 * Is a TAKE-IT model actually published for this feed + date?
 *
 * The floor is applied server-side and deliberately excludes NULL scores
 * (`api/lottery-finder.ts`, `api/silent-boom-feed.ts`) — while a model exists
 * that is right, since an unscored row really is below the floor.
 *
 * It is wrong when NO model is published. `NULL >= 0.70` evaluates to NULL, so
 * every row drops and the feed goes silently empty with no indication why.
 * That shipped: on 2026-08-23 the bundles were missing from Blob entirely
 * (`takeit/latest.json` absent), leaving 16,858/16,858 lottery fires and
 * 634/634 silent boom alerts unscored — both feeds returned zero rows at the
 * default 0.70 floor.
 *
 * This probe separates "everything failed the filter" from "there is no filter
 * to apply", so the caller can fail the floor OPEN in the second case only.
 *
 * Spec: docs/superpowers/specs/takeit-floor-fail-open-2026-08-23.md
 */

import type { getDb } from './db.js';

export type TakeitFeed = 'lottery' | 'silent_boom';

export interface TakeitCoverage {
  /** Rows for that feed on that date. */
  total: number;
  /** Rows carrying a non-NULL `takeit_prob`. */
  scored: number;
  /**
   * True only when rows exist AND none of them are scored.
   *
   * The `total > 0` half is load-bearing: weekends and holidays have zero
   * fires, and reporting "model unavailable" on an empty day would show a
   * false banner every non-trading day.
   */
  unavailable: boolean;
}

/** Raw count columns — the Neon driver returns aggregates as STRINGS. */
interface CoverageRow {
  total: number | string | null;
  scored: number | string | null;
}

export async function getTakeitCoverage(
  db: ReturnType<typeof getDb>,
  feed: TakeitFeed,
  date: string,
): Promise<TakeitCoverage> {
  // Two literal branches rather than an interpolated table name: the Neon
  // driver only takes tagged templates, and a dynamic identifier would need
  // db.unsafe() for no benefit over an exhaustive two-way switch.
  const rows = (await (feed === 'lottery'
    ? db`
        SELECT count(*)::int AS total, count(takeit_prob)::int AS scored
          FROM lottery_finder_fires
         WHERE date = ${date}::date
      `
    : db`
        SELECT count(*)::int AS total, count(takeit_prob)::int AS scored
          FROM silent_boom_alerts
         WHERE date = ${date}::date
      `)) as CoverageRow[];

  const row = rows[0];
  const total = Number(row?.total ?? 0);
  const scored = Number(row?.scored ?? 0);

  return { total, scored, unavailable: total > 0 && scored === 0 };
}
