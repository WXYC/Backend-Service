/**
 * Unit tests for the artwork Discogs provider.
 *
 * Verifies that the search method routes through LML instead of DiscogsService.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

const mockSearchDiscogs = jest.fn<() => Promise<unknown>>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  searchDiscogs: mockSearchDiscogs,
}));

jest.mock('../../../apps/backend/services/discogs/index', () => ({
  DiscogsService: {},
  isDiscogsAvailable: () => true,
}));

jest.mock('../../../apps/backend/services/requestLine/matching/index', () => ({
  calculateConfidence: (_reqArtist: string, _reqAlbum: string, resArtist: string, _resAlbum: string) =>
    resArtist ? 0.85 : 0.5,
}));

import { DiscogsProvider } from '../../../apps/backend/services/artwork/providers/discogs';

describe('artwork DiscogsProvider', () => {
  const originalEnv = process.env;
  let provider: DiscogsProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
    provider = new DiscogsProvider();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns empty when LIBRARY_METADATA_URL is not configured', async () => {
    delete process.env.LIBRARY_METADATA_URL;

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
