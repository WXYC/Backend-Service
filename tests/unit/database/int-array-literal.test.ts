/**
 * Unit tests for `intArrayLiteral` (BS#2010 / shared/database/src/int-array-literal.ts).
 *
 * The canonical fix for the bare-JS-array-in-`ANY()` trap: Drizzle (and
 * postgres-js) splat a JS array interpolated into a `sql` template across N
 * positional placeholders — `ANY(($1, $2, … $n))`, a row constructor, not an
 * array. Postgres rejects that at parse time (42809, "op ANY/ALL (array)
 * requires array on right side" — the BS#1068/BS#1071/#2007 family). Binding
 * one PG-array-literal string (`'{1,2,3}'`) and casting it in SQL
 * (`::int[]`) sidesteps the splat entirely.
 *
 * This helper used to be duplicated (six private copies, one per call site)
 * with a comment claiming the splice was "safe by construction because
 * TypeScript types `ids: number[]`" — not true, since the values usually
 * arrive via an unchecked `as unknown as` cast over raw driver output, with
 * no runtime check that every element is actually an integer. These tests
 * pin the validation this version adds: a genuine integer array still
 * produces the same `'{1,2,3}'` form (no behavior change for the six call
 * sites), but anything that isn't a clean integer is rejected rather than
 * spliced as raw SQL text.
 */

import { intArrayLiteral } from '../../../shared/database/src/int-array-literal';

describe('intArrayLiteral', () => {
  it('builds the PG array-literal form for a non-empty integer array', () => {
    expect(intArrayLiteral([1, 2, 3])).toBe('{1,2,3}');
  });

  it('returns the empty PG array literal for an empty array', () => {
    expect(intArrayLiteral([])).toBe('{}');
  });

  it('handles a single-element array', () => {
    expect(intArrayLiteral([42])).toBe('{42}');
  });

  it('handles negative integers', () => {
    expect(intArrayLiteral([-1, 0, 1])).toBe('{-1,0,1}');
  });

  it('coerces a clean numeric string element (e.g. a bigint column read back by postgres-js) into its integer form', () => {
    // postgres-js returns bigint columns as strings. A caller that has cast
    // driver output straight through (`as unknown as Array<{ id: number }>`
    // over what's actually a bigint column) can hand this function a numeric
    // string. `Number(...)` normalizes it to the same literal a genuine
    // number would have produced.
    expect(intArrayLiteral(['7' as unknown as number, 8, 9])).toBe('{7,8,9}');
  });

  it('throws rather than splicing a non-integer element as raw SQL text', () => {
    // The historical "safe by construction" comment was false: nothing
    // stopped a non-integer value from being joined straight into the SQL
    // string. This is the validation that makes the comment true.
    expect(() => intArrayLiteral([1, 1.5, 3])).toThrow(/integer/i);
  });

  it('throws on a non-numeric string element rather than producing malformed SQL', () => {
    expect(() => intArrayLiteral(['1); DROP TABLE artists; --' as unknown as number])).toThrow(/integer/i);
  });

  it('throws on NaN', () => {
    expect(() => intArrayLiteral([NaN])).toThrow(/integer/i);
  });

  it('throws on a non-finite value (Infinity)', () => {
    expect(() => intArrayLiteral([Infinity])).toThrow(/integer/i);
  });

  it('throws on null/undefined elements rather than coercing to 0', () => {
    // tests/tsconfig.json runs with `strict: false`, so `null`/`undefined`
    // are already assignable to `number` here without a cast — a cast would
    // be flagged as unnecessary by @typescript-eslint/no-unnecessary-type-assertion.
    expect(() => intArrayLiteral([null])).toThrow(/integer/i);
    expect(() => intArrayLiteral([undefined])).toThrow(/integer/i);
  });
});
