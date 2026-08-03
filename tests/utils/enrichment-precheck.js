/**
 * Shared test helper for the enrichment worker's cache-first pre-check
 * (B1 / BS#1747, extended by BS#1915's bounded streaming self-heal gate).
 *
 * `hasLoadBearingMetadata` is the ONE canonical mirror of the SELECT in
 * `apps/enrichment-worker/precheck.ts#hasLoadBearingAlbumMetadata`. The
 * integration runner is babel-jest with no TS support (drizzle-orm + ts-jest
 * incompatibility; see `enrichment-worker-claim.spec.js` header and the
 * sibling `enrichment-claim.js`), so the SQL is duplicated from the TS source
 * rather than imported — and kept in exactly one place so a hand-edit to the
 * predicate is chased through one file.
 *
 * The predicate is the load-bearing test the worker uses to decide whether to
 * skip the LML call. Skip (return true) requires BOTH:
 *   1. A confirmed load-bearing Discogs match — `artwork_url` OR
 *      `discogs_url` is non-null. The four synthesized search-URL columns
 *      are deliberately NOT part of this — a search-URL-only shell is the
 *      BS#1089 poisoned-null shape that must keep re-calling LML to
 *      self-heal.
 *   2. BS#1915: no streaming field is still `unresolved` under the attempt
 *      cap. `spotify_status` / `apple_music_status` / `bandcamp_status`
 *      `= 'unresolved'` AND `streaming_reask_attempts < STREAMING_REASK_ATTEMPT_CAP`
 *      on ANY of the three blocks the skip (re-ask instead), so a transient
 *      "couldn't check" null self-heals on a later sweep instead of freezing
 *      forever. `absent` is terminal (never re-asked — preserves the #1747
 *      amplifier fix) and NULL (never-consulted) does not force a re-ask —
 *      only the field's key ever being explicitly `unresolved` does.
 *      STREAMING_REASK_ATTEMPT_CAP mirrors `apps/enrichment-worker/enrich.ts`'s
 *      exported constant of the same name; keep the literal `3` here in
 *      lockstep with that file.
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** Mirrors `STREAMING_REASK_ATTEMPT_CAP` in `apps/enrichment-worker/enrich.ts` (BS#1915). */
const STREAMING_REASK_ATTEMPT_CAP = 3;

/**
 * Return true iff the album already has a persisted load-bearing Discogs
 * match in `album_metadata` (`artwork_url` OR `discogs_url` non-null) AND no
 * streaming field is still bounded-re-ask-eligible (BS#1915).
 *
 * @param {import('postgres').Sql} sql - the shared test pool from `getTestDb()`.
 * @param {number} albumId - the `album_metadata.album_id` (== `library.id`).
 * @returns {Promise<boolean>} true → the worker skips LML; false → it calls
 *   LML (self-heal path).
 */
async function hasLoadBearingMetadata(sql, albumId) {
  // Bandcamp re-ask de-freeze (ENRICHMENT_BANDCAMP_REASK) mirror: when the
  // gate is on, a load-bearing row whose Bandcamp is a NULL-status
  // `bandcamp.com/search` fallback (the legacy frozen shape) is re-ask
  // eligible too. Read at call time so a test can toggle the env var per
  // case; empty fragment (flag off) is a byte-for-byte no-op.
  const bandcampFrozenReask =
    process.env.ENRICHMENT_BANDCAMP_REASK === 'true'
      ? sql`OR (bandcamp_status IS NULL AND bandcamp_url LIKE ${'%bandcamp.com/search%'})`
      : sql``;
  const rows = await sql`
    SELECT 1
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
       AND (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
       -- COALESCE(..., false) is load-bearing, not decorative: SQL's
       -- three-valued logic makes NULL = 'unresolved' evaluate to NULL
       -- (not false), so for the common case of all three status columns
       -- still NULL (never consulted), the un-coalesced OR/AND chain would
       -- evaluate to NULL, NOT(NULL) is ALSO NULL, and a NULL WHERE clause
       -- excludes the row -- silently breaking the base BS#1747 skip for
       -- every plain load-bearing row. COALESCE pins the "nothing to
       -- re-ask" default to an explicit false before negating.
       AND NOT COALESCE(
         streaming_reask_attempts < ${STREAMING_REASK_ATTEMPT_CAP}
         AND (
           spotify_status = 'unresolved'
           OR apple_music_status = 'unresolved'
           OR bandcamp_status = 'unresolved'
           ${bandcampFrozenReask}
         ),
         false
       )
     LIMIT 1
  `;
  return rows.length > 0;
}

module.exports = { hasLoadBearingMetadata, STREAMING_REASK_ATTEMPT_CAP };
