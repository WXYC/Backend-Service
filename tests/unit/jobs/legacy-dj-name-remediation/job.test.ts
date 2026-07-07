/**
 * Unit tests for the legacy-dj-name-remediation job (BS#1393).
 *
 * The remediation owns three SQL invariants we hold against the v2 PII
 * contract:
 *
 *   (a) Per-batch scrub fires the shows-UPDATE and the marker-flowsheet-NULL
 *       UPDATE atomically (single CTE) — never the two as separate
 *       statements, where a mid-run abort would leave PII on the wire.
 *   (b) Re-resolve is row-id-scoped via `show_id = ANY(batchShowIds)`, so
 *       the job never reproduces the BS#511 unbounded-UPDATE wedge pattern.
 *   (c) The COALESCE chain stops at `shows.legacy_dj_name` — `auth_user.name`
 *       MUST NEVER appear (it would re-open the leak BS#1371 closed).
 *
 * drizzle-orm's `sql.join`/`sql.raw` static methods don't survive ts-jest's
 * transform cleanly (writer.test.ts documents the same workaround for the
 * artist-search-alias-consumer), so we mock the module with a tracking stub
 * and assert on the template-tag invocations directly. That also lets us
 * pin the bind values flowing into the CTE without rendering full SQL.
 */

import { jest } from '@jest/globals';

type SqlTagCall = { strings: string[]; values: unknown[]; tag: 'sql' };
type SqlRawCall = { source: string; tag: 'raw' };
type SqlJoinCall = { fragmentCount: number; tag: 'join' };
type RecordedCall = SqlTagCall | SqlRawCall | SqlJoinCall;

const recorded: RecordedCall[] = [];

jest.mock('drizzle-orm', () => {
  const sqlTag = (() => {
    const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const call: SqlTagCall = { strings: Array.from(strings), values, tag: 'sql' };
      recorded.push(call);
      return { __sql: true, strings: Array.from(strings), values };
    }) as unknown as Record<string, unknown> & ((...args: unknown[]) => unknown);
    (fn as Record<string, unknown>).join = (chunks: unknown[]) => {
      recorded.push({ fragmentCount: chunks.length, tag: 'join' });
      return { __sql: true, __join: true };
    };
    (fn as Record<string, unknown>).raw = (s: unknown) => {
      const source = typeof s === 'string' ? s : JSON.stringify(s);
      recorded.push({ source, tag: 'raw' });
      return { __sql: true, __raw: true, source };
    };
    return fn;
  })();
  return { sql: sqlTag };
});

const mockExecute = jest.fn<(query: unknown) => Promise<unknown>>();

jest.mock('@wxyc/database', () => ({
  db: { execute: mockExecute },
  // `send` returns the empty string so the module-load-time `main().catch(...)`
  // exits cleanly via the "no mappings" early return rather than throwing
  // through `raw.trim()` on undefined.
  MirrorSQL: { instance: () => ({ send: jest.fn().mockResolvedValue(''), close: jest.fn() }) },
  closeDatabaseConnection: jest.fn().mockResolvedValue(undefined),
}));

import {
  runScrubBatch,
  reresolveMarkerDjNames,
  analyzeTables,
  fetchHandleMappings,
  BATCH_SIZE,
} from '../../../../jobs/legacy-dj-name-remediation/job';

const lastSqlTagCall = (): SqlTagCall => {
  for (let i = recorded.length - 1; i >= 0; i--) {
    const call = recorded[i];
    if (call.tag === 'sql') return call;
  }
  throw new Error('no sql\\`\\` calls recorded');
};

/** Render the strings array of the last sql tag call into one search blob. */
const lastSqlBlob = (): string => lastSqlTagCall().strings.join(' ');

const sqlBlobs = (): string[] =>
  recorded.filter((c): c is SqlTagCall => c.tag === 'sql').map((c) => c.strings.join(' '));

