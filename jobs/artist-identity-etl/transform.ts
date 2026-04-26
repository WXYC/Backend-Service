/**
 * Pure helpers for the artist-identity ETL.
 *
 * `applyIdentitySql` builds a single statement that fills the six
 * external-ID columns on `artists` only when they are currently null.
 * Coalescing in the SET clause means we never overwrite a value the
 * library staff might have set by hand: each column's existing value
 * wins over the LML-supplied one, and only the nulls flip.
 *
 * `countMatched` and `countWritten` are pure summarizers over the
 * pre-state vs LML row, used to make per-run logs informative without
 * threading SQL row counts through the call site.
 */

import type { LmlIdentity } from './fetch-lml.js';

export type ExistingArtistIdentity = {
  artist_name: string;
  discogs_artist_id: number | null;
  musicbrainz_artist_id: string | null;
  wikidata_qid: string | null;
  spotify_artist_id: string | null;
  apple_music_artist_id: string | null;
  bandcamp_id: string | null;
};

const RECONCILED_KEYS: Array<keyof Omit<LmlIdentity, 'library_name'>> = [
  'discogs_artist_id',
  'musicbrainz_artist_id',
  'wikidata_qid',
  'spotify_artist_id',
  'apple_music_artist_id',
  'bandcamp_id',
];

/**
 * Returns the set of column names where the LML row has a value and the
 * existing artist row currently has a null. This is the per-row write
 * count: 0 means nothing to do, n>0 means n columns will flip from null
 * to a populated value.
 */
export const columnsToFill = (
  existing: ExistingArtistIdentity,
  lml: LmlIdentity
): Array<keyof Omit<LmlIdentity, 'library_name'>> => {
  const out: Array<keyof Omit<LmlIdentity, 'library_name'>> = [];
  for (const key of RECONCILED_KEYS) {
    if (lml[key] !== null && existing[key] === null) {
      out.push(key);
    }
  }
  return out;
};

/**
 * Returns the keys (if any) where LML and the existing row both have a
 * value but they differ. These rows are skipped, not overwritten -- a
 * staff-applied value wins -- and we surface the conflicts so a human
 * can review them in the run log.
 */
export const columnsInConflict = (
  existing: ExistingArtistIdentity,
  lml: LmlIdentity
): Array<keyof Omit<LmlIdentity, 'library_name'>> => {
  const out: Array<keyof Omit<LmlIdentity, 'library_name'>> = [];
  for (const key of RECONCILED_KEYS) {
    if (existing[key] !== null && lml[key] !== null && existing[key] !== lml[key]) {
      out.push(key);
    }
  }
  return out;
};
