/**
 * Unit tests for the multi-match tie-break utility (B-2.3).
 *
 * When LML resolves a flowsheet entry to a canonical entity that maps to
 * multiple library rows, the linkage path needs a deterministic way to
 * pick a single primary library row. The order is:
 *
 *   1. Currently in rotation (kill_date NULL or > today)
 *   2. Format priority (vinyl > CD > digital > unknown)
 *   3. Higher play count (album_plays MV)
 *   4. Lower library.id (deterministic fallback)
 *
 * The utility is a single-round-trip query: the tie-break is expressed as
 * an ORDER BY against the candidate ids, with EXISTS for rotation
 * membership and a LEFT JOIN to album_plays for the play-weight signal.
 * Unit tests assert the SQL contract; the per-rule behaviour is exercised
 * by Postgres at integration time.
 */
// `library-tiebreak.ts` imports `db` from `./client.js`. The
// moduleNameMapper rewrite only catches the absolute path form, so we mock
// the relative form explicitly here.
jest.mock('../../../shared/database/src/client.js', () => jest.requireActual('../../mocks/database.mock'), {
  virtual: true,
});

import { db } from '../../mocks/database.mock';
import { pickPrimaryLibraryRow } from '../../../shared/database/src/library-tiebreak';

type SqlLike = {
  sql?: string | string[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

describe('pickPrimaryLibraryRow (B-2.3)', () => {
  beforeEach(() => {
    (db.execute as jest.Mock).mockReset();
  });

  it('returns null for an empty candidate list (defensive — caller usually filters)', async () => {
    const picked = await pickPrimaryLibraryRow([]);
    expect(picked).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('short-circuits a singleton input without a query (the common case)', async () => {
    // A "multi-match" with one element shouldn't bother Postgres. Avoids a
    // round-trip per addEntry when callers preemptively call into the
    // tie-break with whatever they have.
    const picked = await pickPrimaryLibraryRow([42]);
    expect(picked).toBe(42);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('issues exactly one SELECT (single round-trip — this is the hot path)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('orders candidates by rotation membership first (kill_date NULL OR > CURRENT_DATE)', async () => {
    // Tie-break #1: a vinyl currently in rotation must beat any other row,
    // even a CD-only one with more plays. The SQL achieves this with an
    // EXISTS subquery against rotation.kill_date.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);

    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/EXISTS[\s\S]*rotation/i);
    expect(sqlText).toMatch(/kill_date"?\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/kill_date"?\s*>\s*CURRENT_DATE/i);
  });

  it('orders by format priority second (vinyl > cd/cdr > digital > unknown)', async () => {
    // Tie-break #2: when no candidate is in rotation, prefer vinyl over CD.
    // Format names in WXYC's catalog are 'cd', 'cdr', 'vinyl', 'vinyl 7"',
    // 'vinyl 12"', 'vinyl 10"' — the ranking has to handle the trailing
    // size variants without listing each one.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);

    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/format_name/i);
    expect(sqlText).toMatch(/vinyl/i);
    expect(sqlText).toMatch(/'cd'/i);
  });

  it('orders by play count third (album_plays MV)', async () => {
    // Tie-break #3: same format, neither in rotation → higher plays wins.
    // Reads from the album_plays MV (Epic A.5/A.6); LEFT JOIN so a row
    // with zero plays still sorts correctly via COALESCE(plays, 0).
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);

    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/album_plays/i);
    expect(sqlText).toMatch(/COALESCE\(\s*[a-z]+\."?plays"?\s*,\s*0\s*\)\s+DESC/i);
  });

  it('orders by library.id ascending as the final deterministic fallback', async () => {
    // Tie-break #4: identical rotation status, format, and plays → the
    // lowest library.id wins. Ensures retries pick the same row across
    // runs even when nothing else differentiates.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);

    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    // Last ORDER BY clause on l.id ASC.
    expect(sqlText).toMatch(/"?id"?\s+ASC[\s\S]*LIMIT\s+1/i);
  });

  it('binds the candidate ids as a parameter array (no string interpolation)', async () => {
    // Drizzle's `${array}` over `ANY(...)` parameterizes the list, so a
    // caller-supplied id can't be SQL-injected via the tie-break.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);

    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toContain('10');
    expect(serialized).toContain('11');
    expect(serialized).toContain('12');
    const sqlText = renderSql((db.execute as jest.Mock).mock.calls[0][0]);
    expect(sqlText).toMatch(/=\s*ANY\(/i);
  });

  it('returns the picked id from the first row and only the first row', async () => {
    // The query is LIMIT 1, so the mock should never need more than one
    // row. The function returns row.id, not the whole row.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 7 }]);
    const picked = await pickPrimaryLibraryRow([5, 6, 7]);
    expect(picked).toBe(7);
  });

  it('returns null when the query somehow returns no rows (e.g. ids deleted between read and write)', async () => {
    // Defensive: callers fed us live ids, but a concurrent delete could
    // wipe them between batch read and tie-break. Returning null lets the
    // caller skip the link rather than crash.
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    const picked = await pickPrimaryLibraryRow([5, 6, 7]);
    expect(picked).toBeNull();
  });

  it('binds the multi-element (arity >= 2) candidate list as a single array-literal param, not a splat (BS#1072)', async () => {
    // postgres-js/drizzle splats `${jsArray}` into N positional
    // placeholders — `ANY(($1,$2,$3))` — which PG rejects at arity >= 2
    // with "op ANY/ALL (array) requires array on right side" (BS#1071,
    // and the cast form `ANY(${array}::int[])` fails the same way per
    // BS#1068). The only shape that survives is `ANY('{10,11,12}'::int[])`
    // — a single bound text param cast to int[] inside PG. Matches the
    // pattern already proven in jobs/album-level-backfill/job.ts.
    (db.execute as jest.Mock).mockResolvedValueOnce([{ id: 11 }]);
    await pickPrimaryLibraryRow([10, 11, 12]);

    const call = (db.execute as jest.Mock).mock.calls[0][0] as { values?: unknown[] } | undefined;
    const sqlText = renderSql(call);
    expect(sqlText).toMatch(/=\s*ANY\(\s*::int\[\]\)/i);

    const values = call?.values ?? [];
    expect(values).toContain('{10,11,12}');
    // Anti-assert the broken shapes: no individual numeric param values
    // from a splat (the BS#1068/BS#1071 symptom).
    expect(values).not.toContain(10);
    expect(values).not.toContain(11);
    expect(values).not.toContain(12);
  });
});
