/**
 * Unit tests for jobs/concerts-artist-lml-resolver targets.ts: the
 * headliner {@link RoleTarget} (BS#1614) and the support {@link RoleTarget}
 * (BS#1763, parent #1618).
 *
 * Both: candidate predicate shape, the FK loop-close singleton check
 * (shared — `lookupSingletonLibraryArtistId` is tested once, under the
 * headliner describe block, since it's role-agnostic), and the SET-clause
 * contracts of both write arms. The load-bearing pin is the FK-TIE case:
 * `artists.discogs_artist_id` has NO unique constraint (duplicates exist
 * in the wild via the identity ETL), and a broken singleton check would
 * silently FK the concert/performer to an arbitrary one of the
 * duplicates — the exact mislabel class the strict resolver's `LIMIT 2`
 * collapse exists to prevent. Here the Discogs id must still land while
 * the FK stays NULL.
 *
 * SQL-shape assertions use the same best-effort `renderSql` as
 * tests/unit/jobs/concerts-artist-resolver/query.test.ts (see the JSDoc
 * there for the drizzle AST forms it handles); guard-clause assertions on
 * the drizzle builder use `util.inspect` over the where AST, whose column
 * names are plain strings under the database mock.
 */
import { jest } from '@jest/globals';
import { inspect } from 'util';

import { db } from '../../../mocks/database.mock';
import {
  HEADLINER_MATCH_SOURCE,
  SUPPORT_MATCH_SOURCE,
  headlinerTarget,
  loadHeadlinerCandidates,
  loadSupportCandidates,
  lookupSingletonLibraryArtistId,
  supportTarget,
} from '../../../../jobs/concerts-artist-lml-resolver/targets';

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
  db._chain.update.mockClear();
  db._chain.set.mockClear();
  db._chain.where.mockClear();
  db._chain.returning.mockReset();
});

describe('loadHeadlinerCandidates', () => {
  test('the candidate predicate pins both id columns NULL, tombstone, upcoming window, and the TTL arms', async () => {
    db.execute.mockResolvedValueOnce([{ id: 3, raw_name: 'Water From Your Eyes' }]);

    const rows = await loadHeadlinerCandidates(30);

    expect(rows).toEqual([{ id: 3, raw_name: 'Water From Your Eyes' }]);
    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain('"headlining_artist_id" IS NULL');
    expect(text).toContain('"headlining_discogs_artist_id" IS NULL');
    expect(text).toContain('"headlining_artist_raw" IS NOT NULL');
    expect(text).toContain('"removed_at" IS NULL');
    // Upcoming-only: never burn Discogs budget resolving past shows. Windowed
    // on the venue-local (Eastern) date the read path uses, not server-clock
    // CURRENT_DATE — a UTC "today" would flip the window at 8 PM Eastern.
    expect(text).toContain(`"starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`);
    // Marker-NULL rows always eligible; stamped rows re-ask only past the TTL.
    expect(text).toContain('"artist_resolve_attempted_at" IS NULL');
    expect(text).toContain(`interval '1 day'`);
    expect(text).toContain('ORDER BY "id" ASC');
  });

  test('an unrecognized db.execute result shape fails LOUD, not as a zero-work run', async () => {
    db.execute.mockResolvedValueOnce({ weird: true });

    await expect(loadHeadlinerCandidates(30)).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });

  test('excludes tribute-context rows — a tribute billing must never resolve an identity', async () => {
    // Mirror of the SQL lane's guard (jobs/concerts-artist-resolver/query.ts):
    // in a tribute-framed event the billed name belongs to (or aliases) the
    // HONOREE, not the performer — the Stanczyks "REM Tribute to Lifes Rich
    // Pageant" row resolved to the real R.E.M. this way. Word-start match
    // (\m) so "Tributaries" doesn't trip; the title arm is NULL-safe.
    db.execute.mockResolvedValueOnce([]);

    await loadHeadlinerCandidates(30);

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain(`("title" IS NULL OR "title" !~* '\\mtribute')`);
    expect(text).toContain(`"headlining_artist_raw" !~* '\\mtribute'`);
  });
});

describe('lookupSingletonLibraryArtistId', () => {
  test('exactly one library artist → its id', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }]);
    await expect(lookupSingletonLibraryArtistId(555)).resolves.toBe(42);
  });

  test('no library artist (the normal touring-act case) → null', async () => {
    db.execute.mockResolvedValueOnce([]);
    await expect(lookupSingletonLibraryArtistId(555)).resolves.toBeNull();
  });

  test('duplicate discogs_artist_id rows → null (collapse-on-ambiguous)', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }, { id: 43 }]);
    await expect(lookupSingletonLibraryArtistId(555)).resolves.toBeNull();
  });

  test('the lookup is LIMIT 2 — the singleton check needs presence-of-a-second, not a full count', async () => {
    db.execute.mockResolvedValueOnce([]);
    await lookupSingletonLibraryArtistId(555);
    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain('"discogs_artist_id" =');
    expect(text).toContain('LIMIT 2');
  });
});

