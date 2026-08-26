/**
 * Data-integrity rules for per-strike Greek exposure.
 *
 * Exists because of two vendor behaviours that collide the same key and
 * demand opposite resolutions.
 *
 * The first: `greek-exposure/strike-expiry` returns the AM-settled and
 * PM-settled series for a monthly expiry merged into one array **with no
 * field that tells them apart**. UW staff confirmed this on 2026-08-21;
 * reproduced live on 2026-08-25, where 2026-08-21 came back as 1,090 rows
 * carrying 590 unique `(expiry, strike)` keys — 500 duplicated, 293 of those
 * with different greeks — while the neighbouring non-OPEX session was
 * perfectly unique. Two real series → their sum is the total exposure.
 *
 * The second, observed once (2025-10-14, found by the Trading-Bot gamma
 * rebuild): the same endpoint served every strike on 35 SPXW-only expiries
 * **twice**, as two intraday snapshot vintages of one series — pairs a
 * median 1.53% apart. One series served twice → summing doubles the day
 * (~1.56M vs a plausible 785k gross); the mean recovers it.
 *
 * The two cases are told apart by OSI root evidence from
 * `/stock/SPX/option-chains?date=D`, which the payload itself drops: an
 * AM/PM merge happens only on expiries listed under **both** roots (SPX and
 * SPXW), while snapshot duplicates arrive on single-root expiries. A caller
 * holding that evidence passes it as `dualRootExpiries` and the rule is
 * resolved per expiry; without it, the uniform batch rule applies.
 *
 * `greek_exposure_strike` is keyed `UNIQUE (date, expiry, strike)`, so an
 * upsert of that payload discarded one series per collided strike and said
 * nothing. Roughly twelve sessions a year, all of them monthly OPEX, which
 * are the highest-gamma days of the month.
 *
 * What this module does NOT do is invent a discriminator. The vendor does not
 * send one, so there is no honest way to label a row AM or PM. What it does
 * instead is make the collision *impossible to ignore*: either the caller
 * names a deterministic rule for combining the rows — which is then applied
 * and recorded on every affected row — or ingestion refuses.
 *
 * A note on the field the owner asked to key on. The requested duplicate key
 * was `(underlying, expiry, strike, option_type, observed_at)`. The payload
 * carries none of the last three: a vendor row holds *both* `call_*` and
 * `put_*` columns, so it is not per-option-type; and there is no timestamp of
 * any kind. `observed_at` is therefore stamped by us at fetch time and is
 * constant within one fetch, which makes it useless as a disambiguator. The
 * key actually enforced is `(underlying, expiry, strike)` within a single
 * response — the strongest key the data supports — and everything else is
 * recorded as provenance rather than pretended to be identity.
 */

// ── Spec version ──────────────────────────────────────────────

/**
 * Version of the per-strike ingestion contract.
 *
 * 1 — original. `ON CONFLICT (date, expiry, strike) DO UPDATE` against a
 *     payload whose key is not unique on monthly expiries. Rows written under
 *     this version are **not trustworthy on OPEX dates** and carry
 *     `spec_version IS NULL` because the column did not exist.
 * 2 — collisions resolved by a named, recorded rule; provenance
 *     (`observed_at`, `spot`, `spot_observed_at`, `calculated_at`,
 *     `source_rows`, `dedupe_rule`, `spec_version`, `source_commit`) written
 *     on every row.
 * 3 — the rule is now chosen per expiry by OSI root evidence when available:
 *     dual-root (SPX + SPXW) expiries are genuine AM/PM merges and are still
 *     summed, while single-root snapshot duplicates are averaged, not summed.
 *
 * Bump this when the meaning of a stored row changes. Research code should
 * filter on it rather than assume every row in the table was produced the
 * same way.
 */
export const GEX_STRIKE_SPEC_VERSION = 3;

