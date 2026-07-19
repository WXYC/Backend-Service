/**
 * Unit tests for jobs/concerts-similar-artists-enrichment job.ts (BS#1701) —
 * the two-lane wiring that BS#1701 adds on top of the BS#1626 orchestrator.
 *
 * `runJob` runs the LIBRARY lane then the DISCOGS lane over the SAME (real)
 * `runEnrichment` orchestrator, mocking only the lane I/O (candidate queries,
 * neighbor fetches, writers) so no DB or network is touched. This pins the
 * genuinely-new glue:
 *   - both lanes run, each against its own endpoint + writer;
 *   - the `{discogs_artist_id} ↔ {artist_id}` translation at the dep boundary
 *     (discogs candidates come IN as `discogs_artist_id`; the discogs writer
 *     receives `discogs_artist_id` back OUT — proving both `.map()`s);
 *   - `runJob` returns `{ library, discogs }`;
 *   - `laneShouldAlert` is the per-lane exit predicate `main` ORs, so a single
 *     failing lane is detected independently (never masked by the other's win).
 *
 * WXYC-representative fixtures. `@wxyc/database` is auto-mocked by the unit
 * jest config's moduleNameMapper; live activity is disabled (lookback 0) so the
 * cooperative pause never probes the mocked db.
 */
import { jest } from '@jest/globals';

import {
  DISCOGS_COHORT_LABEL,
  laneShouldAlert,
  runJob,
  type EnrichJobOptions,
} from '../../../../jobs/concerts-similar-artists-enrichment/job';
import { emptyTotals, type Totals } from '../../../../jobs/concerts-similar-artists-enrichment/orchestrate';
import type { NeighborsBatchResponse } from '../../../../jobs/concerts-similar-artists-enrichment/neighbors-client';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-similar-artists-enrichment/query';
import type { DiscogsEnrichmentCandidate } from '../../../../jobs/concerts-similar-artists-enrichment/discogs-query';
import type { SimilarArtistsRow } from '../../../../jobs/concerts-similar-artists-enrichment/writer';
import type { DiscogsSimilarArtistsRow } from '../../../../jobs/concerts-similar-artists-enrichment/discogs-writer';

jest.mock('../../../../jobs/concerts-similar-artists-enrichment/query', () => ({
  loadEnrichmentCandidates: jest.fn(),
}));
jest.mock('../../../../jobs/concerts-similar-artists-enrichment/discogs-query', () => ({
  loadDiscogsEnrichmentCandidates: jest.fn(),
}));
jest.mock('../../../../jobs/concerts-similar-artists-enrichment/writer', () => ({
  overwriteNeighbors: jest.fn(),
}));
jest.mock('../../../../jobs/concerts-similar-artists-enrichment/discogs-writer', () => ({
  overwriteDiscogsNeighbors: jest.fn(),
}));
jest.mock('../../../../jobs/concerts-similar-artists-enrichment/neighbors-client', () => ({
  SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP: 100,
  fetchNeighborsBatch: jest.fn(),
  fetchDiscogsNeighborsBatch: jest.fn(),
  fetchGraphHealth: jest.fn(),
}));

// Import the mocked fns AFTER jest.mock so the bindings are the mocks.
import { loadEnrichmentCandidates } from '../../../../jobs/concerts-similar-artists-enrichment/query';
import { loadDiscogsEnrichmentCandidates } from '../../../../jobs/concerts-similar-artists-enrichment/discogs-query';
import { overwriteNeighbors } from '../../../../jobs/concerts-similar-artists-enrichment/writer';
import { overwriteDiscogsNeighbors } from '../../../../jobs/concerts-similar-artists-enrichment/discogs-writer';
import {
  fetchDiscogsNeighborsBatch,
  fetchGraphHealth,
  fetchNeighborsBatch,
} from '../../../../jobs/concerts-similar-artists-enrichment/neighbors-client';

