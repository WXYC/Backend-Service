/**
 * Unit tests for jobs/concerts-genre-enrichment bio-backfill.ts (BS#1734).
 *
 * Same dep-injected seam as orchestrate.test.ts (candidate loader, fake
 * `fetchGenres`, fake `applyBioBackfill`). This suite pins:
 *
 *   - candidates page through LML and a real bio verdict updates the row;
 *   - a responded-but-blank bio is skipped, not written (a NULL self-UPDATE
 *     achieves nothing; the row stays NULL-retryable — no attempt marker);
 *   - `unavailable` verdicts are skipped (left retryable);
 *   - a whole-page `unavailable` stops the run early;
 *   - dry-run enumerates but never calls LML or the writer;
 *   - a thrown LML page / writer call is counted + skipped, the run continues;
 *   - the cooperative pause is awaited before each page.
 *
 * WXYC-representative artists per the org fixture convention.
 */
import { jest } from '@jest/globals';

import type { ArtistGenresBulkResponse, ArtistGenresRequestItem, ArtistGenresSource } from '@wxyc/lml-client';
import {
  runBioBackfill,
  type BioBackfillDeps,
  type BioBackfillOptions,
} from '../../../../jobs/concerts-genre-enrichment/bio-backfill';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-genre-enrichment/query';
import type { BioBackfillRow } from '../../../../jobs/concerts-genre-enrichment/writer';

type FetchGenresFn = BioBackfillDeps['fetchGenres'];
type ApplyFn = BioBackfillDeps['applyBioBackfill'];
type LoadCandidatesFn = BioBackfillDeps['loadCandidates'];

const candidate = (discogs_artist_id: number, artist_name: string): EnrichmentCandidate => ({
  discogs_artist_id,
  artist_name,
});

const genresResponse = (
  verdicts: Array<{ bio?: string | null; source?: ArtistGenresSource }>
): ArtistGenresBulkResponse => ({
  results: verdicts.map((v) => ({ genres: [], styles: [], source: v.source ?? 'cache', bio: v.bio ?? null })),
});

const makeDeps = (
  candidates: EnrichmentCandidate[],
  overrides: Partial<BioBackfillDeps> = {}
): {
  deps: BioBackfillDeps;
  loadCandidates: jest.Mock<LoadCandidatesFn>;
  fetchGenres: jest.Mock<FetchGenresFn>;
  applyBioBackfill: jest.Mock<ApplyFn>;
  awaitQuiet: jest.Mock<() => Promise<void>>;
  writes: BioBackfillRow[];
} => {
  const writes: BioBackfillRow[] = [];
  const loadCandidates =
    (overrides.loadCandidates as jest.Mock<LoadCandidatesFn>) ??
    jest.fn<LoadCandidatesFn>().mockResolvedValue(candidates);
  const fetchGenres =
    (overrides.fetchGenres as jest.Mock<FetchGenresFn>) ??
    jest
      .fn<FetchGenresFn>()
      .mockImplementation((items: ArtistGenresRequestItem[]) =>
        Promise.resolve(genresResponse(items.map(() => ({ bio: 'A touring act.' }))))
      );
  const applyBioBackfill =
    (overrides.applyBioBackfill as jest.Mock<ApplyFn>) ??
    jest.fn<ApplyFn>().mockImplementation((rows: BioBackfillRow[]) => {
      writes.push(...rows);
      return Promise.resolve({ updated: rows.length });
    });
  const awaitQuiet =
    (overrides.awaitQuiet as jest.Mock<() => Promise<void>>) ??
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deps: BioBackfillDeps = { loadCandidates, fetchGenres, applyBioBackfill, awaitQuiet };
  return { deps, loadCandidates, fetchGenres, applyBioBackfill, awaitQuiet, writes };
};

const options = (over: Partial<BioBackfillOptions> = {}): BioBackfillOptions => ({
  pageSize: 10,
  dryRun: false,
  ...over,
});

