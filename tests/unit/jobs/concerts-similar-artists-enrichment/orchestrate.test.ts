/**
 * Unit tests for jobs/concerts-similar-artists-enrichment orchestrate.ts (BS#1626).
 *
 * The orchestrator is the unit-testable seam: load cohort → chunk → fetch
 * neighbors → OVERWRITE (upsert non-empty + delete responded-empty), over a
 * dep-injected candidate loader, a fake `fetchNeighbors` (the semantic-index#354
 * contract), a fake `fetchHealth`, and a fake `overwrite`. This suite pins:
 *
 *   - only the loaded cohort flows to the endpoint; an empty cohort makes zero
 *     calls;
 *   - chunking respects chunkSize; verdicts key off the STRINGIFIED input id;
 *   - a non-empty verdict → upsert; a responded-empty verdict → delete;
 *   - the null-wipe guard: an all-empty sweep writes NOTHING (+ all_empty_skip),
 *     and reads /health for the loud log;
 *   - the delete-scoping fix: a thrown chunk's ids appear in NEITHER upserts NOR
 *     deletes (transport failures never wipe a healthy row);
 *   - the empty-fraction ceiling suppresses a broad-but-partial DELETE;
 *   - dry-run enumerates but never fetches or writes;
 *   - the cooperative pause is awaited before each chunk.
 *
 * WXYC-representative artists (Juana Molina, Jessica Pratt, Stereolab, …) per
 * the org fixture convention. `@wxyc/database` is not imported here — the
 * orchestrator is pure over its injected deps.
 */
import { jest } from '@jest/globals';

import {
  EMPTY_DELETE_FRACTION_CEIL,
  runEnrichment,
  type EnrichDeps,
  type EnrichOptions,
} from '../../../../jobs/concerts-similar-artists-enrichment/orchestrate';
import type {
  NeighborsBatchResponse,
  SimilarArtistNeighbor,
} from '../../../../jobs/concerts-similar-artists-enrichment/neighbors-client';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-similar-artists-enrichment/query';
import type { SimilarArtistsRow } from '../../../../jobs/concerts-similar-artists-enrichment/writer';

type FetchNeighborsFn = EnrichDeps['fetchNeighbors'];
type FetchHealthFn = EnrichDeps['fetchHealth'];
type OverwriteFn = EnrichDeps['overwrite'];
type LoadCandidatesFn = EnrichDeps['loadCandidates'];

const candidate = (artist_id: number): EnrichmentCandidate => ({ artist_id });

/** Build a `results`-keyed-by-stringified-id response from an id→neighbors map. */
const neighborsResponse = (byId: Record<number, SimilarArtistNeighbor[]>): NeighborsBatchResponse => {
  const results: Record<string, SimilarArtistNeighbor[]> = {};
  for (const [id, list] of Object.entries(byId)) results[String(id)] = list;
  return { results };
};

/** A one-neighbor list keyed off the input id, so fixtures needn't spell weights. */
const oneNeighbor = (id: number): SimilarArtistNeighbor[] => [{ artist_id: id * 10, weight: 1 }];

type Recorded = { upserts: SimilarArtistsRow[]; deletes: number[] };

