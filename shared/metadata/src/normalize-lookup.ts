import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

import { cleanDiscogsBio } from './helpers/clean-discogs-bio.js';
import { filterSpacerGif } from './helpers/filter-spacer-gif.js';
import { isSyntheticArtwork } from './helpers/is-synthetic-artwork.js';
import { synthesizeSearchUrls } from './helpers/synthesize-search-urls.js';

/**
 * Flat, snake_case metadata shape. Matches the column names in
 * `flowsheet` and `album_metadata` so callers can spread directly into
 * Drizzle `.set({...})` blocks without renaming.
 *
 * Nullability precedence:
 *   - missing in response          → `null`
 *   - synthetic shape (LML#401)    → `null` for Discogs-derived fields,
 *                                     real values for streaming fields
 *   - `release_year === 0` sentinel → `null` (#1002)
 *   - `spacer.gif` artwork URL     → `null` (#649)
 *
 * `youtube_music_url`, `bandcamp_url`, `soundcloud_url` are always
 * populated (synthesized search URL when LML omits) so iOS always has
 * a clickable streaming row.
 */
export type NormalizedMetadata = {
  discogs_url: string | null;
  artwork_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
  youtube_music_url: string;
  bandcamp_url: string;
  soundcloud_url: string;
};

/**
 * Identifiers the caller knew before the lookup. Used to fill in the
 * synthesized search URLs (always emitted) and the artist-side bio
 * synthesis if LML didn't return an artwork match.
 *
 * `artist` is required (every enriching row has one). `album` and
 * `track` are optional + nullable because library-level enrichment
 * (artwork-only) doesn't carry a track, and free-form flowsheet
 * entries can lack an album.
 */
export type MetadataFallbacks = {
  artist: string;
  album?: string | null;
  track?: string | null;
};

/**
 * Normalize a `LookupResponse` into a flat `NormalizedMetadata` for
 * persistence. Pure function — no I/O, no side effects.
 *
 * Three branches:
 *   1. No `artwork` on `response.results[0]`  → all Discogs-derived
 *      fields null; synthesized streaming URLs only.
 *   2. `artwork` is synthetic (LML#401)        → Discogs-derived fields
 *      null but real streaming URLs from LML preferred over synth.
 *   3. `artwork` is a real Discogs match       → full payload, with
 *      synth fallbacks for the three search URLs LML may not have set.
 *
 * Callers do not need to know which branch fired; the return shape is
 * uniform.
 */
export function normalizeLookup(response: LookupResponse, fallbacks: MetadataFallbacks): NormalizedMetadata {
  const artwork: DiscogsMatchResult | null = response.results?.[0]?.artwork ?? null;
  const synth = synthesizeSearchUrls(fallbacks);

  if (!artwork) {
    return {
      discogs_url: null,
      artwork_url: null,
      release_year: null,
      spotify_url: null,
      apple_music_url: null,
      artist_bio: null,
      artist_wikipedia_url: null,
      youtube_music_url: synth.youtube_music_url,
      bandcamp_url: synth.bandcamp_url,
      soundcloud_url: synth.soundcloud_url,
    };
  }

  const synthetic = isSyntheticArtwork(artwork);

  return {
    discogs_url: synthetic ? null : artwork.release_url,
    artwork_url: filterSpacerGif(artwork.artwork_url),
    // Discogs returns 0 as "year unknown"; coerce to null so iOS doesn't
    // render literal "0" on the playcut detail view (#1002).
    release_year: artwork.release_year || null,
    spotify_url: artwork.spotify_url ?? null,
    apple_music_url: artwork.apple_music_url ?? null,
    artist_bio: synthetic ? null : artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
    artist_wikipedia_url: synthetic ? null : (artwork.wikipedia_url ?? null),
    youtube_music_url: artwork.youtube_music_url ?? synth.youtube_music_url,
    bandcamp_url: artwork.bandcamp_url ?? synth.bandcamp_url,
    soundcloud_url: artwork.soundcloud_url ?? synth.soundcloud_url,
  };
}
