/**
 * Unit tests for the album_plays MV refresh service.
 *
 * Coverage:
 *   1. `refreshAlbumPlays` issues REFRESH on a dedicated client (not the
 *      shared API pool) and records last-run on the shared `db`.
 *   2. The dedicated client is built with the env-resolved
 *      `statement_timeout` override, `max: 1`, and a distinct
 *      `application_name`.
 *   3. `startAlbumPlaysRefresh` schedules a recurring timer.
 *   4. `stopAlbumPlaysRefresh` cancels the timer and tears down the
 *      dedicated client.
 *   5. A failed REFRESH does not stop the schedule.
 *
 * The shared `db` is mocked via `tests/mocks/database.mock.ts` (used for
 * the `cronjob_runs` upsert). The dedicated drizzle wrap of
 * `createPostgresClient` is mocked at the module boundary so we can
 * inspect the overrides passed to the factory.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Tagged-template `sql` mock: render the template plus any `sql.raw`
// inlines so tests can assert on the generated text.
jest.mock('drizzle-orm', () => {
  const renderTag = (strings: readonly string[], values: unknown[]): string =>
    strings
      .map((chunk, i) => {
        if (i >= values.length) return chunk;
        const v = values[i];
        const inlined = typeof v === 'object' && v !== null && '__raw' in v ? (v as { __raw: string }).__raw : '?';
        return `${chunk}${inlined}`;
      })
      .join('');
  const sqlMock = jest.fn((strings: readonly string[], ...values: unknown[]) => ({
    __sql: true,
    text: renderTag(strings, values),
  })) as jest.Mock & { raw: jest.Mock };
  sqlMock.raw = jest.fn((s: string) => ({ __raw: s }));
  return { sql: sqlMock };
});

// Dedicated drizzle client: mock the postgres-js drizzle wrapper so we
// can capture the REFRESH execute call separately from the shared `db`
// (which still gets the cronjob_runs upsert).
const dedicatedExecute = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
const dedicatedDrizzle = { execute: dedicatedExecute };
jest.mock('drizzle-orm/postgres-js', () => ({
  drizzle: jest.fn(() => dedicatedDrizzle),
}));

// `@wxyc/database`: the shared test mock provides `db`, `cronjob_runs`,
// `album_plays`. Augment with a stub `createPostgresClient` factory so
// we can inspect the overrides the service passes and observe pool
// teardown.
const fakePostgresClient = { end: jest.fn().mockResolvedValue(undefined) };
const createPostgresClient = jest.fn(() => fakePostgresClient);
jest.mock('@wxyc/database', () => {
  const actual = jest.requireActual('../../../tests/mocks/database.mock');
  return { ...actual, createPostgresClient };
});

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
const valuesMock = db._chain.values as unknown as MockedFn;
const onConflictMock = db._chain.onConflictDoUpdate as unknown as MockedFn;

describe('album-plays-refresh.service', () => {
  beforeEach(() => {
    insertMock.mockClear();
    valuesMock.mockClear();
    onConflictMock.mockClear();
    onConflictMock.mockResolvedValue(undefined);
    dedicatedExecute.mockClear();
    dedicatedExecute.mockResolvedValue([]);
    createPostgresClient.mockClear();
    fakePostgresClient.end.mockClear();
    delete process.env.ALBUM_PLAYS_REFRESH_TIMEOUT_MS;
    // Tear down before each test so the lazy-init re-runs cleanly.
    stopAlbumPlaysRefresh();
  });

  afterEach(() => {
    stopAlbumPlaysRefresh();
  });

  describe('refreshAlbumPlays', () => {
    test('issues REFRESH against the dedicated client and upserts cronjob_runs via shared db', async () => {
      await refreshAlbumPlays();

      expect(dedicatedExecute).toHaveBeenCalledTimes(1);
      const refreshSql = (dedicatedExecute.mock.calls[0]?.[0] as { text: string }).text;
      expect(refreshSql).toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY/i);

      // Last-run upsert goes through the shared `db` — that's the only
      // write the API pool needs to see and it's a millisecond write.
      expect(insertMock).toHaveBeenCalledTimes(1);
      const valuesArg = valuesMock.mock.calls[0]?.[0] as { job_name: string; last_run: Date };
      expect(valuesArg.job_name).toBe('album-plays-refresh');
      expect(valuesArg.last_run).toBeInstanceOf(Date);
      expect(onConflictMock).toHaveBeenCalledTimes(1);
    });

    test('builds the dedicated client with the env-resolved timeout, max=1, and a distinct application_name', async () => {
      await refreshAlbumPlays();
      expect(createPostgresClient).toHaveBeenCalledTimes(1);
      const overrides = createPostgresClient.mock.calls[0]?.[0] as {
        statementTimeoutMs: number;
        applicationName: string;
        max: number;
      };
      expect(overrides.statementTimeoutMs).toBe(__TEST_ONLY__.DEFAULT_REFRESH_TIMEOUT_MS);
      expect(overrides.applicationName).toBe(__TEST_ONLY__.APPLICATION_NAME);
      expect(overrides.max).toBe(1);
    });

    test('honors ALBUM_PLAYS_REFRESH_TIMEOUT_MS override', async () => {
      process.env.ALBUM_PLAYS_REFRESH_TIMEOUT_MS = '120000';
      await refreshAlbumPlays();
      const overrides = createPostgresClient.mock.calls[0]?.[0] as { statementTimeoutMs: number };
      expect(overrides.statementTimeoutMs).toBe(120000);
    });

    test('falls back to the default when env is non-numeric', async () => {
      process.env.ALBUM_PLAYS_REFRESH_TIMEOUT_MS = 'not-a-number';
      await refreshAlbumPlays();
      const overrides = createPostgresClient.mock.calls[0]?.[0] as { statementTimeoutMs: number };
      expect(overrides.statementTimeoutMs).toBe(__TEST_ONLY__.DEFAULT_REFRESH_TIMEOUT_MS);
    });

    test('reuses the dedicated client across refreshes', async () => {
      await refreshAlbumPlays();
      await refreshAlbumPlays();
      // Lazy-init should fire once; the second refresh reuses the
      // existing pool. Otherwise we'd churn a connection per refresh.
      expect(createPostgresClient).toHaveBeenCalledTimes(1);
      expect(dedicatedExecute).toHaveBeenCalledTimes(2);
    });

    test('propagates errors from the REFRESH so callers can decide what to do', async () => {
      dedicatedExecute.mockRejectedValueOnce(new Error('boom'));
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
      // No refresh yet — the migration populates the MV at creation time,
      // so no cold-start fire is needed.
      expect(dedicatedExecute).not.toHaveBeenCalled();
      // Lazy init shouldn't have fired either.
      expect(__TEST_ONLY__.hasDedicatedClient()).toBe(false);
    });

    test('start is idempotent — calling twice does not stack timers', () => {
      startAlbumPlaysRefresh(60_000);
      startAlbumPlaysRefresh(60_000);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('stopAlbumPlaysRefresh cancels the pending timer and ends the dedicated client', async () => {
      // Fire one refresh first so the dedicated client exists.
      await refreshAlbumPlays();
      expect(__TEST_ONLY__.hasDedicatedClient()).toBe(true);

      startAlbumPlaysRefresh(60_000);
      stopAlbumPlaysRefresh();

      expect(__TEST_ONLY__.hasPendingTimer()).toBe(false);
      expect(__TEST_ONLY__.hasDedicatedClient()).toBe(false);
      expect(fakePostgresClient.end).toHaveBeenCalledTimes(1);
    });

    test('refresh fires after the interval and self-reschedules', async () => {
      startAlbumPlaysRefresh(60_000);

      // advanceTimersByTimeAsync drains both timers and the awaited
      // microtasks inside the timer callback before resolving — needed
      // because the callback awaits the dedicated execute and the
      // cronjob upsert before reaching scheduleNext().
      await jest.advanceTimersByTimeAsync(60_000);

      expect(dedicatedExecute).toHaveBeenCalledTimes(1);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('a failing refresh does not stop the schedule', async () => {
      dedicatedExecute.mockRejectedValueOnce(new Error('lock contention'));
      startAlbumPlaysRefresh(60_000);

      await jest.advanceTimersByTimeAsync(60_000);

      // Next tick is still queued — transient failures recover on the
      // next cycle without operator action.
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });
  });
});
