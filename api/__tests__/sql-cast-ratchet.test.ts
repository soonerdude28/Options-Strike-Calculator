// @vitest-environment node

/**
 * Ratchet: no NEW bare `(await sql`...`) as SomeRow[]` assertions.
 *
 * Why this exists
 * ---------------
 * The Neon serverless driver returns Postgres **NUMERIC as a JS string** and
 * **BIGINT as a JS string**. A cast like `(await sql`...`) as FireRow[]`, where
 * FireRow declares those columns `number`, is a TYPE LIE: tsc is satisfied and
 * the runtime value is a string. It has caused four production bugs here:
 *
 *   2826ee4a + 9954d585  BIGINT id ("1") used as a JS Map key against an int4
 *                        from unnest (1). Map does not coerce -> every lookup
 *                        missed -> 1,234 outcome rows silently voided.
 *   7e262c82             NUMERIC-as-string corrupted peak / minutes-to-peak.
 *   fcce72d6             flow_data.ncp/npp ("-800000000.00") compared with `<`,
 *                        which between two strings is LEXICOGRAPHIC. 21.5% of
 *                        production rows flipped Market Tide direction inside
 *                        the Anthropic analyze prompt.
 *
 * None of these were caught by tsc, and none by tests — because the tests
 * mocked the DECLARED type (numbers) rather than what the driver actually
 * returns (strings).
 *
 * What to do instead
 * ------------------
 * Coerce at the boundary, the way db-flow.ts:64 and analyze-context-formatters
 * do: declare a Raw* interface whose NUMERIC/BIGINT fields are
 * `number | string`, then map with Number() so the downstream type is honest.
 *
 *   interface RawFooRow extends Omit<FooRow, 'ncp'> { ncp: number | string }
 *   const rows = ((await sql`...`) as RawFooRow[]).map(toFooRow);
 *
 * Casting inside the SQL (`x::float8`, `count(*)::int`) is equally fine and
 * often better — those come back as real JS numbers.
 *
 * This test does not claim the 39 grandfathered casts are correct. It only
 * stops the count from growing while they are worked through.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import allowlist from './sql-cast-allowlist.json';

/** `) as SomeRow[]` where the cast closes a template literal (a SQL query). */
const CAST_RE = /\)\s*as\s+([A-Z]\w*)\[\]/g;
const CLOSES_TEMPLATE_RE = /`\s*\)\s*as\s+[A-Z]/;

type Inventory = Record<string, Record<string, number>>;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, out);
    } else if (e.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

function inventory(): Inventory {
  const inv: Inventory = {};
  for (const file of walk('api')) {
    const src = readFileSync(file, 'utf8');
    for (const line of src.split('\n')) {
      if (!CLOSES_TEMPLATE_RE.test(line)) continue;
      CAST_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CAST_RE.exec(line)) !== null) {
        const rel = file.replace(/\\/g, '/');
        inv[rel] ??= {};
        inv[rel]![m[1]!] = (inv[rel]![m[1]!] ?? 0) + 1;
      }
    }
  }
  return inv;
}

const HINT =
  '\n\nThe Neon driver returns NUMERIC and BIGINT as STRINGS, so casting a raw ' +
  'query result to a type declaring `number` is a lie tsc cannot see. Coerce at ' +
  'the boundary (a Raw* interface + a Number() mapper, like db-flow.ts:64), or ' +
  'cast in the SQL (::float8 / ::int). If you genuinely need the cast, add it to ' +
  'api/__tests__/sql-cast-allowlist.json and say why in the commit message.';

describe('SQL result casts do not grow', () => {
  const current = inventory();
  const allowed = allowlist as Inventory;

  it('adds no cast in a file that had none', () => {
    const added = Object.keys(current).filter((f) => !(f in allowed));
    expect(
      added,
      `New file with a bare SQL cast: ${added.join(', ')}${HINT}`,
    ).toEqual([]);
  });

  it('adds no cast to a file that already had some', () => {
    const grew: string[] = [];
    for (const [file, types] of Object.entries(current)) {
      const base = allowed[file];
      if (!base) continue;
      for (const [type, n] of Object.entries(types)) {
        const was = base[type] ?? 0;
        if (n > was) grew.push(`${file} :: ${type} (${was} -> ${n})`);
      }
    }
    expect(
      grew,
      `Bare SQL casts increased:\n  ${grew.join('\n  ')}${HINT}`,
    ).toEqual([]);
  });

  it('keeps the allowlist honest when casts are removed', () => {
    // Not a failure mode worth blocking on, but a stale allowlist hides
    // regressions: if a file drops to zero it should leave the list.
    const stale = Object.keys(allowed).filter((f) => !(f in current));
    expect(
      stale,
      `These files no longer contain SQL casts — remove them from ` +
        `sql-cast-allowlist.json so the ratchet keeps its teeth: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
