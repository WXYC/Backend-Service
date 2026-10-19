/**
 * Unit tests for the cache-stats observability helper (BS#989 / G6).
 *
 * Coverage:
 *   1. `recordCacheLookup` projects `cache_hit` / `cache_name` / `cache_size`
 *      / `cache_capacity` onto the active Sentry span on both hit and miss,
 *      and is a safe no-op when there is no active span or the SDK throws.
 *   2. `recordCacheEviction` + `emitPeriodicCacheStats` track capacity-driven
 *      evictions per cache name and project them (plus current size) onto a
 *      "BackgroundJob"-op span, resetting the counters after each emit.
 *   3. `startPeriodicEmit` / `stopPeriodicEmit` schedule and cancel the
 *      once-per-minute (default) recurring emit without double-registering
 *      a timer.
 *
 * Mirrors the LML#213 cache_stats pattern (wrap-at-chokepoint +
 * project-onto-span) and this repo's existing Sentry-mock idiom (see
 * `tests/unit/controllers/proxy.controller.test.ts`).
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

const mockLogCounter = jest.fn<(name: string, value: number, fields?: Record<string, unknown>) => void>();

jest.mock('@wxyc/observability', () => ({ logCounter: mockLogCounter }));

import {
  recordCacheLookup,
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

  describe('recordCacheLookup', () => {
    it('logs cache.lookup with cache_hit=true, cache_name, cache_size, cache_capacity on a hit', () => {
      recordCacheLookup('artwork', true, fakeCache(12, 200));

      expect(mockLogCounter).toHaveBeenCalledWith('cache.lookup', 1, {
        cache_hit: true,
        cache_name: 'artwork',
        cache_size: 12,
        cache_capacity: 200,
      });
    });

    it('logs cache_hit=false on a miss', () => {
      recordCacheLookup('metadata_album', false, fakeCache(0, 2000));

      expect(mockLogCounter).toHaveBeenCalledWith('cache.lookup', 1, {
        cache_hit: false,
        cache_name: 'metadata_album',
        cache_size: 0,
        cache_capacity: 2000,
      });
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
        ['cache.artwork.size', 150],
        ['cache.negative.evictions.count', 1],
        ['cache.negative.size', 999],
        ['cache.tracklist.evictions.count', 0],
        ['cache.tracklist.size', 3],
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
        ['cache.artwork.size', 1],
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
