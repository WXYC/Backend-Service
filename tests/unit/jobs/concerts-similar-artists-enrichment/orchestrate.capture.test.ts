/**
 * Pins the orchestrator's Sentry escalation for a genuine all-empty NEIGHBOR
 * sweep (BS#1702). Separate file so `jest.mock` of the logger module can't leak
 * into the main orchestrate suite (which relies on the real no-op logger) —
 * same isolation pattern as triangle-shows-etl/orchestrate.capture.test.ts.
 *
 * Why this exists: BS#1702 weakened the all-empty-sweep non-zero exit to
 * `all_empty_skip && station_written === 0`, so a night that still wrote station
 * plays now exits 0. The all-empty sweep is the ONE exit-suppressible failure
 * kind that previously had no Sentry fallback (only a stderr `log('error')`), so
 * without an escalation a genuine neighbor-graph fault would go silent at exit 0.
 * The orchestrator now raises one aggregate Sentry signal when the graph reports
 * a HEALTHY `mapped_artist_count` (likely a real fault), and stays log-only when
 * the count is 0/null (the expected pre-rebuild bootstrap).
 */
import { jest } from '@jest/globals';

import {
  runEnrichment,
  type EnrichDeps,
  type EnrichOptions,
} from '../../../../jobs/concerts-similar-artists-enrichment/orchestrate';
import { captureError } from '../../../../jobs/concerts-similar-artists-enrichment/logger';
import type {
  NeighborsBatchResponse,
  SimilarArtistNeighbor,
} from '../../../../jobs/concerts-similar-artists-enrichment/neighbors-client';

jest.mock('../../../../jobs/concerts-similar-artists-enrichment/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
}));

const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

const emptyResponse = (ids: number[]): NeighborsBatchResponse => {
  const results: Record<string, SimilarArtistNeighbor[]> = {};
  for (const id of ids) results[String(id)] = [];
  return { results, source_plays: {} };
};

const baseOptions: EnrichOptions = {
  limit: 20,
  chunkSize: 100,
  dryRun: false,
};

const makeDeps = (mappedArtistCount: number | null): EnrichDeps => ({
  loadCandidates: jest.fn<EnrichDeps['loadCandidates']>().mockResolvedValue([{ artist_id: 1 }, { artist_id: 2 }]),
  fetchNeighbors: jest
    .fn<EnrichDeps['fetchNeighbors']>()
    .mockImplementation((ids: number[]) => Promise.resolve(emptyResponse(ids))),
  fetchHealth: jest.fn<EnrichDeps['fetchHealth']>().mockResolvedValue({ mapped_artist_count: mappedArtistCount }),
  overwrite: jest.fn<EnrichDeps['overwrite']>().mockResolvedValue({ written: 0, deleted: 0 }),
  writeStation: jest.fn<EnrichDeps['writeStation']>().mockResolvedValue({ written: 0 }),
  awaitQuiet: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
});

describe('runEnrichment — all-empty-sweep Sentry escalation (BS#1702)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('raises one all_empty_sweep Sentry signal when the graph reports a healthy mapped_artist_count', async () => {
    const totals = await runEnrichment(makeDeps(22000), baseOptions);

    expect(totals.all_empty_skip).toBe(true);
    const captures = mockedCaptureError.mock.calls.filter(([, step]) => step === 'all_empty_sweep');
    expect(captures).toHaveLength(1);
  });

  it('does NOT raise a Sentry signal on a bootstrap sweep (mapped_artist_count 0/null)', async () => {
    for (const count of [0, null]) {
      jest.clearAllMocks();
      const totals = await runEnrichment(makeDeps(count), baseOptions);
      expect(totals.all_empty_skip).toBe(true);
      const captures = mockedCaptureError.mock.calls.filter(([, step]) => step === 'all_empty_sweep');
      expect(captures).toHaveLength(0);
    }
  });
});
