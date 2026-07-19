/**
 * Writer for jobs/concerts-similar-artists-enrichment (BS#1626).
 *
 * OVERWRITE of the artist-level neighbor lists for the current upcoming curated
 * in-library cohort — the opposite of the genre sibling's `ON CONFLICT DO
 * NOTHING`. Affinity neighbors are recomputed on every semantic-index graph
 * rebuild, so an existing row MUST be refreshed (`DO UPDATE`) to keep it current
 * with the graph; a `DO NOTHING` would freeze it forever.
 *
 * Two operations, both scoped to artists that a chunk RESPONDED for this run and
 * run in one transaction so a partial write can't leave the cohort inconsistent:
 *   - `upserts` — headliners that came back with >= 1 neighbor: INSERT, or on a
 *     PK conflict overwrite `neighbors` + bump `updated_at`.
 *   - `deleteArtistIds` — headliners that came back with an EMPTY list (the
 *     genuine now-unmapped/ambiguous ~1%): DELETE the row so a stale list can't
 *     outlive the graph. The orchestrator passes ONLY ids from a responded
 *     chunk here — never ids from a thrown/errored chunk (those stay untouched
 *     and retryable) and never when the whole sweep was empty (the null-wipe
 *     guard fires upstream). So a DELETE here always reflects a real, observed
 *     empty verdict, never a transient fetch failure.
 *
 * Data-safety: DELETEs are keyed on an explicit id list scoped to the cohort —
 * never a blanket `DELETE FROM ... WHERE true`, so an artist that fell out of
 * the upcoming window (and wasn't queried) keeps its row untouched.
 */

import { inArray, sql } from 'drizzle-orm';
import { artist_similar_artists, db, type SimilarArtistNeighbor } from '@wxyc/database';

/** One artist's overwrite payload. */
export type SimilarArtistsRow = {
  artist_id: number;
  neighbors: SimilarArtistNeighbor[];
};

/**
 * Overwrite the cohort's neighbor rows in a single transaction.
 *
 * @param upserts - responded headliners with a non-empty neighbor list.
 * @param deleteArtistIds - responded headliners whose list came back empty.
 * @returns counts of rows written (inserted-or-updated) and deleted.
 */
export const overwriteNeighbors = async (
  upserts: SimilarArtistsRow[],
  deleteArtistIds: number[]
): Promise<{ written: number; deleted: number }> => {
  if (upserts.length === 0 && deleteArtistIds.length === 0) {
    return { written: 0, deleted: 0 };
  }

  return db.transaction(async (tx) => {
    let written = 0;
    let deleted = 0;

    if (upserts.length > 0) {
      const rows = await tx
        .insert(artist_similar_artists)
        .values(upserts.map((r) => ({ artist_id: r.artist_id, neighbors: r.neighbors })))
        .onConflictDoUpdate({
          target: artist_similar_artists.artist_id,
          // Overwrite with the freshly-fetched list (the conflict-excluded value)
          // and bump the timestamp — this is what keeps neighbors current with
          // the nightly graph rebuild. `now()` (DB clock) matches the column's
          // INSERT-path `defaultNow()`, so inserted and updated rows stamp from
          // one clock.
          set: {
            neighbors: sql`excluded."neighbors"`,
            updated_at: sql`now()`,
          },
        })
        .returning({ artist_id: artist_similar_artists.artist_id });
      written = rows.length;
    }

    if (deleteArtistIds.length > 0) {
      const rows = await tx
        .delete(artist_similar_artists)
        .where(inArray(artist_similar_artists.artist_id, deleteArtistIds))
        .returning({ artist_id: artist_similar_artists.artist_id });
      deleted = rows.length;
    }

    return { written, deleted };
  });
};
