/**
 * Job-local normalization keys for grouping and matching (BS#2319 step 3/4).
 *
 * THE FOLD IS IMPORTED, NOT REIMPLEMENTED -- the same
 * `jobs/album-reviews-etl/link.ts` `relaxedAlbumKey` precedent this job
 * follows verbatim. `foldArtistName` (NFD, strip combining marks, lowercase
 * -- the SQL twin of `wxyc_schema.fold_artist_name`) and `normalizeAlbumTitle`
 * (lowercase, drop featuring/edition cruft, collapse whitespace) are both
 * exported by `@wxyc/database`; only the punctuation collapse below is
 * job-local.
 *
 * The grouping key and the matcher's EXACT tier both compare
 * `foldArtistName(artist)` + `normalizeAlbumTitle(album)`. The matcher's
 * FUZZY tier additionally folds the album leg through `relaxedAlbumKey`
 * (reduce every run of non-alphanumerics to a single separator), exactly the
 * two-tier shape `link.ts` measured on prod: +146 links, zero new ambiguity,
 * and explicitly NOT a trigram/similarity score -- that was measured and
 * REJECTED there (false positives at 0.84-0.88 similarity on sequel titles
 * like "Black Metal 2" -> "Black Metal"). This job reuses that same
 * conservative, deterministic two-tier shape rather than re-deriving a
 * scored fuzzy matcher from the issue body's looser "score in bind_note"
 * language -- the codebase's own measured precedent for this exact problem
 * postdates and supersedes it.
 */

import { foldArtistName, normalizeAlbumTitle } from '@wxyc/database';

const NON_ALPHANUMERIC_RUN = /[^\p{L}\p{N}]+/gu;

export const relaxedAlbumKey = (normalizedTitle: string | null | undefined): string =>
  foldArtistName(normalizedTitle ?? '')
    .replace(NON_ALPHANUMERIC_RUN, ' ')
    .trim();

/** Fold key for the grouping/matching artist leg. */
export const artistFoldKey = (artist: string | null | undefined): string => foldArtistName(artist ?? '');

/**
 * Grouping key for step 3: normalized `(album_artist ?? artist, album)`.
 * `::` is safe as a separator -- neither leg can contain it after folding.
 */
export const albumGroupKey = (
  albumArtist: string | null | undefined,
  artist: string | null | undefined,
  album: string | null | undefined
): string => {
  const artistPart = artistFoldKey(albumArtist ?? artist);
  const albumPart = normalizeAlbumTitle(album ?? '');
  return `${artistPart}::${albumPart}`;
};