/**
 * Rows at or above this version may be used for research without caveat.
 * Spec-2 rows stay trusted because the snapshot failure mode spec 3 guards
 * against recurred roughly once in three years and was not observed during
 * the one-session spec-2 window.
 */
export const GEX_STRIKE_MIN_TRUSTED_SPEC_VERSION = 2;

// ── Duplicate handling ────────────────────────────────────────

/**
 * `strict` — refuse the batch. Correct when a caller cannot tolerate an
 *   assumption about what the duplicate means.
 * `sum` — add the numeric greeks across the collided rows. The defensible
 *   reading for the AM/PM merge: both series are real open interest at that
 *   strike on that expiry date, so total dealer exposure is their sum, and
 *   it is what UW's own web platform displays for a combined view.
 * `mean` — average them instead. The defensible reading for repeated
 *   snapshots of ONE series: averaging recovers the series, while summing
 *   doubles it. Observed 2025-10-14, where 35 SPXW-only expiries each
 *   arrived twice as two intraday vintages, pairs a median 1.53% apart.
 */
export type DedupeRule = 'strict' | 'sum' | 'mean';

/**
 * The rule ingestion runs under. `sum` rather than `strict` because a strict
 * default would take the daily job down on every monthly OPEX — trading one
 * silent failure for a loud one on exactly the days the data matters most.
 * The rule is recorded on every row it touches, so a consumer can always tell
 * a summed row from an untouched one.
 */
export const DEFAULT_DEDUPE_RULE: DedupeRule = 'sum';

/**
 * The relative spread below which a summed collision pair looks like a
 * probable snapshot duplicate rather than a genuine AM/PM merge. Only
 * consulted when no root evidence is available — it flags "these rows were
 * summed but they look like one series served twice, so the day's gamma may
 * be doubled" for a human to check. The measured distributions sit far
 * apart: snapshot pairs were a median 1.53% apart (p95 18.4%), AM/PM pairs a
 * median ~87%. Five percent catches the bulk of the former without tripping
 * on the latter.
 */
export const NEAR_IDENTICAL_REL_DIFF = 0.05;

/**
 * Numeric columns combined by the resolution rules — summed under `sum`,
 * averaged under `mean` — and the columns `maxRelDiff` measures its spread
 * over.
 */
const SUMMABLE = [
  'call_gex',
  'put_gex',
  'call_delta',
  'put_delta',
  'call_charm',
  'put_charm',
  'call_vanna',
  'put_vanna',
] as const;

export type SummableField = (typeof SUMMABLE)[number];

/**
 * The three fields the collision rule needs, and nothing more.
 *
 * Deliberately no index signature. An interface without one is not assignable
 * to a type that has one, so requiring `[field: string]: unknown` here would
 * reject every caller whose row type is a plain interface — which is all of
 * them, and which the production build catches even though a bare
 * `tsc --noEmit` on the root config does not. The greek columns are read
 * through one narrow cast below instead of being pushed into every caller's
 * type.
 */
export interface StrikeKeyed {
  date: string;
  expiry: string;
  strike: string;
}

export interface Collision {
  date: string;
  expiry: string;
  strike: string;
  /** How many vendor rows shared the key. */
  rows: number;
  /** True when the collided rows carried identical greeks. */
  identical: boolean;
  /**
   * The rule applied to this collision — or, on the strict-throw path, the
   * rule that WOULD have applied had the caller allowed a resolution.
   */
  rule: 'sum' | 'mean';
  /**
   * Max over the summable fields of the group's relative spread
   * `(hi − lo) / max(|hi|, |lo|)`, 0 when a field is 0 everywhere. Near
   * zero → probable snapshot duplicate; large → genuine AM/PM divergence.
   */
  maxRelDiff: number;
}

export interface DedupeResult<T extends StrikeKeyed> {
  rows: (T & { source_rows: number; dedupe_rule: DedupeRule })[];
  collisions: Collision[];
  /** The batch rule. Combined rows may carry a per-expiry override. */
  rule: DedupeRule;
}

