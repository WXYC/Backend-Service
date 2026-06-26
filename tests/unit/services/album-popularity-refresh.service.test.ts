/**
 * Unit tests for the album_popularity refresh service (BS#1486 Track 2 / #1492).
 *
 * Two layers:
 *   1. Pure core — `freetextLogicalKey` + `aggregateFreetextPlays` — exercised
 *      against the REAL `freetextPairKey` normalizers (the parity contract with
 *      Track 1's persisted keys). No DB needed.
 *   2. Lifecycle + dedicated-client wiring — mirrors album-plays-refresh: the
 *      rebuild runs in a transaction on a dedicated `max:1` client with the
 *      env-resolved statement_timeout; last-run is recorded on the shared db;
 *      a failed rebuild does not stop the schedule.
 *
 * The full SQL rebuild semantics (master collapse, free-text fold-in) are
 * covered by the pg integration spec `album-popularity-refresh.spec.js`.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

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

// Dedicated drizzle client: stub `transaction` so we can drive the rebuild
// without a database. The callback receives a `tx` with `execute` (the reads +
// DELETE + linked INSERT) and the insert chain (free-text UPSERT).
const txExecute = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
const txOnConflict = jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
const txValues = jest.fn(() => ({ onConflictDoUpdate: txOnConflict }));
const txInsert = jest.fn(() => ({ values: txValues }));
const txStub = { execute: txExecute, insert: txInsert };
const dedicatedTransaction = jest.fn(async (cb: (tx: typeof txStub) => Promise<unknown>) => cb(txStub));
const dedicatedDrizzle = { transaction: dedicatedTransaction };
jest.mock('drizzle-orm/postgres-js', () => ({
  drizzle: jest.fn(() => dedicatedDrizzle),
}));

const fakePostgresClient = { end: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined) };
const createPostgresClient = jest.fn(() => fakePostgresClient);
jest.mock('@wxyc/database', () => {
  // The database mock re-exports the REAL `freetextPairKey` (pure, no DB), so
  // the free-text leg exercises the true normalization — the parity contract
  // with Track 1's persisted keys.
  const actual = jest.requireActual('../../../tests/mocks/database.mock');
  return { ...actual, createPostgresClient };
});

jest.spyOn(console, 'error').mockImplementation(() => {});

import {
  refreshAlbumPopularity,
  startAlbumPopularityRefresh,
  stopAlbumPopularityRefresh,
  freetextLogicalKey,
  aggregateFreetextPlays,
  __TEST_ONLY__,
  type ResolutionRow,
  type RawFreetextPlays,
} from '../../../apps/backend/services/album-popularity-refresh.service';
import { db } from '../../../tests/mocks/database.mock';

type MockedFn = jest.Mock<(...args: unknown[]) => unknown>;
const insertMock = db.insert as unknown as MockedFn;
const valuesMock = db._chain.values as unknown as MockedFn;
const onConflictMock = db._chain.onConflictDoUpdate as unknown as MockedFn;

describe('album-popularity-refresh: pure core', () => {
  describe('freetextLogicalKey', () => {
    test('master wins over release (so pressings fold into the master)', () => {
      expect(freetextLogicalKey({ discogs_master_id: 14, discogs_release_id: 99 })).toBe('master:14');
    });
    test('release is the fallback when there is no master', () => {
      expect(freetextLogicalKey({ discogs_master_id: null, discogs_release_id: 50 })).toBe('release:50');
    });
    test('no-match (both null) is unattributable', () => {
      expect(freetextLogicalKey({ discogs_master_id: null, discogs_release_id: null })).toBeNull();
    });
  });

  describe('aggregateFreetextPlays', () => {
    const resolutions: ResolutionRow[] = [
      { norm_artist: 'j dilla', norm_album: 'donuts', discogs_master_id: 14, discogs_release_id: 99 },
      { norm_artist: 'beach boys', norm_album: 'pet sounds', discogs_master_id: null, discogs_release_id: 50 },
      // No-match row: contributes nothing even if raw plays normalize to it.
      { norm_artist: 'unknown', norm_album: 'mystery', discogs_master_id: null, discogs_release_id: null },
    ];

    test('sums plays across whitespace + edition variants under one logical key', () => {
      const raw: RawFreetextPlays[] = [
        { artist_name: 'J Dilla', album_title: 'Donuts', plays: 3 },
        { artist_name: 'J  Dilla ', album_title: 'Donuts (Remastered)', plays: 2 },
      ];
      const out = aggregateFreetextPlays(resolutions, raw);
      expect(out.get('master:14')).toBe(5);
      expect(out.size).toBe(1);
    });

    test('uses the release fallback key when the resolution has no master', () => {
      const raw: RawFreetextPlays[] = [{ artist_name: 'The Beach Boys', album_title: 'Pet Sounds', plays: 7 }];
      const out = aggregateFreetextPlays(resolutions, raw);
      expect(out.get('release:50')).toBe(7);
    });

    test('drops raw pairs with no resolved match, and no-match resolutions', () => {
      const raw: RawFreetextPlays[] = [
        { artist_name: 'Nobody', album_title: 'Nothing', plays: 9 }, // unresolved
        { artist_name: 'Unknown', album_title: 'Mystery', plays: 4 }, // resolution is no-match
      ];
      const out = aggregateFreetextPlays(resolutions, raw);
      expect(out.size).toBe(0);
    });
  });
});

describe('album-popularity-refresh: lifecycle', () => {
  beforeEach(() => {
    insertMock.mockClear();
    valuesMock.mockClear();
    onConflictMock.mockClear();
    onConflictMock.mockResolvedValue(undefined);
    txExecute.mockClear();
    txExecute.mockResolvedValue([]);
    dedicatedTransaction.mockClear();
    createPostgresClient.mockClear();
    fakePostgresClient.end.mockClear();
    delete process.env.ALBUM_POPULARITY_REFRESH_TIMEOUT_MS;
    stopAlbumPopularityRefresh();
  });

  afterEach(() => {
    stopAlbumPopularityRefresh();
  });

  test('rebuild runs inside a transaction on the dedicated client and records last-run on shared db', async () => {
    await refreshAlbumPopularity();
    expect(dedicatedTransaction).toHaveBeenCalledTimes(1);
    // DELETE + linked INSERT + the two free-text reads all go through tx.execute.
    expect(txExecute).toHaveBeenCalled();
    const deleteIssued = txExecute.mock.calls.some((c) => /DELETE FROM/i.test((c[0] as { text: string }).text));
    expect(deleteIssued).toBe(true);

    expect(insertMock).toHaveBeenCalledTimes(1);
    const valuesArg = valuesMock.mock.calls[0]?.[0] as { job_name: string; last_run: Date };
    expect(valuesArg.job_name).toBe('album-popularity-refresh');
    expect(valuesArg.last_run).toBeInstanceOf(Date);
    expect(onConflictMock).toHaveBeenCalledTimes(1);
  });

  test('builds the dedicated client with env-resolved timeout, max=1, distinct application_name', async () => {
    await refreshAlbumPopularity();
    const overrides = createPostgresClient.mock.calls[0]?.[0] as {
      statementTimeoutMs: number;
      applicationName: string;
      max: number;
    };
    expect(overrides.statementTimeoutMs).toBe(__TEST_ONLY__.DEFAULT_REFRESH_TIMEOUT_MS);
    expect(overrides.applicationName).toBe(__TEST_ONLY__.APPLICATION_NAME);
    expect(overrides.max).toBe(1);
  });

  test('honors ALBUM_POPULARITY_REFRESH_TIMEOUT_MS override', async () => {
    process.env.ALBUM_POPULARITY_REFRESH_TIMEOUT_MS = '120000';
    await refreshAlbumPopularity();
    const overrides = createPostgresClient.mock.calls[0]?.[0] as { statementTimeoutMs: number };
    expect(overrides.statementTimeoutMs).toBe(120000);
  });

  test('reuses the dedicated client across refreshes', async () => {
    await refreshAlbumPopularity();
    await refreshAlbumPopularity();
    expect(createPostgresClient).toHaveBeenCalledTimes(1);
    expect(dedicatedTransaction).toHaveBeenCalledTimes(2);
  });

  test('does not record last-run when the rebuild fails, and propagates the error', async () => {
    txExecute.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshAlbumPopularity()).rejects.toThrow('boom');
    expect(insertMock).not.toHaveBeenCalled();
  });

  describe('timer scheduling', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
    });

    test('schedules the first refresh one interval out (no immediate fire)', () => {
      startAlbumPopularityRefresh(60_000);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
      expect(dedicatedTransaction).not.toHaveBeenCalled();
      expect(__TEST_ONLY__.hasDedicatedClient()).toBe(false);
    });

    test('start is idempotent', () => {
      startAlbumPopularityRefresh(60_000);
      startAlbumPopularityRefresh(60_000);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('refresh fires after the interval and self-reschedules', async () => {
      startAlbumPopularityRefresh(60_000);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(dedicatedTransaction).toHaveBeenCalledTimes(1);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('a failing refresh does not stop the schedule', async () => {
      txExecute.mockRejectedValueOnce(new Error('lock contention'));
      startAlbumPopularityRefresh(60_000);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(true);
    });

    test('stop cancels the timer and tears down the dedicated client', async () => {
      await refreshAlbumPopularity();
      expect(__TEST_ONLY__.hasDedicatedClient()).toBe(true);
      startAlbumPopularityRefresh(60_000);
      stopAlbumPopularityRefresh();
      expect(__TEST_ONLY__.hasPendingTimer()).toBe(false);
      expect(__TEST_ONLY__.hasDedicatedClient()).toBe(false);
      expect(fakePostgresClient.end).toHaveBeenCalledTimes(1);
    });
  });
});
