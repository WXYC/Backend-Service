/**
 * Unit tests for the metadata service.
 *
 * Verifies that fetchMetadata routes through LML's /lookup endpoint
 * and returns metadata for the caller to persist.
 */
import { jest } from '@jest/globals';

// --- Mocks ---

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
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

const lookupResponseWithResults = {
  results: [
    {
      library_item: {
        id: 1,
        title: 'Confield',
        artist: 'Autechre',
        call_number: 'Electronic CD AUT 123/1',
        library_url: 'https://library.wxyc.org/1',
      },
      artwork: {
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
      },
    },
  ],
  search_type: 'direct',
  song_not_found: false,
  found_on_compilation: false,
};

const emptyLookupResponse = {
  results: [],
  search_type: 'none',
  song_not_found: false,
  found_on_compilation: false,
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
    expect(mockLookupMetadata).not.toHaveBeenCalled();
  });

  it('calls lookupMetadata with artist, album, and track', async () => {
    mockLookupMetadata.mockResolvedValue(lookupResponseWithResults);

    await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });

    expect(mockLookupMetadata).toHaveBeenCalledWith('Autechre', 'Confield', 'VI Scose Poise');
  });

  it('makes a single LML call instead of three', async () => {
    mockLookupMetadata.mockResolvedValue(lookupResponseWithResults);

    await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
  });

  it('extracts album metadata from lookup response artwork', async () => {
    mockLookupMetadata.mockResolvedValue(lookupResponseWithResults);

    const result = await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    expect(result?.album?.discogsReleaseId).toBe(12345);
    expect(result?.album?.discogsUrl).toBe('https://www.discogs.com/release/12345');
    expect(result?.album?.artworkUrl).toBe('https://i.discogs.com/art.jpg');
    expect(result?.album?.releaseYear).toBe(2001);
    expect(result?.album?.spotifyUrl).toBe('https://open.spotify.com/album/abc');
    expect(result?.album?.appleMusicUrl).toBe('https://music.apple.com/album/xyz');
    expect(result?.album?.youtubeMusicUrl).toBe('https://music.youtube.com/search?q=Autechre+Confield');
  });

  it('extracts artist metadata from lookup response artwork', async () => {
    mockLookupMetadata.mockResolvedValue(lookupResponseWithResults);

    const result = await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    expect(result?.artist?.bio).toBe('Rob Brown and Sean Booth are Autechre.');
    expect(result?.artist?.wikipediaUrl).toBe('https://en.wikipedia.org/wiki/Autechre');
  });

  it('fills missing streaming URLs with search URL fallbacks', async () => {
    mockLookupMetadata.mockResolvedValue(lookupResponseWithResults);

    const result = await fetchMetadata({
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    // bandcamp_url and soundcloud_url are null in the fixture, so fallbacks should fill them
    expect(result?.album?.bandcampUrl).toContain('bandcamp.com');
    expect(result?.album?.soundcloudUrl).toContain('soundcloud.com');
  });

  it('uses SearchUrlProvider fallback when all LML URLs are null', async () => {
    const responseNoUrls = structuredClone(lookupResponseWithResults);
    const artwork = responseNoUrls.results[0].artwork;
    artwork.spotify_url = null;
    artwork.apple_music_url = null;
    artwork.youtube_music_url = null;
    artwork.bandcamp_url = null;
    artwork.soundcloud_url = null;
    mockLookupMetadata.mockResolvedValue(responseNoUrls);

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.bandcampUrl).toContain('bandcamp.com');
    expect(result?.album?.soundcloudUrl).toContain('soundcloud.com');
    // API-sourced URLs remain undefined (null → undefined)
    expect(result?.album?.spotifyUrl).toBeUndefined();
    expect(result?.album?.appleMusicUrl).toBeUndefined();
  });

  it('rethrows when lookup fails so the caller can route to Sentry', async () => {
    // The previous behavior — swallowing LML errors and falling through to
    // synthesized search URLs — is removed in #639. Failures now propagate
    // to the caller (`enrichment.service.ts` Sentry-reports them; the
    // historical-drain job in #638 logs and skips). A swallowed throw makes
    // the new `metadata_attempt_at` stamp meaningless because the runtime
    // path can no longer distinguish "tried-no-match" from "tried-LML-down".
    mockLookupMetadata.mockRejectedValue(new Error('LML down'));

    await expect(fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' })).rejects.toThrow('LML down');
  });

  it('returns search URLs when lookup returns empty results', async () => {
    mockLookupMetadata.mockResolvedValue(emptyLookupResponse);

    const result = await fetchMetadata({ artistName: 'Unknown Artist' });

    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.discogsReleaseId).toBeUndefined();
  });

  it('returns search URLs when result has no artwork', async () => {
    const responseNoArtwork = {
      ...lookupResponseWithResults,
      results: [{ library_item: lookupResponseWithResults.results[0].library_item, artwork: null }],
    };
    mockLookupMetadata.mockResolvedValue(responseNoArtwork);

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.youtubeMusicUrl).toContain('music.youtube.com');
    expect(result?.album?.discogsReleaseId).toBeUndefined();
  });

  it('strips Discogs spacer.gif placeholder from artworkUrl (#649)', async () => {
    // Discogs returns spacer.gif when a release has no real cover art.
    // Persisting that to flowsheet.artwork_url makes the playlist-proxy
    // partial index treat the row as "has artwork" and iOS shows a
    // broken/blank image. Drop the URL at the chokepoint so every
    // downstream caller of fetchMetadata benefits without remembering.
    const responseWithSpacer = structuredClone(lookupResponseWithResults);
    responseWithSpacer.results[0].artwork.artwork_url = 'https://s.discogs.com/images/spacer.gif';
    mockLookupMetadata.mockResolvedValue(responseWithSpacer);

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.artworkUrl).toBeUndefined();
    // Other album metadata is preserved — the filter only nulls artworkUrl.
    expect(result?.album?.discogsReleaseId).toBe(12345);
    expect(result?.album?.releaseYear).toBe(2001);
  });

  it('preserves non-spacer artwork URLs unchanged (#649 negative case)', async () => {
    mockLookupMetadata.mockResolvedValue(lookupResponseWithResults);

    const result = await fetchMetadata({ artistName: 'Autechre', albumTitle: 'Confield' });

    expect(result?.album?.artworkUrl).toBe('https://i.discogs.com/art.jpg');
  });
});
