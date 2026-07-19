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
  DEFAULT_COHORT_LABEL,
  EMPTY_DELETE_FRACTION_CEIL,
  runEnrichment,
  type EnrichDeps,
  type EnrichOptions,
} from '../../../../jobs/concerts-similar-artists-enrichment/orchestrate';
import * as logger from '../../../../jobs/concerts-similar-artists-enrichment/logger';
import type {
  NeighborsBatchResponse,
  SimilarArtistNeighbor,
} from '../../../../jobs/concerts-similar-artists-enrichment/neighbors-client';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-similar-artists-enrichment/query';
import type { SimilarArtistsRow } from '../../../../jobs/concerts-similar-artists-enrichment/writer';
import type { StationPlaysRow } from '../../../../jobs/concerts-similar-artists-enrichment/station-writer';

type FetchNeighborsFn = EnrichDeps['fetchNeighbors'];
type FetchHealthFn = EnrichDeps['fetchHealth'];
type OverwriteFn = EnrichDeps['overwrite'];
type WriteStationFn = EnrichDeps['writeStation'];
type LoadCandidatesFn = EnrichDeps['loadCandidates'];

const candidate = (artist_id: number): EnrichmentCandidate => ({ artist_id });

/**
 * Build a response from an id→neighbors map plus an optional id→plays map
 * (BS#1702 `source_plays`). Both are keyed by the stringified input id, matching
 * the semantic-index#354/#369 contract.
 */
const neighborsResponse = (
  byId: Record<number, SimilarArtistNeighbor[]>,
  plays: Record<number, number> = {}
): NeighborsBatchResponse => {
  const results: Record<string, SimilarArtistNeighbor[]> = {};
  for (const [id, list] of Object.entries(byId)) results[String(id)] = list;
  const source_plays: Record<string, number> = {};
  for (const [id, n] of Object.entries(plays)) source_plays[String(id)] = n;
  return { results, source_plays };
};

/** A one-neighbor list keyed off the input id, so fixtures needn't spell weights. */
const oneNeighbor = (id: number): SimilarArtistNeighbor[] => [{ artist_id: id * 10, weight: 1 }];

type Recorded = { upserts: SimilarArtistsRow[]; deletes: number[]; station: StationPlaysRow[] };