describe('headlinerTarget.applyResolved', () => {
  test('singleton library artist: Discogs id + provenance + marker + FK loop-close in one UPDATE', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }]); // singleton lookup
    db._chain.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const result = await headlinerTarget.applyResolved([1, 2], { discogs_artist_id: 555, method: 'api_search' });

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set.headlining_discogs_artist_id).toBe(555);
    expect(set.headlining_discogs_artist_id_source).toBe(HEADLINER_MATCH_SOURCE);
    expect(set.artist_resolve_attempted_at).toBeDefined();
    expect(set.headlining_artist_id).toBe(42);
    expect(result).toEqual({ updated: 2, fk_loop_closed: 2 });
  });

  test('FK TIE: two artists sharing the discogs_artist_id → Discogs id lands, FK column stays OUT of the SET', async () => {
    // Production risk this pins: `artists.discogs_artist_id` is NOT unique
    // (identity-ETL duplicates exist). A broken singleton check would FK the
    // concert to an arbitrary one of the two artists — a silent mislabel.
    // The Discogs id itself is still correct and must land.
    db.execute.mockResolvedValueOnce([{ id: 42 }, { id: 43 }]);
    db._chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    const result = await headlinerTarget.applyResolved([1], { discogs_artist_id: 555, method: 'identity_store' });

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set.headlining_discogs_artist_id).toBe(555);
    expect('headlining_artist_id' in set).toBe(false);
    expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });
  });

  test('no library artist: Discogs id lands, FK column stays out of the SET', async () => {
    db.execute.mockResolvedValueOnce([]);
    db._chain.returning.mockResolvedValueOnce([{ id: 1 }]);

    const result = await headlinerTarget.applyResolved([1], { discogs_artist_id: 555, method: 'api_search' });

    expect('headlining_artist_id' in (db._chain.set.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
    expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });
  });

  test('the UPDATE is NULL-guarded on BOTH id columns (fill-NULLs-only, never overwrite)', async () => {
    db.execute.mockResolvedValueOnce([]);
    db._chain.returning.mockResolvedValueOnce([]);

    await headlinerTarget.applyResolved([1, 2], { discogs_artist_id: 555, method: 'api_search' });

    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('headlining_artist_id');
    expect(where).toContain('headlining_discogs_artist_id');
  });

  test('the NULL-guard race surfaces as updated < rowIds.length, not a throw', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }]);
    // 2 rows targeted; 1 survived the guard (the other was resolved mid-run).
    db._chain.returning.mockResolvedValueOnce([{ id: 2 }]);

    const result = await headlinerTarget.applyResolved([1, 2], { discogs_artist_id: 555, method: 'api_search' });

    expect(result).toEqual({ updated: 1, fk_loop_closed: 1 });
  });
});

describe('headlinerTarget.applyNoMatch', () => {
  test('stamps ONLY the attempt-at marker (no id, no provenance)', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const result = await headlinerTarget.applyNoMatch([1, 2]);

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(set)).toEqual(['artist_resolve_attempted_at']);
    expect(result).toEqual({ updated: 2 });
    // No singleton lookup on a no-match — db.execute is the raw-SQL path.
    expect(db.execute).not.toHaveBeenCalled();
  });

  test('keeps the same double-NULL guard as the resolved arm', async () => {
    db._chain.returning.mockResolvedValueOnce([]);

    await headlinerTarget.applyNoMatch([9]);

    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('headlining_artist_id');
    expect(where).toContain('headlining_discogs_artist_id');
  });
});

