/**
 * Unit tests for the rotation-tracks picker LRU warm pass (BS#998).
 *
 * Coverage:
 *  1. The walk fetches active rotation rows (kill_date IS NULL OR > today),
 *     calls `resolveRotationPickerSource` for each, and emits a final
 *     summary log line with the expected counters.
 *  2. A single row's failure is captured to Sentry and does not halt the
 *     walk; subsequent rows are still visited.
 *  3. The counter classification works: tier-3 positive vs negative cache
 *     additions are correctly tallied via the LRU-sizes delta.
 *  4. `startRotationTracksCacheWarm` is fire-and-forget: a thrown error in
 *     the top-level walk is caught and Sentry-captured rather than escaping
 *     to the caller (which would be `app.listen`'s callback).
 *
 * The shared `db` and `resolveRotationPickerSource` (via library.service)
 * are mocked. We hold the LRU-sizes accessor stub so we can simulate
 * positive/negative cache growth.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '../../mocks/database.mock';

// `library.service` exposes both the picker resolver we drive end-to-end
// and the LRU-sizes accessor we read for the counter classifier. Mock at
// the module boundary so the warm service receives our test doubles.
type RotationTrack = { position: string; title: string; duration: string | null; artists: string[] };
type PickerSource = { releaseId: number | null; inlineTracklist: RotationTrack[] | null };
const mockResolveRotationPickerSource = jest.fn<(id: number) => Promise<PickerSource | null>>();
type Sizes = { positive: number; negative: number };
const sizesRef: { current: Sizes } = { current: { positive: 0, negative: 0 } };
const mockRotationLmlCacheSizesForWarm = jest.fn<() => Sizes>(() => sizesRef.current);
const releaseSizesRef: { current: Sizes } = { current: { positive: 0, negative: 0 } };
const mockReleaseTracklistCacheSizesForWarm = jest.fn<() => Sizes>(() => releaseSizesRef.current);
const mockGetRotationTracksFromRelease = jest.fn<(releaseId: number) => Promise<RotationTrack[] | null>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  resolveRotationPickerSource: mockResolveRotationPickerSource,
  __rotationLmlCacheSizesForWarm: mockRotationLmlCacheSizesForWarm,
  getRotationTracksFromRelease: mockGetRotationTracksFromRelease,
  __releaseTracklistCacheSizesForWarm: mockReleaseTracklistCacheSizesForWarm,
}));

const source = (releaseId: number): PickerSource => ({ releaseId, inlineTracklist: null });
const inlineSource = (releaseId: number | null, tracks: RotationTrack[]): PickerSource => ({
  releaseId,
  inlineTracklist: tracks,
});

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import {
  warmRotationTracksCache,
  startRotationTracksCacheWarm,
} from '../../../apps/backend/services/rotation-tracks-cache-warm.service';

type MockedFn = jest.Mock<(...args: unknown[]) => unknown>;

const selectMock = db.select as unknown as MockedFn;

/**
 * Stub the `db.select().from().where()` chain so the warm pass receives the
 * given list of active rotation ids. The query has no further chained
 * methods after `.where()`, so the chain resolves directly when awaited.
 */
function mockActiveRotationRows(ids: number[]): void {
  const fromFn = jest.fn();
  const whereFn = jest.fn<() => Promise<Array<{ id: number }>>>().mockResolvedValue(ids.map((id) => ({ id })));
  fromFn.mockReturnValue({ where: whereFn });
  selectMock.mockReturnValue({ from: fromFn });
}

/**
 * Make `resolveRotationPickerSource` advance the LRU sizes accessor as
 * the real resolver would. Used by the tier-3 classification test.
 */
function resolverSideEffect(grow: 'positive' | 'negative' | 'none', returnValue: number | null): void {
  mockResolveRotationPickerSource.mockImplementationOnce(() => {
    if (grow === 'positive') {
      sizesRef.current = { ...sizesRef.current, positive: sizesRef.current.positive + 1 };
    } else if (grow === 'negative') {
      sizesRef.current = { ...sizesRef.current, negative: sizesRef.current.negative + 1 };
    }
    return Promise.resolve(returnValue === null ? null : source(returnValue));
  });
}