const mock = <T extends (...args: never[]) => unknown>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const jobOptions = (over: Partial<EnrichJobOptions> = {}): EnrichJobOptions => ({
  limit: 20,
  chunkSize: 100,
  liveActivityLookbackSeconds: 0, // disable the cooperative-pause probe (no db)
  liveActivityPauseMs: 0,
  backfill: false,
  dryRun: false,
  ...over,
});

// `source_plays` is empty: this suite exercises the two-lane neighbor WIRING, not
// station plays (BS#1702's own tests cover that). The library lane collects no
// station plays (a harmless empty-skip); the discogs lane omits `writeStation`
// and skips the station path entirely.
const response = (byId: Record<number, Array<{ artist_id: number; weight: number }>>): NeighborsBatchResponse => {
  const results: NeighborsBatchResponse['results'] = {};
  for (const [id, list] of Object.entries(byId)) results[String(id)] = list;
  return { results, source_plays: {} };
};

const passThroughWriter = () =>
  jest.fn(
    (upserts: Array<{ neighbors: unknown[] }>, deletes: number[]) =>
      Promise.resolve({ written: upserts.length, deleted: deletes.length }) as Promise<{
        written: number;
        deleted: number;
      }>
  );

beforeEach(() => {
  mock(fetchGraphHealth).mockResolvedValue({ mapped_artist_count: 22000 });
});