describe('loadSupportCandidates', () => {
  test('the candidate predicate pins both id columns NULL, role=support, tombstone, upcoming window, and the TTL arms', async () => {
    db.execute.mockResolvedValueOnce([{ id: 101, raw_name: 'Ekko Astral' }]);

    const rows = await loadSupportCandidates(30);

    expect(rows).toEqual([{ id: 101, raw_name: 'Ekko Astral' }]);
    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain('"artist_id" IS NULL');
    expect(text).toContain('"discogs_artist_id" IS NULL');
    expect(text).toContain('"removed_at" IS NULL');
    expect(text).toContain(`"role" = 'support'`);
    // Joined to the parent concert's own tombstone + upcoming window — the
    // junction row doesn't inherit the concert's removed_at via cascade.
    expect(text).toContain('c."id" = cp."concert_id"');
    expect(text).toContain(`"starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`);
    expect(text).toContain('"artist_resolve_attempted_at" IS NULL');
    expect(text).toContain(`interval '1 day'`);
    expect(text).toContain('ORDER BY cp."id" ASC');
  });

  test('an unrecognized db.execute result shape fails LOUD, not as a zero-work run', async () => {
    db.execute.mockResolvedValueOnce({ weird: true });

    await expect(loadSupportCandidates(30)).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });

  test('the tribute guard is RAW-NAME-ONLY — no title exclusion (a support at a tribute-titled show is a real opener)', async () => {
    db.execute.mockResolvedValueOnce([]);

    await loadSupportCandidates(30);

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain(`"raw_name" !~* '\\mtribute'`);
    // The headliner arm additionally guards on the concert `title`; the
    // support arm deliberately does not (BS#1760's locked decision, carried
    // over to this LML lane).
    expect(text).not.toContain('"title"');
  });
});

describe('supportTarget.applyResolved', () => {
  test('singleton library artist: Discogs id + provenance + marker + FK loop-close in one UPDATE', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }]); // singleton lookup
    db._chain.returning.mockResolvedValueOnce([{ id: 101 }, { id: 102 }]);

    const result = await supportTarget.applyResolved([101, 102], { discogs_artist_id: 555, method: 'api_search' });

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set.discogs_artist_id).toBe(555);
    expect(set.discogs_artist_id_source).toBe(SUPPORT_MATCH_SOURCE);
    expect(set.artist_resolve_attempted_at).toBeDefined();
    expect(set.artist_id).toBe(42);
    expect(result).toEqual({ updated: 2, fk_loop_closed: 2 });
  });

  test('FK TIE: two artists sharing the discogs_artist_id → Discogs id lands, FK column stays OUT of the SET', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }, { id: 43 }]);
    db._chain.returning.mockResolvedValueOnce([{ id: 101 }]);

    const result = await supportTarget.applyResolved([101], { discogs_artist_id: 555, method: 'identity_store' });

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set.discogs_artist_id).toBe(555);
    expect('artist_id' in set).toBe(false);
    expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });
  });

  test('no library artist: Discogs id lands, FK column stays out of the SET', async () => {
    db.execute.mockResolvedValueOnce([]);
    db._chain.returning.mockResolvedValueOnce([{ id: 101 }]);

    const result = await supportTarget.applyResolved([101], { discogs_artist_id: 555, method: 'api_search' });

    expect('artist_id' in (db._chain.set.mock.calls[0][0] as Record<string, unknown>)).toBe(false);
    expect(result).toEqual({ updated: 1, fk_loop_closed: 0 });
  });

  test('the UPDATE is NULL-guarded on BOTH id columns (fill-NULLs-only, never overwrite)', async () => {
    db.execute.mockResolvedValueOnce([]);
    db._chain.returning.mockResolvedValueOnce([]);

    await supportTarget.applyResolved([101, 102], { discogs_artist_id: 555, method: 'api_search' });

    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('artist_id');
    expect(where).toContain('discogs_artist_id');
  });

  test('the NULL-guard race surfaces as updated < rowIds.length, not a throw', async () => {
    db.execute.mockResolvedValueOnce([{ id: 42 }]);
    // 2 rows targeted; 1 survived the guard (the other was resolved mid-run
    // by concerts-artist-resolver's own pure-SQL support arm).
    db._chain.returning.mockResolvedValueOnce([{ id: 102 }]);

    const result = await supportTarget.applyResolved([101, 102], { discogs_artist_id: 555, method: 'api_search' });

    expect(result).toEqual({ updated: 1, fk_loop_closed: 1 });
  });
});

describe('supportTarget.applyNoMatch', () => {
  test('stamps ONLY the attempt-at marker (no id, no provenance)', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 101 }, { id: 102 }]);

    const result = await supportTarget.applyNoMatch([101, 102]);

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(set)).toEqual(['artist_resolve_attempted_at']);
    expect(result).toEqual({ updated: 2 });
    expect(db.execute).not.toHaveBeenCalled();
  });

  test('keeps the same double-NULL guard as the resolved arm', async () => {
    db._chain.returning.mockResolvedValueOnce([]);

    await supportTarget.applyNoMatch([109]);

    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('artist_id');
    expect(where).toContain('discogs_artist_id');
  });
});