const makeDeps = (
  candidates: EnrichmentCandidate[],
  overrides: Partial<EnrichDeps> = {}
): {
  deps: EnrichDeps;
  loadCandidates: jest.Mock<LoadCandidatesFn>;
  fetchNeighbors: jest.Mock<FetchNeighborsFn>;
  fetchHealth: jest.Mock<FetchHealthFn>;
  overwrite: jest.Mock<OverwriteFn>;
  awaitQuiet: jest.Mock<() => Promise<void>>;
  recorded: Recorded;
} => {
  const recorded: Recorded = { upserts: [], deletes: [] };
  const loadCandidates =
    (overrides.loadCandidates as jest.Mock<LoadCandidatesFn>) ??
    jest.fn<LoadCandidatesFn>().mockResolvedValue(candidates);
  // Default fetch: every requested id resolves to a single neighbor.
  const fetchNeighbors =
    (overrides.fetchNeighbors as jest.Mock<FetchNeighborsFn>) ??
    jest
      .fn<FetchNeighborsFn>()
      .mockImplementation((ids: number[]) =>
        Promise.resolve(neighborsResponse(Object.fromEntries(ids.map((id) => [id, oneNeighbor(id)]))))
      );
  const fetchHealth =
    (overrides.fetchHealth as jest.Mock<FetchHealthFn>) ??
    jest.fn<FetchHealthFn>().mockResolvedValue({ mapped_artist_count: 22000 });
  const overwrite =
    (overrides.overwrite as jest.Mock<OverwriteFn>) ??
    jest.fn<OverwriteFn>().mockImplementation((upserts: SimilarArtistsRow[], deletes: number[]) => {
      recorded.upserts.push(...upserts);
      recorded.deletes.push(...deletes);
      return Promise.resolve({ written: upserts.length, deleted: deletes.length });
    });
  const awaitQuiet =
    (overrides.awaitQuiet as jest.Mock<() => Promise<void>>) ??
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deps: EnrichDeps = { loadCandidates, fetchNeighbors, fetchHealth, overwrite, awaitQuiet };
  return { deps, loadCandidates, fetchNeighbors, fetchHealth, overwrite, awaitQuiet, recorded };
};

const options = (over: Partial<EnrichOptions> = {}): EnrichOptions => ({
  limit: 20,
  chunkSize: 100,
  dryRun: false,
  ...over,
});

