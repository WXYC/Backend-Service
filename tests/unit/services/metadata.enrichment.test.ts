/**
 * Unit tests for the fire-and-forget metadata enrichment helper.
 *
 * Verifies that fireAndForgetMetadataForRow:
 *   - calls fetchMetadata with the input fields
 *   - on success, updates the flowsheet row with the 10-column metadata payload
 *   - on fetch failure, captures the error to Sentry under subsystem='metadata'
 *     and does not throw
 *   - returns synchronously (callers must not be blocked by enrichment)
 */
import { jest } from '@jest/globals';

const mockFetchMetadata = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/metadata/metadata.service', () => ({
  fetchMetadata: mockFetchMetadata,
}));

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

import { db } from '@wxyc/database';
import { fireAndForgetMetadataForRow } from '../../../apps/backend/services/metadata/enrichment.service';

const mockDb = db as unknown as {
  update: jest.Mock;
  _chain: { set: jest.Mock; where: jest.Mock };
};

describe('fireAndForgetMetadataForRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns void synchronously even when fetchMetadata is pending', () => {
    mockFetchMetadata.mockReturnValue(new Promise(() => undefined));

    const result = fireAndForgetMetadataForRow({
      flowsheetId: 1,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });

    expect(result).toBeUndefined();
    expect(mockFetchMetadata).toHaveBeenCalledWith({
      albumId: undefined,
      artistId: undefined,
      artistName: 'Autechre',
      albumTitle: 'Confield',
      trackTitle: 'VI Scose Poise',
    });
  });

  it('writes all 10 metadata columns when fetchMetadata returns full enrichment', async () => {
    mockFetchMetadata.mockResolvedValue({
      album: {
        artworkUrl: 'https://i.discogs.com/art.jpg',
        discogsUrl: 'https://www.discogs.com/release/12345',
        releaseYear: 2001,
        spotifyUrl: 'https://open.spotify.com/album/abc',
        appleMusicUrl: 'https://music.apple.com/album/xyz',
        youtubeMusicUrl: 'https://music.youtube.com/album/aaa',
        bandcampUrl: 'https://bandcamp.com/album/bbb',
        soundcloudUrl: 'https://soundcloud.com/album/ccc',
      },
      artist: {
        bio: 'Rob Brown and Sean Booth are Autechre.',
        wikipediaUrl: 'https://en.wikipedia.org/wiki/Autechre',
      },
    });

    fireAndForgetMetadataForRow({
      flowsheetId: 42,
      artistName: 'Autechre',
      albumTitle: 'Confield',
    });

    // Drain the promise queue so the .then() callback runs.
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb._chain.set).toHaveBeenCalledWith({
      artwork_url: 'https://i.discogs.com/art.jpg',
      discogs_url: 'https://www.discogs.com/release/12345',
      release_year: 2001,
      spotify_url: 'https://open.spotify.com/album/abc',
      apple_music_url: 'https://music.apple.com/album/xyz',
      youtube_music_url: 'https://music.youtube.com/album/aaa',
      bandcamp_url: 'https://bandcamp.com/album/bbb',
      soundcloud_url: 'https://soundcloud.com/album/ccc',
      artist_bio: 'Rob Brown and Sean Booth are Autechre.',
      artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Autechre',
    });
  });

  it('skips the DB update when fetchMetadata returns null', async () => {
    mockFetchMetadata.mockResolvedValue(null);

    fireAndForgetMetadataForRow({
      flowsheetId: 99,
      artistName: 'Anonymous Artist',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('accepts null albumTitle/trackTitle from truncate() and forwards as undefined to fetchMetadata', () => {
    mockFetchMetadata.mockReturnValue(new Promise(() => undefined));

    fireAndForgetMetadataForRow({
      flowsheetId: 5,
      artistName: 'Lone Anonymous',
      albumTitle: null,
      trackTitle: null,
    });

    expect(mockFetchMetadata).toHaveBeenCalledWith({
      albumId: undefined,
      artistId: undefined,
      artistName: 'Lone Anonymous',
      albumTitle: undefined,
      trackTitle: undefined,
    });
  });

  it('reports fetchMetadata errors to Sentry with subsystem=metadata and does not throw', async () => {
    const error = new Error('LML responded with 502');
    mockFetchMetadata.mockRejectedValue(error);

    expect(() =>
      fireAndForgetMetadataForRow({
        flowsheetId: 7,
        artistName: 'King Crimson',
        albumTitle: 'Discipline',
      })
    ).not.toThrow();

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockCaptureException).toHaveBeenCalledWith(error, {
      tags: { subsystem: 'metadata' },
      extra: {
        flowsheetId: 7,
        artistName: 'King Crimson',
        albumTitle: 'Discipline',
      },
    });
  });
});
