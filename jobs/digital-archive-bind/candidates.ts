/**
 * Match-target loaders for step 4: one query per table, sweeping the whole
 * candidate population into memory once. Same shape as
 * `jobs/album-reviews-etl/link.ts`'s "ONE query sweeps `library`" precedent
 * -- the population is tens of thousands of rows, not millions, and
 * matching per-candidate against an in-memory array is cheap next to a
 * per-file round trip against Postgres.
 */

import { isNotNull } from 'drizzle-orm';
import { db, library, rotation } from '@wxyc/database';
import type { LibraryCandidateRow, RotationCandidateRow } from './match.js';

/** `rotation` rows with a resolved `album_id` -- an unlinked row can't produce a `library_id`. */
export const loadRotationCandidates = async (): Promise<RotationCandidateRow[]> => {
  const rows = await db
    .select({ libraryId: rotation.album_id, artistName: rotation.artist_name, albumTitle: rotation.album_title })
    .from(rotation)
    .where(isNotNull(rotation.album_id));
  return rows
    .filter((r): r is typeof r & { libraryId: number } => r.libraryId !== null)
    .map((r) => ({ libraryId: r.libraryId, artistName: r.artistName, albumTitle: r.albumTitle }));
};

export const loadLibraryCandidates = async (): Promise<LibraryCandidateRow[]> => {
  const rows = await db
    .select({
      libraryId: library.id,
      artistName: library.artist_name,
      albumArtist: library.album_artist,
      alternateArtistName: library.alternate_artist_name,
      albumTitle: library.album_title,
    })
    .from(library);
  return rows;
};
