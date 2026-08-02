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

const mockSpanSetAttributes = jest.fn();
const mockGetActiveSpan = jest.fn<() => { setAttributes: typeof mockSpanSetAttributes } | undefined>(() => ({
  setAttributes: mockSpanSetAttributes,
}));

const mockBackgroundSpanSetAttributes = jest.fn();
type MockBackgroundSpan = { setAttributes: (attrs: object) => void; isRecording: () => boolean };
const mockStartSpan = jest.fn((_opts: { name: string; op: string }, callback: (span: MockBackgroundSpan) => unknown) =>
  callback({ setAttributes: mockBackgroundSpanSetAttributes, isRecording: () => true })
);

jest.mock('@sentry/node', () => ({
  getActiveSpan: mockGetActiveSpan,
  startSpan: mockStartSpan,
}));

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
    mockGetActiveSpan.mockReturnValue({ setAttributes: mockSpanSetAttributes });
    // `clearAllMocks` resets call history but not a custom `mockImplementation`
    // installed by an earlier test (e.g. the "swallows Sentry.startSpan
    // throwing" case below) — reinstall the default pass-through explicitly
    // so tests stay isolated.
    mockStartSpan.mockImplementation((_opts, callback) =>
      callback({ setAttributes: mockBackgroundSpanSetAttributes, isRecording: () => true })
    );
    __resetCacheStatsForTests();
  });

  afterEach(() => {
    stopPeriodicEmit();
    __resetCacheStatsForTests();
  });

  describe('recordCacheLookup', () => {
    it('projects cache_hit=true, cache_name, cache_size, cache_capacity onto the active span on a hit', () => {
      recordCacheLookup('artwork', true, fakeCache(12, 200));

      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
        cache_hit: true,
        cache_name: 'artwork',
        cache_size: 12,
        cache_capacity: 200,
      });
    });

    it('projects cache_hit=false on a miss', () => {
      recordCacheLookup('metadata_album', false, fakeCache(0, 2000));

      expect(mockSpanSetAttributes).toHaveBeenCalledWith({
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
      expect(mockSpanSetAttributes).toHaveBeenCalledWith(expect.objectContaining({ cache_name: name }));
    });

    it('is a no-op when there is no active span', () => {
      mockGetActiveSpan.mockReturnValue(undefined);
      expect(() => recordCacheLookup('artwork', true, fakeCache(1, 10))).not.toThrow();
    });

    it('swallows and logs an error instead of throwing when the Sentry SDK throws', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockSpanSetAttributes.mockImplementation(() => {
        throw new Error('Sentry SDK exploded');
      });

      expect(() => recordCacheLookup('artwork', true, fakeCache(1, 10))).not.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[CacheStats]'), expect.any(Error));

      consoleWarnSpy.mockRestore();
    });
  });

  describe('recordCacheEviction + emitPeriodicCacheStats', () => {
    it('projects cache.<name>.evictions.count and cache.<name>.size for every registered cache', () => {
      recordCacheEviction('artwork');
      recordCacheEviction('artwork');
      recordCacheEviction('negative');

      const caches: RegisteredCache[] = [
        { name: 'artwork', cache: fakeCache(150, 200) },
        { name: 'negative', cache: fakeCache(999, 1000) },
        { name: 'tracklist', cache: fakeCache(3, 500) },
      ];
      emitPeriodicCacheStats(caches);

      expect(mockStartSpan).toHaveBeenCalledWith(
        expect.objectContaining({ op: 'BackgroundJob' }),
        expect.any(Function)
      );
      expect(mockBackgroundSpanSetAttributes).toHaveBeenCalledWith({
        'cache.artwork.evictions.count': 2,
        'cache.artwork.size': 150,
        'cache.negative.evictions.count': 1,
        'cache.negative.size': 999,
        'cache.tracklist.evictions.count': 0,
        'cache.tracklist.size': 3,
      });
    });

    it('resets eviction counters after each emit so the value reads as a rate, not a cumulative total', () => {
      recordCacheEviction('artwork');
      const caches: RegisteredCache[] = [{ name: 'artwork', cache: fakeCache(10, 200) }];

      emitPeriodicCacheStats(caches);
      expect(mockBackgroundSpanSetAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'cache.artwork.evictions.count': 1 })
      );

      mockBackgroundSpanSetAttributes.mockClear();
      emitPeriodicCacheStats(caches);
      expect(mockBackgroundSpanSetAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'cache.artwork.evictions.count': 0 })
      );
    });

    it('keeps eviction counts when the span is not recording, so an unsampled emit does not drop them', () => {
      recordCacheEviction('artwork');
      const caches: RegisteredCache[] = [{ name: 'artwork', cache: fakeCache(10, 200) }];

      // First emit lands on an unsampled (non-recording) BackgroundJob span:
      // setAttributes is a no-op, so the reset must be skipped or the single
      // eviction is lost forever between emits.
      mockStartSpan.mockImplementationOnce((_opts, callback) =>
        callback({ setAttributes: mockBackgroundSpanSetAttributes, isRecording: () => false })
      );
      emitPeriodicCacheStats(caches);

      // Next emit is recorded and must still see the carried-over eviction.
      emitPeriodicCacheStats(caches);
      expect(mockBackgroundSpanSetAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'cache.artwork.evictions.count': 1 })
      );
    });

    it('reports zero evictions for a cache that has never evicted', () => {
      const caches: RegisteredCache[] = [{ name: 'spotify_track', cache: fakeCache(0, 2000) }];
      emitPeriodicCacheStats(caches);

      expect(mockBackgroundSpanSetAttributes).toHaveBeenCalledWith({
        'cache.spotify_track.evictions.count': 0,
        'cache.spotify_track.size': 0,
      });
    });

    it('swallows and logs an error instead of throwing when Sentry.startSpan throws', () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockStartSpan.mockImplementation(() => {
        throw new Error('Sentry SDK exploded');
      });

      expect(() => emitPeriodicCacheStats([{ name: 'artwork', cache: fakeCache(1, 10) }])).not.toThrow();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[CacheStats]'), expect.any(Error));

      consoleWarnSpy.mockRestore();
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

      expect(mockBackgroundSpanSetAttributes).toHaveBeenCalledWith({
        'cache.artwork.evictions.count': 1,
        'cache.artwork.size': 1,
      });
      jest.useRealTimers();
    });

    it('stopPeriodicEmit cancels the timer so a subsequent tick never fires', () => {
      jest.useFakeTimers();
      startPeriodicEmit([{ name: 'artwork', cache: fakeCache(1, 10) }], 1_000);
      stopPeriodicEmit();
      mockBackgroundSpanSetAttributes.mockClear();

      jest.advanceTimersByTime(5_000);

      expect(mockBackgroundSpanSetAttributes).not.toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('stopPeriodicEmit is a safe no-op when no timer is running', () => {
      expect(() => stopPeriodicEmit()).not.toThrow();
    });
  });
});
