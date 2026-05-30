import { normalizeLookup, type NormalizedMetadata } from '@wxyc/metadata';

import {
  FULL_MATCH,
  MATCH_MISSING_SEARCH_URLS,
  NO_ARTWORK,
  NO_MATCH,
  SPACER_GIF_ARTWORK,
  SYNTHETIC_MATCH,
  YEAR_ZERO_MATCH,
} from './__fixtures__/lookup-responses.js';

const FALLBACKS = {
  artist: 'Jessica Pratt',
  album: 'On Your Own Love Again',
  track: 'Back, Baby',
};

describe('normalizeLookup', () => {
  describe('no-match branches', () => {
    it.each([
      ['empty results array', NO_MATCH],
      ['result without artwork field', NO_ARTWORK],
    ])('returns nulls for Discogs fields + synthesized streaming URLs (%s)', (_label, response) => {
      const out = normalizeLookup(response, FALLBACKS);
      expect(out.discogs_url).toBeNull();
      expect(out.artwork_url).toBeNull();
      expect(out.release_year).toBeNull();
      expect(out.spotify_url).toBeNull();
      expect(out.apple_music_url).toBeNull();
      expect(out.artist_bio).toBeNull();
      expect(out.artist_wikipedia_url).toBeNull();
      // Search URLs synthesized from fallbacks
      expect(out.youtube_music_url).toContain('Jessica%20Pratt');
      expect(out.bandcamp_url).toContain('Jessica%20Pratt');
      expect(out.soundcloud_url).toContain('Jessica%20Pratt');
    });
  });

  describe('synthetic match (LML#401)', () => {
    it('nulls Discogs-derived fields but preserves LML-supplied streaming URLs', () => {
      const out = normalizeLookup(SYNTHETIC_MATCH, FALLBACKS);
      // Discogs identifiers suppressed
      expect(out.discogs_url).toBeNull();
      expect(out.artwork_url).toBeNull();
      // Artist-side derived fields suppressed (the bio in the fixture is bogus)
      expect(out.artist_bio).toBeNull();
      expect(out.artist_wikipedia_url).toBeNull();
      // Real streaming URLs from LML preserved
      expect(out.spotify_url).toBe('https://open.spotify.com/album/abc');
      expect(out.apple_music_url).toBe('https://music.apple.com/us/album/123');
      expect(out.youtube_music_url).toBe('https://music.youtube.com/playlist?list=OLAK');
      expect(out.bandcamp_url).toBe('https://jessicapratt.bandcamp.com/album/on-your-own');
      // soundcloud_url=null in fixture → synth fallback fills it
      expect(out.soundcloud_url).toContain('soundcloud.com/search');
    });
  });

  describe('full match', () => {
    it('emits the full payload, cleaning Discogs bio markup', () => {
      const out = normalizeLookup(FULL_MATCH, FALLBACKS);
      const expected: NormalizedMetadata = {
        discogs_url: 'https://www.discogs.com/release/12345',
        artwork_url: 'https://i.discogs.com/abc.jpg',
        release_year: 2015,
        spotify_url: 'https://open.spotify.com/album/abc',
        apple_music_url: 'https://music.apple.com/us/album/123',
        artist_bio: 'Member of Jessica Pratt and signed to Drag City.',
        artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Jessica_Pratt',
        youtube_music_url: 'https://music.youtube.com/playlist?list=OLAK',
        bandcamp_url: 'https://jessicapratt.bandcamp.com/album/on-your-own',
        soundcloud_url: 'https://soundcloud.com/dragcity/on-your-own',
      };
      expect(out).toEqual(expected);
    });
  });

  describe('spacer.gif filtering', () => {
    it('nulls artwork_url when LML returned spacer.gif', () => {
      const out = normalizeLookup(SPACER_GIF_ARTWORK, FALLBACKS);
      expect(out.artwork_url).toBeNull();
      // Other fields still come through
      expect(out.discogs_url).toBe('https://www.discogs.com/release/99');
    });
  });

  describe('release_year sentinel (#1002)', () => {
    it('coerces release_year=0 to null', () => {
      const out = normalizeLookup(YEAR_ZERO_MATCH, FALLBACKS);
      expect(out.release_year).toBeNull();
    });
  });

  describe('search URL fallbacks on a real match', () => {
    it('uses LML-supplied streaming URLs when present, synth when not', () => {
      const out = normalizeLookup(MATCH_MISSING_SEARCH_URLS, FALLBACKS);
      // LML supplied spotify; preserved
      expect(out.spotify_url).toBe('https://open.spotify.com/album/abc');
      // LML didn't supply yt/bc/sc; synth fills them
      expect(out.youtube_music_url).toContain('music.youtube.com/search?q=');
      expect(out.bandcamp_url).toContain('bandcamp.com/search?q=');
      expect(out.soundcloud_url).toContain('soundcloud.com/search?q=');
    });
  });

  describe('uniform shape', () => {
    it('returns the same key set regardless of branch', () => {
      const keys = (m: NormalizedMetadata) => Object.keys(m).sort();
      const noMatch = keys(normalizeLookup(NO_MATCH, FALLBACKS));
      const synthetic = keys(normalizeLookup(SYNTHETIC_MATCH, FALLBACKS));
      const full = keys(normalizeLookup(FULL_MATCH, FALLBACKS));
      expect(synthetic).toEqual(noMatch);
      expect(full).toEqual(noMatch);
    });
  });
});
