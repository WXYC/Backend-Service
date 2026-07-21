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

import { sql } from 'drizzle-orm';
import { artist_metadata, db } from '@wxyc/database';

/** One artist's resolved genres/styles/bio, ready to persist. */
export type ArtistGenresRow = {
  discogs_artist_id: number;
  genres: string[];
  styles: string[];
  artist_bio: string | null;
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
        artist_bio: r.artist_bio,
      }))
    )
    .onConflictDoNothing({ target: artist_metadata.discogs_artist_id })
    .returning({ discogs_artist_id: artist_metadata.discogs_artist_id });
  return { inserted: inserted.length };
};

/** One artist's re-fetched bio, ready to fill onto an existing row. */
export type BioBackfillRow = {
  discogs_artist_id: number;
  artist_bio: string | null;
};

/**
 * Fill-null bio backfill (BS#1734) for pre-existing genres-only `artist_metadata`
 * rows: an `INSERT ... ON CONFLICT DO UPDATE` whose `set` only ever writes
 * `artist_bio`/`updated_at`, and whose `setWhere` restricts the UPDATE to rows
 * whose `artist_bio` is currently NULL — the row always already exists (it was
 * created by `upsertArtistGenres` above), so the INSERT branch never actually
 * fires; `genres`/`styles` values are structurally required by `.values()` but
 * are discarded by the DO UPDATE's `set` (never overwritten). Idempotent and
 * re-run-safe: a row already carrying a bio, or a fixed-by-a-previous-page row,
 * silently drops out of `setWhere` and `updated` reports its true count.
 * Mirrors the fill-null pattern in `jobs/flowsheet-linked-reenrichment` (the
 * structural donor for `album_metadata`).
 */
export const applyBioBackfill = async (rows: BioBackfillRow[]): Promise<{ updated: number }> => {
  if (rows.length === 0) return { updated: 0 };
  const updated = await db
    .insert(artist_metadata)
    .values(
      rows.map((r) => ({
        discogs_artist_id: r.discogs_artist_id,
        genres: [] as string[],
        styles: [] as string[],
        artist_bio: r.artist_bio,
      }))
    )
    .onConflictDoUpdate({
      target: artist_metadata.discogs_artist_id,
      set: {
        artist_bio: sql`excluded."artist_bio"`,
        updated_at: sql`NOW()`,
      },
      setWhere: sql`${artist_metadata.artist_bio} IS NULL`,
    })
    .returning({ discogs_artist_id: artist_metadata.discogs_artist_id });
  return { updated: updated.length };
};
