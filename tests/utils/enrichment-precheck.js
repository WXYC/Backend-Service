/**
 * Shared test helper for the enrichment worker's cache-first pre-check
 * (B1 / BS#1747).
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
 * skip the LML call: skip only when `artwork_url` OR `discogs_url` is
 * non-null. The four synthesized search-URL columns are deliberately NOT part
 * of the predicate — a search-URL-only shell is the BS#1089 poisoned-null
 * shape that must keep re-calling LML to self-heal.
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Return true iff the album already has a persisted load-bearing Discogs
 * match in `album_metadata` (`artwork_url` OR `discogs_url` non-null).
 *
 * @param {import('postgres').Sql} sql - the shared test pool from `getTestDb()`.
 * @param {number} albumId - the `album_metadata.album_id` (== `library.id`).
 * @returns {Promise<boolean>} true → the worker skips LML; false → it calls
 *   LML (self-heal path).
 */
async function hasLoadBearingMetadata(sql, albumId) {
  const rows = await sql`
    SELECT 1
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
       AND (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
     LIMIT 1
  `;
  return rows.length > 0;
}

module.exports = { hasLoadBearingMetadata };
