/**
 * Call-shape pin for the BS#2065/#2068 stale-open-show detector's final
 * selection bound (BS#2069 review finding 1 + finding 2) — asserts that the
 * `show_end`-marker carve-out is composed with drizzle's `or()` helper, not
 * assembled as a raw `sql` fragment containing a literal ` OR ` passed
 * directly as one of `and()`'s own arguments.
 *
 * THE BUG THIS PINS: `and(...)` wraps its own children COLLECTIVELY in one
 * pair of parentheses; it does not parenthesize each child individually. The
 * shipped-then-caught defect built the carve-out as:
 *
 *   and(bound1, bound2, bound3, bound4,
 *     sql`(${shows.id} IS DISTINCT FROM ${latestShowId}) OR (${newestEntryType} = 'show_end')`)
 *
 * — a single raw-sql fragment as `and()`'s fifth argument, never touching
 * `or()` at all. Because that fragment is ONE argument to `and(...)`, not two
 * arguments to `or(...)`, the literal ` OR ` renders (in real Postgres) at
 * the SAME nesting depth as bound1..bound4 — i.e. as a sibling disjunct of
 * the AND-list, not a parenthesized sub-group. SQL's `AND` binds tighter
 * than `OR`, so `WHERE (b1 AND b2 AND b3 AND b4 AND armA) OR armB` reports
 * the entire historical population of shows whose newest flowsheet entry
 * happens to be `show_end` — no `end_time IS NULL`, no threshold, no window.
 * Verified against a real (non-mocked) drizzle-orm build of this exact query
 * outside this test suite, during development of this fix:
 *
 *   BEFORE: "...and (<end_time> is null and ... and NOT EXISTS (...) and
 *     (<id> IS DISTINCT FROM (SELECT max(s2.id) FROM <shows> s2)) OR
 *     ((SELECT fe.entry_type FROM <flowsheet> fe ...) = 'show_end'))"
 *     — OR sits at the SAME depth as the and-joined bounds.
 *
 *   AFTER:  "...and (<end_time> is null and ... and NOT EXISTS (...) and
 *     (<id> IS DISTINCT FROM (SELECT max(s2.id) FROM <shows> s2) or
 *     (SELECT fe.entry_type FROM <flowsheet> fe ...) = show_end))"
 *     — or is nested one paren level deeper than the and-joined bounds.
 *
 * The fix wraps the two arms with drizzle's `or()` helper
 * (`apps/enrichment-worker/precheck.ts`'s `hasLoadBearingAlbumMetadata` is
 * the established precedent: `and(..., or(isNotNull(a), isNotNull(b)), ...)`),
 * which renders its own group in its own parens correctly nested one level
 * inside `and()`'s.
 *
 * WHY THIS LIVES IN THE UNIT TIER, NOT THE INTEGRATION TWIN: the integration
 * spec (`tests/integration/legacy-mirror-reconcile-stale-open-shows.spec.js`)
 * maintains a HAND-WRITTEN SQL TWIN of this WHERE clause, forced by the
 * babel-jest integration runner having no TypeScript support. The twin writes
 * its bound correctly parenthesized by construction (`AND (... OR ...)`) —
 * it can't reproduce a drizzle `and()`/`or()` composition bug because it was
 * never built by composing drizzle query-builder calls in the first place.
 * That gave the shipped defect zero executable coverage: the twin passed
 * while production was broken.
 *
 * WHY A CALL-SHAPE ASSERTION RATHER THAN A RENDERED-SQL-TEXT ONE: this unit
 * suite globally auto-mocks the `drizzle-orm` package itself
 * (`tests/__mocks__/drizzle-orm.ts`, Jest's automatic per-package
 * `__mocks__`-adjacent-to-`node_modules` convention — no `jest.mock(...)`
 * call needed, confirmed empirically while writing this test) so that EVERY
 * unit test in this tier, including the rest of `orchestrate.test.ts`, gets
 * `and`/`or`/`sql`/`eq`/etc as plain call-recording stand-ins
 * (`and(...conditions) => ({ and: conditions })`, `or(...) => ({ or:
 * [...] })`) rather than real dialect-aware SQL builders. That means no unit
 * test anywhere in this repo can render genuine `.toSQL()` text — the
 * strongest available pin is asserting on how the REAL production code
 * (`buildStaleOpenShowsQuery`, imported unmodified from `orchestrate.ts`)
 * CALLED those combinators. That is exactly the fact that distinguishes the
 * bug from the fix here: pre-fix, `or()` is never called at all (the carve-
 * out is a bare `sql` leaf passed straight to `and()`); post-fix, `or()` is
 * called once with the two arms, and its return value — not a raw fragment —
 * is what `and()` receives as its final argument. Asserting that call shape
 * pins the identical structural fact the rendered-text form above documents,
 * driven through the real, unmodified query-construction code path.
 */

