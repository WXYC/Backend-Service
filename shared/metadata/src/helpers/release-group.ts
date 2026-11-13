/**
 * The release group of `album_metadata`: the columns that belong to one
 * Discogs release, written as a unit from an answer, nulls included, so a
 * column the new release lacks is NULL rather than the old release's value
 * ("any repair must write the full payload or it manufactures the next partial
 * row"). Pure — no I/O.
 *
 * Moved here from the re-ask (`jobs/album-metadata-reask/payload.ts`, BS#3137)
 * unchanged (BS#3791), so the release picker (BS#3790) writes the same columns
 * the same way. The artist group stays with each caller: the re-ask merges it
 * (`mergeArtistGroup`), the picker overwrites it.
 */

import type { AlbumMetadata } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';
import { normalizeLookup, type MetadataFallbacks } from '../normalize-lookup.js';

// Column names and types come from the schema, so a renamed or retyped column
// fails to compile here. The jsonb column is untyped in the schema and takes
// LML's type instead.
export type ReleaseGroup = Pick<
  AlbumMetadata,
  'discogs_url' | 'artwork_url' | 'release_year' | 'label' | 'full_release_date' | 'genres' | 'styles'
> & { tracklist: NonNullable<DiscogsMatchResult['tracklist']> | null };

/** The re-ask's `clear` release group: a confidently wrong release is worse than none (BS#3137 decision 3). */
export const CLEAR_RELEASE_GROUP: Readonly<ReleaseGroup> = Object.freeze({
  discogs_url: null,
  artwork_url: null,
  release_year: null,
  label: null,
  full_release_date: null,
  genres: null,
  styles: null,
  tracklist: null,
});

/**
 * The release group of a trusted answer for `results[0]`, as the enrichment
 * worker would store it: `normalizeLookup` supplies the Discogs URL, the cover
 * (`filterSpacerGif`, so a coverless release writes NULL) and the year (0
 * becomes NULL); the extended fields pass through.
 */
export const buildReleaseGroup = (lookup: LookupResponse, fallbacks: MetadataFallbacks): ReleaseGroup => {
  const normalized = normalizeLookup(lookup, fallbacks);
  const artwork = lookup.results?.[0]?.artwork;
  return {
    discogs_url: normalized.discogs_url,
    artwork_url: normalized.artwork_url,
    release_year: normalized.release_year,
    label: artwork?.label ?? null,
    full_release_date: artwork?.full_release_date ?? null,
    genres: artwork?.genres ?? null,
    styles: artwork?.styles ?? null,
    tracklist: artwork?.tracklist ?? null,
  };
};