export class DuplicateStrikeRowsError extends Error {
  readonly collisions: Collision[];

  constructor(collisions: Collision[]) {
    const sample = collisions
      .slice(0, 3)
      .map((c) => `${c.expiry}@${c.strike}×${c.rows}`)
      .join(', ');
    super(
      `${collisions.length} duplicate (underlying, expiry, strike) key(s) in one ` +
        `response and dedupe rule is 'strict': ${sample}` +
        (collisions.length > 3 ? ', …' : '') +
        '. The vendor merges AM- and PM-settled series with no discriminator; ' +
        "pass rule: 'sum' to combine them (or rule: 'mean' for snapshot " +
        'duplicates, or dualRootExpiries to resolve per expiry from root ' +
        'evidence), and the choice will be recorded on every affected row.',
    );
    this.name = 'DuplicateStrikeRowsError';
    this.collisions = collisions;
  }
}

const keyOf = (r: StrikeKeyed) => `${r.date}|${r.expiry}|${r.strike}`;

/** Read a greek column off a row whose type does not declare an index. */
const fieldOf = (row: StrikeKeyed, field: string): unknown =>
  (row as unknown as Record<string, unknown>)[field];

const num = (v: unknown): number => {
  const n = Number.parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Collapse rows that share `(date, expiry, strike)` under the named rule.
 *
 * Order-independent by construction: `sum` and `mean` are both commutative,
 * so unlike the upsert it replaces, the result does not depend on which
 * series the vendor happened to list first. Rows that did not collide are
 * returned unchanged apart from `source_rows: 1` and the batch rule as
 * `dedupe_rule`, which is what lets a consumer separate a combined row from
 * an original one without guessing.
 *
 * `dualRootExpiries` is the OSI root evidence from the option-chains
 * endpoint (see the module header): when supplied, the rule is resolved per
 * expiry — dual-root → `sum` (genuine AM/PM merge), single-root → `mean`
 * (snapshot duplicate) — and each combined row records the rule that
 * actually touched it. When absent, the uniform batch rule applies.
 */
export function dedupeStrikeRows<T extends StrikeKeyed>(
  rows: T[],
  options: { rule?: DedupeRule; dualRootExpiries?: ReadonlySet<string> } = {},
): DedupeResult<T> {
  const rule = options.rule ?? DEFAULT_DEDUPE_RULE;
  const { dualRootExpiries } = options;

  // The rule a collision on this expiry gets — or, under `strict`, the rule
  // it would have gotten, so the thrown collisions still say what a
  // permissive caller would have done.
  const resolveRule = (expiry: string): 'sum' | 'mean' => {
    if (dualRootExpiries) return dualRootExpiries.has(expiry) ? 'sum' : 'mean';
    return rule === 'mean' ? 'mean' : 'sum';
  };

  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const collisions: Collision[] = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const identical = group.every((r) =>
      SUMMABLE.every(
        (f) => String(fieldOf(r, f) ?? '') === String(fieldOf(first, f) ?? ''),
      ),
    );
    let maxRelDiff = 0;
    for (const field of SUMMABLE) {
      const values = group.map((r) => num(fieldOf(r, field)));
      const hi = Math.max(...values);
      const lo = Math.min(...values);
      const denom = Math.max(Math.abs(hi), Math.abs(lo));
      const rel = denom === 0 ? 0 : (hi - lo) / denom;
      if (rel > maxRelDiff) maxRelDiff = rel;
    }
    collisions.push({
      date: first.date,
      expiry: first.expiry,
      strike: first.strike,
      rows: group.length,
      identical,
      rule: resolveRule(first.expiry),
      maxRelDiff,
    });
  }

  if (collisions.length > 0 && rule === 'strict') {
    throw new DuplicateStrikeRowsError(collisions);
  }

  const out: (T & { source_rows: number; dedupe_rule: DedupeRule })[] = [];
  for (const [, group] of groups) {
    const first = group[0]!;
    if (group.length === 1) {
      out.push({ ...first, source_rows: 1, dedupe_rule: rule });
      continue;
    }
    const applied = resolveRule(first.expiry);
    const combined: Record<string, unknown> = {
      ...(first as unknown as Record<string, unknown>),
    };
    for (const field of SUMMABLE) {
      const total = group.reduce((sum, r) => sum + num(fieldOf(r, field)), 0);
      const value = applied === 'mean' ? total / group.length : total;
      combined[field] = value.toString();
    }
    out.push({
      ...(combined as T),
      source_rows: group.length,
      dedupe_rule: applied,
    });
  }
  return { rows: out, collisions, rule };
}

