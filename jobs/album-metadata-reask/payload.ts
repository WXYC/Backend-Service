/**
 * What a writing verdict puts in `album_metadata` (BS#3137, "What is
 * rewritten"). Pure — no I/O.
 *
 * Two column groups, and only these. The streaming columns are never in the
 * payload: LML resolves them per catalog row (artist and title), not per
 * Discogs release, so a rebind has nothing new to say about them.
 *
 *   - Release group: written as a unit from the answer, nulls included, so a
 *     column the new release lacks is NULL rather than the old release's value
 *     ("any repair must write the full payload or it manufactures the next
 *     partial row"). `clear` writes it all NULL (decision 3).
 *   - Artist group: the answer's values, merged with the stored ones by
 *     `mergeArtistGroup` (decision 8). Never written on `clear`.
 */

import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';
import { normalizeLookup, type MetadataFallbacks } from '@wxyc/metadata';

export type ReleaseGroup = {
  discogs_url: string | null;
  artwork_url: string | null;
  release_year: number | null;
  label: string | null;
  full_release_date: string | null;
  genres: string[] | null;
  styles: string[] | null;
  tracklist: NonNullable<DiscogsMatchResult['tracklist']> | null;
};

export type ArtistGroup = {
  discogs_artist_id: number | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
  artist_image_url: string | null;
  bio_tokens: NonNullable<DiscogsMatchResult['profile_tokens']> | null;
};

export type RebindPayload = { release: ReleaseGroup; artist: ArtistGroup };

/** The `clear` release group: a confidently wrong release is worse than none (decision 3). */
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
 * The payload of a trusted answer for `results[0]`, as the enrichment worker
 * would store it: `normalizeLookup` supplies the Discogs URL, the cover
 * (`filterSpacerGif`, so a coverless release writes NULL), the year (0 becomes
 * NULL) and the bio (`cleanDiscogsBio`); the extended fields pass through.
 */
export const buildPayload = (lookup: LookupResponse, fallbacks: MetadataFallbacks): RebindPayload => {
  const normalized = normalizeLookup(lookup, fallbacks);
  const artwork = lookup.results?.[0]?.artwork;
  return {
    release: {
      discogs_url: normalized.discogs_url,
      artwork_url: normalized.artwork_url,
      release_year: normalized.release_year,
      label: artwork?.label ?? null,
      full_release_date: artwork?.full_release_date ?? null,
      genres: artwork?.genres ?? null,
      styles: artwork?.styles ?? null,
      tracklist: artwork?.tracklist ?? null,
    },
    artist: {
      discogs_artist_id: artwork?.discogs_artist_id ?? null,
      artist_bio: normalized.artist_bio,
      artist_wikipedia_url: normalized.artist_wikipedia_url,
      artist_image_url: artwork?.artist_image_url ?? null,
      bio_tokens: artwork?.profile_tokens ?? null,
    },
  };
};

/**
 * Decision 8, the merged BS#3128 artist rule (`apps/enrichment-worker/
 * degraded-keep-sql.ts`): a column keeps its stored value where the answer is
 * null only if both `discogs_artist_id`s are non-null and equal, or if either
 * is null and the release is unchanged. A rebind always changes the release,
 * so here it reduces to "both ids set and equal". Otherwise the answer is
 * written as-is, nulls included. `discogs_artist_id` is always the answer's.
 *
 * Unlike the worker, which keeps stored values only on a degraded reply, this
 * applies to a healthy rebind answer (this job never writes a degraded one): a
 * sibling release of the same Discogs artist does not erase that artist's bio.
 * The write itself evaluates the rule in SQL against the row it locks; this is
 * the same rule over values in hand, for the preview and as its executable spec.
 */
export const mergeArtistGroup = (stored: ArtistGroup, answer: ArtistGroup): ArtistGroup => {
  const sameArtist =
    stored.discogs_artist_id !== null &&
    answer.discogs_artist_id !== null &&
    stored.discogs_artist_id === answer.discogs_artist_id;
  if (!sameArtist) return answer;
  return {
    discogs_artist_id: answer.discogs_artist_id,
    artist_bio: answer.artist_bio ?? stored.artist_bio,
    artist_wikipedia_url: answer.artist_wikipedia_url ?? stored.artist_wikipedia_url,
    artist_image_url: answer.artist_image_url ?? stored.artist_image_url,
    bio_tokens: answer.bio_tokens ?? stored.bio_tokens,
  };
};
