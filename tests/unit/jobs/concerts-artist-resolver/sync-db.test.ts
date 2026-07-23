/**
 * Unit tests for jobs/concerts-artist-resolver sync-db.ts (BS#1760).
 *
 * `loadSyncCandidates` issues two independent SELECTs (upcoming
 * non-tombstoned concerts + their existing role='support' junction rows)
 * and zips them client-side into `SyncCandidate[]`. Both SELECTs must
 * independently filter `concerts.removed_at IS NULL` and the upcoming
 * window — per the BS#1760 issue, the junction row alone doesn't carry
 * its parent concert's tombstone.
 *
 * `applySyncDiff` issues up to three guarded Drizzle-typed-builder calls
 * (insert new / untombstone reappeared / tombstone dropped), each
 * skipped entirely when its bucket is empty.
 *
 * SQL-shape assertions reuse the same best-effort `renderSql` helper as
 * query.test.ts / targets.test.ts; guard-clause assertions on the
 * Drizzle builder use `util.inspect` over the mocked `where` AST, per
 * targets.test.ts's convention.
 */
import { jest } from '@jest/globals';
import { inspect } from 'util';

import { db } from '../../../mocks/database.mock';
import { loadSyncCandidates, applySyncDiff } from '../../../../jobs/concerts-artist-resolver/sync-db';

type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<unknown>;
  value?: string | string[];
  raw?: string;
};

const PARAM_PLACEHOLDER = '<?>';

/** Best-effort drizzle-SQL renderer; see query.test.ts for the full contract. */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return PARAM_PLACEHOLDER;
  }
  const obj = value as SqlLike;
  if (Array.isArray(obj.sql) && Array.isArray(obj.values)) {
    const fragments = obj.sql;
    const values = obj.values;
    const parts: string[] = [];
    fragments.forEach((fragment, i) => {
      parts.push(fragment);
      if (i < values.length) {
        parts.push(renderSql(values[i]));
      }
    });
    return parts.join('');
  }
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks.map((chunk) => renderSql(chunk)).join('');
  }
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.value)) return obj.value.join('');
  if (typeof obj.value === 'string') return PARAM_PLACEHOLDER;
  return '';
};

beforeEach(() => {
  db.execute.mockReset();
  db._chain.insert.mockClear();
  db._chain.values.mockClear();
  db._chain.update.mockClear();
  db._chain.set.mockClear();
  db._chain.where.mockClear();
  db._chain.onConflictDoNothing.mockClear();
  db._chain.returning.mockReset();
  (db.transaction as jest.Mock).mockClear();
});

describe('loadSyncCandidates', () => {
  test('both SELECTs independently filter the tombstone + upcoming window', async () => {
    db.execute.mockResolvedValueOnce([{ concert_id: 1, supporting_artists_raw: [] }]).mockResolvedValueOnce([]);

    await loadSyncCandidates();

    expect(db.execute).toHaveBeenCalledTimes(2);
    const concertsSql = renderSql(db.execute.mock.calls[0][0]);
    expect(concertsSql).toContain('"removed_at" IS NULL');
    expect(concertsSql).toContain(`"starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`);

    const existingSql = renderSql(db.execute.mock.calls[1][0]);
    expect(existingSql).toContain(`"role" = 'support'`);
    // Independently filtered — not just an implicit join off query 1's ids.
    expect(existingSql).toContain('"removed_at" IS NULL');
    expect(existingSql).toContain(`"starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`);
  });

  test('zips concerts with their existing junction rows by concert_id', async () => {
    db.execute
      .mockResolvedValueOnce([
        { concert_id: 1, supporting_artists_raw: ['Sluice'] },
        { concert_id: 2, supporting_artists_raw: [] },
      ])
      .mockResolvedValueOnce([
        { concert_id: 1, raw_name: 'Sluice', removed_at: null },
        { concert_id: 1, raw_name: 'Old Act', removed_at: '2026-01-01T00:00:00Z' },
      ]);

    const rows = await loadSyncCandidates();

    expect(rows).toEqual([
      {
        concert_id: 1,
        supporting_artists_raw: ['Sluice'],
        existing: [
          { raw_name: 'Sluice', removed_at: null },
          { raw_name: 'Old Act', removed_at: '2026-01-01T00:00:00Z' },
        ],
      },
      { concert_id: 2, supporting_artists_raw: [], existing: [] },
    ]);
  });

  test('an unrecognized db.execute result shape fails LOUD, not as a zero-work run', async () => {
    db.execute.mockResolvedValueOnce({ weird: true });
    await expect(loadSyncCandidates()).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });
});

