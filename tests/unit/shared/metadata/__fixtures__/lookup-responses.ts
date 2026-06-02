import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';

const baseArtwork: DiscogsMatchResult = {
  album: 'On Your Own Love Again',
  artist: 'Jessica Pratt',
  release_id: 0,
  release_url: '',
  confidence: 0,
};

/**
 * Wraps a `DiscogsMatchResult` in the `LookupResponse` envelope the way
 * LML returns it on a successful match.
 */
const wrap = (artwork: DiscogsMatchResult): LookupResponse => ({
  results: [
    {
      library_item: {
        artist_name: artwork.artist ?? '',
        album_title: artwork.album ?? '',
      } as never,
      artwork,
    } as never,
  ],
});

/** LML returned `{ results: [] }` — no match at all. */
export const NO_MATCH: LookupResponse = { results: [] };

/** LML returned a result row but with no `artwork` field. */
export const NO_ARTWORK: LookupResponse = {
  results: [
    {
      library_item: {
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
      } as never,
    } as never,
  ],
};

/**
 * LML#401 streaming-only synth: Discogs miss, but LML synthesized a
 * shell with real streaming URLs. `release_id === 0 && release_url === ''`
 * is the sentinel pair.
 */
export const SYNTHETIC_MATCH: LookupResponse = wrap({
  ...baseArtwork,
  release_id: 0,
  release_url: '',
  artwork_url: undefined,
  spotify_url: 'https://open.spotify.com/album/abc',
  apple_music_url: 'https://music.apple.com/us/album/123',
  youtube_music_url: 'https://music.youtube.com/playlist?list=OLAK',
  bandcamp_url: 'https://jessicapratt.bandcamp.com/album/on-your-own',
  soundcloud_url: null,
  artist_bio: 'should be ignored on synthetic',
  wikipedia_url: 'https://en.wikipedia.org/wiki/Jessica_Pratt',
});

/**
 * LML returned a real Discogs match with every field populated. Bio
 * contains `[a=...]` markup that `cleanDiscogsBio` should strip.
 */
export const FULL_MATCH: LookupResponse = wrap({
  album: 'On Your Own Love Again',
  artist: 'Jessica Pratt',
  release_id: 12345,
  release_url: 'https://www.discogs.com/release/12345',
  artwork_url: 'https://i.discogs.com/abc.jpg',
  confidence: 95,
  release_year: 2015,
  artist_bio: 'Member of [a=Jessica Pratt] and signed to [l=Drag City].',
  wikipedia_url: 'https://en.wikipedia.org/wiki/Jessica_Pratt',
  spotify_url: 'https://open.spotify.com/album/abc',
  apple_music_url: 'https://music.apple.com/us/album/123',
  youtube_music_url: 'https://music.youtube.com/playlist?list=OLAK',
  bandcamp_url: 'https://jessicapratt.bandcamp.com/album/on-your-own',
  soundcloud_url: 'https://soundcloud.com/dragcity/on-your-own',
});

/** LML returned an artwork match whose `artwork_url` is Discogs's spacer.gif. */
export const SPACER_GIF_ARTWORK: LookupResponse = wrap({
  ...baseArtwork,
  release_id: 99,
  release_url: 'https://www.discogs.com/release/99',
  artwork_url: 'https://i.discogs.com/img/spacer.gif',
  confidence: 80,
});

/**
 * LML returned a real Discogs match but with `release_year=0` (Discogs's
 * "year unknown" sentinel — #1002).
 */
export const YEAR_ZERO_MATCH: LookupResponse = wrap({
  ...baseArtwork,
  release_id: 12345,
  release_url: 'https://www.discogs.com/release/12345',
  artwork_url: 'https://i.discogs.com/abc.jpg',
  release_year: 0,
  confidence: 75,
});

/**
 * LML returned a real match but omitted the three search-style streaming
 * fields LML *can* compute (youtube/bandcamp/soundcloud). The synth
 * fallback should kick in.
 */
export const MATCH_MISSING_SEARCH_URLS: LookupResponse = wrap({
  ...baseArtwork,
  release_id: 12345,
  release_url: 'https://www.discogs.com/release/12345',
  artwork_url: 'https://i.discogs.com/abc.jpg',
  confidence: 90,
  spotify_url: 'https://open.spotify.com/album/abc',
});
