/**
 * Unit tests for the enrichment-worker in-flight drain (BS#1108).
 *
 * The CDC dispatcher invokes `handleCandidate(candidate)` as
 * `void handleCandidate(...)` — fire-and-forget. Without a registry the
 * worker's SIGTERM handler would tear down the DB pool while LML lookups
 * are still pending; the subsequent claim or finalize write throws and the
 * row stays in `metadata_status='enriching'` until C6 (#895) sweeps it
 * (which itself round-trips a second Discogs lookup whose answer was
 * already retrieved and discarded).
 *
 * `handleCandidate` self-registers in the `inFlightCandidates` set and
 * unregisters via `.finally`. `drainInFlightCandidates(deadlineMs)` races
 * `Promise.allSettled(snapshot)` against `setTimeout(deadlineMs)`, returns
 * the *current registry size* afterward (mirrors the backend's
 * `drainInFlightEnrichments` contract in
 * `apps/backend/services/metadata/enrichment.service.ts`).
 *
 * Three contract guarantees pinned here:
 *   1. Each invocation auto-registers + auto-unregisters on settle (resolved
 *      AND rejected) so the registry can never slow-leak past a tick.
 *   2. `drainInFlightCandidates` awaits pending promises and returns 0 when
 *      they finish inside the deadline.
 *   3. `drainInFlightCandidates` bounds the wait by `deadlineMs` and returns
 *      the unsettled count — never throws — so a hung LML call can't block
 *      deploy indefinitely.
 */

import { jest } from '@jest/globals';

jest.mock('@sentry/node', () => ({
  startSpan: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockLookupMetadata = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  envInt: (_name: string, fallback: number) => fallback,
}));

const mockClaimRowForEnrichment =
  jest.fn<(id: number) => Promise<{ claimed: true; id: number } | { claimed: false }>>();
jest.mock('../../../../apps/enrichment-worker/claim.js', () => ({
  claimRowForEnrichment: mockClaimRowForEnrichment,
}));

const mockFilterForEnrichment = jest.fn<(event: unknown) => unknown>();
jest.mock('../../../../apps/enrichment-worker/cdc-subscriber.js', () => ({
  filterForEnrichment: mockFilterForEnrichment,
}));

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

import {
  drainInFlightCandidates,
  getInFlightCandidateCount,
  makeEnrichmentHandler,
  _resetInFlightCandidatesForTest,
} from '../../../../apps/enrichment-worker/handler';

type SpanLike = { setAttribute: jest.Mock };

const makeCandidate = (id: number) => ({
  id,
  entry_type: 'track' as const,
  metadata_status: 'pending' as const,
  artist_name: 'Stereolab',
  album_title: 'Dots and Loops',
  track_title: 'Miss Modular',
  album_id: null,
});

/**
 * Dispatch one CDC tick. Returns the candidate's id so tests can correlate
 * across multiple in-flight invocations.
 */
function dispatchTick(id: number): void {
  const span: SpanLike = { setAttribute: jest.fn() };
  (Sentry.startSpan as jest.Mock).mockImplementation(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (_opts: unknown, fn: any) => fn(span)
  );
  mockFilterForEnrichment.mockReturnValueOnce(makeCandidate(id));
  mockClaimRowForEnrichment.mockResolvedValueOnce({ claimed: true, id });
  const handler = makeEnrichmentHandler();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler({} as any);
}

