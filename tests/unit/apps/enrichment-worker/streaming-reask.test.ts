/**
 * Unit tests for the enrichment worker's hourly streaming self-heal sweep
 * (BS#1915).
 *
 * `findUnresolvedStreamingCandidates` selects `album_metadata` rows that
 * still carry a load-bearing Discogs match but have a streaming field stuck
 * `unresolved` under `STREAMING_REASK_ATTEMPT_CAP`. `reaskUnresolvedStreaming`
 * is the driver: for each candidate it re-asks LML through the SAME class-5
 * `enrichmentBulkLookup` pipeline the live CDC path uses (already tagged
 * `caller: 'enrichment-worker'` — the batch/low-priority lane, BS#1826), and
 * on a fresh artwork response reuses `upsertMatchedAlbumMetadata`'s merge +
 * UPSERT (never overwriting a verified URL, treating `absent` as terminal).
 * A candidate whose re-ask comes back with no artwork at all still spends an
 * attempt (`bumpStreamingReaskAttempts`) so a persistently-unmatchable album
 * doesn't retry forever; a candidate whose LML call THROWS (transient
 * failure/shed) spends nothing and stays eligible for the next sweep.
 *
 * Real-Postgres coverage of the candidate-selection WHERE and the
 * merge/write contract (an `unresolved` field healing to `verified`,
 * `absent` staying terminal, the attempt cap holding, a verified URL never
 * overwritten) lives in
 * tests/integration/enrichment-worker-streaming-reask.spec.js.
 */
import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => ({
  startSpan: jest.fn((_opts: unknown, fn: (span: { setAttribute: jest.Mock }) => unknown) =>
    fn({ setAttribute: jest.fn() })
  ),
  captureException: jest.fn(),
}));

const mockEnrichmentBulkLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../../../../apps/enrichment-worker/lookup-batcher.js', () => ({
  enrichmentBulkLookup: mockEnrichmentBulkLookup,
}));

const mockUpsertMatchedAlbumMetadata = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockBumpStreamingReaskAttempts = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.mock('../../../../apps/enrichment-worker/enrich.js', () => {
  const actual = jest.requireActual<typeof import('../../../../apps/enrichment-worker/enrich')>(
    '../../../../apps/enrichment-worker/enrich'
  );
  return {
    ...actual,
    upsertMatchedAlbumMetadata: mockUpsertMatchedAlbumMetadata,
    bumpStreamingReaskAttempts: mockBumpStreamingReaskAttempts,
  };
});

import { db } from '@wxyc/database';
import {
  findUnresolvedStreamingCandidates,
  reaskUnresolvedStreaming,
} from '../../../../apps/enrichment-worker/streaming-reask';

const mockDb = db as unknown as {
  select: jest.Mock;
  _chain: { from: jest.Mock; innerJoin: jest.Mock; where: jest.Mock; limit: jest.Mock };
};

const CANDIDATE = { album_id: 7, artist_name: 'Sessa', album_title: 'Pequena Vertigem de Amor' };

describe('findUnresolvedStreamingCandidates (BS#1915)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queries album_metadata and passes the caller limit through to .limit()', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    await findUnresolvedStreamingCandidates(25);

    expect(mockDb.select).toHaveBeenCalled();
    expect(mockDb._chain.limit).toHaveBeenCalledWith(25);
  });

  it('returns the rows the query resolves', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE]));

    const candidates = await findUnresolvedStreamingCandidates(100);

    expect(candidates).toEqual([CANDIDATE]);
  });
});

