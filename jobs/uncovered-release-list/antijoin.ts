/**
 * The two anti-joins for jobs/uncovered-release-list (BS#1877, ADR 0013):
 *
 *   1. `loadCoveredLibraryIds` — releases that already have at least one
 *      `album_critic_reviews` row (migration 0125). Whether that row came
 *      from the weekly manifest ETL, the seed script, or (eventually) a
 *      search-sourced hit that already round-tripped back through the
 *      manifest pipeline, it means "has a review" and must never be
 *      re-included.
 *   2. `loadHandedOffLibraryIds` — releases already recorded in
 *      `uncovered_release_search_markers` (migration 0146): the "searched,
 *      found nothing" marker, in the sense of "already handed off for
 *      search at least once" (see that table's schema.ts doc comment for
 *      why publish-once, not retried). Distinct from (1) by construction —
 *      a release can be handed off and STILL have no review (search came up
 *      empty), which is exactly the case this anti-join exists to catch.
 *
 * Both read via `db.execute(sql\`...\`)` with an `int[]`-literal-bound
 * `ANY(...)`, mirroring `jobs/album-critic-reviews-etl/antijoin.ts` — NOT
 * drizzle's `inArray()` query-builder helper, which the shared unit-test
 * mock (`tests/mocks/database.mock.ts`) can't resolve as a bare `.execute()`
 * terminal. See that sibling file's docstring for the full rationale.
 */
import { sql } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { unwrapRows } from './db-utils.js';
import type { CanonicalRelease } from './rotation.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const ALBUM_CRITIC_REVIEWS = sql.raw(`"${SCHEMA}"."album_critic_reviews"`);
const SEARCH_MARKERS = sql.raw(`"${SCHEMA}"."uncovered_release_search_markers"`);

const idArrayLiteral = (ids: number[]): string => `{${ids.join(',')}}`;

/** `library.id`s among `libraryIds` that already carry >=1
 *  `album_critic_reviews` row. Empty input short-circuits without a DB
 *  round-trip. */
export const loadCoveredLibraryIds = async (libraryIds: number[]): Promise<Set<number>> => {
  if (libraryIds.length === 0) return new Set();

  const result: unknown = await db.execute(sql`
    SELECT DISTINCT "album_id"
    FROM ${ALBUM_CRITIC_REVIEWS}
    WHERE "album_id" = ANY(${idArrayLiteral(libraryIds)}::int[])
  `);
  const rows = unwrapRows<{ album_id: number }>(result);
  return new Set(rows.map((row) => row.album_id));
};

/** `library.id`s among `libraryIds` that already have a
 *  `uncovered_release_search_markers` row (already handed off at least
 *  once). Empty input short-circuits without a DB round-trip. */
export const loadHandedOffLibraryIds = async (libraryIds: number[]): Promise<Set<number>> => {
  if (libraryIds.length === 0) return new Set();

  const result: unknown = await db.execute(sql`
    SELECT "album_id"
    FROM ${SEARCH_MARKERS}
    WHERE "album_id" = ANY(${idArrayLiteral(libraryIds)}::int[])
  `);
  const rows = unwrapRows<{ album_id: number }>(result);
  return new Set(rows.map((row) => row.album_id));
};

/** Pure combine: drop any release already covered OR already handed off.
 *  Order-preserving. */
export const filterUncovered = (
  releases: readonly CanonicalRelease[],
  covered: ReadonlySet<number>,
  handedOff: ReadonlySet<number>
): CanonicalRelease[] =>
  releases.filter((release) => !covered.has(release.libraryId) && !handedOff.has(release.libraryId));
