/**
 * Unit tests for the dual-table writer (§3.2.2.2).
 *
 * The writer's contract:
 *   1. Open a db.transaction().
 *   2. SELECT … FOR UPDATE on the existing main row (defense-in-depth per
 *      §5.1; the actual first-insert serialization is `ON CONFLICT`).
 *   3. INSERT/UPSERT each per-source row (one row per leg's contribution).
 *   4. Call `recomputeMainRow` to produce the new main-row values.
 *   5. UPSERT the main row with `ON CONFLICT (library_id) DO UPDATE`.
 *
 * Everything happens inside the transaction; rollback on any error.
 */
import { db } from '@wxyc/database';
import { writeIdentity } from '../../../../jobs/library-identity-backfill/writer';
import type { SourceRowToWrite } from '../../../../jobs/library-identity-backfill/resolve';

type SqlChunk = { value?: string | string[]; queryChunks?: SqlChunk[]; raw?: string };
type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<string | SqlChunk>;
  raw?: string;
};
const renderValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as SqlChunk & SqlLike;
    if (typeof o.raw === 'string') return o.raw;
    if (Array.isArray(o.queryChunks) || Array.isArray(o.sql)) return renderSql(o);
    if (Array.isArray(o.value)) return o.value.join('');
    if (typeof o.value === 'string') return o.value;
  }
  return '';
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) {
    let out = '';
    const fragments = obj.sql;
    const values = obj.values ?? [];
    for (let i = 0; i < fragments.length; i++) {
      out += fragments[i];
      if (i < values.length) out += renderValue(values[i]);
    }
    return out;
  }
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.queryChunks)) return renderSql(chunk);
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const findCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

const s1Row = (overrides: Partial<SourceRowToWrite> = {}): SourceRowToWrite => ({
  library_id: 100,
  source: 'discogs_release',
  external_id: '987654',
  method: 'exact_match',
  confidence: 1.0,
  last_verified_at: new Date('2026-04-15T00:00:00Z'),
  boost_sources: null,
  notes: 'backfill:S1',
  ...overrides,
});

describe('writeIdentity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.execute as jest.Mock).mockResolvedValue([]);
  });

  it('opens a transaction', async () => {
    await writeIdentity(100, [s1Row()], []);
    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
  });

  it('issues SELECT … FOR UPDATE on library_identity for the target library_id', async () => {
    // Defense-in-depth per §5.1; the lock no-ops when the main row doesn't yet
    // exist, but it's the correct mechanism for the cross-leg case (2.1+).
    await writeIdentity(100, [s1Row()], []);
    const call = findCallMatching(/SELECT[\s\S]*library_identity[\s\S]*FOR UPDATE/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toContain('100');
  });

  it('UPSERTs each per-source row into library_identity_source', async () => {
    await writeIdentity(100, [s1Row()], []);
    const call = findCallMatching(/INSERT INTO[\s\S]*library_identity_source/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/ON CONFLICT/i);
    expect(sqlText).toMatch(/library_id"?\s*,\s*"?source/i);
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('discogs_release');
    expect(serialized).toContain('987654');
    expect(serialized).toContain('exact_match');
    expect(serialized).toContain('backfill:S1');
  });

  it('UPSERTs the main row into library_identity with ON CONFLICT (library_id) DO UPDATE', async () => {
    // The unique index on library_id is what serializes concurrent first-
    // inserts (§5.1 corrected concurrency mechanism).
    await writeIdentity(100, [s1Row()], []);
    const call = findCallMatching(/INSERT INTO[\s\S]*library_identity\b(?![_])/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/ON CONFLICT\s*\(\s*"?library_id"?\s*\)\s*DO UPDATE/i);
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('exact_match');
    // The main row's discogs_release_id is the parsed integer.
    expect(serialized).toContain('987654');
  });

  it('issues per-source upsert(s) before the main-row upsert', async () => {
    // Order matters: §3.2.2.2 requires per-source first so the main-row
    // recompute reflects the new state.
    await writeIdentity(100, [s1Row()], []);
    const calls = (db.execute as jest.Mock).mock.calls.map((c) => renderSql(c[0]));
    const sourceUpsertIdx = calls.findIndex((s) => /INSERT INTO[\s\S]*library_identity_source/i.test(s));
    const mainUpsertIdx = calls.findIndex((s) =>
      /INSERT INTO[\s\S]*library_identity\b(?![_])[\s\S]*ON CONFLICT\s*\(\s*"?library_id"?\s*\)/i.test(s)
    );
    expect(sourceUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(mainUpsertIdx).toBeGreaterThanOrEqual(0);
    expect(sourceUpsertIdx).toBeLessThan(mainUpsertIdx);
  });
});
