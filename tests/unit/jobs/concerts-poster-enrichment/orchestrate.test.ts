/**
 * Unit tests for jobs/concerts-poster-enrichment orchestrate.ts (BS#1743).
 *
 * The orchestrator is the unit-testable seam: load candidates (concerts with
 * `image_url IS NULL` and a resolvable headliner Discogs id) → dedupe by
 * artist → page the UNIQUE artists → fetch each artist's Discogs image via a
 * dep-injected `fetchArtistImage` (the LML `getArtistDetails` wrapper) →
 * write the fetched image onto every concert row that shares that headliner.
 * This suite pins:
 *
 *   - candidates dedupe to one fetch per distinct headliner, even when
 *     multiple concerts share it;
 *   - a fetched image writes to every concert row for that artist;
 *   - a null/blank image is skipped (`skipped_no_image`), never written;
 *   - a thrown per-artist fetch is skipped (`skipped_no_artist`), left
 *     retryable, and does not abort the run;
 *   - paging respects pageSize (over the deduped artist list, not the raw
 *     concert-row count);
 *   - dry-run enumerates but never calls fetch or the writer;
 *   - a thrown write is counted as errors and the run continues;
 *   - the cooperative pause is awaited before each page.
 *
 * WXYC-representative artists (Juana Molina, Chuquimamani-Condori, …) per the
 * org fixture convention.
 */
import { jest } from '@jest/globals';

import {
  runEnrichment,
  type EnrichDeps,
  type EnrichOptions,
} from '../../../../jobs/concerts-poster-enrichment/orchestrate';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-poster-enrichment/query';
import type { ConcertImageRow } from '../../../../jobs/concerts-poster-enrichment/writer';

type FetchArtistImageFn = EnrichDeps['fetchArtistImage'];
type WriteImagesFn = EnrichDeps['writeImages'];
type LoadCandidatesFn = EnrichDeps['loadCandidates'];

const candidate = (concert_id: number, discogs_artist_id: number): EnrichmentCandidate => ({
  concert_id,
  discogs_artist_id,
});

const makeDeps = (
  candidates: EnrichmentCandidate[],
  overrides: Partial<EnrichDeps> = {}
): {
  deps: EnrichDeps;
  loadCandidates: jest.Mock<LoadCandidatesFn>;
  fetchArtistImage: jest.Mock<FetchArtistImageFn>;
  writeImages: jest.Mock<WriteImagesFn>;
  awaitQuiet: jest.Mock<() => Promise<void>>;
  writes: ConcertImageRow[];
} => {
  const writes: ConcertImageRow[] = [];
  const loadCandidates =
    (overrides.loadCandidates as jest.Mock<LoadCandidatesFn>) ??
    jest.fn<LoadCandidatesFn>().mockResolvedValue(candidates);
  // Default fetch: every artist resolves to a stable per-id image URL.
  const fetchArtistImage =
    (overrides.fetchArtistImage as jest.Mock<FetchArtistImageFn>) ??
    jest
      .fn<FetchArtistImageFn>()
      .mockImplementation((id: number) => Promise.resolve({ image_url: `https://discogs.example/artist/${id}.jpg` }));
  const writeImages =
    (overrides.writeImages as jest.Mock<WriteImagesFn>) ??
    jest.fn<WriteImagesFn>().mockImplementation((rows: ConcertImageRow[]) => {
      writes.push(...rows);
      return Promise.resolve({ updated: rows.reduce((sum, r) => sum + r.concert_ids.length, 0) });
    });
  const awaitQuiet =
    (overrides.awaitQuiet as jest.Mock<() => Promise<void>>) ??
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deps: EnrichDeps = { loadCandidates, fetchArtistImage, writeImages, awaitQuiet };
  return { deps, loadCandidates, fetchArtistImage, writeImages, awaitQuiet, writes };
};

const options = (over: Partial<EnrichOptions> = {}): EnrichOptions => ({ pageSize: 10, dryRun: false, ...over });