describe('runEnrichment (BS#1626)', () => {
  it('fetches neighbors for the loaded cohort and upserts non-empty lists', async () => {
    const { deps, fetchNeighbors, overwrite, recorded } = makeDeps([candidate(100), candidate(200)]);

    const totals = await runEnrichment(deps, options());

    expect(fetchNeighbors).toHaveBeenCalledTimes(1);
    expect(fetchNeighbors.mock.calls[0][0]).toEqual([100, 200]);
    expect(overwrite).toHaveBeenCalledTimes(1);
    expect(recorded.upserts).toEqual([
      { artist_id: 100, neighbors: oneNeighbor(100) },
      { artist_id: 200, neighbors: oneNeighbor(200) },
    ]);
    expect(recorded.deletes).toEqual([]);
    expect(totals).toMatchObject({
      cohort: 2,
      chunks: 1,
      fetched: 2,
      with_neighbors: 2,
      enriched: 2,
      cleared: 0,
      errors: 0,
      all_empty_skip: false,
    });
  });

  it('makes zero endpoint calls when the cohort is empty', async () => {
    const { deps, fetchNeighbors, overwrite } = makeDeps([]);

    const totals = await runEnrichment(deps, options());

    expect(fetchNeighbors).not.toHaveBeenCalled();
    expect(overwrite).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ cohort: 0, chunks: 0, enriched: 0 });
  });

  it('chunks the cohort by chunkSize and keys verdicts off the stringified id', async () => {
    const { deps, fetchNeighbors, recorded } = makeDeps([candidate(1), candidate(2), candidate(3)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValueOnce(neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2) }))
        .mockResolvedValueOnce(neighborsResponse({ 3: oneNeighbor(3) })),
    });

    const totals = await runEnrichment(deps, options({ chunkSize: 2 }));

    expect(fetchNeighbors).toHaveBeenCalledTimes(2);
    expect(fetchNeighbors.mock.calls[0][0]).toEqual([1, 2]);
    expect(fetchNeighbors.mock.calls[1][0]).toEqual([3]);
    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 3]);
    expect(totals).toMatchObject({ cohort: 3, chunks: 2, fetched: 3, enriched: 3 });
  });

  it('deletes a responded-empty headliner (the now-unmapped ~1%) but upserts the rest', async () => {
    // 5 responded ids, one empty (id 3) → 20% empty, at (not above) the ceiling,
    // so the DELETE branch runs. 1/2/4/5 have neighbors.
    const { deps, recorded } = makeDeps([candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(
          neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2), 3: [], 4: oneNeighbor(4), 5: oneNeighbor(5) })
        ),
    });

    const totals = await runEnrichment(deps, options());

    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 4, 5]);
    expect(recorded.deletes).toEqual([3]);
    expect(totals).toMatchObject({
      fetched: 5,
      with_neighbors: 4,
      enriched: 4,
      cleared: 1,
      deletes_suppressed: false,
    });
  });

  it('null-wipe guard: an all-empty sweep writes nothing and reads /health', async () => {
    const { deps, overwrite, fetchHealth } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest.fn<FetchNeighborsFn>().mockResolvedValue(neighborsResponse({ 1: [], 2: [] })),
    });

    const totals = await runEnrichment(deps, options());

    expect(overwrite).not.toHaveBeenCalled(); // never wipe collected rows
    expect(fetchHealth).toHaveBeenCalledTimes(1); // read only to enrich the loud log
    expect(totals).toMatchObject({
      cohort: 2,
      chunks: 1,
      fetched: 2,
      with_neighbors: 0,
      enriched: 0,
      cleared: 0,
      all_empty_skip: true,
    });
  });

  it('a thrown chunk leaves its ids in NEITHER upserts NOR deletes (retryable, never wiped)', async () => {
    // Two chunks (chunkSize 6): chunk 1 (ids 1-6) responds — 1-5 have neighbors,
    // 6 is empty; chunk 2 (ids 7,8) throws. The thrown chunk's ids 7 & 8 must be
    // in NEITHER set (transport failure ≠ "now unmapped"). The responded chunk's
    // lone empty (6) is 1/6 ≈ 17% of responded ids, under the ceiling, so it IS
    // deleted — proving the delete decision keys on responded verdicts only.
    const { deps, recorded, overwrite } = makeDeps([1, 2, 3, 4, 5, 6, 7, 8].map(candidate), {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValueOnce(
          neighborsResponse({
            1: oneNeighbor(1),
            2: oneNeighbor(2),
            3: oneNeighbor(3),
            4: oneNeighbor(4),
            5: oneNeighbor(5),
            6: [],
          })
        )
        .mockRejectedValueOnce(new Error('semantic-index 503')),
    });

    const totals = await runEnrichment(deps, options({ chunkSize: 6 }));

    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 3, 4, 5]);
    expect(recorded.deletes).toEqual([6]); // NOT 7 or 8
    expect(recorded.deletes).not.toContain(7);
    expect(recorded.deletes).not.toContain(8);
    expect(overwrite).toHaveBeenCalledTimes(1);
    expect(totals).toMatchObject({ cohort: 8, chunks: 1, fetched: 6, errors: 2, enriched: 5, cleared: 1 });
  });

  it('does NOT trip the all-empty guard when at least one responded id has neighbors', async () => {
    const { deps, overwrite } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest.fn<FetchNeighborsFn>().mockResolvedValue(neighborsResponse({ 1: oneNeighbor(1), 2: [] })),
    });

    const totals = await runEnrichment(deps, options());

    expect(overwrite).toHaveBeenCalledTimes(1);
    expect(totals.all_empty_skip).toBe(false);
  });

  it('suppresses the DELETE branch when the empty fraction exceeds the ceiling (partial rebuild)', async () => {
    // 5 responded ids, 2 with neighbors + 3 empty → 60% empty, above the 20%
    // ceiling. A partial mapping rebuild shouldn't clear rows: the 2 non-empty
    // still upsert, but the 3 empties are NOT deleted.
    const ids = [1, 2, 3, 4, 5];
    const { deps, recorded, overwrite } = makeDeps(ids.map(candidate), {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2), 3: [], 4: [], 5: [] })),
    });

    const totals = await runEnrichment(deps, options());

    expect(3 / 5).toBeGreaterThan(EMPTY_DELETE_FRACTION_CEIL);
    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2]);
    expect(recorded.deletes).toEqual([]); // suppressed
    expect(overwrite).toHaveBeenCalledTimes(1);
    expect(totals).toMatchObject({ enriched: 2, cleared: 0, deletes_suppressed: true, all_empty_skip: false });
  });

  it('dry-run enumerates but never fetches or writes', async () => {
    const { deps, fetchNeighbors, overwrite } = makeDeps([candidate(1)]);

    const totals = await runEnrichment(deps, options({ dryRun: true }));

    expect(fetchNeighbors).not.toHaveBeenCalled();
    expect(overwrite).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ cohort: 1, chunks: 0, enriched: 0 });
  });

  it('counts a thrown overwrite as errors and returns', async () => {
    const { deps } = makeDeps([candidate(1), candidate(2)], {
      overwrite: jest.fn<OverwriteFn>().mockRejectedValue(new Error('deadlock')),
    });

    const totals = await runEnrichment(deps, options());

    expect(totals).toMatchObject({ cohort: 2, chunks: 1, fetched: 2, enriched: 0, errors: 2 });
  });

  it('awaits the cooperative pause before each chunk', async () => {
    const { deps, awaitQuiet } = makeDeps([candidate(1), candidate(2), candidate(3)]);

    await runEnrichment(deps, options({ chunkSize: 1 }));

    expect(awaitQuiet).toHaveBeenCalledTimes(3);
  });

  it('a total outage (every chunk throws) reports zero progress — the exit-code signal', async () => {
    // Every chunk throws, so no chunk responds: fetched stays empty, the
    // all-empty guard's `fetched.size > 0` is false, and nothing is written. The
    // returned totals (errors === cohort, enriched === 0, cleared === 0) are what
    // main() reads to raise a non-zero exit so the cron alerts on a full outage
    // (not just on the all_empty_skip data signal).
    const { deps, recorded } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest.fn<FetchNeighborsFn>().mockRejectedValue(new Error('semantic-index down')),
    });

    const totals = await runEnrichment(deps, options({ chunkSize: 1 }));

    // Nothing was upserted or deleted (overwrite, if called, got empty arrays —
    // a no-op the writer guards): the cohort's rows are untouched + retryable.
    expect(recorded.upserts).toEqual([]);
    expect(recorded.deletes).toEqual([]);
    expect(totals).toMatchObject({
      cohort: 2,
      chunks: 0,
      fetched: 0,
      errors: 2,
      enriched: 0,
      cleared: 0,
      all_empty_skip: false,
    });
  });

  it('treats a malformed non-array verdict as empty (never writes garbage jsonb)', async () => {
    // A contract-violating non-array value must not be pushed into `upserts`
    // (which would write garbage into the jsonb column). `Array.isArray` coerces
    // it to empty; here id 5 is a string, so it becomes an empty verdict
    // (1/5 = 20%, at the ceiling → deleted) while 1-4 upsert normally.
    const bad = { 1: oneNeighbor(1), 2: oneNeighbor(2), 3: oneNeighbor(3), 4: oneNeighbor(4), 5: 'not-an-array' };
    const { deps, recorded } = makeDeps([1, 2, 3, 4, 5].map(candidate), {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue({ results: bad as unknown as Record<string, SimilarArtistNeighbor[]> }),
    });

    const totals = await runEnrichment(deps, options());

    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 3, 4]);
    expect(recorded.deletes).toEqual([5]);
    expect(totals).toMatchObject({ fetched: 5, with_neighbors: 4 });
  });

  it('defaults a contract-guaranteed-present id missing from results to empty (no throw)', async () => {
    // The contract guarantees every requested id is present; if the server ever
    // omits one, treat it as empty rather than crashing the run. Here id 5 is
    // absent from results — handled as an empty verdict (1/5 = 20%, at the
    // ceiling, so still deleted).
    const { deps, recorded } = makeDeps([1, 2, 3, 4, 5].map(candidate), {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(
          neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2), 3: oneNeighbor(3), 4: oneNeighbor(4) })
        ),
    });

    const totals = await runEnrichment(deps, options());

    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 3, 4]);
    expect(recorded.deletes).toEqual([5]);
    expect(totals).toMatchObject({ fetched: 5, with_neighbors: 4 });
  });
});
