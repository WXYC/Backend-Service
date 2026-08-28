/**
 * Raw-SQL mirror of `jobs/streaming-columns-drain/job.ts`'s two statements,
 * for the integration runner.
 *
 * Same reason `tests/utils/enrichment-precheck.js` exists: the integration
 * runner is babel-jest with no TS support (drizzle-orm + ts-jest
 * incompatibility), so the spec cannot import the job. This module is the ONE
 * place the mirrored SQL lives, so a drifting predicate is chased through one
 * file rather than every test that touches it.
 *
 * The mirrored statements must stay clause-for-clause identical to
 * `cohortPredicateSql()` and `applyStreamingFill` in the job. The unit suite
 * pins the job's own string shape; this pins its behaviour against real
 * Postgres — in particular the three-valued-logic and TOCTOU properties that
 * only a real planner can demonstrate.
 *
 * @see WXYC/Backend-Service#2295
 */

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** The five streaming URL columns, in the job's order. */
const COHORT_COLUMNS = ['spotify_url', 'apple_music_url', 'youtube_music_url', 'bandcamp_url', 'soundcloud_url'];

/**
 * True iff the album is in the BS#2295 frozen cohort: a load-bearing Discogs
 * match present, and every one of the five streaming columns null.
 */
async function isInCohort(sql, albumId) {
  const rows = await sql`
    SELECT 1
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE album_id = ${albumId}
       AND (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
       AND spotify_url IS NULL
       AND apple_music_url IS NULL
       AND youtube_music_url IS NULL
       AND bandcamp_url IS NULL
       AND soundcloud_url IS NULL
     LIMIT 1
  `;
  return rows.length > 0;
}

/** Count the whole cohort — the job's before/after measurement. */
async function countCohort(sql) {
  const rows = await sql`
    SELECT count(*)::int AS n
      FROM ${sql(SCHEMA)}.album_metadata
     WHERE (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
       AND spotify_url IS NULL
       AND apple_music_url IS NULL
       AND youtube_music_url IS NULL
       AND bandcamp_url IS NULL
       AND soundcloud_url IS NULL
  `;
  return Number(rows[0].n);
}

/**
 * Apply one fill, fill-null only, with the cohort predicate re-asserted in the
 * WHERE. Returns true iff a row was updated.
 *
 * Both guards from the job are mirrored deliberately: the COALESCE (a column
 * holding a value keeps it) AND the cohort predicate (if ANY of the five
 * became non-null since enumeration, nothing is written at all). The spec
 * below shows they are not redundant in the same way — the predicate is what
 * makes a partially-healed row untouched rather than partially topped up.
 */
async function applyStreamingFill(sql, albumId, fill) {
  const rows = await sql`
    UPDATE ${sql(SCHEMA)}.album_metadata
       SET spotify_url       = COALESCE(spotify_url, ${fill.spotify_url ?? null}),
           apple_music_url   = COALESCE(apple_music_url, ${fill.apple_music_url ?? null}),
           youtube_music_url = COALESCE(youtube_music_url, ${fill.youtube_music_url ?? null}),
           bandcamp_url      = COALESCE(bandcamp_url, ${fill.bandcamp_url ?? null}),
           soundcloud_url    = COALESCE(soundcloud_url, ${fill.soundcloud_url ?? null}),
           updated_at        = NOW()
     WHERE album_id = ${albumId}
       AND (artwork_url IS NOT NULL OR discogs_url IS NOT NULL)
       AND spotify_url IS NULL
       AND apple_music_url IS NULL
       AND youtube_music_url IS NULL
       AND bandcamp_url IS NULL
       AND soundcloud_url IS NULL
    RETURNING album_id
  `;
  return rows.length > 0;
}

module.exports = { COHORT_COLUMNS, isInCohort, countCohort, applyStreamingFill, SCHEMA };
