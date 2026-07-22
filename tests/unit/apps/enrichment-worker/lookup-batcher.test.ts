/**
 * Unit tests for the enrichment worker's LML lookup batcher (B3 / BS#1749,
 * under Epic C #877).
 *
 * The CDC worker dispatches one `handleCandidate` per new flowsheet row,
 * fire-and-forget. Before B3 each of those issued its OWN `lookupMetadata`
 * call, so a burst of N rows fired N round-trips and overran LML's
 * server-side concurrency ceiling. B3 coalesces the burst: rows that arrive
 * inside a short window are buffered and flushed through a single
 * `bulkLookupMetadata` call (the shared-client method that already exists and
 * was previously unused), chunked at LML's hard cap of 100 items per call.
 *
 * Pinned here (the BS#1749 acceptance criteria):
 *   - A burst of N (< 100) rows issues exactly ONE bulk call, not N.
 *   - A burst larger than 100 chunks into multiple bulk calls, none > 100.
 *   - Per-row results still land — each caller resolves with its own
 *     per-index verdict; an `error` verdict rejects only that caller.
 *   - Items carry `extended: true` so the worker's BS#1336 album_metadata
 *     columns survive the batch (LML#685 honors per-item `extended` on the
 *     bulk path).
 */

import { jest } from '@jest/globals';

