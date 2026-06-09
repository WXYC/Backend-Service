/**
 * Unit tests for enrichment-worker handler.ts captureMessage volume control
 * (BS#1311 / follow-up to BS#969).
 *
 * The original PR #1304 (closes #969) fired `Sentry.captureMessage` on every
 * empty outcome — degraded LML matches, no-match verdicts, raced finalize
 * outcomes, and the catch-arm path. Post-hoc code review surfaced two HIGH
 * issues against the unrestored WXYC org Sentry quota (BS#1291 RCA):
 *
 *   1. `lml_no_match` is by-design Discogs miss, not a degradation; firing
 *      captureMessage there inflates the rate the BS#969 alert is meant to
 *      track.
 *   2. `_raced` outcomes were written by a sibling worker / C6 sweep, not
 *      by this worker; firing captureMessage cascades a C6 recovery into a
 *      flood whose events don't correspond to actual user-visible
 *      degradation.
 *
 * Plus the catch-arm captureMessage doubles every LML throw against quota
 * (captureException already records the same event); BS#1311 drops it.
 *
 * Net result pinned here: captureMessage fires only on `lml_degraded`
 * outcomes that this worker actually wrote (the LML#408 class) — the
 * dominant case BS#969 was filed to surface. The `enrichment.outcome`
 * span attribute (still set on every tick) remains the source of truth
 * for dashboard-side rate aggregation of the no-match and raced classes.
 */

import { jest } from '@jest/globals';

// Mock @sentry/node BEFORE importing handler.ts so the handler picks up the
// mock at module-load time. unit.setup.ts's clearMocks: true handles per-test
// reset; we just need the symbols to exist.
jest.mock('@sentry/node', () => ({
  startSpan: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

// Mock @wxyc/lml-client so we control the response shape and don't take a
// network dependency. envInt is re-exported from the package; provide a
// passthrough so the ENRICHMENT_LML_BUDGET_MS module-init read works.
const mockLookupMetadata = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  envInt: (_name: string, fallback: number) => fallback,
}));

// Mock the sibling enrichment-worker modules so the test only exercises the
// captureMessage branching in handler.ts.
const mockClaimRowForEnrichment =
  jest.fn<(id: number) => Promise<{ claimed: true; id: number } | { claimed: false }>>();
jest.mock('../../../../apps/enrichment-worker/claim.js', () => ({
  claimRowForEnrichment: mockClaimRowForEnrichment,
}));

const mockFilterForEnrichment = jest.fn<(event: unknown) => unknown>();
jest.mock('../../../../apps/enrichment-worker/cdc-subscriber.js', () => ({
  filterForEnrichment: mockFilterForEnrichment,
}));

// Preserve the real `extractArtwork` (imported by empty-outcome.ts) and only
// stub `finalizeRow`. Mocking the whole module would break the empty-outcome
// classification path because empty-outcome.ts re-imports extractArtwork.
const mockFinalizeRow = jest.fn<(...args: unknown[]) => Promise<string>>();
jest.mock('../../../../apps/enrichment-worker/enrich.js', () => {
  const actual = jest.requireActual<typeof import('../../../../apps/enrichment-worker/enrich')>(
    '../../../../apps/enrichment-worker/enrich'
  );
  return {
    ...actual,
    finalizeRow: mockFinalizeRow,
  };
});

import * as Sentry from '@sentry/node';

import { makeEnrichmentHandler } from '../../../../apps/enrichment-worker/handler';

type SpanLike = { setAttribute: jest.Mock };

const makeCandidate = () => ({
  id: 42,
  entry_type: 'track' as const,
  metadata_status: 'pending' as const,
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  album_id: null,
});

const driveOneTick = async (): Promise<SpanLike> => {
  const span: SpanLike = { setAttribute: jest.fn() };
  (Sentry.startSpan as jest.Mock).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_opts: unknown, fn: any) => fn(span)
  );
  const candidate = makeCandidate();
  mockFilterForEnrichment.mockReturnValueOnce(candidate);
  mockClaimRowForEnrichment.mockResolvedValueOnce({ claimed: true, id: 42 });

  const handler = makeEnrichmentHandler();
  // The CDC handler dispatches via `void handleCandidate(...)` — fire-and-
  // forget. Drain the microtask queue so the awaited chain inside the
  // handler completes before our assertions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler({} as any);
  await new Promise((resolve) => setImmediate(resolve));
  return span;
};

const matchResponseWithArtwork = {
  results: [
    {
      artwork: {
        artwork_url: 'https://i.discogs.com/abc/cover.jpg',
        release_url: 'https://discogs.com/release/123',
      },
    },
  ],
};

const degradedResponse = {
  results: [
    {
      artwork: {
        artwork_url: null,
        release_url: 'https://discogs.com/release/123',
      },
    },
  ],
};

const noMatchResponse = { results: [] };

describe('makeEnrichmentHandler captureMessage volume control (BS#1311)', () => {
  it('fires captureMessage on lml_degraded — the dominant BS#969 class', async () => {
    mockLookupMetadata.mockResolvedValueOnce(degradedResponse);
    mockFinalizeRow.mockResolvedValueOnce('enriched_match');

    const span = await driveOneTick();

    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'enriched_match');
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'enrichment-empty-outcome',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ cause: 'lml_degraded', outcome: 'enriched_match' }),
      })
    );
  });

  it('does NOT fire captureMessage when outcome ends in _raced (enriched_match_raced)', async () => {
    // A sibling worker / C6 sweep won the finalize race; the user-visible
    // state was written by them. This worker's captureMessage would inflate
    // the BS#969 rate against the true degradation rate.
    mockLookupMetadata.mockResolvedValueOnce(degradedResponse);
    mockFinalizeRow.mockResolvedValueOnce('enriched_match_raced');

    const span = await driveOneTick();

    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'enriched_match_raced');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does NOT fire captureMessage when outcome ends in _raced (enriched_no_match_raced)', async () => {
    mockLookupMetadata.mockResolvedValueOnce(noMatchResponse);
    mockFinalizeRow.mockResolvedValueOnce('enriched_no_match_raced');

    const span = await driveOneTick();

    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'enriched_no_match_raced');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does NOT fire captureMessage when cause is lml_no_match (by-design Discogs miss)', async () => {
    // Dashboard aggregation of the no-match rate uses the
    // `enrichment.outcome` span attribute, not per-event Sentry issues.
    mockLookupMetadata.mockResolvedValueOnce(noMatchResponse);
    mockFinalizeRow.mockResolvedValueOnce('enriched_no_match');

    const span = await driveOneTick();

    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'enriched_no_match');
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('does NOT fire captureMessage on lml_match (artwork_url present)', async () => {
    // Sanity: the happy path stays silent. extractArtwork sees a populated
    // artwork_url so isEmptyOutcome returns false.
    mockLookupMetadata.mockResolvedValueOnce(matchResponseWithArtwork);
    mockFinalizeRow.mockResolvedValueOnce('enriched_match');

    await driveOneTick();

    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  it('catch arm: captureException stays, captureMessage is dropped (no double-fire on LML throw)', async () => {
    // Pre-1311 behavior fired both captureException AND captureMessage on
    // every LML throw — two quota slots per timeout. captureException is the
    // source-of-truth for the stack trace; the catch-arm captureMessage was
    // redundant and BS#1311 drops it.
    mockLookupMetadata.mockRejectedValueOnce(new Error('LML timeout'));

    const span = await driveOneTick();

    expect(span.setAttribute).toHaveBeenCalledWith('enrichment.outcome', 'lml_error');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
