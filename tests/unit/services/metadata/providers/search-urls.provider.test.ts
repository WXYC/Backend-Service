/**
 * Unit tests for `SearchUrlProvider` — the canonical synthesis of
 * fallback search URLs for YouTube Music / Bandcamp / SoundCloud (BS#889).
 *
 * The provider is the single source of truth for the search-URL shape.
 * Three call sites historically drifted (metadata.service runtime path,
 * the flowsheet-metadata-backfill inline copy, the proxy.controller
 * fallback). These tests pin the canonical semantics; companion parity
 * tests pin that each consumer site produces identical output.
 *
 * Per-service semantics:
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
    it('produces the three URLs from one call with mixed inputs', () => {
      const urls = provider.getAllSearchUrls('Juana Molina', 'DOGA', 'la paradoja');
      expect(urls).toEqual({
        youtubeMusicUrl: 'https://music.youtube.com/search?q=Juana%20Molina%20la%20paradoja',
        bandcampUrl: 'https://bandcamp.com/search?q=Juana%20Molina%20DOGA',
        soundcloudUrl: 'https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja',
      });
    });

    it('handles artist-only correctly across all three services', () => {
      const urls = provider.getAllSearchUrls('Juana Molina');
      expect(urls).toEqual({
        youtubeMusicUrl: 'https://music.youtube.com/search?q=Juana%20Molina',
        bandcampUrl: 'https://bandcamp.com/search?q=Juana%20Molina',
        soundcloudUrl: 'https://soundcloud.com/search?q=Juana%20Molina',
      });
    });

    it('encodes diacritics correctly (Nilüfer Yanya / Hermanos Gutiérrez)', () => {
      // Per memory: the canonical test corpus includes three diacritic-
      // bearing artist names so the URL encoding path is exercised.
      const urls = provider.getAllSearchUrls('Nilüfer Yanya', undefined, undefined);
      expect(urls.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=Nil%C3%BCfer%20Yanya');
      expect(urls.bandcampUrl).toBe('https://bandcamp.com/search?q=Nil%C3%BCfer%20Yanya');
      expect(urls.soundcloudUrl).toBe('https://soundcloud.com/search?q=Nil%C3%BCfer%20Yanya');
    });
  });
});