// Mock @sentry/node so the shared client's span wiring (imported transitively)
// is inert under test.
jest.mock('@sentry/node', () => ({
  startSpan: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

class FakeLmlClientError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LmlClientError';
    this.status = status;
  }
}

type BulkItem = { artist?: string; album?: string; song?: string; raw_message: string; extended?: boolean };
type BulkResult = { index: number; status: 'match' | 'no_match' | 'error'; lookup: unknown; message?: string };

const mockBulkLookupMetadata = jest.fn<(items: BulkItem[], options?: unknown) => Promise<{ results: BulkResult[] }>>();

jest.mock('@wxyc/lml-client', () => ({
  bulkLookupMetadata: mockBulkLookupMetadata,
  envInt: (_name: string, fallback: number) => fallback,
  LmlClientError: FakeLmlClientError,
}));

import {
  enrichmentBulkLookup,
  _resetLookupBatcherForTest,
  ENRICHMENT_BULK_WINDOW_MS,
} from '../../../../apps/enrichment-worker/lookup-batcher';

/** Build a candidate-shaped lookup input. */
const makeInput = (artist: string, album: string | null = null, track: string | null = null) => ({
  artist_name: artist,
  album_title: album,
  track_title: track,
});

/** A minimal LookupResponse with a populated artwork block. */
const matchLookup = (artistTag: string) => ({
  results: [{ artwork: { artwork_url: `https://i.discogs.com/${artistTag}.jpg`, release_url: null } }],
});

/**
 * Resolve `bulkLookupMetadata` with one `match` verdict per input item, in
 * input order. The nested `lookup` carries the artist tag so parity — the
 * right response reaching the right caller — is checkable.
 */
const echoAllMatched = (items: BulkItem[]) => ({
  results: items.map((item, index) => ({
    index,
    status: 'match' as const,
    lookup: matchLookup(item.artist ?? `idx${index}`),
  })),
});

/**
 * Advance past the flush window and let the mocked bulk call + the per-item
 * settle microtasks drain, so awaited assertions see resolved promises.
 */
const flushWindow = async () => {
  jest.advanceTimersByTime(ENRICHMENT_BULK_WINDOW_MS);
  // Two macrotask hops: one for the bulk promise, one for the per-item fan-out.
  await Promise.resolve();
  await Promise.resolve();
};

describe('enrichmentBulkLookup burst coalescing (B3 / BS#1749)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    _resetLookupBatcherForTest();
    mockBulkLookupMetadata.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces a burst of N rows into a SINGLE bulk call (not N calls)', async () => {
    mockBulkLookupMetadata.mockImplementation((items) => Promise.resolve(echoAllMatched(items)));

    const artists = ['Stereolab', 'Juana Molina', 'Jessica Pratt', 'Duke Ellington & John Coltrane'];
    const promises = artists.map((a) => enrichmentBulkLookup(makeInput(a)));

    await flushWindow();
    await Promise.all(promises);

    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(1);
    const [items] = mockBulkLookupMetadata.mock.calls[0];
    expect(items).toHaveLength(4);
  });

  it('sets extended:true and synthesizes raw_message + fields on each item', async () => {
    mockBulkLookupMetadata.mockImplementation((items) => Promise.resolve(echoAllMatched(items)));

    const p = enrichmentBulkLookup(makeInput('Juana Molina', 'DOGA', 'la paradoja'));
    await flushWindow();
    await p;

    const [items] = mockBulkLookupMetadata.mock.calls[0];
    expect(items[0]).toEqual({
      artist: 'Juana Molina',
      album: 'DOGA',
      song: 'la paradoja',
      raw_message: 'Juana Molina - DOGA - la paradoja',
      extended: true,
    });
  });

  it('chunks a burst larger than 100 into multiple bulk calls, none exceeding 100', async () => {
    mockBulkLookupMetadata.mockImplementation((items) => Promise.resolve(echoAllMatched(items)));

    const promises = Array.from({ length: 250 }, (_, i) => enrichmentBulkLookup(makeInput(`Stereolab ${i}`)));

    await flushWindow();
    await Promise.all(promises);

    expect(mockBulkLookupMetadata).toHaveBeenCalledTimes(3);
    const sizes = mockBulkLookupMetadata.mock.calls.map(([items]) => items.length);
    expect(sizes).toEqual([100, 100, 50]);
    for (const size of sizes) {
      expect(size).toBeLessThanOrEqual(100);
    }
  });

  it('lands each per-row result with its own caller (parity with per-call path)', async () => {
    mockBulkLookupMetadata.mockImplementation((items) => Promise.resolve(echoAllMatched(items)));

    const a = enrichmentBulkLookup(makeInput('Stereolab'));
    const b = enrichmentBulkLookup(makeInput('Jessica Pratt'));
    const c = enrichmentBulkLookup(makeInput('Juana Molina'));

    await flushWindow();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(ra.results[0].artwork.artwork_url).toContain('Stereolab');
    expect(rb.results[0].artwork.artwork_url).toContain('Jessica Pratt');
    expect(rc.results[0].artwork.artwork_url).toContain('Juana Molina');
  });

  it('resolves a no_match verdict (empty results) instead of rejecting', async () => {
    mockBulkLookupMetadata.mockResolvedValueOnce({
      results: [{ index: 0, status: 'no_match', lookup: { results: [] } }],
    });

    const p = enrichmentBulkLookup(makeInput('Stereolab'));
    await flushWindow();
    const response = await p;

    expect(response.results).toEqual([]);
  });

  it('rejects only the caller whose verdict is error; siblings still resolve', async () => {
    mockBulkLookupMetadata.mockResolvedValueOnce({
      results: [
        { index: 0, status: 'match', lookup: matchLookup('Stereolab') },
        { index: 1, status: 'error', lookup: null, message: 'perform_lookup raised' },
      ],
    });

    const ok = enrichmentBulkLookup(makeInput('Stereolab'));
    const bad = enrichmentBulkLookup(makeInput('Jessica Pratt'));
    // Attach rejection handlers synchronously so the rejection is observed and
    // never surfaces as an unhandledRejection when the batch settles.
    const okResult = ok.then((r) => ({ status: 'resolved' as const, r }));
    const badResult = bad.then(
      () => ({ status: 'resolved' as const }),
      (e: Error) => ({ status: 'rejected' as const, message: e.message })
    );

    await flushWindow();

    await expect(okResult).resolves.toMatchObject({ status: 'resolved' });
    await expect(badResult).resolves.toMatchObject({ status: 'rejected' });
  });

  it('rejects every caller in a chunk when the bulk call itself throws', async () => {
    mockBulkLookupMetadata.mockRejectedValueOnce(new FakeLmlClientError('LML request timed out', 504));

    const a = enrichmentBulkLookup(makeInput('Stereolab'));
    const b = enrichmentBulkLookup(makeInput('Juana Molina'));
    const aObserved = a.catch((e: Error) => e.message);
    const bObserved = b.catch((e: Error) => e.message);

    await flushWindow();

    await expect(aObserved).resolves.toBe('LML request timed out');
    await expect(bObserved).resolves.toBe('LML request timed out');
  });
});