// ── Expiry classification ─────────────────────────────────────

/**
 * Whether an ISO date is a monthly OPEX (the third Friday).
 *
 * Used for *reporting and mode selection only*. No key, anywhere, is derived
 * from it: labelling a row "OPEX" and bucketing by that label would lose the
 * expiry, which is the thing that must survive.
 */
export function isOpexExpiry(isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCDay() !== 5) return false; // not a Friday
  const dayOfMonth = Number(d);
  return dayOfMonth >= 15 && dayOfMonth <= 21; // the third Friday
}

// ── Aggregation modes ─────────────────────────────────────────

/**
 * `all_expiries`  — every expiry in the set, each kept separate.
 * `target_expiry` — one named expiry only.
 * `opex_only`     — only monthly-OPEX expiries, still one row per expiry.
 *
 * Three names rather than a boolean, because "aggregate the gamma" is
 * ambiguous in a way that silently changes the number: a caller that means
 * 0DTE and a caller that means the whole surface should not be able to write
 * the same call.
 */
export type AggregationMode = 'all_expiries' | 'target_expiry' | 'opex_only';

export const AGGREGATION_MODES: readonly AggregationMode[] = [
  'all_expiries',
  'target_expiry',
  'opex_only',
] as const;

/**
 * The default, and the one the 0DTE ingestion runs under. `target_expiry`
 * because every existing consumer of this table asks for a single session's
 * chain; defaulting to `all_expiries` would silently widen every one of them.
 */
export const DEFAULT_AGGREGATION_MODE: AggregationMode = 'target_expiry';

export function selectByMode<T extends { expiry: string }>(
  rows: T[],
  mode: AggregationMode = DEFAULT_AGGREGATION_MODE,
  options: { targetExpiry?: string } = {},
): T[] {
  switch (mode) {
    case 'all_expiries':
      return [...rows];
    case 'opex_only':
      return rows.filter((r) => isOpexExpiry(r.expiry));
    case 'target_expiry': {
      const target = options.targetExpiry;
      if (!target) {
        throw new Error(
          "aggregation mode 'target_expiry' requires options.targetExpiry",
        );
      }
      return rows.filter((r) => r.expiry === target);
    }
    default: {
      const exhaustive: never = mode;
      throw new Error(`unknown aggregation mode: ${String(exhaustive)}`);
    }
  }
}

// ── Reconciliation ────────────────────────────────────────────

export interface Reconciliation {
  ok: boolean;
  perExpiryTotal: number;
  aggregateTotal: number;
  difference: number;
  tolerance: number;
}

/**
 * The sum of the expiry-level totals must equal the aggregate.
 *
 * Absolute tolerance, not relative: these are dollar-gamma magnitudes in the
 * hundreds of thousands, and a relative epsilon would wave through an error
 * larger than a whole strike's exposure. The default admits float
 * re-association across a few hundred addends and nothing more.
 */
export function reconcileExpiryTotals(
  perExpiry: Iterable<number>,
  aggregate: number,
  tolerance = 1e-6,
): Reconciliation {
  let perExpiryTotal = 0;
  for (const v of perExpiry) perExpiryTotal += v;
  const difference = Math.abs(perExpiryTotal - aggregate);
  return {
    ok: difference <= tolerance,
    perExpiryTotal,
    aggregateTotal: aggregate,
    difference,
    tolerance,
  };
}