describe('reaskUnresolvedStreaming (BS#1915)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('short-circuits with zero counts when there are no candidates — never calls LML', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    const result = await reaskUnresolvedStreaming(100);

    expect(mockEnrichmentBulkLookup).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 0, succeeded: 0, failed: 0 });
  });

  it('dispatches enrichmentBulkLookup per candidate through the shared batch-lane batcher, and upserts a fresh match', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE]));
    mockEnrichmentBulkLookup.mockResolvedValueOnce({
      search_type: 'direct',
      results: [
        { artwork: { artwork_url: 'https://i.discogs.com/x.jpg', release_url: 'https://discogs.com/release/1' } },
      ],
    });

    const result = await reaskUnresolvedStreaming(100);

    expect(mockEnrichmentBulkLookup).toHaveBeenCalledWith(
      expect.objectContaining({ artist_name: 'Sessa', album_title: 'Pequena Vertigem de Amor', track_title: null })
    );
    expect(mockUpsertMatchedAlbumMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertMatchedAlbumMetadata.mock.calls[0]?.[0]).toBe(7);
    expect(mockBumpStreamingReaskAttempts).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 1, succeeded: 1, failed: 0 });
  });

  it('bumps the attempt counter (no album_metadata write) when LML answers with no artwork at all', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE]));
    mockEnrichmentBulkLookup.mockResolvedValueOnce({ results: [] });

    const result = await reaskUnresolvedStreaming(100);

    expect(mockBumpStreamingReaskAttempts).toHaveBeenCalledWith(7);
    expect(mockUpsertMatchedAlbumMetadata).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 1, succeeded: 1, failed: 0 });
  });

  it('spends nothing when the LML call itself throws — bounded, but a transient failure never costs an attempt', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE]));
    mockEnrichmentBulkLookup.mockRejectedValueOnce(new Error('shed_limiter_saturated'));

    const result = await reaskUnresolvedStreaming(100);

    expect(mockBumpStreamingReaskAttempts).not.toHaveBeenCalled();
    expect(mockUpsertMatchedAlbumMetadata).not.toHaveBeenCalled();
    expect(result).toEqual({ candidates: 1, succeeded: 0, failed: 1 });
  });

  it('processes multiple candidates independently — one failure does not block the others', async () => {
    const second = { album_id: 8, artist_name: 'Chuquimamani-Condori', album_title: 'Edits' };
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE, second]));
    mockEnrichmentBulkLookup.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({
      search_type: 'direct',
      results: [
        { artwork: { artwork_url: 'https://i.discogs.com/y.jpg', release_url: 'https://discogs.com/release/2' } },
      ],
    });

    const result = await reaskUnresolvedStreaming(100);

    expect(mockUpsertMatchedAlbumMetadata).toHaveBeenCalledTimes(1);
    expect(mockUpsertMatchedAlbumMetadata.mock.calls[0]?.[0]).toBe(8);
    expect(result).toEqual({ candidates: 2, succeeded: 1, failed: 1 });
  });

  /**
   * BS#1359 — the reask arm inherits the track-context gate from the single
   * `extractArtwork` chokepoint even though this lookup is album-level
   * (`track_title: null`). The plan documents this as an intentional
   * degeneration to album-context (only `direct` is reachable in practice —
   * a track-less lookup does not surface `compilation`), which is strictly
   * more conservative than the pre-gate "any artwork" behavior: an untrusted
   * re-match spends an attempt via `bumpStreamingReaskAttempts` instead of
   * healing streaming off an unconfirmed album re-match.
   */
  describe('BS#1359 track-context trust gate on the reask arm', () => {
    it("search_type 'direct' upserts a fresh match", async () => {
      mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE]));
      mockEnrichmentBulkLookup.mockResolvedValueOnce({
        search_type: 'direct',
        results: [
          { artwork: { artwork_url: 'https://i.discogs.com/z.jpg', release_url: 'https://discogs.com/release/3' } },
        ],
      });

      const result = await reaskUnresolvedStreaming(100);

      expect(mockUpsertMatchedAlbumMetadata).toHaveBeenCalledTimes(1);
      expect(mockBumpStreamingReaskAttempts).not.toHaveBeenCalled();
      expect(result).toEqual({ candidates: 1, succeeded: 1, failed: 0 });
    });

    it("an untrusted search_type (e.g. 'fallback') with a populated artwork object routes to bumpStreamingReaskAttempts, not upsertMatchedAlbumMetadata", async () => {
      mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([CANDIDATE]));
      mockEnrichmentBulkLookup.mockResolvedValueOnce({
        search_type: 'fallback',
        results: [
          { artwork: { artwork_url: 'https://i.discogs.com/wrong.jpg', release_url: 'https://discogs.com/release/4' } },
        ],
      });

      const result = await reaskUnresolvedStreaming(100);

      expect(mockUpsertMatchedAlbumMetadata).not.toHaveBeenCalled();
      expect(mockBumpStreamingReaskAttempts).toHaveBeenCalledWith(7);
      expect(result).toEqual({ candidates: 1, succeeded: 1, failed: 0 });
    });
  });
});