describe('runEnrichment (BS#1743)', () => {
  it('fetches one image per distinct headliner and writes it to every concert row that shares it', async () => {
    const { deps, fetchArtistImage, writeImages, writes } = makeDeps([
      candidate(1, 100), // Juana Molina, show A
      candidate(2, 100), // Juana Molina, show B (same headliner)
      candidate(3, 200), // Chuquimamani-Condori
    ]);

    const totals = await runEnrichment(deps, options());

    // Dedup: 2 distinct artists, not 3 fetch calls.
    expect(fetchArtistImage).toHaveBeenCalledTimes(2);
    expect(fetchArtistImage).toHaveBeenCalledWith(100);
    expect(fetchArtistImage).toHaveBeenCalledWith(200);
    expect(writeImages).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(
      expect.arrayContaining([
        { discogs_artist_id: 100, concert_ids: [1, 2], image_url: 'https://discogs.example/artist/100.jpg' },
        { discogs_artist_id: 200, concert_ids: [3], image_url: 'https://discogs.example/artist/200.jpg' },
      ])
    );
    expect(totals).toMatchObject({ candidates: 3, artists: 2, pages: 1, fetched: 2, enriched: 3, errors: 0 });
  });

  it('makes zero LML calls when there are no candidates', async () => {
    const { deps, fetchArtistImage, writeImages } = makeDeps([]);

    const totals = await runEnrichment(deps, options());

    expect(fetchArtistImage).not.toHaveBeenCalled();
    expect(writeImages).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 0, artists: 0, pages: 0, enriched: 0 });
  });

  it('skips a null image as skipped_no_image and never writes it', async () => {
    const { deps, writes } = makeDeps([candidate(1, 100)], {
      fetchArtistImage: jest.fn<FetchArtistImageFn>().mockResolvedValue({ image_url: null }),
    });

    const totals = await runEnrichment(deps, options());

    expect(writes).toEqual([]);
    expect(totals).toMatchObject({ fetched: 1, skipped_no_image: 1, enriched: 0 });
  });

  it('skips a blank image as skipped_no_image and never writes it', async () => {
    const { deps, writes } = makeDeps([candidate(1, 100)], {
      fetchArtistImage: jest.fn<FetchArtistImageFn>().mockResolvedValue({ image_url: '   ' }),
    });

    const totals = await runEnrichment(deps, options());

    expect(writes).toEqual([]);
    expect(totals).toMatchObject({ fetched: 1, skipped_no_image: 1, enriched: 0 });
  });

  it('counts a thrown per-artist fetch as skipped_no_artist and continues (left retryable)', async () => {
    const { deps, writeImages, writes } = makeDeps([candidate(1, 100), candidate(2, 200)], {
      fetchArtistImage: jest
        .fn<FetchArtistImageFn>()
        .mockImplementation((id: number) =>
          id === 100
            ? Promise.reject(new Error('LML 404'))
            : Promise.resolve({ image_url: 'https://discogs.example/200.jpg' })
        ),
    });

    const totals = await runEnrichment(deps, options());

    expect(writes).toEqual([
      { discogs_artist_id: 200, concert_ids: [2], image_url: 'https://discogs.example/200.jpg' },
    ]);
    expect(totals).toMatchObject({ candidates: 2, artists: 2, fetched: 1, skipped_no_artist: 1, enriched: 1 });
    expect(writeImages).toHaveBeenCalledTimes(1);
  });

  it('pages the deduped artist list by pageSize', async () => {
    const { deps, fetchArtistImage, writeImages } = makeDeps([candidate(1, 1), candidate(2, 2), candidate(3, 3)]);

    const totals = await runEnrichment(deps, options({ pageSize: 2 }));

    expect(fetchArtistImage).toHaveBeenCalledTimes(3);
    expect(writeImages).toHaveBeenCalledTimes(2); // page 1 (artists 1,2), page 2 (artist 3)
    expect(totals).toMatchObject({ candidates: 3, artists: 3, pages: 2, fetched: 3, enriched: 3 });
  });

  it('dry-run enumerates but never calls fetch or the writer', async () => {
    const { deps, fetchArtistImage, writeImages } = makeDeps([candidate(1, 100)]);

    const totals = await runEnrichment(deps, options({ dryRun: true }));

    expect(fetchArtistImage).not.toHaveBeenCalled();
    expect(writeImages).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 1, artists: 1, pages: 0, enriched: 0 });
  });

  it('counts a thrown write as errors and continues', async () => {
    const { deps } = makeDeps([candidate(1, 100), candidate(2, 200)], {
      writeImages: jest.fn<WriteImagesFn>().mockRejectedValue(new Error('deadlock')),
    });

    const totals = await runEnrichment(deps, options());

    expect(totals).toMatchObject({ candidates: 2, artists: 2, fetched: 2, enriched: 0, errors: 2 });
  });

  it('awaits the cooperative pause before each page', async () => {
    const { deps, awaitQuiet } = makeDeps([candidate(1, 1), candidate(2, 2), candidate(3, 3)]);

    await runEnrichment(deps, options({ pageSize: 1 }));

    expect(awaitQuiet).toHaveBeenCalledTimes(3);
  });
});