describe('runBioBackfill (BS#1734)', () => {
  it('fetches bios for the loaded candidates and persists them', async () => {
    const { deps, fetchGenres, applyBioBackfill, writes } = makeDeps([
      candidate(100, 'Juana Molina'),
      candidate(200, 'Jessica Pratt'),
    ]);

    const totals = await runBioBackfill(deps, options());

    expect(fetchGenres).toHaveBeenCalledTimes(1);
    expect(fetchGenres.mock.calls[0][0]).toEqual([
      { artist_name: 'Juana Molina', discogs_artist_id: 100 },
      { artist_name: 'Jessica Pratt', discogs_artist_id: 200 },
    ]);
    expect(applyBioBackfill).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([
      { discogs_artist_id: 100, artist_bio: 'A touring act.' },
      { discogs_artist_id: 200, artist_bio: 'A touring act.' },
    ]);
    expect(totals).toMatchObject({ candidates: 2, pages: 1, fetched: 2, updated: 2, errors: 0 });
  });

  it('makes zero LML calls when no row needs a bio', async () => {
    const { deps, fetchGenres, applyBioBackfill } = makeDeps([]);

    const totals = await runBioBackfill(deps, options());

    expect(fetchGenres).not.toHaveBeenCalled();
    expect(applyBioBackfill).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 0, pages: 0, updated: 0 });
  });

  it('skips a responded-but-blank bio, leaving the row NULL-retryable (no attempt marker)', async () => {
    const { deps, writes } = makeDeps([candidate(300, 'Obscure Touring Act')], {
      fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(genresResponse([{ bio: null }])),
    });

    const totals = await runBioBackfill(deps, options());

    // A blank profile is not written (a NULL self-UPDATE would achieve nothing);
    // the row keeps `artist_bio IS NULL` and is re-selected on a future run.
    expect(writes).toEqual([]);
    expect(totals).toMatchObject({ fetched: 1, no_bio_skipped: 1, updated: 0 });
  });

  it('skips an empty-string bio the same way as a null bio', async () => {
    const { deps, writes } = makeDeps([candidate(301, 'Blank Profile Act')], {
      fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(genresResponse([{ bio: '' }])),
    });

    const totals = await runBioBackfill(deps, options());

    expect(writes).toEqual([]);
    expect(totals).toMatchObject({ fetched: 1, no_bio_skipped: 1, updated: 0 });
  });

  it('skips `unavailable` verdicts (left retryable)', async () => {
    const { deps, applyBioBackfill, writes } = makeDeps([candidate(1, 'Cached Act'), candidate(2, 'Couldnt Ask Act')], {
      fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(
        genresResponse([
          { bio: 'Has a bio.', source: 'cache' },
          { bio: null, source: 'unavailable' },
        ])
      ),
    });

    const totals = await runBioBackfill(deps, options());

    expect(writes).toEqual([{ discogs_artist_id: 1, artist_bio: 'Has a bio.' }]);
    expect(writes.some((w) => w.discogs_artist_id === 2)).toBe(false);
    expect(totals).toMatchObject({ fetched: 2, unavailable_skipped: 1, updated: 1 });
    expect(applyBioBackfill).toHaveBeenCalledTimes(1);
  });

  it('stops early when a whole page comes back `unavailable` (breaker open)', async () => {
    const { deps, fetchGenres, applyBioBackfill, writes } = makeDeps(
      [candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C')],
      {
        fetchGenres: jest
          .fn<FetchGenresFn>()
          .mockResolvedValueOnce(genresResponse([{ source: 'unavailable' }, { source: 'unavailable' }]))
          .mockResolvedValueOnce(genresResponse([{ bio: 'A touring act.' }])),
      }
    );

    const totals = await runBioBackfill(deps, options({ pageSize: 2 }));

    expect(fetchGenres).toHaveBeenCalledTimes(1);
    expect(applyBioBackfill).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(totals).toMatchObject({
      candidates: 3,
      pages: 1,
      fetched: 2,
      unavailable_skipped: 2,
      updated: 0,
      stopped_early: true,
    });
  });

  it('dry-run enumerates but never calls LML or the writer', async () => {
    const { deps, fetchGenres, applyBioBackfill } = makeDeps([candidate(1, 'Juana Molina')]);

    const totals = await runBioBackfill(deps, options({ dryRun: true }));

    expect(fetchGenres).not.toHaveBeenCalled();
    expect(applyBioBackfill).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 1, pages: 0, updated: 0 });
  });

  it('counts a thrown LML page as errors and continues to the next page', async () => {
    const { deps, applyBioBackfill, writes } = makeDeps([candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C')], {
      fetchGenres: jest
        .fn<FetchGenresFn>()
        .mockRejectedValueOnce(new Error('LML 503'))
        .mockResolvedValueOnce(genresResponse([{ bio: 'A touring act.' }])),
    });

    const totals = await runBioBackfill(deps, options({ pageSize: 2 }));

    expect(totals).toMatchObject({ candidates: 3, pages: 1, fetched: 1, updated: 1, errors: 2 });
    expect(writes).toEqual([{ discogs_artist_id: 3, artist_bio: 'A touring act.' }]);
    expect(applyBioBackfill).toHaveBeenCalledTimes(1);
  });

  it('counts a thrown writer call as errors and continues', async () => {
    const { deps } = makeDeps([candidate(1, 'A'), candidate(2, 'B')], {
      applyBioBackfill: jest.fn<ApplyFn>().mockRejectedValue(new Error('deadlock')),
    });

    const totals = await runBioBackfill(deps, options());

    expect(totals).toMatchObject({ candidates: 2, pages: 1, fetched: 2, updated: 0, errors: 2 });
  });

  it('awaits the cooperative pause before each page', async () => {
    const { deps, awaitQuiet } = makeDeps([candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C')]);

    await runBioBackfill(deps, options({ pageSize: 1 }));

    expect(awaitQuiet).toHaveBeenCalledTimes(3);
  });
});
