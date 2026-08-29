/**
 * Pins the RENDERED SQL of this job's real read/write statements (BS#2281
 * review finding 5).
 *
 * `tests/integration/flowsheet-dj-name-scrub.spec.js` hand-mirrors
 * `applyDjNameBatch`/`loadMainPage`/`loadOrphanPage`/`loadMessagePage` in
 * plain JS — its own header explains why (babel-jest, no TS transform) — and
 * that mirror already diverges from the real implementation: the real
 * `applyDjNameBatch` has no `RETURNING` and reports
 * `Number((result as { count?: number }).count ?? 0)`, while the mirror uses
 * `RETURNING t."id"` and `rows.length`. So the `written` count an operator
 * reads was proven by nothing, and the integration tier's "search_doc
 * regenerates in the same UPDATE" / "CAS no-ops" claims were proven about the
 * MIRROR rather than the shipped SQL — the same defect one level up from the
 * one this job's own docstring convicts BS#1393 of (its doc comment claimed
 * two predicates matched when they did not).
 *
 * This tier closes that gap the way `tests/unit/jobs/flowsheet-dj-name-backfill/job.test.ts`
 * does: run the REAL functions against the mocked `@wxyc/database` `db.execute`,
 * and assert on the load-bearing fragments of the RENDERED SQL — never a
 * brittle full-string snapshot, which would break on whitespace-only Drizzle
 * changes and prove nothing extra.
 */

import { db } from '@wxyc/database';
import {
  applyDjNameBatch,
  applyMessageBatch,
  loadMainPage,
  loadOrphanPage,
  loadMessagePage,
} from '../../../../jobs/flowsheet-dj-name-scrub/orchestrate';

/**
 * `orchestrate.ts` imports `sql` straight from `drizzle-orm` (not the
 * `@wxyc/database` mock), so `db.execute` is called with the REAL Drizzle
 * `SQL` object: `{ sql: string[], values: unknown[] }`, where a nested
 * `sql.raw(...)` or `sql\`...\`` interpolation (the schema-qualified table
 * refs, the entry-type lists, the VALUES rows) shows up inside `values` as
 * `{ raw: string }` or another nested `SQL` object, NOT inlined into the
 * outer `.sql` chunk array. A naive `chunks.join('')` — the shape the
 * `flowsheet-dj-name-backfill` donor's `renderSql` gets away with, because
 * that job writes its table/column names as literal template text rather
 * than interpolating a `sql.raw` table ref — would therefore drop every
 * interpolated fragment silently, including the table name itself. This
 * version reconstructs the literal SQL by interleaving chunks with rendered
 * values, recursing into nested `SQL` objects and unwrapping `{ raw }`.
 */
type DrizzleSqlLike = { sql?: string[]; values?: unknown[] };

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    const obj = value as { raw?: unknown; sql?: string[] };
    if (typeof obj.raw === 'string') return obj.raw;
    if (Array.isArray(obj.sql)) return renderSql(value);
  }
  return String(value);
};

const renderSql = (value: unknown): string => {
  const obj = value as DrizzleSqlLike | null | undefined;
  if (!obj || !Array.isArray(obj.sql)) return '';
  const values = obj.values ?? [];
  let out = '';
  obj.sql.forEach((chunk, i) => {
    out += chunk;
    if (i < values.length) out += renderValue(values[i]);
  });
  return out;
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('applyDjNameBatch — the real write statement', () => {
  it('is a compare-and-set VALUES-join UPDATE on IS NOT DISTINCT FROM', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 1 });

    await applyDjNameBatch([{ id: 1, djName: 'zorp', oldDjName: 'stale' }], 300_000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*SET[\s\S]*"dj_name"/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/FROM\s*\(\s*VALUES/i);
    expect(sqlText).toMatch(/t\."id"\s*=\s*v\."id"/);
    expect(sqlText).toMatch(/t\."dj_name"\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v\."old_dj_name"/i);
  });

  it('never sets updated_at or search_doc — the migration-0084 trigger and the generated column own them', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 1 });

    await applyDjNameBatch([{ id: 1, djName: 'zorp', oldDjName: 'stale' }], 300_000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*SET[\s\S]*"dj_name"/i);
    const sqlText = renderSql(call?.[0]);
    const setClause = sqlText.slice(sqlText.search(/SET/i), sqlText.search(/FROM\s*\(\s*VALUES/i));
    expect(setClause).not.toMatch(/updated_at/i);
    expect(setClause).not.toMatch(/search_doc/i);
  });

  it('has no RETURNING clause — the caller reads result.count, not row count', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 7 });

    const written = await applyDjNameBatch([{ id: 1, djName: 'zorp', oldDjName: 'stale' }], 300_000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*SET[\s\S]*"dj_name"/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).not.toMatch(/RETURNING/i);
    // The exact divergence finding 5 flags in the integration mirror: this
    // job reads result.count, never rows.length from a RETURNING clause.
    expect(written).toBe(7);
  });

  it('returns 0 for an empty fixes array without issuing any statement', async () => {
    const written = await applyDjNameBatch([], 300_000);
    expect(written).toBe(0);
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe('applyMessageBatch — the real write statement', () => {
  it('is a compare-and-set VALUES-join UPDATE on IS NOT DISTINCT FROM, same shape as dj_name', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 1 });

    await applyMessageBatch([{ id: 1, message: 'DJ joined the set!', oldMessage: 'A. Hearst joined the set!' }], 300_000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*SET[\s\S]*"message"/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/FROM\s*\(\s*VALUES/i);
    expect(sqlText).toMatch(/t\."message"\s+IS\s+NOT\s+DISTINCT\s+FROM\s+v\."old_message"/i);
  });

  it('never sets updated_at or dj_name — this pass touches message only', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ count: 1 });

    await applyMessageBatch([{ id: 1, message: 'DJ joined the set!', oldMessage: 'A. Hearst joined the set!' }], 300_000);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*flowsheet[\s\S]*SET[\s\S]*"message"/i);
    const sqlText = renderSql(call?.[0]);
    const setClause = sqlText.slice(sqlText.search(/SET/i), sqlText.search(/FROM\s*\(\s*VALUES/i));
    expect(setClause).not.toMatch(/updated_at/i);
    expect(setClause).not.toMatch(/"dj_name"/i);
  });
});

