/**
 * Unit tests for `SearchUrlProvider` — the canonical synthesis of
 * fallback search URLs for Spotify / Apple Music / YouTube Music / Bandcamp
 * / SoundCloud (BS#889 + BS#1185).
 *
 * The provider is the single source of truth for the search-URL shape.
 * Three call sites historically drifted (metadata.service runtime path,
 * the flowsheet-metadata-backfill inline copy, the proxy.controller
 * fallback). These tests pin the canonical semantics; companion parity
 * tests pin that each consumer site produces identical output.
 *
 * Per-service semantics:
 *   - Spotify:       trackTitle > albumTitle > artistName. Matches LML's
 *                    `_build_streaming_search_url("https://open.spotify.com/search/", ...)`
 *                    path-style format so BS-side fallback URLs are byte-
 *                    identical to LML-surfaced URLs (BS#1185).
 *   - Apple Music:   trackTitle > albumTitle > artistName. Apple's web
 *                    search uses `music.apple.com/search?term=<q>` and
 *                    geo-redirects to the caller's local store.
 *   - YouTube Music: trackTitle > albumTitle > artistName (3-tier fallback).
 *   - Bandcamp:      albumTitle > artistName (2-tier; album-leaning).
 *   - SoundCloud:    trackTitle > artistName (2-tier; track-leaning, NO
 *                    album fallback).
 *
 * The asymmetry is deliberate: Bandcamp pages are album-centric, SoundCloud
 * pages are track-centric. Searching SoundCloud by album-only often returns
 * unrelated DJ mixes.
 */

import { SearchUrlProvider } from '../../../../../apps/backend/services/metadata/providers/search-urls.provider';

describe('SearchUrlProvider', () => {
  const provider = new SearchUrlProvider();

  describe('getSpotifyUrl', () => {
    it('prefers track when present', () => {
      expect(provider.getSpotifyUrl('Stereolab', 'Miss Modular', 'Dots and Loops')).toBe(
        'https://open.spotify.com/search/Stereolab%20Miss%20Modular'
      );
    });
    it('falls back to album when no track', () => {
      expect(provider.getSpotifyUrl('Stereolab', undefined, 'Dots and Loops')).toBe(
        'https://open.spotify.com/search/Stereolab%20Dots%20and%20Loops'
      );
    });
    it('falls back to artist when neither track nor album', () => {
      expect(provider.getSpotifyUrl('Stereolab')).toBe('https://open.spotify.com/search/Stereolab');
    });
  });

  describe('getAppleMusicUrl', () => {
    it('prefers track when present', () => {
      expect(provider.getAppleMusicUrl('Stereolab', 'Miss Modular', 'Dots and Loops')).toBe(
        'https://music.apple.com/search?term=Stereolab%20Miss%20Modular'
      );
    });
    it('falls back to album when no track', () => {
      expect(provider.getAppleMusicUrl('Stereolab', undefined, 'Dots and Loops')).toBe(
        'https://music.apple.com/search?term=Stereolab%20Dots%20and%20Loops'
      );
    });
    it('falls back to artist when neither track nor album', () => {
      expect(provider.getAppleMusicUrl('Stereolab')).toBe('https://music.apple.com/search?term=Stereolab');
    });
  });

  describe('getYoutubeMusicUrl', () => {
    it('prefers track when present', () => {
      expect(provider.getYoutubeMusicUrl('Stereolab', 'Miss Modular', 'Dots and Loops')).toBe(
        'https://music.youtube.com/search?q=Stereolab%20Miss%20Modular'
      );
    });
    it('falls back to album when no track', () => {
      expect(provider.getYoutubeMusicUrl('Stereolab', undefined, 'Dots and Loops')).toBe(
        'https://music.youtube.com/search?q=Stereolab%20Dots%20and%20Loops'
      );
    });
    it('falls back to artist when neither track nor album', () => {
      expect(provider.getYoutubeMusicUrl('Stereolab')).toBe('https://music.youtube.com/search?q=Stereolab');
    });
  });

  describe('getBandcampUrl', () => {
    it('prefers album when present', () => {
      expect(provider.getBandcampUrl('Stereolab', 'Dots and Loops')).toBe(
        'https://bandcamp.com/search?q=Stereolab%20Dots%20and%20Loops'
      );
    });
    it('falls back to artist when no album', () => {
      expect(provider.getBandcampUrl('Stereolab')).toBe('https://bandcamp.com/search?q=Stereolab');
    });
  });

  describe('getSoundcloudUrl', () => {
    it('prefers track when present', () => {
      expect(provider.getSoundcloudUrl('Stereolab', 'Miss Modular')).toBe(
        'https://soundcloud.com/search?q=Stereolab%20Miss%20Modular'
      );
    });
    it('falls back to artist when no track (does NOT fall through album)', () => {
      // The SoundCloud helper deliberately does not take an album parameter:
      // SoundCloud searches by album-only return unrelated DJ mixes more
      // often than the album itself. The two-tier fallback (track > artist)
      // is the contract; any consumer that passes album-as-track here is
      // misusing the API.
      expect(provider.getSoundcloudUrl('Stereolab')).toBe('https://soundcloud.com/search?q=Stereolab');
    });
  });

  describe('getAllSearchUrls', () => {
    it('produces all five URLs from one call with mixed inputs', () => {
      const urls = provider.getAllSearchUrls('Juana Molina', 'DOGA', 'la paradoja');
      expect(urls).toEqual({
        spotifyUrl: 'https://open.spotify.com/search/Juana%20Molina%20la%20paradoja',
        appleMusicUrl: 'https://music.apple.com/search?term=Juana%20Molina%20la%20paradoja',
        youtubeMusicUrl: 'https://music.youtube.com/search?q=Juana%20Molina%20la%20paradoja',
        bandcampUrl: 'https://bandcamp.com/search?q=Juana%20Molina%20DOGA',
        soundcloudUrl: 'https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja',
      });
    });

    it('handles artist-only correctly across all five services', () => {
      const urls = provider.getAllSearchUrls('Juana Molina');
      expect(urls).toEqual({
        spotifyUrl: 'https://open.spotify.com/search/Juana%20Molina',
        appleMusicUrl: 'https://music.apple.com/search?term=Juana%20Molina',
        youtubeMusicUrl: 'https://music.youtube.com/search?q=Juana%20Molina',
        bandcampUrl: 'https://bandcamp.com/search?q=Juana%20Molina',
        soundcloudUrl: 'https://soundcloud.com/search?q=Juana%20Molina',
      });
    });

    it('encodes diacritics correctly (Nilüfer Yanya / Hermanos Gutiérrez)', () => {
      // Per memory: the canonical test corpus includes three diacritic-
      // bearing artist names so the URL encoding path is exercised.
      const urls = provider.getAllSearchUrls('Nilüfer Yanya', undefined, undefined);
      expect(urls.spotifyUrl).toBe('https://open.spotify.com/search/Nil%C3%BCfer%20Yanya');
      expect(urls.appleMusicUrl).toBe('https://music.apple.com/search?term=Nil%C3%BCfer%20Yanya');
      expect(urls.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=Nil%C3%BCfer%20Yanya');
      expect(urls.bandcampUrl).toBe('https://bandcamp.com/search?q=Nil%C3%BCfer%20Yanya');
      expect(urls.soundcloudUrl).toBe('https://soundcloud.com/search?q=Nil%C3%BCfer%20Yanya');
    });
  });
});
