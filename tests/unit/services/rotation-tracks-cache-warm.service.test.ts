/**
 * Unit tests for the rotation-tracks picker LRU warm pass (BS#998).
 *
 * Coverage:
 *  1. The walk fetches active rotation rows (kill_date IS NULL OR > today),
 *     calls `getDiscogsReleaseIdByRotationId` for each, and emits a final
 *     summary log line with the expected counters.
 *  2. A single row's failure is captured to Sentry and does not halt the
 *     walk; subsequent rows are still visited.
 *  3. The counter classification works: tier-3 positive vs negative cache
 *     additions are correctly tallied via the LRU-sizes delta.
 *  4. `startRotationTracksCacheWarm` is fire-and-forget: a thrown error in
 *     the top-level walk is caught and Sentry-captured rather than escaping
 *     to the caller (which would be `app.listen`'s callback).
 *
 * The shared `db` and `getDiscogsReleaseIdByRotationId` (via library.service)
 * are mocked. We hold the LRU-sizes accessor stub so we can simulate
 * positive/negative cache growth.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '../../mocks/database.mock';

// `library.service` exposes both the picker resolver we drive end-to-end
// and the LRU-sizes accessor we read for the counter classifier. Mock at
// the module boundary so the warm service receives our test doubles.
const mockGetDiscogsReleaseIdByRotationId = jest.fn<(id: number) => Promise<number | null>>();
type Sizes = { positive: number; negative: number };
const sizesRef: { current: Sizes } = { current: { positive: 0, negative: 0 } };
const mockRotationLmlCacheSizesForWarm = jest.fn<() => Sizes>(() => sizesRef.current);

jest.mock('../../../apps/backend/services/library.service', () => ({
  getDiscogsReleaseIdByRotationId: mockGetDiscogsReleaseIdByRotationId,
  __rotationLmlCacheSizesForWarm: mockRotationLmlCacheSizesForWarm,
}));

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
 * Make `getDiscogsReleaseIdByRotationId` advance the LRU sizes accessor as
 * the real resolver would. Used by the tier-3 classification test.
 */
function resolverSideEffect(grow: 'positive' | 'negative' | 'none', returnValue: number | null): void {
  mockGetDiscogsReleaseIdByRotationId.mockImplementationOnce(() => {
    if (grow === 'positive') {
      sizesRef.current = { ...sizesRef.current, positive: sizesRef.current.positive + 1 };
    } else if (grow === 'negative') {
      sizesRef.current = { ...sizesRef.current, negative: sizesRef.current.negative + 1 };
    }
    return Promise.resolve(returnValue);
  });
}

describe('rotation-tracks-cache-warm.service', () => {
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let consoleWarnSpy: jest.SpiedFunction<typeof console.warn>;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    selectMock.mockReset();
    mockGetDiscogsReleaseIdByRotationId.mockReset();
    mockCaptureException.mockReset();
    sizesRef.current = { positive: 0, negative: 0 };
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
      mockGetDiscogsReleaseIdByRotationId.mockResolvedValue(null);

      await warmRotationTracksCache();

      expect(mockGetDiscogsReleaseIdByRotationId).toHaveBeenCalledTimes(3);
      expect(mockGetDiscogsReleaseIdByRotationId).toHaveBeenNthCalledWith(1, 10);
      expect(mockGetDiscogsReleaseIdByRotationId).toHaveBeenNthCalledWith(2, 20);
      expect(mockGetDiscogsReleaseIdByRotationId).toHaveBeenNthCalledWith(3, 30);
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

    test('does not halt when a single row throws — sibling rows still visited and captured to Sentry', async () => {
      mockActiveRotationRows([10, 20, 30]);
      mockGetDiscogsReleaseIdByRotationId.mockResolvedValueOnce(123);
      mockGetDiscogsReleaseIdByRotationId.mockRejectedValueOnce(new Error('LML timeout'));
      mockGetDiscogsReleaseIdByRotationId.mockResolvedValueOnce(null);

      const counters = await warmRotationTracksCache();

      // Walk visited all three rows despite the middle row throwing.
      expect(mockGetDiscogsReleaseIdByRotationId).toHaveBeenCalledTimes(3);
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

      expect(mockGetDiscogsReleaseIdByRotationId).not.toHaveBeenCalled();
      expect(counters.scanned).toBe(0);
      expect(counters.errors).toBe(0);
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