import { jest } from '@jest/globals';
// Resolves to `tests/__mocks__/drizzle-orm.ts` automatically (see the
// class-level doc comment) — the SAME mocked `and`/`or` singletons
// `orchestrate.ts`'s own `import { and, or, ... } from 'drizzle-orm'`
// resolves to within this test file's module registry.
import { and, or } from 'drizzle-orm';
import {
  buildStaleOpenShowsQuery,
  type StaleOpenShowOptions,
} from '../../../../jobs/legacy-mirror-reconcile/orchestrate';

const mockAnd = and as jest.Mock;
const mockOr = or as jest.Mock;

const OPTIONS: StaleOpenShowOptions = { windowHours: 48, settleMinutes: 15, staleAfterHours: 12 };

describe('buildStaleOpenShowsQuery — id-exclusion/show_end carve-out composition (BS#2068/#2069 review)', () => {
  it('composes the carve-out with or(), not a raw sql fragment folded into and()', () => {
    buildStaleOpenShowsQuery(OPTIONS);

    // Pre-fix (the shipped-then-caught defect): the carve-out was
    // `sql`(...) OR (...)`` passed directly as one of and()'s own arguments
    // — or() was never called. This assertion alone is the red/green line:
    // it fails against the pre-fix code (0 calls) and passes against the fix
    // (1 call).
    expect(mockOr).toHaveBeenCalledTimes(1);

    // The or() call carries exactly the two arms the docblock above
    // describes: the id-exclusion arm and the show_end-marker arm.
    expect(mockOr.mock.calls[0]).toHaveLength(2);
  });

  it("passes or()'s own return value as and()'s final bound — not a bare sql leaf", () => {
    buildStaleOpenShowsQuery(OPTIONS);

    expect(mockAnd).toHaveBeenCalledTimes(1);
    const andArgs = mockAnd.mock.calls[0];
    const finalBound = andArgs[andArgs.length - 1];

    // Structural identity, not a shape guess: whatever and() received last
    // must be THE SAME OBJECT or() returned this call — i.e. and() is
    // wrapping or()'s result, not a separately-constructed raw fragment that
    // merely happens to look similar.
    expect(finalBound).toBe(mockOr.mock.results[0].value);
  });

  it("regression guard: and()'s final bound is never a bare {sql, values} leaf (the pre-fix shape)", () => {
    buildStaleOpenShowsQuery(OPTIONS);

    const andArgs = mockAnd.mock.calls[0];
    const finalBound = andArgs[andArgs.length - 1] as Record<string, unknown>;

    // The pre-fix code's final and() argument was tests/__mocks__/drizzle-orm.ts's
    // sql-tag shape ({ sql: TemplateStringsArray, values: unknown[] }) — a
    // bare leaf carrying the literal ` OR ` text inside its own template
    // strings, never wrapped by or(). Asserting the fixed shape's absence,
    // not just the fixed shape's presence, is what makes this a genuine
    // regression guard rather than a restatement of the previous test.
    expect(finalBound).not.toHaveProperty('sql');
    expect(finalBound).toHaveProperty('or');
  });
});
