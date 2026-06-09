/**
 * Unit tests for jobs/rotation-artist-backfill/lml-fetch.ts (BS#1361).
 *
 * Two behaviors under test:
 *   1. classifyError: 404 → kind=not_found; 5xx + timeout + network → kind=error,retryable=true;
 *      4xx other than 404 → kind=error,retryable=false.
 *   2. extractPhase1ArtistIds: the singular `release.artist_id` and every credit
 *      in `release.artists` with a non-null `artist_id`. NULL credits skipped;
 *      duplicates deduped; sorted ascending for deterministic logging.
 *
 * The release/artist endpoint wrappers themselves are thin pass-throughs to
 * @wxyc/lml-client.getRelease/getArtistDetails wrapped in defaultLmlLimiter;
 * the integration behavior is covered through the orchestrate.test.ts mocks
 * (which inject FetchOutcome directly), so we don't double-test the wrap here.
 */

import { jest } from '@jest/globals';
import { LmlClientError } from '@wxyc/lml-client';

describe('jobs/rotation-artist-backfill/lml-fetch', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const loadModule = async (
    overrides: { getRelease?: jest.Mock; getArtistDetails?: jest.Mock } = {}
  ): Promise<typeof import('../../../../jobs/rotation-artist-backfill/lml-fetch.js')> => {
    jest.doMock('../../../../jobs/rotation-artist-backfill/lml-limiter.js', () => ({
      // Run-through limiter: no rate-limiting in unit tests.
      defaultLmlLimiter: { run: <T>(fn: () => Promise<T>) => fn() },
    }));
    jest.doMock('@wxyc/lml-client', () => ({
      LmlClientError,
      getRelease: overrides.getRelease ?? jest.fn(),
      getArtistDetails: overrides.getArtistDetails ?? jest.fn(),
    }));
    return import('../../../../jobs/rotation-artist-backfill/lml-fetch.js');
  };

  describe('fetchRelease', () => {
    it('returns {kind: "ok", value} on success', async () => {
      const release = {
        release_id: 123,
        title: 'Test',
        artist: 'X',
        artists: [],
        genres: [],
        styles: [],
        tracklist: [],
      };
      const getRelease = jest.fn().mockResolvedValue(release);
      const { fetchRelease } = await loadModule({ getRelease });
      const result = await fetchRelease(123);
      expect(result).toEqual({ kind: 'ok', value: release });
      expect(getRelease).toHaveBeenCalledWith(123);
    });

    it('maps a 404 LmlClientError to {kind: "not_found"}', async () => {
      const getRelease = jest.fn().mockRejectedValue(new LmlClientError('not found', 404));
      const { fetchRelease } = await loadModule({ getRelease });
      const result = await fetchRelease(999);
      expect(result.kind).toBe('not_found');
    });

    it('maps a 5xx LmlClientError to {kind: "error", retryable: true}', async () => {
      const getRelease = jest.fn().mockRejectedValue(new LmlClientError('upstream', 502));
      const { fetchRelease } = await loadModule({ getRelease });
      const result = await fetchRelease(1);
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.retryable).toBe(true);
    });

    it('maps a 504 LmlClientError to {kind: "error", retryable: true}', async () => {
      const getRelease = jest.fn().mockRejectedValue(new LmlClientError('timed out', 504));
      const { fetchRelease } = await loadModule({ getRelease });
      const result = await fetchRelease(1);
      if (result.kind === 'error') expect(result.retryable).toBe(true);
    });

    it('maps a 401/403 LmlClientError to {kind: "error", retryable: false}', async () => {
      const getRelease = jest.fn().mockRejectedValue(new LmlClientError('unauthorized', 401));
      const { fetchRelease } = await loadModule({ getRelease });
      const result = await fetchRelease(1);
      if (result.kind === 'error') expect(result.retryable).toBe(false);
    });

    it('maps a non-LmlClientError to {kind: "error", retryable: true}', async () => {
      const getRelease = jest.fn().mockRejectedValue(new Error('socket hang up'));
      const { fetchRelease } = await loadModule({ getRelease });
      const result = await fetchRelease(1);
      if (result.kind === 'error') expect(result.retryable).toBe(true);
    });
  });

  describe('fetchArtist', () => {
    it('returns {kind: "ok", value} on success', async () => {
      const artist = { artist_id: 6998498, name: 'Yetsuby', profile: '...' };
      const getArtistDetails = jest.fn().mockResolvedValue(artist);
      const { fetchArtist } = await loadModule({ getArtistDetails });
      const result = await fetchArtist(6998498);
      expect(result).toEqual({ kind: 'ok', value: artist });
    });

    it('maps a 404 LmlClientError to {kind: "not_found"}', async () => {
      const getArtistDetails = jest.fn().mockRejectedValue(new LmlClientError('gone', 404));
      const { fetchArtist } = await loadModule({ getArtistDetails });
      const result = await fetchArtist(42);
      expect(result.kind).toBe('not_found');
    });
  });

  describe('extractPhase1ArtistIds', () => {
    it('returns the singular release.artist_id when present', async () => {
      const { extractPhase1ArtistIds } = await loadModule();
      expect(
        extractPhase1ArtistIds({ artist_id: 555, artists: [] } as unknown as Parameters<
          typeof extractPhase1ArtistIds
        >[0])
      ).toEqual([555]);
    });

    it('returns every release.artists[*].artist_id', async () => {
      const { extractPhase1ArtistIds } = await loadModule();
      const release = {
        artist_id: 100,
        artists: [
          { artist_id: 100, name: 'A', join: ' & ' },
          { artist_id: 200, name: 'B', join: '' },
        ],
      };
      expect(extractPhase1ArtistIds(release as unknown as Parameters<typeof extractPhase1ArtistIds>[0])).toEqual([
        100, 200,
      ]);
    });

    it('skips credits with null artist_id (name-only)', async () => {
      const { extractPhase1ArtistIds } = await loadModule();
      const release = {
        artists: [
          { artist_id: 100, name: 'A', join: '' },
          { artist_id: null, name: 'Unknown', join: '' },
        ],
      };
      expect(extractPhase1ArtistIds(release as unknown as Parameters<typeof extractPhase1ArtistIds>[0])).toEqual([100]);
    });

    it('returns ids sorted ascending for deterministic logging', async () => {
      const { extractPhase1ArtistIds } = await loadModule();
      const release = {
        artists: [
          { artist_id: 300, name: 'C', join: '' },
          { artist_id: 100, name: 'A', join: '' },
          { artist_id: 200, name: 'B', join: '' },
        ],
      };
      expect(extractPhase1ArtistIds(release as unknown as Parameters<typeof extractPhase1ArtistIds>[0])).toEqual([
        100, 200, 300,
      ]);
    });

    it('returns an empty array when no ids are present', async () => {
      const { extractPhase1ArtistIds } = await loadModule();
      expect(
        extractPhase1ArtistIds({ artists: [] } as unknown as Parameters<typeof extractPhase1ArtistIds>[0])
      ).toEqual([]);
    });

    it('tolerates missing artists array', async () => {
      const { extractPhase1ArtistIds } = await loadModule();
      expect(extractPhase1ArtistIds({} as unknown as Parameters<typeof extractPhase1ArtistIds>[0])).toEqual([]);
    });
  });
});
