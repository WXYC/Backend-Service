/**
 * Writer for the DISCOGS lane of jobs/concerts-similar-artists-enrichment
 * (BS#1701). The Discogs-keyed twin of `writer.ts`: same OVERWRITE (`ON CONFLICT
 * DO UPDATE`) + scoped-DELETE transaction, but on `discogs_artist_similar_artists`
 * keyed on `discogs_artist_id` rather than `artist_similar_artists.artist_id`.
 *
 * Same refresh rationale: affinity neighbors are recomputed on every
 * semantic-index graph rebuild, so an existing row MUST be refreshed to stay
 * current; a `DO NOTHING` would freeze it forever.
 *
 * Same data-safety discipline: DELETEs are keyed on an explicit id list scoped
 * to the cohort (never a blanket `DELETE FROM ... WHERE true`), and the
 * orchestrator only ever passes ids from a RESPONDED chunk with an observed
 * EMPTY verdict — never a thrown/errored chunk's ids, and never when the whole
 * sweep was empty (the null-wipe guard fires upstream).
 */

import { inArray, sql } from 'drizzle-orm';
import { db, discogs_artist_similar_artists, type SimilarArtistNeighbor } from '@wxyc/database';

/** One Discogs artist's overwrite payload. */
export type DiscogsSimilarArtistsRow = {
  discogs_artist_id: number;
  neighbors: SimilarArtistNeighbor[];
};

/**
 * Overwrite the discogs-lane cohort's neighbor rows in a single transaction.
 *
 * @param upserts - responded headliners with a non-empty neighbor list.
 * @param deleteDiscogsIds - responded headliners whose list came back empty.
 * @returns counts of rows written (inserted-or-updated) and deleted.
 */
export const overwriteDiscogsNeighbors = async (
  upserts: DiscogsSimilarArtistsRow[],
  deleteDiscogsIds: number[]
): Promise<{ written: number; deleted: number }> => {
  if (upserts.length === 0 && deleteDiscogsIds.length === 0) {
    return { written: 0, deleted: 0 };
  }

  return db.transaction(async (tx) => {
    let written = 0;
    let deleted = 0;

    if (upserts.length > 0) {
      const rows = await tx
        .insert(discogs_artist_similar_artists)
        .values(upserts.map((r) => ({ discogs_artist_id: r.discogs_artist_id, neighbors: r.neighbors })))
        .onConflictDoUpdate({
          target: discogs_artist_similar_artists.discogs_artist_id,
          // Overwrite with the freshly-fetched list (the conflict-excluded
          // value) and bump the timestamp — keeps neighbors current with the
          // nightly graph rebuild. `now()` (DB clock) matches the column's
          // INSERT-path `defaultNow()`.
          set: {
            neighbors: sql`excluded."neighbors"`,
            updated_at: sql`now()`,
          },
        })
        .returning({ discogs_artist_id: discogs_artist_similar_artists.discogs_artist_id });
      written = rows.length;
    }

    if (deleteDiscogsIds.length > 0) {
      const rows = await tx
        .delete(discogs_artist_similar_artists)
        .where(inArray(discogs_artist_similar_artists.discogs_artist_id, deleteDiscogsIds))
        .returning({ discogs_artist_id: discogs_artist_similar_artists.discogs_artist_id });
      deleted = rows.length;
    }

    return { written, deleted };
  });
};
