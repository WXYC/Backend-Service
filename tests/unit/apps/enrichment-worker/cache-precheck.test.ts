/**
 * Unit tests for the enrichment worker's cache-first pre-check (B1 /
 * BS#1747, under Epic C #877).
 *
 * The CDC worker used to issue one LML lookup per new flowsheet row with no
 * `album_metadata` pre-check, so a release played 50× paid 50 cold lookups
 * (Epic D collapsed the per-play *writes* but not the per-play *LML calls*).
 * B1 reads `album_metadata` for the row's album before calling LML and skips
 * the call when the album already carries a load-bearing field.
 *
 * The regression this test locks down (BS#1089 negative-cache poisoning): a
 * naive "skip if any album_metadata row exists" would freeze a false
 * no-match forever — a null `artwork_url` written during a cold-cache
 * degradation window would never be retried. The skip therefore keys on a
 * confirmed non-null load-bearing field (`artwork_url` / `discogs_url`); null
 * and search-URL-only shells still call LML so they self-heal. That decision
 * lives in `precheck.ts#hasLoadBearingAlbumMetadata`; here we pin that the
 * handler honors its verdict:
 *   - verdict true  → LML is NOT called, the row is finalized from cache.
 *   - verdict false → LML IS called (self-heal path).
 *   - album_id null → the pre-check is not even consulted (unlinked rows have
 *     no album_metadata row); LML is always called.
 *
 * The SQL contract of `hasLoadBearingAlbumMetadata` itself (which column
 * shapes count as load-bearing vs. a self-heal-eligible shell) is validated
 * against real PostgreSQL in
 * `tests/integration/enrichment-worker-cache-precheck.spec.js`.
 */

import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => ({
  startSpan: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// B3 (BS#1749): the handler's LML call now goes through the burst batcher.
// Mock that seam; the pre-check assertions only care whether an LML call is
// issued at all, which the batcher stands in for here.
const mockEnrichmentBulkLookup = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('../../../../apps/enrichment-worker/lookup-batcher.js', () => ({
  enrichmentBulkLookup: mockEnrichmentBulkLookup,
}));

const mockClaimRowForEnrichment =
  jest.fn<(id: number) => Promise<{ claimed: true; id: number } | { claimed: false }>>();
jest.mock('../../../../apps/enrichment-worker/claim.js', () => ({
  claimRowForEnrichment: mockClaimRowForEnrichment,
}));

const mockFilterForEnrichment = jest.fn<(event: unknown) => unknown>();
jest.mock('../../../../apps/enrichment-worker/cdc-subscriber.js', () => ({
  filterForEnrichment: mockFilterForEnrichment,
}));

// Stub finalizeRow (the LML-path finalize) but keep the real extractArtwork
// that empty-outcome.ts re-imports.
const mockFinalizeRow = jest.fn<(...args: unknown[]) => Promise<string>>();
jest.mock('../../../../apps/enrichment-worker/enrich.js', () => {
  const actual = jest.requireActual<typeof import('../../../../apps/enrichment-worker/enrich')>(
    '../../../../apps/enrichment-worker/enrich'
  );
  return { ...actual, finalizeRow: mockFinalizeRow };
});

// The pre-check module under test at the seam. Both functions are mocked so
// this file exercises only the handler's branching; their DB behavior is
// covered by the integration spec + precheck.test.ts.
const mockHasLoadBearingAlbumMetadata = jest.fn<(albumId: number) => Promise<boolean>>();
const mockFinalizeFromCachedMetadata = jest.fn<(...args: unknown[]) => Promise<string>>();
jest.mock('../../../../apps/enrichment-worker/precheck.js', () => ({
  hasLoadBearingAlbumMetadata: mockHasLoadBearingAlbumMetadata,
  finalizeFromCachedMetadata: mockFinalizeFromCachedMetadata,
}));

import * as Sentry from '@sentry/node';

import { makeEnrichmentHandler } from '../../../../apps/enrichment-worker/handler';

type SpanLike = { setAttribute: jest.Mock };

const makeCandidate = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  entry_type: 'track' as const,
  metadata_status: 'pending' as const,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  album_id: 7 as number | null,
  ...overrides,
});

const driveOneTick = async (candidate: ReturnType<typeof makeCandidate>): Promise<SpanLike> => {
  const span: SpanLike = { setAttribute: jest.fn() };
  (Sentry.startSpan as jest.Mock).mockImplementation((_opts: unknown, fn: any) => fn(span));
  mockFilterForEnrichment.mockReturnValueOnce(candidate);
  mockClaimRowForEnrichment.mockResolvedValueOnce({ claimed: true, id: candidate.id });

  const handler = makeEnrichmentHandler();
  handler({} as any);
  await new Promise((resolve) => setImmediate(resolve));
  return span;
};

const matchResponse = {
  results: [
    {
      artwork: {
        artwork_url: 'https://i.discogs.com/abc/cover.jpg',
        release_url: 'https://discogs.com/release/123',
      },
    },
  ],
};

describe('enrichment-worker cache-first pre-check (B1 / BS#1747)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips the LML call when album_metadata already carries a load-bearing field', async () => {
    mockHasLoadBearingAlbumMetadata.mockResolvedValueOnce(true);
    mockFinalizeFromCachedMetadata.mockResolvedValueOnce('cache_hit');

    const span = await driveOneTick(makeCandidate({ album_id: 7 }));

    expect(mockHasLoadBearingAlbumMetadata).toHaveBeenCalledWith(7);
    expect(mockEnrichmentBulkLookup).not.toHaveBeenCalled();
    expect(mockFinalizeFromCachedMetadata).toHaveBeenCalledTimes(1);
    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'cache_hit');
    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.lml_skipped', true);
  });

  it('still calls LML when the album row is a self-heal-eligible shell (verdict false)', async () => {
    // BS#1089 regression guard: a null / search-URL-only album_metadata row
    // must NOT freeze a false no-match. The pre-check returns false, so the
    // worker re-calls LML.
    mockHasLoadBearingAlbumMetadata.mockResolvedValueOnce(false);
    mockEnrichmentBulkLookup.mockResolvedValueOnce(matchResponse);
    mockFinalizeRow.mockResolvedValueOnce('enriched_match');

    const span = await driveOneTick(makeCandidate({ album_id: 7 }));

    expect(mockHasLoadBearingAlbumMetadata).toHaveBeenCalledWith(7);
    expect(mockEnrichmentBulkLookup).toHaveBeenCalledTimes(1);
    expect(mockFinalizeFromCachedMetadata).not.toHaveBeenCalled();
    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'enriched_match');
  });

  it('does not consult the pre-check for unlinked rows (album_id null) and always calls LML', async () => {
    mockEnrichmentBulkLookup.mockResolvedValueOnce(matchResponse);
    mockFinalizeRow.mockResolvedValueOnce('enriched_match');

    await driveOneTick(makeCandidate({ album_id: null }));

    expect(mockHasLoadBearingAlbumMetadata).not.toHaveBeenCalled();
    expect(mockEnrichmentBulkLookup).toHaveBeenCalledTimes(1);
  });
});
