/**
 * Unit tests for the metadata service.
 *
 * Verifies that fetchMetadata routes through LML and returns metadata
 * for the caller to persist.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

const mockSearchDiscogs = jest.fn<() => Promise<unknown>>();
const mockGetRelease = jest.fn<() => Promise<unknown>>();
const mockGetArtistDetails = jest.fn<() => Promise<unknown>>();

jest.mock('../../../apps/backend/services/lml/lml.client', () => ({
  searchDiscogs: mockSearchDiscogs,
  getRelease: mockGetRelease,
  getArtistDetails: mockGetArtistDetails,
  LmlClientError: class LmlClientError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = 'LmlClientError';
      this.statusCode = statusCode;
    }
  },
}));

jest.mock('../../../apps/backend/services/metadata/providers/search-urls.provider', () => ({
  SearchUrlProvider: jest.fn().mockImplementation(() => ({
    getAllSearchUrls: (artist: string, album?: string, track?: string) => {
      const q = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
      return {
        youtubeMusicUrl: `https://music.youtube.com/search?q=${encodeURIComponent(q)}`,
        bandcampUrl: `https://bandcamp.com/search?q=${encodeURIComponent(q)}`,
        soundcloudUrl: `https://soundcloud.com/search?q=${encodeURIComponent(q)}`,
      };
    },
  })),
}));

import { fetchMetadata } from '../../../apps/backend/services/metadata/metadata.service';

// --- Fixtures ---

const lmlSearchResult = {
  release_id: 12345,
  release_url: 'https://www.discogs.com/release/12345',
  artwork_url: 'https://i.discogs.com/art.jpg',
  album: 'Confield',
  artist: 'Autechre',
  confidence: 0.95,
  release_year: 2001,
  artist_bio: '[a=Rob Brown] and [a=Sean Booth] are Autechre.',
  wikipedia_url: 'https://en.wikipedia.org/wiki/Autechre',
  spotify_url: 'https://open.spotify.com/album/abc',
  apple_music_url: 'https://music.apple.com/album/xyz',
  youtube_music_url: 'https://music.youtube.com/search?q=Autechre+Confield',
  bandcamp_url: null,
  soundcloud_url: null,
};

const lmlReleaseResponse = {
  release_id: 12345,
  title: 'Confield',
  artist: 'Autechre',
  year: 2001,
  label: 'Warp',
  artist_id: 3840,
  genres: ['Electronic'],
  styles: ['IDM'],
  tracklist: [],
  artwork_url: 'https://i.discogs.com/art-release.jpg',
  release_url: 'https://www.discogs.com/release/12345',
  released: '2001-04-30',
  cached: false,
  artists: [{ artist_id: 3840, name: 'Autechre', join: '', role: null }],
};

const lmlArtistResponse = {
  artist_id: 3840,
  name: 'Autechre',
  profile: '[a=Rob Brown] and [a=Sean Booth] formed Autechre in [l=Warp Records].',
  image_url: 'https://i.discogs.com/autechre.jpg',
  name_variations: [],
  aliases: [],
  members: [],
  urls: ['https://en.wikipedia.org/wiki/Autechre', 'https://autechre.ws'],
  cached: false,
};

// --- Tests ---

describe('metadata.service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, LIBRARY_METADATA_URL: 'http://lml.test:8000' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns null when LIBRARY_METADATA_URL is not configured', async () => {
    delete process.env.LIBRARY_METADATA_URL;

    const result = await fetchMetadata({ artistName: 'Autechre' });

    expect(result).toBeNull();
    expect(mockSearchDiscogs).not.toHaveBeenCalled();
  });

  it('fetches album and artist metadata via LML and returns it', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [lmlSearchResult], total: 1, cached: false });
    mockGetRelease.mockResolvedValue(lmlReleaseResponse);
    mockGetArtistDetails.mockResolvedValue(lmlArtistResponse);

    const result = await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
      albumId: 42,
      artistId: 99,
    });

    // Verify LML was called
    expect(mockSearchDiscogs).toHaveBeenCalledWith('Autechre', 'Confield');
    expect(mockGetRelease).toHaveBeenCalledWith(12345);
    expect(mockGetArtistDetails).toHaveBeenCalledWith(3840);

    // Verify album metadata
    expect(result?.album?.discogsReleaseId).toBe(12345);
    expect(result?.album?.spotifyUrl).toBe('https://open.spotify.com/album/abc');
    expect(result?.album?.appleMusicUrl).toBe('https://music.apple.com/album/xyz');
    expect(result?.album?.artworkUrl).toBe('https://i.discogs.com/art-release.jpg'); // release artwork preferred
    expect(result?.album?.releaseYear).toBe(2001);
    // Fallback search URLs filled for missing fields
    expect(result?.album?.bandcampUrl).toContain('bandcamp.com');
    expect(result?.album?.soundcloudUrl).toContain('soundcloud.com');

    // Verify artist metadata — bio should be cleaned of Discogs markup
    expect(result?.artist?.bio).toBe('Rob Brown and Sean Booth formed Autechre in Warp Records.');
    expect(result?.artist?.wikipediaUrl).toBe('https://en.wikipedia.org/wiki/Autechre');
  });

  it('extracts streaming URLs from LML search results', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [lmlSearchResult], total: 1, cached: false });
    mockGetRelease.mockResolvedValue(lmlReleaseResponse);
    mockGetArtistDetails.mockResolvedValue(lmlArtistResponse);

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.spotifyUrl).toBe('https://open.spotify.com/album/abc');
    expect(result?.album?.appleMusicUrl).toBe('https://music.apple.com/album/xyz');
    expect(result?.album?.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=Autechre+Confield');
  });

  it('uses SearchUrlProvider fallback when LML URLs are null', async () => {
    const resultNoUrls = {
      ...lmlSearchResult,
      spotify_url: null,
      apple_music_url: null,
      youtube_music_url: null,
      bandcamp_url: null,
      soundcloud_url: null,
    };
    mockSearchDiscogs.mockResolvedValue({ results: [resultNoUrls], total: 1, cached: false });
    mockGetRelease.mockResolvedValue(lmlReleaseResponse);
    mockGetArtistDetails.mockResolvedValue(lmlArtistResponse);

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    // Search URLs constructed as fallback
    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.bandcampUrl).toContain('bandcamp.com');
    expect(result?.album?.soundcloudUrl).toContain('soundcloud.com');
    // API-sourced URLs remain undefined
    expect(result?.album?.spotifyUrl).toBeUndefined();
    expect(result?.album?.appleMusicUrl).toBeUndefined();
  });

  it('returns search URLs when LML search fails', async () => {
    mockSearchDiscogs.mockRejectedValue(new Error('LML down'));

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.bandcampUrl).toContain('bandcamp.com');
    expect(result?.album?.spotifyUrl).toBeUndefined();
    expect(result?.artist).toBeUndefined();
  });

  it('returns search URLs when LML search returns empty results', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [], total: 0, cached: false });

    const result = await fetchMetadata({ artistName: 'Unknown Artist' });

    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.discogsReleaseId).toBeUndefined();
  });

  it('retries with track title when album title search returns empty', async () => {
    // First call (album title) returns nothing; second call (track title) succeeds
    mockSearchDiscogs
      .mockResolvedValueOnce({ results: [], total: 0, cached: false })
      .mockResolvedValueOnce({ results: [lmlSearchResult], total: 1, cached: false });
    mockGetRelease.mockResolvedValue(lmlReleaseResponse);
    mockGetArtistDetails.mockResolvedValue(lmlArtistResponse);

    const result = await fetchMetadata({
      artistName: 'Cocteau Twins',
      albumTitle: 'cocteau twins singles collections',
      trackTitle: 'crushed',
    });

    // searchDiscogs called twice: first with album title, then with track title
    expect(mockSearchDiscogs).toHaveBeenCalledTimes(2);
    expect(mockSearchDiscogs).toHaveBeenNthCalledWith(1, 'Cocteau Twins', 'cocteau twins singles collections');
    expect(mockSearchDiscogs).toHaveBeenNthCalledWith(2, 'Cocteau Twins', 'crushed');
    // Metadata populated from the retry result
    expect(result?.album?.discogsReleaseId).toBe(12345);
    expect(result?.album?.spotifyUrl).toBe('https://open.spotify.com/album/abc');
  });

  it('returns search URLs when both album and track title searches return empty', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [], total: 0, cached: false });

    const result = await fetchMetadata({
      artistName: 'Unknown Artist',
      albumTitle: 'wrong album',
      trackTitle: 'wrong track',
    });

    // searchDiscogs called twice, no infinite retry
    expect(mockSearchDiscogs).toHaveBeenCalledTimes(2);
    expect(mockSearchDiscogs).toHaveBeenNthCalledWith(1, 'Unknown Artist', 'wrong album');
    expect(mockSearchDiscogs).toHaveBeenNthCalledWith(2, 'Unknown Artist', 'wrong track');
    // Falls back to search URLs
    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.discogsReleaseId).toBeUndefined();
  });

  it('does not retry when album title search succeeds on first try', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [lmlSearchResult], total: 1, cached: false });
    mockGetRelease.mockResolvedValue(lmlReleaseResponse);
    mockGetArtistDetails.mockResolvedValue(lmlArtistResponse);

    const result = await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });

    expect(mockSearchDiscogs).toHaveBeenCalledTimes(1);
    expect(mockSearchDiscogs).toHaveBeenCalledWith('Autechre', 'Confield');
    expect(result?.album?.discogsReleaseId).toBe(12345);
  });

  it('does not retry when albumTitle is absent and trackTitle is used as primary', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [], total: 0, cached: false });

    const result = await fetchMetadata({
      artistName: 'Unknown Artist',
      trackTitle: 'some track',
    });

    // Only one call — trackTitle was already the primary search term
    expect(mockSearchDiscogs).toHaveBeenCalledTimes(1);
    expect(mockSearchDiscogs).toHaveBeenCalledWith('Unknown Artist', 'some track');
    expect(result?.album?.discogsReleaseId).toBeUndefined();
  });

  it('falls back to search result bio when artist details fails', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [lmlSearchResult], total: 1, cached: false });
    mockGetRelease.mockResolvedValue(lmlReleaseResponse);
    mockGetArtistDetails.mockRejectedValue(new Error('Artist fetch failed'));

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    // Falls back to search result bio (cleaned of markup)
    expect(result?.artist?.bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(result?.artist?.wikipediaUrl).toBe('https://en.wikipedia.org/wiki/Autechre');
  });

  it('handles release fetch failure gracefully', async () => {
    mockSearchDiscogs.mockResolvedValue({ results: [lmlSearchResult], total: 1, cached: false });
    mockGetRelease.mockRejectedValue(new Error('Release fetch failed'));
    // No artist ID available → falls back to search result
    mockGetArtistDetails.mockRejectedValue(new Error('No ID'));

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.discogsReleaseId).toBe(12345);
    expect(result?.album?.spotifyUrl).toBe('https://open.spotify.com/album/abc');
    // Year from search result, not release
    expect(result?.album?.releaseYear).toBe(2001);
  });
});