describe('runJob two-lane wiring (BS#1701)', () => {
  it('runs BOTH lanes and translates ids at the discogs dep boundary', async () => {
    mock(loadEnrichmentCandidates).mockResolvedValue([{ artist_id: 100 }] as EnrichmentCandidate[]);
    mock(loadDiscogsEnrichmentCandidates).mockResolvedValue([
      { discogs_artist_id: 900123 },
    ] as DiscogsEnrichmentCandidate[]);
    mock(fetchNeighborsBatch).mockResolvedValue(response({ 100: [{ artist_id: 1000, weight: 4.2 }] }));
    mock(fetchDiscogsNeighborsBatch).mockResolvedValue(response({ 900123: [{ artist_id: 2000, weight: 3.1 }] }));
    mock(overwriteNeighbors).mockImplementation(passThroughWriter());
    mock(overwriteDiscogsNeighbors).mockImplementation(passThroughWriter());

    const result = await runJob(jobOptions());

    // Library lane hit the library endpoint + writer with the catalog id verbatim.
    expect(mock(fetchNeighborsBatch)).toHaveBeenCalledWith([100], 20);
    expect(mock(overwriteNeighbors)).toHaveBeenCalledTimes(1);
    const libUpserts = mock(overwriteNeighbors).mock.calls[0][0] as SimilarArtistsRow[];
    expect(libUpserts).toEqual([{ artist_id: 100, neighbors: [{ artist_id: 1000, weight: 4.2 }] }]);

    // Discogs lane: the cohort's `discogs_artist_id` reached the discogs endpoint
    // (IN translation), and the discogs writer received it back as
    // `discogs_artist_id` (OUT translation) — never leaking the orchestrator's
    // internal `artist_id` field name.
    expect(mock(fetchDiscogsNeighborsBatch)).toHaveBeenCalledWith([900123], 20);
    expect(mock(fetchNeighborsBatch)).not.toHaveBeenCalledWith([900123], 20); // not the library endpoint
    expect(mock(overwriteDiscogsNeighbors)).toHaveBeenCalledTimes(1);
    const discogsUpserts = mock(overwriteDiscogsNeighbors).mock.calls[0][0] as DiscogsSimilarArtistsRow[];
    expect(discogsUpserts).toEqual([{ discogs_artist_id: 900123, neighbors: [{ artist_id: 2000, weight: 3.1 }] }]);

    expect(result.library.enriched).toBe(1);
    expect(result.discogs.enriched).toBe(1);
  });

  it('labels the discogs cohort distinctly and never writes a discogs id into the library table', async () => {
    mock(loadEnrichmentCandidates).mockResolvedValue([] as EnrichmentCandidate[]);
    mock(loadDiscogsEnrichmentCandidates).mockResolvedValue([
      { discogs_artist_id: 900500 },
    ] as DiscogsEnrichmentCandidate[]);
    mock(fetchDiscogsNeighborsBatch).mockResolvedValue(response({ 900500: [{ artist_id: 3000, weight: 1 }] }));
    mock(overwriteNeighbors).mockImplementation(passThroughWriter());
    mock(overwriteDiscogsNeighbors).mockImplementation(passThroughWriter());

    const result = await runJob(jobOptions());

    // Empty library cohort → library lane made no endpoint call and wrote nothing.
    expect(mock(fetchNeighborsBatch)).not.toHaveBeenCalled();
    expect(mock(overwriteNeighbors)).not.toHaveBeenCalled();
    expect(result.library.cohort).toBe(0);
    // The discogs id only ever reaches the discogs writer.
    expect(mock(overwriteDiscogsNeighbors)).toHaveBeenCalledTimes(1);
    expect(DISCOGS_COHORT_LABEL).toBe('Discogs-only headliners');
  });

  it('detects a single failing lane independently (discogs all-empty-skip, library ok)', async () => {
    mock(loadEnrichmentCandidates).mockResolvedValue([{ artist_id: 100 }] as EnrichmentCandidate[]);
    mock(loadDiscogsEnrichmentCandidates).mockResolvedValue([
      { discogs_artist_id: 900123 },
    ] as DiscogsEnrichmentCandidate[]);
    mock(fetchNeighborsBatch).mockResolvedValue(response({ 100: [{ artist_id: 1000, weight: 4.2 }] }));
    // Discogs lane: the only responded verdict is empty → null-wipe guard fires,
    // writes nothing, sets all_empty_skip.
    mock(fetchDiscogsNeighborsBatch).mockResolvedValue(response({ 900123: [] }));
    mock(overwriteNeighbors).mockImplementation(passThroughWriter());
    mock(overwriteDiscogsNeighbors).mockImplementation(passThroughWriter());

    const result = await runJob(jobOptions());

    expect(result.library.all_empty_skip).toBe(false);
    expect(result.discogs.all_empty_skip).toBe(true);
    // The per-lane predicate `main` ORs: library is fine, discogs alerts.
    expect(laneShouldAlert(result.library)).toBe(false);
    expect(laneShouldAlert(result.discogs)).toBe(true);
    // Discogs lane wrote nothing (guard held); the library write survived.
    expect(mock(overwriteDiscogsNeighbors)).not.toHaveBeenCalled();
    expect(result.library.enriched).toBe(1);
  });
});

describe('laneShouldAlert (per-lane exit predicate, BS#1701)', () => {
  const totals = (over: Partial<Totals>): Totals => ({ ...emptyTotals(), ...over });

  it('does not alert on a clean empty cohort (wrote nothing, nothing failed)', () => {
    expect(laneShouldAlert(emptyTotals())).toBe(false);
  });

  it('alerts when the null-wipe guard fired (all_empty_skip)', () => {
    expect(laneShouldAlert(totals({ all_empty_skip: true }))).toBe(true);
  });

  it('alerts when it wrote nothing AND a signal failed (errors / malformed / write_failed)', () => {
    expect(laneShouldAlert(totals({ enriched: 0, cleared: 0, errors: 1 }))).toBe(true);
    expect(laneShouldAlert(totals({ enriched: 0, cleared: 0, malformed: 1 }))).toBe(true);
    expect(laneShouldAlert(totals({ enriched: 0, cleared: 0, write_failed: true }))).toBe(true);
  });

  it('does not alert on a PARTIAL failure that still wrote something', () => {
    expect(laneShouldAlert(totals({ enriched: 5, errors: 1 }))).toBe(false);
    expect(laneShouldAlert(totals({ cleared: 2, malformed: 3 }))).toBe(false);
  });
});