// ── Spot freshness ────────────────────────────────────────────

/**
 * `verified`   — a spot price with a timestamp inside the freshness window.
 * `stale`      — a spot price whose timestamp is outside it.
 * `unverified` — no spot, or a spot with no timestamp to check.
 */
export type SpotFreshness = 'verified' | 'stale' | 'unverified';

/**
 * UW staff confirmed on 2026-08-21 that premarket gamma — SPX *and* VIX — is
 * computed against a spot that is not fresh. The vendor does not say so in
 * the payload: `greek-exposure/strike-expiry` carries no spot and no
 * timestamp at all, only a date. So freshness cannot be read off the gamma
 * response and has to be established separately, from
 * `/stock/{t}/spot-exposures/strike`, which does return `price` **and**
 * `time`.
 *
 * Rows are flagged rather than dropped. A stale-spot row is still the
 * vendor's own published exposure and still belongs in the archive; what must
 * not happen is a consumer treating it as a live reading. The flag makes that
 * a filter rather than a guess.
 */
export function assessSpotFreshness(input: {
  spot: number | null | undefined;
  spotObservedAt: string | null | undefined;
  now: Date;
  maxAgeSeconds?: number;
}): { freshness: SpotFreshness; ageSeconds: number | null } {
  const { spot, spotObservedAt, now, maxAgeSeconds = 900 } = input;
  if (spot === null || spot === undefined || !Number.isFinite(spot)) {
    return { freshness: 'unverified', ageSeconds: null };
  }
  if (!spotObservedAt) return { freshness: 'unverified', ageSeconds: null };
  const observed = new Date(spotObservedAt);
  if (Number.isNaN(observed.getTime())) {
    return { freshness: 'unverified', ageSeconds: null };
  }
  const ageSeconds = (now.getTime() - observed.getTime()) / 1000;
  return {
    freshness: ageSeconds <= maxAgeSeconds ? 'verified' : 'stale',
    ageSeconds,
  };
}

// ── Invalidating what the faulty version wrote ────────────────

/**
 * Whether a stored row can be trusted for research.
 *
 * The blunt reading of "invalidate prior outputs" would be to exclude every
 * row written before spec 2 — but that would throw away years of correct
 * data to fix twelve days a year. The bug had a precise footprint: the vendor
 * only merges AM and PM series on **monthly expiries**, verified directly
 * against the API (2026-08-21 came back with 500 duplicated keys; 2026-08-20
 * with none). A pre-fix row on a non-OPEX expiry was written from a payload
 * that had nothing to collide, so it is exactly as good as a post-fix one.
 *
 * So the invalidation is surgical: a row is untrusted when it predates the
 * fix **and** its expiry is a monthly OPEX. Everything else stands.
 *
 * Note this keys off `expiry`, not the trade date: the collision belongs to
 * the expiry whose two settlement series were merged.
 */
export function isTrustedStrikeRow(row: {
  spec_version?: number | null;
  expiry: string;
}): boolean {
  const version = row.spec_version ?? 0;
  if (version >= GEX_STRIKE_MIN_TRUSTED_SPEC_VERSION) return true;
  return !isOpexExpiry(row.expiry);
}

/**
 * The same rule as a SQL predicate, for queries that must not pull the
 * untrusted rows across the wire in the first place.
 *
 * Postgres has no third-Friday function, so the OPEX test is spelled out:
 * day-of-week 5 and day-of-month between 15 and 21.
 */
export const TRUSTED_STRIKE_ROW_SQL = `(
  COALESCE(spec_version, 0) >= ${GEX_STRIKE_MIN_TRUSTED_SPEC_VERSION}
  OR NOT (
    EXTRACT(ISODOW FROM expiry) = 5
    AND EXTRACT(DAY FROM expiry) BETWEEN 15 AND 21
  )
)`;