describe('loadMainPage — the real candidate SELECT', () => {
  it('INNER JOINs shows and LEFT JOINs auth_user, cursors on id, and scopes entry_type', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await loadMainPage(42, 5000);

    const call = findExecuteCallMatching(/SELECT[\s\S]*flowsheet/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/JOIN[\s\S]*shows[\s\S]*AS\s+s\s+ON\s+s\."id"\s*=\s*f\."show_id"/i);
    expect(sqlText).not.toMatch(/LEFT\s+JOIN[\s\S]*shows/i); // shows is the INNER join, not the LEFT one
    expect(sqlText).toMatch(/LEFT\s+JOIN\s+"auth_user"/i);
    expect(sqlText).toMatch(/f\."id"\s*>\s*42/); // the id-cursor form: f."id" > <bound cursor>
    expect(sqlText).toMatch(/entry_type"?\s+IN\s*\(/i);
    expect(sqlText).toMatch(/'track'/);
    expect(sqlText).toMatch(/ORDER\s+BY\s+f\."id"/i);
    expect(sqlText).toMatch(/LIMIT/i);
  });

  it('does not surface an excluded entry type in its IN list', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadMainPage(0, 5000);
    const sqlText = renderSql(findExecuteCallMatching(/SELECT[\s\S]*flowsheet/i)?.[0]);
    expect(sqlText).not.toMatch(/'talkset'/);
    expect(sqlText).not.toMatch(/'breakpoint'/);
    expect(sqlText).not.toMatch(/'message'/);
  });
});

describe('loadOrphanPage — the real candidate SELECT (BS#2281 review finding 4)', () => {
  it('scopes to show_id IS NULL OR a dangling show_id via NOT EXISTS, plus a non-null dj_name', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await loadOrphanPage(0, 5000);

    const call = findExecuteCallMatching(/SELECT[\s\S]*flowsheet/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/"show_id"\s+IS\s+NULL/i);
    expect(sqlText).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM[\s\S]*shows[\s\S]*s\."id"\s*=\s*f\."show_id"/i);
    expect(sqlText).toMatch(/"dj_name"\s+IS\s+NOT\s+NULL/i);
    expect(sqlText).toMatch(/ORDER\s+BY\s+f\."id"/i);
    expect(sqlText).toMatch(/LIMIT/i);
  });

  it('never joins the main pass\'s auth_user column — there is no shows chain to read one from', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadOrphanPage(0, 5000);
    const sqlText = renderSql(findExecuteCallMatching(/SELECT[\s\S]*flowsheet/i)?.[0]);
    expect(sqlText).not.toMatch(/auth_user/i);
  });
});

describe('loadMessagePage — the real candidate SELECT', () => {
  it('scopes to the four marker types with a non-null message, cursored on id', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await loadMessagePage(0, 5000);

    const call = findExecuteCallMatching(/SELECT[\s\S]*flowsheet/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/"message"\s+IS\s+NOT\s+NULL/i);
    expect(sqlText).toMatch(/entry_type"?\s+IN\s*\(/i);
    expect(sqlText).toMatch(/'show_start'/);
    expect(sqlText).toMatch(/'show_end'/);
    expect(sqlText).toMatch(/'dj_join'/);
    expect(sqlText).toMatch(/'dj_leave'/);
    expect(sqlText).not.toMatch(/'track'/);
    expect(sqlText).toMatch(/ORDER\s+BY\s+f\."id"/i);
    expect(sqlText).toMatch(/LIMIT/i);
  });
});
