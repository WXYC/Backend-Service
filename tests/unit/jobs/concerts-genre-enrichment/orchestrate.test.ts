/**
 * Unit tests for jobs/concerts-genre-enrichment orchestrate.ts (BS#1624).
 *
 * The orchestrator is the unit-testable seam: load candidates → serial pages
 * → fetch genres → UPSERT, over a dep-injected candidate loader, a fake
 * `fetchGenres` (the LML#781 contract), and a fake `upsert`. This suite pins:
 *
 *   - only unenriched candidates flow to LML (the loader is the anti-join;
 *     an empty candidate set makes zero LML calls);
 *   - paging respects pageSize; verdicts zip to candidates positionally;
 *   - empty genres still produce a persisted row (terminal "no genres" state);
 *   - dry-run enumerates but never calls LML or the writer;
 *   - a thrown LML page is counted + skipped, the run continues (retryable);
 *   - a thrown UPSERT is counted + skipped, the run continues;
 *   - the cooperative pause is awaited before each page.
 *
 * WXYC-representative artists (Juana Molina, Jessica Pratt, Stereolab, …) per
 * the org fixture convention.
 */
import { jest } from '@jest/globals';

import type { ArtistGenresBulkResponse, ArtistGenresRequestItem, ArtistGenresSource } from '@wxyc/lml-client';
import {
  runEnrichment,
  type EnrichDeps,
  type EnrichOptions,
} from '../../../../jobs/concerts-genre-enrichment/orchestrate';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-genre-enrichment/query';
import type { ArtistGenresRow } from '../../../../jobs/concerts-genre-enrichment/writer';

type FetchGenresFn = EnrichDeps['fetchGenres'];
type UpsertFn = EnrichDeps['upsert'];
type LoadCandidatesFn = EnrichDeps['loadCandidates'];

const candidate = (discogs_artist_id: number, artist_name: string): EnrichmentCandidate => ({
  discogs_artist_id,
  artist_name,
});

/**
 * An LML response echoing one `{ genres, styles, source, bio }` verdict per
 * input item. `source` defaults to `'cache'` so genre-content fixtures needn't
 * spell it out; the source-routing tests pass it explicitly. `bio` defaults to
 * `null` so pre-BS#1734 fixtures don't need updating.
 */
const genresResponse = (
  verdicts: Array<{ genres: string[]; styles: string[]; source?: ArtistGenresSource; bio?: string | null }>
): ArtistGenresBulkResponse => ({
  results: verdicts.map((v) => ({
    genres: v.genres,
    styles: v.styles,
    source: v.source ?? 'cache',
    bio: v.bio ?? null,
  })),
});

const makeDeps = (
  candidates: EnrichmentCandidate[],
  overrides: Partial<EnrichDeps> = {}
): {
  deps: EnrichDeps;
  loadCandidates: jest.Mock<LoadCandidatesFn>;
  fetchGenres: jest.Mock<FetchGenresFn>;
  upsert: jest.Mock<UpsertFn>;
  awaitQuiet: jest.Mock<() => Promise<void>>;
  writes: ArtistGenresRow[];
} => {
  const writes: ArtistGenresRow[] = [];
  const loadCandidates =
    (overrides.loadCandidates as jest.Mock<LoadCandidatesFn>) ??
    jest.fn<LoadCandidatesFn>().mockResolvedValue(candidates);
  // Default fetch: every artist resolves to a single genre keyed by its id.
  const fetchGenres =
    (overrides.fetchGenres as jest.Mock<FetchGenresFn>) ??
    jest
      .fn<FetchGenresFn>()
      .mockImplementation((items: ArtistGenresRequestItem[]) =>
        Promise.resolve(genresResponse(items.map(() => ({ genres: ['Rock'], styles: ['Indie Rock'] }))))
      );
  const upsert =
    (overrides.upsert as jest.Mock<UpsertFn>) ??
    jest.fn<UpsertFn>().mockImplementation((rows: ArtistGenresRow[]) => {
      writes.push(...rows);
      return Promise.resolve({ inserted: rows.length });
    });
  const awaitQuiet =
    (overrides.awaitQuiet as jest.Mock<() => Promise<void>>) ??
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deps: EnrichDeps = { loadCandidates, fetchGenres, upsert, awaitQuiet };
  return { deps, loadCandidates, fetchGenres, upsert, awaitQuiet, writes };
};

const options = (over: Partial<EnrichOptions> = {}): EnrichOptions => ({ pageSize: 10, dryRun: false, ...over });