describe('rotation-tracks-cache-warm.service', () => {
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    selectMock.mockReset();
    mockResolveRotationPickerSource.mockReset();
    mockGetRotationTracksFromRelease.mockReset();
    mockGetRotationTracksFromRelease.mockResolvedValue([]);
    mockCaptureException.mockReset();
    sizesRef.current = { positive: 0, negative: 0 };
    releaseSizesRef.current = { positive: 0, negative: 0 };
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('warmRotationTracksCache', () => {
    test('visits every active rotation row in id order', async () => {
      mockActiveRotationRows([10, 20, 30]);
      mockResolveRotationPickerSource.mockResolvedValue(null);

      await warmRotationTracksCache();

      expect(mockResolveRotationPickerSource).toHaveBeenCalledTimes(3);
      expect(mockResolveRotationPickerSource).toHaveBeenNthCalledWith(1, 10);
      expect(mockResolveRotationPickerSource).toHaveBeenNthCalledWith(2, 20);
      expect(mockResolveRotationPickerSource).toHaveBeenNthCalledWith(3, 30);
    });

    test('summary counters: classifies tier-3 positive vs negative vs pre-resolved per row', async () => {
      // Row 10 — tier 1/2 hit (resolver returns id, LRU sizes unchanged).
      // Row 20 — tier-3 LML positive (LRU positive size grows by 1).
      // Row 30 — tier-3 LML negative (LRU negative size grows by 1).
      // Row 40 — tier 1/2 NULL (resolver returns null, LRU sizes unchanged).
      mockActiveRotationRows([10, 20, 30, 40]);
      resolverSideEffect('none', 12345);
      resolverSideEffect('positive', 4080);
      resolverSideEffect('negative', null);
      resolverSideEffect('none', null);

      const counters = await warmRotationTracksCache();

      expect(counters.scanned).toBe(4);
      expect(counters.preResolved).toBe(2);
      expect(counters.lmlPositive).toBe(1);
      expect(counters.lmlNegative).toBe(1);
      expect(counters.errors).toBe(0);
      expect(counters.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    test('warms the release-tracklist LRU for rows resolving via tier 1/2 (no inline tracklist)', async () => {
      mockActiveRotationRows([10, 20]);
      // Row 10: tier-1 hit (releaseId set, no inline tracklist) → must follow up.
      // Row 20: tier-3 inline (releaseId set, inline tracklist carried) → must NOT follow up.
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(4080));
      mockResolveRotationPickerSource.mockResolvedValueOnce(
        inlineSource(12345, [{ position: '1', title: 'T', duration: null, artists: ['A'] }])
      );

      await warmRotationTracksCache();

      expect(mockGetRotationTracksFromRelease).toHaveBeenCalledTimes(1);
      expect(mockGetRotationTracksFromRelease).toHaveBeenCalledWith(4080);
    });

    test('does not call getRotationTracksFromRelease when the resolver returns null', async () => {
      mockActiveRotationRows([10]);
      mockResolveRotationPickerSource.mockResolvedValue(null);

      await warmRotationTracksCache();

      expect(mockGetRotationTracksFromRelease).not.toHaveBeenCalled();
    });

    test('does not call getRotationTracksFromRelease when releaseId is the BS#1185 sentinel zero with inline tracklist', async () => {
      // MB-rescue rows carry releaseId=0 + inline tracklist; the picker
      // short-circuits on inline tracks, so the warmer must too — calling
      // getRotationTracksFromRelease(0) would 404 and waste a semaphore slot.
      mockActiveRotationRows([10]);
      mockResolveRotationPickerSource.mockResolvedValue(
        inlineSource(0, [{ position: '1', title: 'T', duration: null, artists: ['A'] }])
      );

      await warmRotationTracksCache();

      expect(mockGetRotationTracksFromRelease).not.toHaveBeenCalled();
    });

    test('release-tracklist warm counters: classifies positive vs negative cache additions per row', async () => {
      mockActiveRotationRows([10, 20, 30]);
      // Row 10: tier-1 hit, release-fetch warms positive LRU.
      // Row 20: tier-1 hit, release-fetch returns null (404), warms negative LRU.
      // Row 30: tier-3 inline, no release-fetch attempted.
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(4080));
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(9999999));
      mockResolveRotationPickerSource.mockResolvedValueOnce(
        inlineSource(12345, [{ position: '1', title: 'T', duration: null, artists: ['A'] }])
      );
      mockGetRotationTracksFromRelease.mockImplementationOnce(() => {
        releaseSizesRef.current = { ...releaseSizesRef.current, positive: releaseSizesRef.current.positive + 1 };
        return Promise.resolve([{ position: '1', title: 'T', duration: null, artists: ['A'] }]);
      });
      mockGetRotationTracksFromRelease.mockImplementationOnce(() => {
        releaseSizesRef.current = { ...releaseSizesRef.current, negative: releaseSizesRef.current.negative + 1 };
        return Promise.resolve(null);
      });

      const counters = await warmRotationTracksCache();

      expect(counters.releaseFetchPositive).toBe(1);
      expect(counters.releaseFetchNegative).toBe(1);
      expect(counters.releaseFetchErrors).toBe(0);
    });

    test('release-fetch failure is captured to Sentry but does not halt the walk', async () => {
      mockActiveRotationRows([10, 20]);
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(4080));
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(9999));
      mockGetRotationTracksFromRelease.mockRejectedValueOnce(new Error('LML 504'));
      mockGetRotationTracksFromRelease.mockResolvedValueOnce([]);

      const counters = await warmRotationTracksCache();

      expect(counters.scanned).toBe(2);
      expect(counters.releaseFetchErrors).toBe(1);
      expect(mockGetRotationTracksFromRelease).toHaveBeenCalledTimes(2);
      // Sentry capture carries the rotation_id + release_id context.
      const release_fetch_captures = mockCaptureException.mock.calls.filter(
        (call) => (call[1] as { tags?: Record<string, string> })?.tags?.phase === 'release_fetch'
      );
      expect(release_fetch_captures).toHaveLength(1);
      const [capturedErr, captureContext] = release_fetch_captures[0] as [
        Error,
        { tags?: Record<string, string>; extra?: Record<string, unknown> },
      ];
      expect(capturedErr.message).toBe('LML 504');
      expect(captureContext.tags?.subsystem).toBe('rotation-tracks-cache-warm');
      expect(captureContext.extra?.rotation_id).toBe(10);
      expect(captureContext.extra?.release_id).toBe(4080);
    });

    test('bails the loop and tallies budgetSkipped when the wall-clock budget elapses', async () => {
      // Hard cap is 30 min (1.8e6 ms). Drive Date.now so iteration 3 fires
      // after the cap; rows 1 and 2 should run, row 3 should be skipped.
      // Disable the cooperative-pause probe to keep the Date.now() sequence
      // simple — the pause path is exercised by dedicated tests below.
      mockActiveRotationRows([10, 20, 30]);
      mockResolveRotationPickerSource.mockResolvedValue(null);
      const BUDGET_MS = 30 * 60 * 1000;
      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValueOnce(0); // startTime
      dateSpy.mockReturnValueOnce(100); // row 10: within budget
      dateSpy.mockReturnValueOnce(200); // row 20: within budget
      dateSpy.mockReturnValueOnce(BUDGET_MS + 1); // row 30: over budget
      dateSpy.mockReturnValue(BUDGET_MS + 100); // elapsedMs computation

      const counters = await warmRotationTracksCache({ liveActivityLookbackSeconds: 0 });

      expect(counters.scanned).toBe(2);
      expect(counters.budgetSkipped).toBe(1);
      expect(mockResolveRotationPickerSource).toHaveBeenCalledTimes(2);

      dateSpy.mockRestore();
    });

    test('counts a cross-row release-fetch cache hit as releaseFetchAlreadyWarm', async () => {
      // Two rows share the same releaseId. The first warms the LRU; the
      // second's release-fetch returns the cached projection without
      // growing either LRU.
      mockActiveRotationRows([10, 20]);
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(4080));
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(4080));
      mockGetRotationTracksFromRelease.mockImplementationOnce(() => {
        releaseSizesRef.current = { ...releaseSizesRef.current, positive: releaseSizesRef.current.positive + 1 };
        return Promise.resolve([]);
      });
      // Second call: no size change (cache hit).
      mockGetRotationTracksFromRelease.mockResolvedValueOnce([]);

      const counters = await warmRotationTracksCache();

      expect(counters.releaseFetchPositive).toBe(1);
      expect(counters.releaseFetchAlreadyWarm).toBe(1);
      expect(counters.releaseFetchNegative).toBe(0);
    });

    test('does not halt when a single row throws — sibling rows still visited and captured to Sentry', async () => {
      mockActiveRotationRows([10, 20, 30]);
      mockResolveRotationPickerSource.mockResolvedValueOnce(source(123));
      mockResolveRotationPickerSource.mockRejectedValueOnce(new Error('LML timeout'));
      mockResolveRotationPickerSource.mockResolvedValueOnce(null);

      const counters = await warmRotationTracksCache();

      // Walk visited all three rows despite the middle row throwing.
      expect(mockResolveRotationPickerSource).toHaveBeenCalledTimes(3);
      expect(counters.scanned).toBe(3);
      expect(counters.errors).toBe(1);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [capturedErr, captureContext] = mockCaptureException.mock.calls[0] as [
        Error,
        { tags?: Record<string, string>; extra?: Record<string, unknown> },
      ];
      expect(capturedErr).toBeInstanceOf(Error);
      expect(capturedErr.message).toBe('LML timeout');
      expect(captureContext.tags?.subsystem).toBe('rotation-tracks-cache-warm');
      expect(captureContext.extra?.rotation_id).toBe(20);
    });

    test('emits a final summary log line carrying the expected counters', async () => {
      mockActiveRotationRows([10, 20]);
      resolverSideEffect('positive', 4080);
      resolverSideEffect('negative', null);

      await warmRotationTracksCache();

      // Final summary line is the last call to console.log emitted by the
      // walk. Match on the counter shape rather than exact text so a minor
      // copy edit doesn't break the assertion.
      const finalLog = consoleLogSpy.mock.calls
        .map((args) => args[0])
        .filter((line): line is string => typeof line === 'string')
        .reverse()
        .find((line) => line.includes('done:'));
      expect(finalLog).toBeDefined();
      expect(finalLog).toContain('scanned=2');
      expect(finalLog).toContain('lmlPositive=1');
      expect(finalLog).toContain('lmlNegative=1');
      expect(finalLog).toContain('errors=0');
      expect(finalLog).toMatch(/elapsedMs=\d+/);
    });

    test('zero active rows is a clean no-op (no resolver calls, no errors)', async () => {
      mockActiveRotationRows([]);

      const counters = await warmRotationTracksCache();

      expect(mockResolveRotationPickerSource).not.toHaveBeenCalled();
      expect(counters.scanned).toBe(0);
      expect(counters.errors).toBe(0);
    });

    test('cooperative pause: defers when checkLiveActivity returns true, resumes when it returns false', async () => {
      mockActiveRotationRows([10, 20]);
      mockResolveRotationPickerSource.mockResolvedValue(null);
      const probe = jest.fn<(s: number) => Promise<boolean>>();
      probe.mockResolvedValueOnce(true); // row 10: pause
      probe.mockResolvedValueOnce(false); // row 10: resume
      probe.mockResolvedValueOnce(false); // row 20: no pause

      const counters = await warmRotationTracksCache({
        checkLiveActivity: probe,
        liveActivityLookbackSeconds: 60,
        liveActivityPauseMs: 0,
      });

      expect(counters.scanned).toBe(2);
      expect(counters.liveActivityPauseCount).toBe(1);
      expect(mockResolveRotationPickerSource).toHaveBeenCalledTimes(2);
      expect(probe).toHaveBeenCalledTimes(3);
    });

    test('cooperative pause: lookback=0 disables probe entirely', async () => {
      mockActiveRotationRows([10]);
      mockResolveRotationPickerSource.mockResolvedValue(null);
      const probe = jest.fn<(s: number) => Promise<boolean>>().mockResolvedValue(true);

      const counters = await warmRotationTracksCache({
        checkLiveActivity: probe,
        liveActivityLookbackSeconds: 0,
        liveActivityPauseMs: 0,
      });

      expect(counters.scanned).toBe(1);
      expect(counters.liveActivityPauseCount).toBe(0);
      expect(probe).not.toHaveBeenCalled();
    });

    test('cooperative pause: row tallied as budgetSkipped (NOT scanned) when global budget elapses mid-pause', async () => {
      // The whole point of the pause is to NOT contend with LML while a DJ
      // is active. If the budget elapses while the walker is paused, the row
      // must be skipped — firing LML right after confirming the DJ is on
      // would defeat the pause's purpose. Pin that contract.
      mockActiveRotationRows([10]);
      mockResolveRotationPickerSource.mockResolvedValue(null);
      const BUDGET_MS = 30 * 60 * 1000;
      const probe = jest.fn<(s: number) => Promise<boolean>>().mockResolvedValue(true);
      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValueOnce(0); // startTime
      dateSpy.mockReturnValueOnce(0); // top-of-loop budget check (within)
      dateSpy.mockReturnValueOnce(0); // pauseLoopStart
      dateSpy.mockReturnValueOnce(BUDGET_MS + 1); // inside while: over budget → break
      dateSpy.mockReturnValue(BUDGET_MS + 100); // elapsedMs

      const counters = await warmRotationTracksCache({
        checkLiveActivity: probe,
        liveActivityLookbackSeconds: 60,
        liveActivityPauseMs: 0,
      });

      expect(counters.scanned).toBe(0);
      expect(counters.budgetSkipped).toBe(1);
      expect(mockResolveRotationPickerSource).not.toHaveBeenCalled();
      dateSpy.mockRestore();
    });

    test('cooperative pause: row tallied as budgetSkipped when per-row pause cap exceeded', async () => {
      // PER_ROW_PAUSE_BUDGET_MS (10 min) caps how long a single row can
      // pause before the walker yields to the next row. Without this, a
      // long continuous show could consume the whole 30-min global budget
      // on a single stuck row.
      mockActiveRotationRows([10, 20]);
      mockResolveRotationPickerSource.mockResolvedValue(null);
      const probe = jest
        .fn<(s: number) => Promise<boolean>>()
        .mockResolvedValueOnce(true) // row 10: stuck (probe returns true)
        .mockResolvedValue(false); // subsequent calls (row 20): clear
      const dateSpy = jest.spyOn(Date, 'now');
      dateSpy.mockReturnValueOnce(0); // startTime
      dateSpy.mockReturnValueOnce(0); // row 10: top-of-loop budget check
      dateSpy.mockReturnValueOnce(0); // row 10: pauseLoopStart
      // After probe returns true, inside the while body's two-arm check:
      dateSpy.mockReturnValueOnce(11 * 60 * 1000); // global budget check (within 30min)
      dateSpy.mockReturnValueOnce(11 * 60 * 1000); // per-row budget check (over 10min → break)
      // Row 20 follows:
      dateSpy.mockReturnValueOnce(11 * 60 * 1000); // row 20: top-of-loop
      dateSpy.mockReturnValueOnce(11 * 60 * 1000); // row 20: pauseLoopStart
      dateSpy.mockReturnValue(11 * 60 * 1000 + 100); // elapsedMs

      const counters = await warmRotationTracksCache({
        checkLiveActivity: probe,
        liveActivityLookbackSeconds: 60,
        liveActivityPauseMs: 0,
      });

      expect(counters.budgetSkipped).toBe(1); // row 10 capped
      expect(counters.scanned).toBe(1); // row 20 still runs
      dateSpy.mockRestore();
    });
  });

  describe('startRotationTracksCacheWarm', () => {
    test('returns synchronously and does not throw when the walk fails at the top level', async () => {
      // A DB outage at the SELECT step would reject before the per-row loop
      // even begins; the kick-off must catch it so a transient blip during
      // app boot can't crash the listen callback or emit an unhandled
      // rejection.
      const fromFn = jest.fn();
      const whereFn = jest.fn<() => Promise<Array<{ id: number }>>>().mockRejectedValue(new Error('db down'));
      fromFn.mockReturnValue({ where: whereFn });
      selectMock.mockReturnValue({ from: fromFn });

      expect(() => startRotationTracksCacheWarm()).not.toThrow();

      // Let the background promise settle so we can assert the catch arm
      // captured to Sentry.
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      const [capturedErr, captureContext] = mockCaptureException.mock.calls[0] as [
        Error,
        { tags?: Record<string, string> },
      ];
      expect(capturedErr.message).toBe('db down');
      expect(captureContext.tags?.subsystem).toBe('rotation-tracks-cache-warm');
    });
  });
});
