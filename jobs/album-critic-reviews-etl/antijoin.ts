/**
 * Pre-LLM anti-join for album-critic-reviews-etl (BS#1830): drop items whose
 * `(album_id, source_url)` pair already exists in `album_critic_reviews`
 * BEFORE calling Haiku. Haiku extraction is nondeterministic — re-extracting
 * an existing row could yield a different snippet, churning the UPSERT
 * (breaking the second-run-0-changed guarantee) while re-spending tokens.
 * Only genuinely new pairs reach the LLM.
 *
 * Read via `db.execute(sql\`...\`)` (raw SQL, schema-qualified,
 * `int[]`-literal-bound `ANY(...)` via the shared `intArrayLiteral` helper,
 * BS#2010), mirroring `jobs/album-reviews-etl/link.ts` and
 * `shared/database/src/library-tiebreak.ts` — NOT drizzle's `inArray()`
 * query-builder helper. `inArray()` is real-drizzle-safe (its query builder
 * is itself thenable), but the shared unit-test mock
 * (`tests/mocks/database.mock.ts`) only resolves `.execute()`/`.returning()`
 * terminals; a bare `.where(inArray(...))` chain call is unusable there. See
 * jobs/album-reviews-etl/link.ts's `loadCandidates` for the same `int[]`
 * literal idiom on a text[] column via its job-local `textArrayLiteral`
 * (real PG quoting for text elements — deliberately not promoted alongside
 * `intArrayLiteral`; see that helper's docblock for why) — this is the
 * integer-array analog, validated by `intArrayLiteral` rather than trusted
 * by construction.
 *
 * Note (issue step 4): dedup never DELETES a losing row, so if an album
 * already carries a lower-preference card and a later corpus adds a
 * higher-preference review, the anti-join — keyed on the PAIR, not the
 * album alone — does not suppress the new `source_url`. The album then
 * carries two rows. This is consistent with the schema's "key supports
 * multi-source cards" design (`CRITIC_REVIEWS_LIMIT = 5` on the read); see
 * `filterNew`'s test for this exact scenario.
 */
import { sql } from 'drizzle-orm';
import { db, intArrayLiteral } from '@wxyc/database';
import type { MatchedItem } from './dedup.js';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const TABLE = sql.raw(`"${SCHEMA}"."album_critic_reviews"`);

/** Normalize `db.execute` results across drizzle driver shapes
 *  (postgres-js returns an array; node-postgres `{ rows }`). */
const unwrapRows = <T>(result: unknown): T[] => {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error('album-critic-reviews-etl antijoin: unrecognized db.execute() result shape');
};

export const pairKey = (albumId: number, sourceUrl: string): string => `${albumId}:${sourceUrl}`;

/** Existing `(album_id, source_url)` pairs for the given album ids, as a
 *  `pairKey` set. Empty input short-circuits without a DB round-trip. */
export const loadExistingPairs = async (albumIds: number[]): Promise<Set<string>> => {
  if (albumIds.length === 0) return new Set();

  // Bind as a single PG-array-literal string param, not a bare interpolated
  // JS array — see the module docstring + `intArrayLiteral`'s own docblock
  // for the BS#1068/BS#1071/#2007 trap this avoids.
  const idArrayLiteral = intArrayLiteral(albumIds);

  const result: unknown = await db.execute(sql`
    SELECT "album_id", "source_url"
    FROM ${TABLE}
    WHERE "album_id" = ANY(${idArrayLiteral}::int[])
  `);
  const rows = unwrapRows<{ album_id: number; source_url: string }>(result);
  return new Set(rows.map((row) => pairKey(row.album_id, row.source_url)));
};

/** Drop deduped items whose (albumId, sourceUrl) pair is already present. */
export const filterNew = (deduped: MatchedItem[], existing: Set<string>): MatchedItem[] =>
  deduped.filter((candidate) => !existing.has(pairKey(candidate.albumId, candidate.item.sourceUrl)));