describe('runEnrichment (BS#1624)', () => {
  it('fetches genres only for the loaded (unenriched) candidates and persists them', async () => {
    const { deps, fetchGenres, upsert, writes } = makeDeps([
      candidate(100, 'Juana Molina'),
      candidate(200, 'Jessica Pratt'),
    ]);

    const totals = await runEnrichment(deps, options());

    expect(fetchGenres).toHaveBeenCalledTimes(1);
    // Request items carry both name and discogs id (the LML#781 request shape).
    expect(fetchGenres.mock.calls[0][0]).toEqual([
      { artist_name: 'Juana Molina', discogs_artist_id: 100 },
      { artist_name: 'Jessica Pratt', discogs_artist_id: 200 },
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([
      { discogs_artist_id: 100, genres: ['Rock'], styles: ['Indie Rock'], artist_bio: null },
      { discogs_artist_id: 200, genres: ['Rock'], styles: ['Indie Rock'], artist_bio: null },
    ]);
    expect(totals).toMatchObject({ candidates: 2, pages: 1, fetched: 2, with_genres: 2, enriched: 2, errors: 0 });
  });

  it('threads the LML bio verdict through to the persisted row (BS#1734)', async () => {
    const { deps, writes } = makeDeps([candidate(100, 'Juana Molina'), candidate(200, 'Jessica Pratt')], {
      fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(
        genresResponse([
          { genres: ['Rock'], styles: [], bio: 'Argentine singer-songwriter.' },
          { genres: ['Rock'], styles: [] }, // no bio on this verdict → null
        ])
      ),
    });

    await runEnrichment(deps, options());

    expect(writes).toEqual([
      { discogs_artist_id: 100, genres: ['Rock'], styles: [], artist_bio: 'Argentine singer-songwriter.' },
      { discogs_artist_id: 200, genres: ['Rock'], styles: [], artist_bio: null },
    ]);
  });

  it('makes zero LML calls when no candidate needs enrichment (anti-join drained)', async () => {
    const { deps, fetchGenres, upsert } = makeDeps([]);

    const totals = await runEnrichment(deps, options());

    expect(fetchGenres).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 0, pages: 0, enriched: 0 });
  });

  it('pages candidates by pageSize and zips verdicts to candidates positionally', async () => {
    const { deps, fetchGenres, writes } = makeDeps(
      [candidate(1, 'Stereolab'), candidate(2, 'Cat Power'), candidate(3, 'Chuquimamani-Condori')],
      {
        fetchGenres: jest
          .fn<FetchGenresFn>()
          .mockResolvedValueOnce(
            genresResponse([
              { genres: ['Electronic'], styles: [] },
              { genres: ['Rock'], styles: [] },
            ])
          )
          .mockResolvedValueOnce(genresResponse([{ genres: ['Jazz'], styles: ['Big Band'] }])),
      }
    );

    const totals = await runEnrichment(deps, options({ pageSize: 2 }));

    expect(fetchGenres).toHaveBeenCalledTimes(2);
    expect(writes).toEqual([
      { discogs_artist_id: 1, genres: ['Electronic'], styles: [], artist_bio: null },
      { discogs_artist_id: 2, genres: ['Rock'], styles: [], artist_bio: null },
      { discogs_artist_id: 3, genres: ['Jazz'], styles: ['Big Band'], artist_bio: null },
    ]);
    expect(totals).toMatchObject({ candidates: 3, pages: 2, fetched: 3, enriched: 3 });
  });

  it('persists a row even when LML returns empty genres (terminal "no genres" state)', async () => {
    const { deps, writes } = makeDeps([candidate(300, 'Obscure Touring Act')], {
      fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(genresResponse([{ genres: [], styles: [] }])),
    });

    const totals = await runEnrichment(deps, options());

    expect(writes).toEqual([{ discogs_artist_id: 300, genres: [], styles: [], artist_bio: null }]);
    expect(totals).toMatchObject({ fetched: 1, with_genres: 0, enriched: 1 });
  });

  it('skips `unavailable` verdicts (left retryable) but persists `not_found`', async () => {
    // A page mixing sources: `cache` + `not_found` persist (the latter an empty
    // negative-cache row); `unavailable` — LML couldn't reach Discogs — is
    // skipped so the artist keeps no row and the candidate anti-join re-selects
    // it next run. Persisting the couldn't-ask would negative-cache it forever.
    const { deps, upsert, writes } = makeDeps(
      [candidate(1, 'Cached Act'), candidate(2, 'Couldnt Ask Act'), candidate(3, 'Confirmed Empty Act')],
      {
        fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(
          genresResponse([
            { genres: ['Rock'], styles: [], source: 'cache' },
            { genres: [], styles: [], source: 'unavailable' },
            { genres: [], styles: [], source: 'not_found' },
          ])
        ),
      }
    );

    const totals = await runEnrichment(deps, options());

    // Only the cache + not_found artists are written; the unavailable one is not.
    expect(writes).toEqual([
      { discogs_artist_id: 1, genres: ['Rock'], styles: [], artist_bio: null },
      { discogs_artist_id: 3, genres: [], styles: [], artist_bio: null },
    ]);
    expect(writes.some((w) => w.discogs_artist_id === 2)).toBe(false);
    expect(totals).toMatchObject({ fetched: 3, unavailable_skipped: 1, with_genres: 1, enriched: 2 });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('stops early when a whole page comes back `unavailable` (breaker open)', async () => {
    // Page 1 (all unavailable) means LML's Discogs breaker is open; paging
    // further would just waste round-trips. The run stops and every remaining
    // candidate stays retryable via the anti-join.
    const { deps, fetchGenres, upsert, writes } = makeDeps(
      [candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C'), candidate(4, 'D')],
      {
        fetchGenres: jest
          .fn<FetchGenresFn>()
          .mockResolvedValueOnce(
            genresResponse([
              { genres: [], styles: [], source: 'unavailable' },
              { genres: [], styles: [], source: 'unavailable' },
            ])
          )
          .mockResolvedValueOnce(genresResponse([{ genres: ['Rock'], styles: [] }])),
      }
    );

    const totals = await runEnrichment(deps, options({ pageSize: 2 }));

    // Only page 1 ran; page 2 was never fetched and nothing was written.
    expect(fetchGenres).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(totals).toMatchObject({
      candidates: 4,
      pages: 1,
      fetched: 2,
      unavailable_skipped: 2,
      enriched: 0,
      stopped_early: true,
    });
  });

  it('does NOT stop early on a page only partially `unavailable`', async () => {
    // One unavailable verdict among three must not trip the all-unavailable
    // breaker guard — the run pages to completion.
    const { deps, fetchGenres } = makeDeps([candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C')], {
      fetchGenres: jest.fn<FetchGenresFn>().mockResolvedValue(
        genresResponse([
          { genres: ['Rock'], styles: [], source: 'cache' },
          { genres: [], styles: [], source: 'unavailable' },
          { genres: ['Jazz'], styles: [], source: 'cache' },
        ])
      ),
    });

    const totals = await runEnrichment(deps, options({ pageSize: 3 }));

    expect(fetchGenres).toHaveBeenCalledTimes(1);
    expect(totals).toMatchObject({ pages: 1, unavailable_skipped: 1, enriched: 2, stopped_early: false });
  });

  it('dry-run enumerates but never calls LML or the writer', async () => {
    const { deps, fetchGenres, upsert } = makeDeps([candidate(1, 'Juana Molina')]);

    const totals = await runEnrichment(deps, options({ dryRun: true }));

    expect(fetchGenres).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ candidates: 1, pages: 0, enriched: 0 });
  });

  it('counts a thrown LML page as errors and continues to the next page', async () => {
    const { deps, upsert, writes } = makeDeps([candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C')], {
      fetchGenres: jest
        .fn<FetchGenresFn>()
        .mockRejectedValueOnce(new Error('LML 503'))
        .mockResolvedValueOnce(genresResponse([{ genres: ['Rock'], styles: [] }])),
    });

    const totals = await runEnrichment(deps, options({ pageSize: 2 }));

    // Page 1 (2 artists) threw → counted as 2 errors, nothing written; page 2
    // (1 artist) succeeded.
    expect(totals).toMatchObject({ candidates: 3, pages: 1, fetched: 1, enriched: 1, errors: 2 });
    expect(writes).toEqual([{ discogs_artist_id: 3, genres: ['Rock'], styles: [], artist_bio: null }]);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('counts a thrown UPSERT as errors and continues', async () => {
    const { deps } = makeDeps([candidate(1, 'A'), candidate(2, 'B')], {
      upsert: jest.fn<UpsertFn>().mockRejectedValue(new Error('deadlock')),
    });

    const totals = await runEnrichment(deps, options());

    expect(totals).toMatchObject({ candidates: 2, pages: 1, fetched: 2, enriched: 0, errors: 2 });
  });

  it('awaits the cooperative pause before each page', async () => {
    const { deps, awaitQuiet } = makeDeps([candidate(1, 'A'), candidate(2, 'B'), candidate(3, 'C')]);

    await runEnrichment(deps, options({ pageSize: 1 }));

    // One await per page (3 pages).
    expect(awaitQuiet).toHaveBeenCalledTimes(3);
  });
});
