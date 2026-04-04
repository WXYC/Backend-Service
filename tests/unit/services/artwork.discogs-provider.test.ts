/**
 * Unit tests for the artwork Discogs provider.
 *
 * All methods route through the LML client.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

const mockSearchDiscogs = jest.fn<() => Promise<unknown>>();
const mockSearchTrackReleases = jest.fn<() => Promise<unknown>>();
const mockValidateTrackOnRelease = jest.fn<() => Promise<boolean>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  searchDiscogs: mockSearchDiscogs,
  searchTrackReleases: mockSearchTrackReleases,
  validateTrackOnRelease: mockValidateTrackOnRelease,
  isLmlConfigured: mockIsLmlConfigured,
}));

jest.mock('../../../apps/backend/services/requestLine/matching/index', () => ({
  calculateConfidence: (_reqArtist: string, _reqAlbum: string, resArtist: string, _resAlbum: string) =>
    resArtist ? 0.85 : 0.5,
}));

import { DiscogsProvider } from '../../../apps/backend/services/artwork/providers/discogs';

describe('artwork DiscogsProvider', () => {
  let provider: DiscogsProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsLmlConfigured.mockReturnValue(true);
    provider = new DiscogsProvider();
  });

  describe('search', () => {
    it('returns empty when LML is not configured', async () => {
      mockIsLmlConfigured.mockReturnValue(false);

      const results = await provider.search({ artist: 'Autechre', album: 'Confield' });

      expect(results).toEqual([]);
      expect(mockSearchDiscogs).not.toHaveBeenCalled();
    });

    it('returns empty when no searchable fields provided', async () => {
      const results = await provider.search({});

      expect(results).toEqual([]);
      expect(mockSearchDiscogs).not.toHaveBeenCalled();
    });

    it('searches LML and maps results to ArtworkSearchResult', async () => {
      mockSearchDiscogs.mockResolvedValue({
        results: [
          {
            release_id: 12345,
            release_url: 'https://www.discogs.com/release/12345',
            artwork_url: 'https://i.discogs.com/confield.jpg',
            album: 'Confield',
            artist: 'Autechre',
            confidence: 0.95,
            release_year: 2001,
            artist_bio: null,
            wikipedia_url: null,
            spotify_url: null,
            apple_music_url: null,
            youtube_music_url: null,
            bandcamp_url: null,
            soundcloud_url: null,
          },
        ],
        total: 1,
        cached: false,
      });

      const results = await provider.search({ artist: 'Autechre', album: 'Confield' });

      expect(mockSearchDiscogs).toHaveBeenCalledWith('Autechre', 'Confield');
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        artworkUrl: 'https://i.discogs.com/confield.jpg',
        releaseUrl: 'https://www.discogs.com/release/12345',
        album: 'Confield',
        artist: 'Autechre',
        source: 'discogs',
        confidence: 0.85,
      });
    });

    it('filters out results without artwork or with spacer.gif', async () => {
      mockSearchDiscogs.mockResolvedValue({
        results: [
          {
            release_id: 1,
            release_url: 'https://discogs.com/1',
            artwork_url: null,
            album: 'No Art',
            artist: 'Artist',
            confidence: 0.9,
            release_year: null,
            artist_bio: null,
            wikipedia_url: null,
            spotify_url: null,
            apple_music_url: null,
            youtube_music_url: null,
            bandcamp_url: null,
            soundcloud_url: null,
          },
          {
            release_id: 2,
            release_url: 'https://discogs.com/2',
            artwork_url: 'https://i.discogs.com/spacer.gif',
            album: 'Spacer',
            artist: 'Artist',
            confidence: 0.8,
            release_year: null,
            artist_bio: null,
            wikipedia_url: null,
            spotify_url: null,
            apple_music_url: null,
            youtube_music_url: null,
            bandcamp_url: null,
            soundcloud_url: null,
          },
        ],
        total: 2,
        cached: false,
      });

      const results = await provider.search({ artist: 'Artist', album: 'Album' });

      expect(results).toHaveLength(0);
    });

    it('returns empty on LML error', async () => {
      mockSearchDiscogs.mockRejectedValue(new Error('LML down'));

      const results = await provider.search({ artist: 'Autechre', album: 'Confield' });

      expect(results).toEqual([]);
    });

    it('uses song as search term when album is not provided', async () => {
      mockSearchDiscogs.mockResolvedValue({ results: [], total: 0, cached: false });

      await provider.search({ artist: 'Autechre', song: 'VI Scose Poise' });

      expect(mockSearchDiscogs).toHaveBeenCalledWith('Autechre', 'VI Scose Poise');
    });
  });

  describe('searchTrack', () => {
    it('returns null when LML is not configured', async () => {
      mockIsLmlConfigured.mockReturnValue(false);

      const result = await provider.searchTrack('VI Scose Poise', 'Autechre');

      expect(result).toBeNull();
      expect(mockSearchTrackReleases).not.toHaveBeenCalled();
    });

    it('returns album name from first result', async () => {
      mockSearchTrackReleases.mockResolvedValue({
        track: 'VI Scose Poise',
        artist: 'Autechre',
        releases: [
          { album: 'Confield', artist: 'Autechre', release_id: 123, release_url: 'https://discogs.com/123', is_compilation: false },
        ],
        total: 1,
        cached: false,
      });

      const result = await provider.searchTrack('VI Scose Poise', 'Autechre');

      expect(result).toBe('Confield');
      expect(mockSearchTrackReleases).toHaveBeenCalledWith('VI Scose Poise', 'Autechre');
    });

    it('returns null when no releases found', async () => {
      mockSearchTrackReleases.mockResolvedValue({
        track: 'Unknown Track',
        artist: null,
        releases: [],
        total: 0,
        cached: false,
      });

      const result = await provider.searchTrack('Unknown Track');

      expect(result).toBeNull();
    });

    it('returns null on LML error', async () => {
      mockSearchTrackReleases.mockRejectedValue(new Error('LML down'));

      const result = await provider.searchTrack('VI Scose Poise', 'Autechre');

      expect(result).toBeNull();
    });
  });

  describe('searchReleasesByTrack', () => {
    it('returns empty when LML is not configured', async () => {
      mockIsLmlConfigured.mockReturnValue(false);

      const results = await provider.searchReleasesByTrack('Back, Baby', 'Jessica Pratt');

      expect(results).toEqual([]);
    });

    it('returns artist/album tuples', async () => {
      mockSearchTrackReleases.mockResolvedValue({
        track: 'Back, Baby',
        artist: 'Jessica Pratt',
        releases: [
          { album: 'On Your Own Love Again', artist: 'Jessica Pratt', release_id: 456, release_url: 'https://discogs.com/456', is_compilation: false },
          { album: 'Quiet Signs', artist: 'Jessica Pratt', release_id: 789, release_url: 'https://discogs.com/789', is_compilation: false },
        ],
        total: 2,
        cached: false,
      });

      const results = await provider.searchReleasesByTrack('Back, Baby', 'Jessica Pratt');

      expect(results).toEqual([
        ['Jessica Pratt', 'On Your Own Love Again'],
        ['Jessica Pratt', 'Quiet Signs'],
      ]);
    });

    it('validates compilation releases and skips invalid ones', async () => {
      mockSearchTrackReleases.mockResolvedValue({
        track: 'Back, Baby',
        artist: 'Jessica Pratt',
        releases: [
          { album: 'On Your Own Love Again', artist: 'Jessica Pratt', release_id: 456, release_url: 'https://discogs.com/456', is_compilation: false },
          { album: 'Indie Hits Vol. 3', artist: 'Various Artists', release_id: 999, release_url: 'https://discogs.com/999', is_compilation: true },
        ],
        total: 2,
        cached: false,
      });
      mockValidateTrackOnRelease.mockResolvedValue(false);

      const results = await provider.searchReleasesByTrack('Back, Baby', 'Jessica Pratt');

      expect(mockValidateTrackOnRelease).toHaveBeenCalledWith(999, 'Back, Baby', 'Jessica Pratt');
      expect(results).toEqual([
        ['Jessica Pratt', 'On Your Own Love Again'],
      ]);
    });
  });

  describe('validateTrackOnRelease', () => {
    it('returns false when LML is not configured', async () => {
      mockIsLmlConfigured.mockReturnValue(false);

      const result = await provider.validateTrackOnRelease(123, 'VI Scose Poise', 'Autechre');

      expect(result).toBe(false);
    });

    it('delegates to LML validateTrackOnRelease', async () => {
      mockValidateTrackOnRelease.mockResolvedValue(true);

      const result = await provider.validateTrackOnRelease(123, 'VI Scose Poise', 'Autechre');

      expect(result).toBe(true);
      expect(mockValidateTrackOnRelease).toHaveBeenCalledWith(123, 'VI Scose Poise', 'Autechre');
    });

    it('returns false on LML error', async () => {
      mockValidateTrackOnRelease.mockRejectedValue(new Error('LML down'));

      const result = await provider.validateTrackOnRelease(123, 'VI Scose Poise', 'Autechre');

      expect(result).toBe(false);
    });
  });
});