const makeDeps = (
  candidates: EnrichmentCandidate[],
  overrides: Partial<EnrichDeps> = {}
): {
  deps: EnrichDeps;
  loadCandidates: jest.Mock<LoadCandidatesFn>;
  fetchNeighbors: jest.Mock<FetchNeighborsFn>;
  fetchHealth: jest.Mock<FetchHealthFn>;
  overwrite: jest.Mock<OverwriteFn>;
  writeStation: jest.Mock<WriteStationFn>;
  awaitQuiet: jest.Mock<() => Promise<void>>;
  recorded: Recorded;
} => {
  const recorded: Recorded = { upserts: [], deletes: [], station: [] };
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
  const writeStation =
    (overrides.writeStation as jest.Mock<WriteStationFn>) ??
    jest.fn<WriteStationFn>().mockImplementation((rows: StationPlaysRow[]) => {
      recorded.station.push(...rows);
      return Promise.resolve({ written: rows.length });
    });
  const awaitQuiet =
    (overrides.awaitQuiet as jest.Mock<() => Promise<void>>) ??
    jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const deps: EnrichDeps = { loadCandidates, fetchNeighbors, fetchHealth, overwrite, writeStation, awaitQuiet };
  return { deps, loadCandidates, fetchNeighbors, fetchHealth, overwrite, writeStation, awaitQuiet, recorded };
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

  it('threads a custom cohortLabel into the enumerated log (discogs lane accuracy, BS#1701)', async () => {
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => {});
    try {
      const { deps } = makeDeps([candidate(900123)]);
      await runEnrichment(deps, options({ cohortLabel: 'Discogs-only headliners' }));
      const enumerated = logSpy.mock.calls.find((c) => c[1] === 'enumerated');
      expect(enumerated).toBeDefined();
      expect(enumerated?.[2]).toContain('Discogs-only headliners');
      expect(enumerated?.[3]).toMatchObject({ cohort_label: 'Discogs-only headliners' });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('defaults the enumerated cohort noun to the library-lane wording when no label is passed', async () => {
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => {});
    try {
      const { deps } = makeDeps([candidate(100)]);
      await runEnrichment(deps, options());
      const enumerated = logSpy.mock.calls.find((c) => c[1] === 'enumerated');
      expect(enumerated?.[2]).toContain(DEFAULT_COHORT_LABEL);
      expect(enumerated?.[3]).toMatchObject({ cohort_label: DEFAULT_COHORT_LABEL });
    } finally {
      logSpy.mockRestore();
    }
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

  it('flags a thrown overwrite via write_failed (distinct from fetch errors) and returns', async () => {
    const { deps } = makeDeps([candidate(1), candidate(2)], {
      overwrite: jest.fn<OverwriteFn>().mockRejectedValue(new Error('deadlock')),
    });

    const totals = await runEnrichment(deps, options());

    // write_failed (not errors) carries the write failure; fetch `errors` stays
    // 0. main() reads write_failed + wroteNothing to raise a non-zero exit.
    expect(totals).toMatchObject({
      cohort: 2,
      chunks: 1,
      fetched: 2,
      enriched: 0,
      cleared: 0,
      errors: 0,
      write_failed: true,
    });
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

  it('routes a malformed non-array verdict to `malformed` (skip + retry), never DELETE', async () => {
    // A contract-violating non-array value is NOT an observed-empty verdict, so
    // it must NOT be pushed to `upserts` (garbage jsonb) NOR to the DELETE set
    // (wiping a healthy row on an upstream glitch). Here id 5 is a string → it is
    // skipped entirely (neither upserted nor deleted) and counted as `malformed`,
    // while 1-4 upsert normally.
    const bad = { 1: oneNeighbor(1), 2: oneNeighbor(2), 3: oneNeighbor(3), 4: oneNeighbor(4), 5: 'not-an-array' };
    const { deps, recorded } = makeDeps([1, 2, 3, 4, 5].map(candidate), {
      fetchNeighbors: jest.fn<FetchNeighborsFn>().mockResolvedValue({
        results: bad as unknown as Record<string, SimilarArtistNeighbor[]>,
        source_plays: {},
      }),
    });

    const totals = await runEnrichment(deps, options());

    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 3, 4]);
    expect(recorded.deletes).toEqual([]); // id 5 is NOT deleted
    expect(totals).toMatchObject({ fetched: 4, with_neighbors: 4, malformed: 1, cleared: 0 });
  });

  it('routes an id absent from results to `malformed` (skip + retry), never DELETE', async () => {
    // A contract violation: the endpoint must return every requested id. If one
    // is omitted (a partial upstream fault), treat it as malformed — skip it, do
    // not crash, and above all do not DELETE its healthy row. Here id 5 is absent.
    const { deps, recorded } = makeDeps([1, 2, 3, 4, 5].map(candidate), {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(
          neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2), 3: oneNeighbor(3), 4: oneNeighbor(4) })
        ),
    });

    const totals = await runEnrichment(deps, options());

    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 2, 3, 4]);
    expect(recorded.deletes).toEqual([]); // id 5 is NOT deleted
    expect(totals).toMatchObject({ fetched: 4, with_neighbors: 4, malformed: 1, cleared: 0 });
  });

  it('deletes a single genuine empty even in a small cohort (below the count floor)', async () => {
    // 3-id cohort, one observed-empty (id 2): 1/3 ≈ 33% is above the 20% fraction
    // ceiling, but only 1 empty is below EMPTY_DELETE_MIN_COUNT (3) — so it is
    // real churn, not a partial rebuild, and MUST still clear. This is the
    // small-cohort case the fraction-only guard would wrongly suppress.
    const { deps, recorded } = makeDeps([candidate(1), candidate(2), candidate(3)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(neighborsResponse({ 1: oneNeighbor(1), 2: [], 3: oneNeighbor(3) })),
    });

    const totals = await runEnrichment(deps, options());

    expect(1 / 3).toBeGreaterThan(EMPTY_DELETE_FRACTION_CEIL); // fraction ceiling alone would suppress
    expect(recorded.upserts.map((u) => u.artist_id)).toEqual([1, 3]);
    expect(recorded.deletes).toEqual([2]); // but the count floor lets a single genuine empty clear
    expect(totals).toMatchObject({ enriched: 2, cleared: 1, deletes_suppressed: false });
  });
});

/**
 * BS#1702 station-affinity write. The orchestrator collects the additive
 * `source_plays` map across chunks and UPSERTs it through the injected
 * `writeStation` dep — INDEPENDENTLY of the neighbor write, and crucially
 * BEFORE the neighbors null-wipe early return so a heavily-played headliner with
 * no affinity neighbors still gets its count. These pin the orchestration
 * decisions over a mocked writer; the real PG UPSERT is asserted in the
 * integration spec.
 */
