/**
 * Unit tests for the artwork Discogs provider.
 *
 * All methods route through the LML client.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockSearchTrackReleases = jest.fn<() => Promise<unknown>>();
const mockValidateTrackOnRelease = jest.fn<() => Promise<boolean>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  searchTrackReleases: mockSearchTrackReleases,
  validateTrackOnRelease: mockValidateTrackOnRelease,
  isLmlConfigured: mockIsLmlConfigured,
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
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('returns empty when no searchable fields provided', async () => {
      const results = await provider.search({});

      expect(results).toEqual([]);
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('searches LML and maps results to ArtworkSearchResult', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'Confield',
              artist: 'Autechre',
              call_number: 'Electronic CD AUT 1/1',
              library_url: 'https://library.wxyc.org/1',
            },
            artwork: {
              release_id: 12345,
              release_url: 'https://www.discogs.com/release/12345',
              artwork_url: 'https://i.discogs.com/confield.jpg',
              album: 'Confield',
              artist: 'Autechre',
              confidence: 0.95,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await provider.search({ artist: 'Autechre', album: 'Confield' });

      expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield', undefined);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        artworkUrl: 'https://i.discogs.com/confield.jpg',
        releaseUrl: 'https://www.discogs.com/release/12345',
        album: 'Confield',
        artist: 'Autechre',
        source: 'discogs',
        confidence: 0.95,
      });
    });

    it('filters out results without artwork or with spacer.gif', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [
          {
            library_item: {
              id: 1,
              title: 'No Art',
              artist: 'Artist',
              call_number: 'Rock CD ART 1/1',
              library_url: 'https://library.wxyc.org/1',
            },
            artwork: { release_id: 1, release_url: 'https://discogs.com/1', artwork_url: null, confidence: 0 },
          },
          {
            library_item: {
              id: 2,
              title: 'Spacer',
              artist: 'Artist',
              call_number: 'Rock CD ART 2/1',
              library_url: 'https://library.wxyc.org/2',
            },
            artwork: {
              release_id: 2,
              release_url: 'https://discogs.com/2',
              artwork_url: 'https://i.discogs.com/spacer.gif',
              confidence: 0,
            },
          },
        ],
        search_type: 'direct',
        song_not_found: false,
        found_on_compilation: false,
      });

      const results = await provider.search({ artist: 'Artist', album: 'Album' });

      expect(results).toHaveLength(0);
    });

    it('returns empty on LML error', async () => {
      mockLookupMetadata.mockRejectedValue(new Error('LML down'));

      const results = await provider.search({ artist: 'Autechre', album: 'Confield' });

      expect(results).toEqual([]);
    });

    it('uses song when album is not provided', async () => {
      mockLookupMetadata.mockResolvedValue({
        results: [],
        search_type: 'none',
        song_not_found: false,
        found_on_compilation: false,
      });

      await provider.search({ artist: 'Autechre', song: 'VI Scose Poise' });

      expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', undefined, 'VI Scose Poise');
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
          {
            album: 'Confield',
            artist: 'Autechre',
            release_id: 123,
            release_url: 'https://discogs.com/123',
            is_compilation: false,
          },
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
          {
            album: 'On Your Own Love Again',
            artist: 'Jessica Pratt',
            release_id: 456,
            release_url: 'https://discogs.com/456',
            is_compilation: false,
          },
          {
            album: 'Quiet Signs',
            artist: 'Jessica Pratt',
            release_id: 789,
            release_url: 'https://discogs.com/789',
            is_compilation: false,
          },
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
          {
            album: 'On Your Own Love Again',
            artist: 'Jessica Pratt',
            release_id: 456,
            release_url: 'https://discogs.com/456',
            is_compilation: false,
          },
          {
            album: 'Indie Hits Vol. 3',
            artist: 'Various Artists',
            release_id: 999,
            release_url: 'https://discogs.com/999',
            is_compilation: true,
          },
        ],
        total: 2,
        cached: false,
      });
      mockValidateTrackOnRelease.mockResolvedValue(false);

      const results = await provider.searchReleasesByTrack('Back, Baby', 'Jessica Pratt');

      expect(mockValidateTrackOnRelease).toHaveBeenCalledWith(999, 'Back, Baby', 'Jessica Pratt');
      expect(results).toEqual([['Jessica Pratt', 'On Your Own Love Again']]);
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
