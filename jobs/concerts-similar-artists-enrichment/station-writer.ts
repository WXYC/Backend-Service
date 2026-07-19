/**
 * Station-plays writer for jobs/concerts-similar-artists-enrichment (BS#1702).
 *
 * UPSERT of the all-time WXYC flowsheet play count (`semantic-index
 * artist.total_plays`) for the current upcoming curated in-library cohort into
 * `artist_station_plays`, keyed by `artists.id`. This is the station-affinity
 * signal behind the On Tour "For You" shelf: `GET /concerts` LEFT-joins it onto
 * `Concert.station_plays`.
 *
 * UPSERT-ONLY, no DELETE — the deliberate difference from the neighbors writer
 * (`writer.ts`). Neighbor lists are recomputed on every graph rebuild, so a
 * now-unmapped artist's stale list must be cleared; a play count, by contrast,
 * only ever grows and drifts slowly, and a stale row for an artist no longer
 * touring is harmless (no upcoming concert joins it). Above all, the station
 * count must NOT share the neighbors writer's DELETE-on-empty lifecycle: a
 * heavily-played artist with no affinity neighbors is exactly the cold-start
 * card this feature exists to surface, so its count must survive a neighbors
 * DELETE / all-empty sweep. Hence a separate table and a separate writer.
 */

import { sql } from 'drizzle-orm';
import { artist_station_plays, db } from '@wxyc/database';

/** One artist's station-plays payload. */
export type StationPlaysRow = {
  artist_id: number;
  plays: number;
};

/**
 * UPSERT the cohort's station-plays rows.
 *
 * @param rows - responded headliners with a validated non-negative play count.
 * @returns count of rows written (inserted-or-updated).
 */
export const writeStationPlays = async (rows: StationPlaysRow[]): Promise<{ written: number }> => {
  if (rows.length === 0) {
    return { written: 0 };
  }

  const written = await db
    .insert(artist_station_plays)
    .values(rows.map((r) => ({ artist_id: r.artist_id, plays: r.plays })))
    .onConflictDoUpdate({
      target: artist_station_plays.artist_id,
      // Overwrite with the freshly-fetched count and bump the timestamp. `now()`
      // (DB clock) matches the column's INSERT-path `defaultNow()`, so inserted
      // and updated rows stamp from one clock.
      set: {
        plays: sql`excluded."plays"`,
        updated_at: sql`now()`,
      },
    })
    .returning({ artist_id: artist_station_plays.artist_id });

  return { written: written.length };
};