describe('applySyncDiff', () => {
  test('empty diff issues zero writer calls', async () => {
    const outcome = await applySyncDiff(1, { to_insert: [], to_untombstone: [], to_tombstone: [] });

    expect(db._chain.insert).not.toHaveBeenCalled();
    expect(db._chain.update).not.toHaveBeenCalled();
    expect(outcome).toEqual({ inserted: 0, untombstoned: 0, tombstoned: 0 });
  });

  test('to_insert only: one INSERT with ON CONFLICT DO NOTHING on the (concert_id, role, raw_name) target', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 101 }]);

    const outcome = await applySyncDiff(7, { to_insert: ['Squirrel Flower'], to_untombstone: [], to_tombstone: [] });

    expect(db._chain.insert).toHaveBeenCalledTimes(1);
    expect(db._chain.update).not.toHaveBeenCalled();
    const values = db._chain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(values).toEqual([{ concert_id: 7, raw_name: 'Squirrel Flower', role: 'support' }]);
    expect(db._chain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ inserted: 1, untombstoned: 0, tombstoned: 0 });
  });

  test('to_untombstone only: UPDATE clears removed_at, guarded on role + concert_id + removed_at IS NOT NULL', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 55 }]);

    const outcome = await applySyncDiff(7, { to_insert: [], to_untombstone: ['Returning Act'], to_tombstone: [] });

    expect(db._chain.update).toHaveBeenCalledTimes(1);
    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set).toEqual({ removed_at: null });
    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('concert_id');
    expect(where).toContain('role');
    expect(where).toContain('isNotNull');
    expect(where).toContain('inArray');
    expect(outcome).toEqual({ inserted: 0, untombstoned: 1, tombstoned: 0 });
  });

  test('to_tombstone only: UPDATE sets removed_at, guarded on role + concert_id + removed_at IS NULL', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 56 }]);

    const outcome = await applySyncDiff(7, { to_insert: [], to_untombstone: [], to_tombstone: ['Dropped Act'] });

    expect(db._chain.update).toHaveBeenCalledTimes(1);
    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set.removed_at).toBeDefined();
    expect(set.removed_at).not.toBeNull();
    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('concert_id');
    expect(where).toContain('role');
    expect(where).toContain('isNull');
    expect(where).toContain('inArray');
    expect(outcome).toEqual({ inserted: 0, untombstoned: 0, tombstoned: 1 });
  });

  test('a mixed diff issues exactly the calls each non-empty bucket needs, in one transaction', async () => {
    db._chain.returning
      .mockResolvedValueOnce([{ id: 1 }]) // insert
      .mockResolvedValueOnce([{ id: 2 }]) // untombstone
      .mockResolvedValueOnce([{ id: 3 }]); // tombstone

    const outcome = await applySyncDiff(7, {
      to_insert: ['New Act'],
      to_untombstone: ['Returning Act'],
      to_tombstone: ['Dropped Act'],
    });

    expect(db._chain.insert).toHaveBeenCalledTimes(1);
    expect(db._chain.update).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({ inserted: 1, untombstoned: 1, tombstoned: 1 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('a race (0 rows affected) surfaces as a lower count, not a throw', async () => {
    db._chain.returning.mockResolvedValueOnce([]); // another run already tombstoned it

    const outcome = await applySyncDiff(7, { to_insert: [], to_untombstone: [], to_tombstone: ['Already Gone'] });

    expect(outcome).toEqual({ inserted: 0, untombstoned: 0, tombstoned: 0 });
  });
});
