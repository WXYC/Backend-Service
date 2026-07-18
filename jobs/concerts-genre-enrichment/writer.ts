/**
 * Writer for jobs/concerts-genre-enrichment (BS#1624).
 *
 * Batch UPSERT of artist-level genres into `artist_metadata`, keyed on the
 * Discogs artist id. `ON CONFLICT DO NOTHING` is the idempotency + data-safety
 * guarantee: the candidate query already excludes artists that have a row, so a
 * conflict here can only be a concurrent writer (another pod, or the nightly
 * cron racing the one-time backfill) — and in that case the existing row wins
 * and is never overwritten (the collected-data rule).
 *
 * Empty `genres`/`styles` arrays are persisted verbatim (not coalesced to
 * NULL): an artist LML resolved to "no Discogs genres" gets a row, so the
 * anti-join in query.ts won't re-select it every night. The row's presence —
 * not its contents — is what makes the enrichment idempotent.
 */

import { artist_metadata, db } from '@wxyc/database';

/** One artist's resolved genres/styles, ready to persist. */
export type ArtistGenresRow = {
  discogs_artist_id: number;
  genres: string[];
  styles: string[];
};

/**
 * Insert the batch, skipping any Discogs id that already has a row. Returns the
 * count actually inserted (a re-run over an already-enriched set returns 0 —
 * the idempotency signal the tests assert on).
 */
export const upsertArtistGenres = async (rows: ArtistGenresRow[]): Promise<{ inserted: number }> => {
  if (rows.length === 0) return { inserted: 0 };
  const inserted = await db
    .insert(artist_metadata)
    .values(
      rows.map((r) => ({
        discogs_artist_id: r.discogs_artist_id,
        genres: r.genres,
        styles: r.styles,
      }))
    )
    .onConflictDoNothing({ target: artist_metadata.discogs_artist_id })
    .returning({ discogs_artist_id: artist_metadata.discogs_artist_id });
  return { inserted: inserted.length };
};
