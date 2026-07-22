/**
 * Pins the orchestrator's Sentry capture gating for per-artist fetch failures
 * (BS#1743). Separate file so `jest.mock` of the logger module can't leak into
 * the main orchestrate suite (which relies on the real no-op logger) — same
 * isolation pattern as
 * concerts-similar-artists-enrichment/orchestrate.capture.test.ts.
 *
 * Why this exists: `getArtistDetails` throws `LmlClientError` on EVERY non-2xx
 * (404 for a stale/absent Discogs id; 502/503/504 while LML or Discogs is
 * down). This job keeps no negative cache, so a stale headliner id stays a
 * candidate every run — capturing it unconditionally would fire one Sentry
 * event PER NIGHT until the show ages out (months, for a far-future show), and
 * a full LML outage would fire one per distinct headliner. An expected
 * `LmlClientError` must be counted + warn-logged (visible in the summary) and
 * left retryable, but NOT escalated to Sentry; only a genuinely-unexpected
 * error is captured. Mirrors the genre sibling's `unavailable`-is-not-an-
 * anomaly routing.
 */
import { jest } from '@jest/globals';
import { LmlClientError } from '@wxyc/lml-client';

import {
  runEnrichment,
  type EnrichDeps,
  type EnrichOptions,
} from '../../../../jobs/concerts-poster-enrichment/orchestrate';
import { captureError } from '../../../../jobs/concerts-poster-enrichment/logger';
import type { EnrichmentCandidate } from '../../../../jobs/concerts-poster-enrichment/query';

jest.mock('../../../../jobs/concerts-poster-enrichment/logger', () => ({
  log: jest.fn(),
  captureError: jest.fn(),
}));

const mockedCaptureError = captureError as jest.MockedFunction<typeof captureError>;

const candidate = (concert_id: number, discogs_artist_id: number): EnrichmentCandidate => ({
  concert_id,
  discogs_artist_id,
});

const baseOptions: EnrichOptions = { pageSize: 10, dryRun: false };

const makeDeps = (fetchArtistImage: EnrichDeps['fetchArtistImage']): EnrichDeps => ({
  loadCandidates: jest.fn<EnrichDeps['loadCandidates']>().mockResolvedValue([candidate(1, 100)]),
  fetchArtistImage,
  writeImages: jest.fn<EnrichDeps['writeImages']>().mockResolvedValue({ updated: 0 }),
  awaitQuiet: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
});

const artistFetchCaptures = () => mockedCaptureError.mock.calls.filter(([, step]) => step === 'artist_fetch_failed');

describe('runEnrichment — per-artist fetch-failure Sentry gating (BS#1743)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does NOT capture an expected LmlClientError (e.g. a 404 stale id) but still counts it retryable', async () => {
    const deps = makeDeps(
      jest.fn<EnrichDeps['fetchArtistImage']>().mockRejectedValue(new LmlClientError('artist not found', 404))
    );

    const totals = await runEnrichment(deps, baseOptions);

    expect(totals).toMatchObject({ skipped_no_artist: 1, enriched: 0 });
    expect(artistFetchCaptures()).toHaveLength(0);
  });

  it('does NOT capture an expected LmlClientError on a 5xx outage', async () => {
    const deps = makeDeps(
      jest.fn<EnrichDeps['fetchArtistImage']>().mockRejectedValue(new LmlClientError('LML request failed', 502))
    );

    await runEnrichment(deps, baseOptions);

    expect(artistFetchCaptures()).toHaveLength(0);
  });

  it('DOES capture a genuinely-unexpected error (not an LmlClientError)', async () => {
    const deps = makeDeps(
      jest.fn<EnrichDeps['fetchArtistImage']>().mockRejectedValue(new TypeError('cannot read image_url of undefined'))
    );

    const totals = await runEnrichment(deps, baseOptions);

    expect(totals).toMatchObject({ skipped_no_artist: 1 });
    expect(artistFetchCaptures()).toHaveLength(1);
  });
});