beforeEach(() => {
  recorded.length = 0;
  mockExecute.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('legacy-dj-name-remediation: runScrubBatch', () => {
  it('CTE returns batch_show_ids (all BS shows in batch), not just scrub-touched ids — guards prior-run-crash recovery', async () => {
    // Per the BatchResult docstring: if a prior run committed the scrub but
    // the subsequent re-resolve crashed, the next run's scrub no-ops on the
    // already-clean shows. The re-resolve must still see those show_ids so
    // it can heal the dangling NULL markers from the previous crash. So the
    // CTE selects `array_agg(show_id) FROM all_known` (every batch show),
    // never `FROM to_update` (only scrub-touched). If this regresses, a
    // partial-failure re-run leaks PII residue indefinitely.
    mockExecute.mockResolvedValueOnce([{ shows_updated: 0, markers_reset: 0, batch_show_ids: [10, 11] }]);

    await runScrubBatch([{ showId: 1001, djHandle: 'DJ Bluejay' }]);

    const sql = lastSqlBlob();
    expect(sql).toMatch(/array_agg\(show_id\)\s+FROM\s+all_known/i);
    expect(sql).not.toMatch(/array_agg\(show_id\)\s+FROM\s+to_update/i);
  });

  it('builds a single CTE that scrubs shows.legacy_dj_name AND nulls matching marker dj_name in one statement', async () => {
    // Atomicity is the whole point of the CTE — a mid-run abort cannot leave
    // shows.legacy_dj_name corrected with the matching marker dj_name still
    // leaking PII.
    mockExecute.mockResolvedValueOnce([{ shows_updated: 2, markers_reset: 5, batch_show_ids: [10, 11] }]);

    await runScrubBatch([
      { showId: 1001, djHandle: 'DJ Bluejay' },
      { showId: 1002, djHandle: 'dj wilde' },
    ]);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    const sql = lastSqlBlob();
    expect(sql).toMatch(/WITH input/i);
    expect(sql).toMatch(/UPDATE[\s\S]+shows[\s\S]+SET legacy_dj_name/i);
    expect(sql).toMatch(/UPDATE[\s\S]+flowsheet[\s\S]+SET dj_name = NULL/i);
    // Marker row reset must be scoped by entry_type — never NULL non-marker rows.
    expect(sql).toMatch(/entry_type\s+IN\s*\(/i);
    expect(sql).toMatch(/'show_start'/);
    expect(sql).toMatch(/'show_end'/);
    expect(sql).toMatch(/'dj_join'/);
    expect(sql).toMatch(/'dj_leave'/);
  });

  it('uses trim-aware comparison so trailing-whitespace pollution does not evade the NULL-out', async () => {
    // A row stored as `'Real Name  '` (trailing whitespace from a legacy
    // write path) must match `oldHandle = 'Real Name'`. Otherwise the
    // PII residue stays on the v2 wire after the scrub claims success.
    mockExecute.mockResolvedValueOnce([{ shows_updated: 0, markers_reset: 0, batch_show_ids: [] }]);

    await runScrubBatch([{ showId: 1001, djHandle: 'DJ Bluejay' }]);

    const sql = lastSqlBlob();
    expect(sql).toMatch(/trim\(\s*f\.dj_name\s*\)\s*=\s*trim\(/i);
    // After the iter-3 refactor `legacy_dj_name` is projected into the
    // `all_known` CTE as `old_handle`, and the IS DISTINCT FROM filter
    // compares against the `new_handle` column from the same CTE. The
    // structural invariant — trim-aware, NULL-vs-empty-tolerant — is the
    // same.
    expect(sql).toMatch(/COALESCE\(trim\(old_handle\),\s*''\)\s+IS DISTINCT FROM\s+COALESCE\(trim\(new_handle\)/i);
  });

  it('binds (showId, djHandle) tuples through sql.join — never sql.raw (PII / SQL-injection regression)', async () => {
    // The previous iteration of this script built the per-row UPDATE via
    // `sql.raw` + a hand-rolled `replace(/'/g, "''")` escape — which doesn't
    // cover backslashes or NUL bytes. Pin that the implementation routes the
    // dj-handle values through sql.join's parameter binder instead.
    mockExecute.mockResolvedValueOnce([{ shows_updated: 0, markers_reset: 0, batch_show_ids: [] }]);

    await runScrubBatch([
      { showId: 1001, djHandle: "O'Brien" },
      { showId: 1002, djHandle: 'Bro\\Slash' },
    ]);

    expect(recorded.some((c) => c.tag === 'join')).toBe(true);
    // Look at the per-row sql\`(${showId}::int, ${handle}::text)\` invocations
    // and confirm the handles arrived as bound values, not interpolated text.
    const tupleCalls = recorded.filter((c): c is SqlTagCall => c.tag === 'sql' && c.values.length === 2);
    const boundHandles = tupleCalls.map((c) => c.values[1]);
    expect(boundHandles).toEqual(expect.arrayContaining(["O'Brien", 'Bro\\Slash']));
  });

  it('returns shows_updated / markers_reset / batch_show_ids from the CTE result row', async () => {
    mockExecute.mockResolvedValueOnce([{ shows_updated: 17, markers_reset: 42, batch_show_ids: [10, 11, 12] }]);

    const result = await runScrubBatch([{ showId: 1001, djHandle: 'A' }]);

    expect(result.showsUpdated).toBe(17);
    expect(result.markerRowsReset).toBe(42);
    expect(result.batchShowIds).toEqual([10, 11, 12]);
  });

  it('returns zeroes + empty list when the batch is empty (no SQL issued)', async () => {
    const result = await runScrubBatch([]);

    expect(result.showsUpdated).toBe(0);
    expect(result.markerRowsReset).toBe(0);
    expect(result.batchShowIds).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('legacy-dj-name-remediation: reresolveMarkerDjNames', () => {
  it('UPDATE is row-id-scoped via show_id = ANY(batchShowIds) so it never wedges like BS#511', async () => {
    // The whole point of the per-batch row-id scope is that the re-resolve
    // never runs unbounded against the whole flowsheet. If the ANY-scope
    // ever gets dropped, this test fires.
    mockExecute.mockResolvedValueOnce({ count: 5 });

    await reresolveMarkerDjNames([10, 11, 12]);

    const sql = lastSqlBlob();
    expect(sql).toMatch(/UPDATE[\s\S]+flowsheet[\s\S]+SET dj_name/i);
    expect(sql).toMatch(/show_id\s*=\s*ANY/i);
  });

  it('binds batchShowIds as a single PG array-literal string with ::int[] cast — never a JS array splat (BS#1071 regression)', async () => {
    // Drizzle/postgres-js splat a JS array in `${...}` positions across N
    // positional placeholders, producing `ANY(($1, $2, …, $n))`. Postgres
    // rejects with `op ANY/ALL (array) requires array on right side`. The fix
    // (per album-level-backfill / BS#1071) is to bind the array as a single
    // PG-literal string parameter and cast with `::int[]`. If a refactor
    // ever reverts to bare `ANY(${batchShowIds})`, this test fires.
    mockExecute.mockResolvedValueOnce({ count: 0 });

    await reresolveMarkerDjNames([10, 11, 12]);

    const sqlCall = lastSqlTagCall();
    expect(sqlCall.strings.join(' ')).toMatch(/::int\[\]/);
    // The bound value must be the literal `'{10,11,12}'` string, NOT the
    // JS array (which would trigger drizzle's splat path).
    expect(sqlCall.values).toContain('{10,11,12}');
    expect(sqlCall.values.some((v) => Array.isArray(v))).toBe(false);
  });

  it('COALESCE chain is auth_user.dj_name → shows.legacy_dj_name only (no auth_user.name fallback — PII regression guard)', async () => {
    mockExecute.mockResolvedValueOnce({ count: 0 });

    await reresolveMarkerDjNames([10]);

    const sql = lastSqlBlob();
    expect(sql).toMatch(/COALESCE\(\s*u\.dj_name\s*,\s*s\.legacy_dj_name\s*\)/);
    expect(sql).not.toMatch(/u\.name\b/);
  });

  it('only re-resolves marker rows (entry_type IN show_start/show_end/dj_join/dj_leave)', async () => {
    mockExecute.mockResolvedValueOnce({ count: 0 });

    await reresolveMarkerDjNames([10]);

    const sql = lastSqlBlob();
    expect(sql).toMatch(/entry_type\s+IN\s*\(/i);
    expect(sql).toMatch(/'show_start'/);
    expect(sql).toMatch(/'show_end'/);
    expect(sql).toMatch(/'dj_join'/);
    expect(sql).toMatch(/'dj_leave'/);
    expect(sql).not.toMatch(/'track'/);
  });

  it('short-circuits without SQL when no shows were touched (idempotent no-op)', async () => {
    const updated = await reresolveMarkerDjNames([]);

    expect(updated).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns the postgres-js result.count value', async () => {
    mockExecute.mockResolvedValueOnce({ count: 1234 });

    const updated = await reresolveMarkerDjNames([10]);

    expect(updated).toBe(1234);
  });
});

describe('legacy-dj-name-remediation: analyzeTables', () => {
  it('issues ANALYZE on both shows and flowsheet (paired-bulk rule, docs/bulk-update-playbook.md)', async () => {
    mockExecute.mockResolvedValue(undefined);

    await analyzeTables();

    const blobs = sqlBlobs();
    expect(blobs.some((s) => /ANALYZE/i.test(s) && /shows/.test(s))).toBe(true);
    expect(blobs.some((s) => /ANALYZE/i.test(s) && /flowsheet/.test(s))).toBe(true);
  });
});

describe('legacy-dj-name-remediation: fetchHandleMappings', () => {
  it('skips rows whose handle contains an embedded NUL byte (Postgres refuses, would abort batch)', async () => {
    const mirror = {
      send: jest.fn<() => Promise<string>>().mockResolvedValue('1001\tDJ Bluejay\n1002\tBad\0Name\n1003\tdj wilde\n'),
      close: jest.fn(),
    };

    const mappings = await fetchHandleMappings(mirror as never);

    expect(mappings).toEqual([
      { showId: 1001, djHandle: 'DJ Bluejay' },
      { showId: 1003, djHandle: 'dj wilde' },
    ]);
  });

  it('truncates DJ_HANDLE to 128 chars to match shows.legacy_dj_name varchar(128) ceiling', async () => {
    // Production prior incident: a 300+ char DJ_HANDLE (the Cynocephalus
    // handle, tubafrenzy#573) aborts the batch CTE mid-pass with `value too
    // long for type character varying(128)`. The flowsheet ETL truncates at
    // the source; this fetcher must do the same so the remediation matches
    // what the ETL would write on the same row.
    const longHandle = 'A'.repeat(300);
    const mirror = {
      send: jest.fn<() => Promise<string>>().mockResolvedValue(`1001\t${longHandle}\n`),
      close: jest.fn(),
    };

    const mappings = await fetchHandleMappings(mirror as never);

    expect(mappings).toEqual([{ showId: 1001, djHandle: 'A'.repeat(128) }]);
  });

  it('treats empty / NULL / whitespace handles as null', async () => {
    // Use a sentinel non-whitespace value as the last row's handle so the
    // outer `.trim()` doesn't strip the row's tab delimiter and trigger the
    // `cols.length < 2` skip path (which is correct behaviour, just not what
    // we are testing here).
    const mirror = {
      send: jest.fn<() => Promise<string>>().mockResolvedValue('1001\tDJ Bluejay\n1002\t\n1003\tNULL\n1004\t   \nXXX'),
      close: jest.fn(),
    };

    const mappings = await fetchHandleMappings(mirror as never);

    expect(mappings).toContainEqual({ showId: 1001, djHandle: 'DJ Bluejay' });
    expect(mappings).toContainEqual({ showId: 1002, djHandle: null });
    expect(mappings).toContainEqual({ showId: 1003, djHandle: null });
    expect(mappings).toContainEqual({ showId: 1004, djHandle: null });
  });
});

describe('legacy-dj-name-remediation: BATCH_SIZE', () => {
  it('matches the established one-shot-job convention (5000)', () => {
    expect(BATCH_SIZE).toBe(5000);
  });
});
