/**
 * Unit tests for the album_plays MV refresh service.
 *
 * The DB is mocked via `tests/mocks/database.mock.ts`. Tests verify:
 *   1. `refreshAlbumPlays` issues the REFRESH and records last-run.
 *   2. `startAlbumPlaysRefresh` schedules a recurring timer.
 *   3. `stopAlbumPlaysRefresh` cancels the timer.
 *   4. A failed refresh does not stop the schedule.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// drizzle-orm: only `sql` is referenced by the service. We need the tag
// function to be callable but we don't inspect the result.
jest.mock('drizzle-orm', () => ({
  sql: Object.assign(
    jest.fn((..._args: unknown[]) => ({ __sql: true })),
    { raw: jest.fn() }
  ),
}));

// Suppress error logging from the deliberate failure test.
jest.spyOn(console, 'error').mockImplementation(() => {});

import {
  refreshAlbumPlays,
  startAlbumPlaysRefresh,
  stopAlbumPlaysRefresh,
  __TEST_ONLY__,
} from '../../../apps/backend/services/album-plays-refresh.service';
import { db } from '../../../tests/mocks/database.mock';

type MockedFn = jest.Mock<(...args: unknown[]) => unknown>;

const insertMock = db.insert as unknown as MockedFn;
const executeMock = db.execute as unknown as MockedFn;
const valuesMock = db._chain.values as unknown as MockedFn;
const onConflictMock = db._chain.onConflictDoUpdate as unknown as MockedFn;

describe('album-plays-refresh.service', () => {
  beforeEach(() => {
    insertMock.mockClear();
    executeMock.mockClear();
    valuesMock.mockClear();
    onConflictMock.mockClear();
    executeMock.mockResolvedValue([]);
    onConflictMock.mockResolvedValue(undefined);
    stopAlbumPlaysRefresh();
  });

  afterEach(() => {
    stopAlbumPlaysRefresh();
  });

  describe('refreshAlbumPlays', () => {
    test('issues REFRESH MATERIALIZED VIEW CONCURRENTLY and upserts cronjob_runs', async () => {
      await refreshAlbumPlays();

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(insertMock).toHaveBeenCalledTimes(1);
      // Upsert into cronjob_runs with the canonical job name. Both the
      // job-name string and the upsert shape are part of the contract
      // shared with `getLastRunTimestamp`.
      const valuesArg = valuesMock.mock.calls[0]?.[0] as { job_name: string; last_run: Date };
      expect(valuesArg.job_name).toBe('album-plays-refresh');
      expect(valuesArg.last_run).toBeInstanceOf(Date);
      expect(onConflictMock).toHaveBeenCalledTimes(1);
    });

    test('propagates errors from the REFRESH so callers can decide what to do', async () => {
      executeMock.mockRejectedValueOnce(new Error('boom'));
      await expect(refreshAlbumPlays()).rejects.toThrow('boom');
      // Last-run is intentionally NOT recorded on failure — operators
      // looking at cronjob_runs should see the last *successful* run,
      // matching the ETL pattern.
      expect(insertMock).not.toHaveBeenCalled();
    });
  });

  describe('startAlbumPlaysRefresh / stopAlbumPlaysRefresh', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test('schedules the first refresh one interval out (no immediate fire)', () => {
      startAlbumPlaysRefresh(60_000);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
      // No refresh has happened yet — the migration populates the MV at
      // creation time, so no cold-start fire is needed.
      expect(executeMock).not.toHaveBeenCalled();
    });

    test('start is idempotent — calling twice does not stack timers', () => {
      startAlbumPlaysRefresh(60_000);
      startAlbumPlaysRefresh(60_000);
      // Second call is a no-op while a timer is already pending.
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('stopAlbumPlaysRefresh cancels the pending timer', () => {
      startAlbumPlaysRefresh(60_000);
      stopAlbumPlaysRefresh();
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(false);
    });

    test('refresh fires after the interval and self-reschedules', async () => {
      startAlbumPlaysRefresh(60_000);

      // advanceTimersByTimeAsync drains both timers and the awaited
      // microtasks inside the timer callback before resolving — needed
      // because the callback awaits db.execute and the cronjob upsert
      // before reaching scheduleNext().
      await jest.advanceTimersByTimeAsync(60_000);

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('a failing refresh does not stop the schedule', async () => {
      executeMock.mockRejectedValueOnce(new Error('lock contention'));
      startAlbumPlaysRefresh(60_000);

      await jest.advanceTimersByTimeAsync(60_000);

      // Next tick is still queued — transient failures (e.g. another
      // concurrent refresh, lock contention) recover automatically.
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });
  });
});