describe('enrichment-worker in-flight drain (BS#1108)', () => {
  beforeEach(() => {
    _resetInFlightCandidatesForTest();
    // Every mock today uses `mockReturnValueOnce` / `mockResolvedValueOnce`,
    // so leakage between cases is latent rather than observable. Reset
    // pinned here so a future test that uses `mockReturnValue` (sticky) or
    // forgets to re-mock can't silently inherit a previous case's stub —
    // the failure mode would be a flaky test that passes in isolation and
    // fails in suite order, which is exactly the kind of bug a unit-test
    // file should refuse to harbor.
    jest.resetAllMocks();
  });

  describe('inFlightCandidates registry', () => {
    it('starts empty', () => {
      expect(getInFlightCandidateCount()).toBe(0);
    });

    it('registers an in-flight candidate while the LML lookup is pending', async () => {
      // Never-resolving lookup so the promise stays in-flight for assertion.
      mockLookupMetadata.mockReturnValueOnce(new Promise(() => undefined));

      dispatchTick(1);
      // Yield once so the dispatched `void handleCandidate(...)` reaches
      // its `await Sentry.startSpan(...)` and the wrapper has had a chance
      // to add itself to the registry.
      await new Promise((resolve) => setImmediate(resolve));

      expect(getInFlightCandidateCount()).toBe(1);
    });

    it('unregisters the candidate after a successful tick (settle on resolve)', async () => {
      mockLookupMetadata.mockResolvedValueOnce({ results: [] });
      mockFinalizeRow.mockResolvedValueOnce('enriched_no_match');

      dispatchTick(2);
      // Allow the full tick chain (lookup -> finalize -> .finally) to run.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(getInFlightCandidateCount()).toBe(0);
    });

    it('unregisters the candidate when the LML lookup rejects (settle on reject)', async () => {
      // The handler's internal try/catch turns the LML throw into a
      // resolved promise (logging + capturing the error), so the wrapper's
      // .finally must still fire and the registry must reach 0. Without
      // the unregister side, a slow stream of LML errors would slow-leak
      // the registry and inflate the shutdown-time "dropped" count.
      mockLookupMetadata.mockRejectedValueOnce(new Error('LML timeout'));

      dispatchTick(3);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(getInFlightCandidateCount()).toBe(0);
    });

    it('skips registration when the CDC filter rejects the event (no candidate)', async () => {
      mockFilterForEnrichment.mockReturnValueOnce(null);

      const handler = makeEnrichmentHandler();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler({} as any);
      await new Promise((resolve) => setImmediate(resolve));

      expect(getInFlightCandidateCount()).toBe(0);
    });

    it('does not raise unhandledRejection when Sentry.startSpan throws synchronously', async () => {
      // Defensive: handleCandidate wraps its body in try/catch but the outer
      // `await Sentry.startSpan(...)` sits outside any try/catch. If Sentry's
      // internals throw (exporter error, disposed hub during shutdown), the
      // handleCandidate promise rejects. The dispatcher's `void promise.finally(...)`
      // would otherwise discard the rejection and surface as an
      // unhandledRejection in production. The `.catch(() => {})` chain pins
      // that contract here.
      mockFilterForEnrichment.mockReturnValueOnce(makeCandidate(99));
      (Sentry.startSpan as jest.Mock).mockImplementation(() => {
        throw new Error('Sentry exporter dead during shutdown');
      });

      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const handler = makeEnrichmentHandler();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler({} as any);
        // Two macrotask yields: one to let the rejection propagate through
        // the .catch + .finally chain, one to let Node's microtask queue
        // surface any unhandled rejection it would have emitted.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(getInFlightCandidateCount()).toBe(0);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  describe('drainInFlightCandidates', () => {
    it('returns 0 immediately when the registry is empty', async () => {
      const remaining = await drainInFlightCandidates(2_000);
      expect(remaining).toBe(0);
    });

    it('awaits in-flight promises and returns 0 when they settle inside the deadline', async () => {
      let resolveLookup: (value: unknown) => void = () => undefined;
      mockLookupMetadata.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLookup = resolve;
        })
      );
      mockFinalizeRow.mockResolvedValueOnce('enriched_no_match');

      dispatchTick(4);
      await new Promise((resolve) => setImmediate(resolve));
      expect(getInFlightCandidateCount()).toBe(1);

      // Resolve the pending lookup on the next tick — well within the
      // 2s deadline. The drain must wait for the resolution, see the
      // unregister fire, and return 0.
      setImmediate(() => resolveLookup({ results: [] }));

      const remaining = await drainInFlightCandidates(2_000);
      expect(remaining).toBe(0);
      expect(getInFlightCandidateCount()).toBe(0);
    });

    it('returns the unsettled count after the deadline elapses (bounds the wait)', async () => {
      // Two never-resolving lookups simulate hung LML calls during deploy.
      // The drain must NOT hang the SIGTERM — it returns the count of
      // promises still pending after `deadlineMs`.
      mockLookupMetadata.mockReturnValueOnce(new Promise(() => undefined));
      mockLookupMetadata.mockReturnValueOnce(new Promise(() => undefined));

      dispatchTick(5);
      dispatchTick(6);
      await new Promise((resolve) => setImmediate(resolve));
      expect(getInFlightCandidateCount()).toBe(2);

      // 50ms test-only deadline. Production uses 30s (WORKER_DRAIN_DEADLINE_MS).
      const start = Date.now();
      const remaining = await drainInFlightCandidates(50);
      const elapsed = Date.now() - start;

      expect(remaining).toBe(2);
      // Sanity: the drain returned promptly after the deadline, not after
      // the never-resolving lookups.
      expect(elapsed).toBeLessThan(500);
    });

    it('does not throw when an in-flight handler rejected mid-drain', async () => {
      // handleCandidate's internal try/catch already converts LML throws
      // into resolved promises; this case pins that the wrapper's
      // .finally chain doesn't reintroduce an unhandled rejection that
      // would crash the shutdown path.
      mockLookupMetadata.mockRejectedValueOnce(new Error('LML timeout'));

      dispatchTick(7);
      // Don't yield yet — the rejection happens inside the drain.

      const remaining = await drainInFlightCandidates(2_000);
      expect(remaining).toBe(0);
    });
  });
});
