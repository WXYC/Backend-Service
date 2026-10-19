/**
 * Unit tests for the cache-stats observability helper (BS#989 / G6).
 *
 * Coverage:
 *   1. `recordCacheLookup` aggregates hit/miss counts per cache name in
 *      process and writes one `cache.lookup` summary line per name per
 *      60 s interval (nothing in a quiet interval), plus a flush on
 *      `flushCacheLookups` / `stopPeriodicEmit` (graceful shutdown).
 *   2. `recordCacheEviction` + `emitPeriodicCacheStats` track capacity-driven
 *      evictions per cache name and log them (plus current size, as a gauge),
 *      resetting the counters after each emit.
 *   3. `startPeriodicEmit` / `stopPeriodicEmit` schedule and cancel the
 *      once-per-minute (default) recurring emit without double-registering
 *      a timer.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockLogCounter = jest.fn<(name: string, value: number, fields?: Record<string, unknown>) => void>();

jest.mock('@wxyc/observability', () =>
  jest
    .requireActual<typeof import('../../utils/observability')>('../../utils/observability')
    .mockObservabilityBarrel({ logCounter: mockLogCounter })
);

import {
  recordCacheLookup,
  flushCacheLookups,
  recordCacheEviction,
  emitPeriodicCacheStats,
  startPeriodicEmit,
  stopPeriodicEmit,
  __resetCacheStatsForTests,
  type RegisteredCache,
} from '../../../apps/backend/services/observability/cache-stats';

function fakeCache(size: number, max: number): { size: number; max: number } {
  return { size, max };
}

describe('cache-stats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetCacheStatsForTests();
  });

  afterEach(() => {
    stopPeriodicEmit();
    __resetCacheStatsForTests();
  });

  describe('recordCacheLookup (aggregated per interval)', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('writes nothing at lookup time', () => {
      recordCacheLookup('artwork', true, fakeCache(12, 200));
      recordCacheLookup('artwork', false, fakeCache(13, 200));

      expect(mockLogCounter).not.toHaveBeenCalled();
    });

    it('N lookups produce one cache.lookup summary line per cache name per 60s interval', () => {
      jest.useFakeTimers();
      for (let i = 0; i < 50; i += 1) {
        recordCacheLookup('artwork', i % 5 !== 0, fakeCache(100 + i, 200));
      }
      recordCacheLookup('metadata_album', false, fakeCache(0, 2000));
      recordCacheLookup('metadata_album', true, fakeCache(1, 2000));

      jest.advanceTimersByTime(59_999);
      expect(mockLogCounter).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(mockLogCounter).toHaveBeenCalledTimes(2);
      expect(mockLogCounter).toHaveBeenCalledWith('cache.lookup', 50, {
        cache_name: 'artwork',
        cache_hits: 40,
        cache_misses: 10,
        cache_size: 149,
        cache_capacity: 200,
      });
      expect(mockLogCounter).toHaveBeenCalledWith('cache.lookup', 2, {
        cache_name: 'metadata_album',
        cache_hits: 1,
        cache_misses: 1,
        cache_size: 1,
        cache_capacity: 2000,
      });
    });

    it('a quiet interval after a flush writes nothing', () => {
      jest.useFakeTimers();
      recordCacheLookup('tracklist', true, fakeCache(1, 500));
      jest.advanceTimersByTime(60_000);
      expect(mockLogCounter).toHaveBeenCalledTimes(1);

      mockLogCounter.mockClear();
      jest.advanceTimersByTime(5 * 60_000);
      expect(mockLogCounter).not.toHaveBeenCalled();
    });

    it('counts restart from zero in the interval after a flush', () => {
      jest.useFakeTimers();
      recordCacheLookup('tracklist', true, fakeCache(1, 500));
      jest.advanceTimersByTime(60_000);
      mockLogCounter.mockClear();

      recordCacheLookup('tracklist', false, fakeCache(2, 500));
      jest.advanceTimersByTime(60_000);
      expect(mockLogCounter.mock.calls).toEqual([
        [
          'cache.lookup',
          1,
          { cache_name: 'tracklist', cache_hits: 0, cache_misses: 1, cache_size: 2, cache_capacity: 500 },
        ],
      ]);
    });

    it('flushCacheLookups writes the pending summaries immediately and cancels the pending timer', () => {
      jest.useFakeTimers();
      recordCacheLookup('negative', false, fakeCache(3, 1000));

      flushCacheLookups();
      expect(mockLogCounter).toHaveBeenCalledTimes(1);

      mockLogCounter.mockClear();
      jest.advanceTimersByTime(60_000);
      expect(mockLogCounter).not.toHaveBeenCalled();
    });

    it('stopPeriodicEmit (graceful shutdown) flushes pending lookup summaries', () => {
      recordCacheLookup('spotify_track', true, fakeCache(4, 500));

      stopPeriodicEmit();

      expect(mockLogCounter).toHaveBeenCalledWith(
        'cache.lookup',
        1,
        expect.objectContaining({ cache_name: 'spotify_track', cache_hits: 1, cache_misses: 0 })
      );
    });

    it('schedules the flush timer with unref() so it never holds the process open', () => {
      const unref = jest.fn();
      const setTimeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);
      recordCacheLookup('artwork', true, fakeCache(1, 10));
      recordCacheLookup('artwork', true, fakeCache(1, 10));

      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(unref).toHaveBeenCalledTimes(1);
      setTimeoutSpy.mockRestore();
    });

    it.each([
      'artwork',
      'negative',
      'tracklist',
      'track_search',
      'metadata_album',
      'metadata_artist',
      'entity_resolve',
      'spotify_track',
    ] as const)('accepts the %s cache name', (name) => {
      recordCacheLookup(name, true, fakeCache(1, 10));
      flushCacheLookups();
      expect(mockLogCounter).toHaveBeenCalledWith('cache.lookup', 1, expect.objectContaining({ cache_name: name }));
    });
  });

  describe('recordCacheEviction + emitPeriodicCacheStats', () => {
    it('logs cache.<name>.evictions.count and cache.<name>.size for every registered cache', () => {
      recordCacheEviction('artwork');
      recordCacheEviction('artwork');
      recordCacheEviction('negative');

      const caches: RegisteredCache[] = [
        { name: 'artwork', cache: fakeCache(150, 200) },
        { name: 'negative', cache: fakeCache(999, 1000) },
        { name: 'tracklist', cache: fakeCache(3, 500) },
      ];
      emitPeriodicCacheStats(caches);

      expect(mockLogCounter.mock.calls).toEqual([
        ['cache.artwork.evictions.count', 2],
        ['cache.artwork.size', 150, { kind: 'gauge' }],
        ['cache.negative.evictions.count', 1],
        ['cache.negative.size', 999, { kind: 'gauge' }],
        ['cache.tracklist.evictions.count', 0],
        ['cache.tracklist.size', 3, { kind: 'gauge' }],
      ]);
    });

    it('resets eviction counters after each emit so the value reads as a rate, not a cumulative total', () => {
      recordCacheEviction('artwork');
      const caches: RegisteredCache[] = [{ name: 'artwork', cache: fakeCache(10, 200) }];

      emitPeriodicCacheStats(caches);
      expect(mockLogCounter).toHaveBeenCalledWith('cache.artwork.evictions.count', 1);

      mockLogCounter.mockClear();
      emitPeriodicCacheStats(caches);
      expect(mockLogCounter).toHaveBeenCalledWith('cache.artwork.evictions.count', 0);
    });
  });

  describe('startPeriodicEmit / stopPeriodicEmit', () => {
    it('schedules a recurring timer at the default 60s interval', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }]);

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      setIntervalSpy.mockRestore();
    });

    it('honors a custom interval override', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }], 5_000);

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
      setIntervalSpy.mockRestore();
    });

    it('does not start a second timer when called twice', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }]);
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }]);

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });

    it('fires emitPeriodicCacheStats on each tick', () => {
      jest.useFakeTimers();
      recordCacheEviction('artwork');
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }], 1_000);

      jest.advanceTimersByTime(1_000);

      expect(mockLogCounter.mock.calls).toEqual([
        ['cache.artwork.evictions.count', 1],
        ['cache.artwork.size', 1, { kind: 'gauge' }],
      ]);
      jest.useRealTimers();
    });

    it('stopPeriodicEmit cancels the timer so a subsequent tick never fires', () => {
      jest.useFakeTimers();
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }], 1_000);
      stopPeriodicEmit();
      mockLogCounter.mockClear();

      jest.advanceTimersByTime(5_000);

      expect(mockLogCounter).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('stopPeriodicEmit is a safe no-op when no timer is running', () => {
      expect(() => stopPeriodicEmit()).not.toThrow();
    });
  });
});
