/**
 * Unit tests for jobs/concerts-artist-resolver support-db.ts (BS#1760).
 *
 * `loadSupportCandidates` pins the candidate predicate: unresolved, active
 * junction rows (role='support', artist_id IS NULL, removed_at IS NULL)
 * joined to an upcoming non-tombstoned concert, with the RAW-NAME-ONLY
 * tribute guard (deliberately NOT the concert-title guard the headliner
 * arm carries — a support act at a tribute show is a real opener).
 *
 * `writeSupportArtistId` pins the fill-NULLs-only UPDATE guard and that
 * NO attempt-at marker is ever touched by this Phase-B arm.
 */
import { inspect } from 'util';

import { db } from '../../../mocks/database.mock';
import { loadSupportCandidates, writeSupportArtistId } from '../../../../jobs/concerts-artist-resolver/support-db';

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

describe('loadSupportCandidates', () => {
  test('selects unresolved, active, upcoming, non-tombstoned support rows', async () => {
    db.execute.mockResolvedValueOnce([{ id: 9, raw_name: 'Squirrel Flower' }]);

    const rows = await loadSupportCandidates();

    expect(rows).toEqual([{ id: 9, raw_name: 'Squirrel Flower' }]);
    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain(`cp."role" = 'support'`);
    expect(text).toContain('cp."artist_id" IS NULL');
    expect(text).toContain('cp."removed_at" IS NULL');
    expect(text).toContain('c."removed_at" IS NULL');
    expect(text).toContain(`c."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date`);
    expect(text).toContain('ORDER BY cp."id" ASC');
  });

  test('the tribute guard is RAW-NAME-ONLY — no concert-title exclusion', async () => {
    // Deliberate divergence from the headliner arm's loadCandidates
    // (jobs/concerts-artist-resolver/query.ts), which also excludes on
    // `title !~* '\mtribute'`. A support act billed at a tribute show is
    // a real opener — only the raw performer name itself gates here.
    db.execute.mockResolvedValueOnce([]);

    await loadSupportCandidates();

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain(`cp."raw_name" !~* '\\mtribute'`);
    expect(text).not.toContain('title');
  });

  test('an unrecognized db.execute result shape fails LOUD, not as a zero-work run', async () => {
    db.execute.mockResolvedValueOnce({ weird: true });
    await expect(loadSupportCandidates()).rejects.toThrow(/unrecognized db\.execute\(\) result shape/);
  });
});

describe('writeSupportArtistId', () => {
  test('fills artist_id and touches nothing else — no attempt-at marker on this Phase-B arm', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 9 }]);

    const result = await writeSupportArtistId(9, 501);

    const set = db._chain.set.mock.calls[0][0] as Record<string, unknown>;
    expect(set).toEqual({ artist_id: 501 });
    expect(result).toEqual({ written: true });
  });

  test('the UPDATE is guarded fill-NULLs-only on artist_id IS NULL', async () => {
    db._chain.returning.mockResolvedValueOnce([{ id: 9 }]);

    await writeSupportArtistId(9, 501);

    const where = inspect(db._chain.where.mock.calls[0][0], { depth: 30 });
    expect(where).toContain('id');
    expect(where).toContain('artist_id');
    expect(where).toContain('isNull');
  });

  test('a race (0 rows affected) surfaces as written:false, not a throw', async () => {
    db._chain.returning.mockResolvedValueOnce([]);

    const result = await writeSupportArtistId(9, 501);

    expect(result).toEqual({ written: false });
  });
});