describe('runEnrichment station-plays (BS#1702)', () => {
  it('collects source_plays across chunks and UPSERTs them via the station writer', async () => {
    const { deps, writeStation, recorded } = makeDeps([candidate(1), candidate(2), candidate(3)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValueOnce(neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2) }, { 1: 312, 2: 58 }))
        .mockResolvedValueOnce(neighborsResponse({ 3: oneNeighbor(3) }, { 3: 9 })),
    });

    const totals = await runEnrichment(deps, options({ chunkSize: 2 }));

    expect(writeStation).toHaveBeenCalledTimes(1);
    expect(recorded.station).toEqual([
      { artist_id: 1, plays: 312 },
      { artist_id: 2, plays: 58 },
      { artist_id: 3, plays: 9 },
    ]);
    expect(totals).toMatchObject({ station_written: 3, station_empty_skip: false, station_write_failed: false });
  });

  it('writes station plays even when the neighbors sweep is all-empty (before the null-wipe return)', async () => {
    // Every neighbor list empty (all_empty_sweep fires) BUT plays are present —
    // the heavily-played-artist-with-no-neighbors cold-start case this feature
    // targets. The station write MUST land before the neighbors early return.
    const { deps, writeStation, overwrite, recorded } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(neighborsResponse({ 1: [], 2: [] }, { 1: 999, 2: 500 })),
    });

    const totals = await runEnrichment(deps, options());

    // Neighbors: all-empty sweep → null-wipe guard fires, overwrite NOT called.
    expect(overwrite).not.toHaveBeenCalled();
    expect(totals.all_empty_skip).toBe(true);
    // Station: written despite the neighbors sweep being all-empty.
    expect(writeStation).toHaveBeenCalledTimes(1);
    expect(recorded.station).toEqual([
      { artist_id: 1, plays: 999 },
      { artist_id: 2, plays: 500 },
    ]);
    expect(totals.station_written).toBe(2);
  });

  it('flags station_empty_skip and writes nothing when a responded run returns no source_plays', async () => {
    // Neighbors present, but source_plays empty for the whole run (the default
    // fetch mock omits plays) — semantic-index#369 not yet deployed. Write no
    // station rows; never UPSERT zeros over real counts.
    const { deps, writeStation } = makeDeps([candidate(1), candidate(2)]);

    const totals = await runEnrichment(deps, options());

    expect(writeStation).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ enriched: 2, station_written: 0, station_empty_skip: true });
  });

  it('does not flag station_empty_skip on a total outage (no chunk responded)', async () => {
    // Every chunk throws → no response, no source_plays. The empty station map is
    // an outage (already carried by `errors`), NOT the "endpoint returned no
    // plays" signal, so station_empty_skip stays false.
    const { deps, writeStation } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest.fn<FetchNeighborsFn>().mockRejectedValue(new Error('semantic-index down')),
    });

    const totals = await runEnrichment(deps, options({ chunkSize: 1 }));

    expect(writeStation).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ chunks: 0, errors: 2, station_written: 0, station_empty_skip: false });
  });

  it('collects a play count for an id whose neighbor verdict is absent (independent of the malformed skip)', async () => {
    // id 2 is absent from `results` (a malformed neighbor verdict) but present in
    // source_plays — its play count is collected BEFORE the malformed continue,
    // proving station-plays is independent of the neighbor verdict.
    const { deps, recorded, writeStation } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(neighborsResponse({ 1: oneNeighbor(1) }, { 1: 100, 2: 42 })),
    });

    const totals = await runEnrichment(deps, options());

    expect(totals.malformed).toBe(1); // id 2 absent from results
    expect(writeStation).toHaveBeenCalledTimes(1);
    expect(recorded.station).toEqual([
      { artist_id: 1, plays: 100 },
      { artist_id: 2, plays: 42 },
    ]);
    expect(totals).toMatchObject({ enriched: 1, station_written: 2 });
  });

  it('flags station_write_failed when the station UPSERT throws (neighbors path untouched)', async () => {
    const { deps, overwrite } = makeDeps([candidate(1), candidate(2)], {
      fetchNeighbors: jest
        .fn<FetchNeighborsFn>()
        .mockResolvedValue(neighborsResponse({ 1: oneNeighbor(1), 2: oneNeighbor(2) }, { 1: 10, 2: 20 })),
      writeStation: jest.fn<WriteStationFn>().mockRejectedValue(new Error('deadlock')),
    });

    const totals = await runEnrichment(deps, options());

    expect(totals.station_write_failed).toBe(true);
    expect(totals.station_written).toBe(0);
    // The neighbor overwrite still ran — the two writes are independent.
    expect(overwrite).toHaveBeenCalledTimes(1);
    expect(totals.enriched).toBe(2);
  });

  it('does not write station plays on a dry run', async () => {
    const { deps, writeStation } = makeDeps([candidate(1)]);
    const totals = await runEnrichment(deps, options({ dryRun: true }));
    expect(writeStation).not.toHaveBeenCalled();
    expect(totals).toMatchObject({ station_written: 0, station_empty_skip: false });
  });
});
