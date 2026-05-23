/**
 * Unit tests for the album_metadata historical backfill job (Epic D / BS#898).
 *
 * The backfill is the runtime counterpart to migration 0079 (D1): after the
 * `album_metadata` table is created (empty), this job populates it from the
 * enriched subset of flowsheet rows via a single INSERT ... SELECT DISTINCT ON.
 * D3 (#899) is the writer cutover that keeps `album_metadata` fresh for new
 * enrichments; D4 (#900) drops the inline columns after stabilization.
 *
 * These tests use the @wxyc/database mock and inspect the SQL text generated
 * by Drizzle. They cover the load-bearing semantics of the migration query
 * (which columns, the right filter, DISTINCT ON, ORDER BY tiebreak, ON CONFLICT
 * DO NOTHING, COALESCE on updated_at) and the verify / loop control surface.
 */

import { db } from '@wxyc/database';
import {
  runBackfill,
  verifyComplete,
  analyzeTable,
  formatDuration,
} from '../../../../jobs/album-metadata-backfill/job';

type SqlLike = {
  sql?: string | string[];
  raw?: string;
  queryChunks?: Array<string | { value?: string | string[]; raw?: string }>;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (typeof chunk.raw === 'string') return chunk.raw;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

describe('album-metadata-backfill: runBackfill query shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs inside a transaction so SET LOCAL statement_timeout takes effect', async () => {
    // SET LOCAL only scopes to the current transaction. Outside a transaction
    // (postgres-js auto-commits per execute), it's a silent no-op — and the
    // 15-minute guardrail disappears. The whole job must run inside
    // db.transaction.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
  });

  it('sets statement_timeout to 15min inside the transaction', async () => {
    // Guardrail: a runaway SELECT over the 2.6M-row flowsheet would otherwise
    // hold a SHARE lock and pollute the buffer cache indefinitely.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    const call = findExecuteCallMatching(/SET\s+LOCAL\s+statement_timeout/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/15\s*min/i);
  });

  it('targets the album_metadata table with the full 11-column INSERT list', async () => {
    // Migration 0079 defines 11 NOT NULL/nullable columns (album_id PK + 9 URL
    // fields + release_year + updated_at). Drift here would either lose data
    // or fail on a missing column.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    const call = findExecuteCallMatching(/INSERT\s+INTO[\s\S]*album_metadata/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/"?album_metadata"?/i);
    for (const col of [
      'album_id',
      'artwork_url',
      'discogs_url',
      'release_year',
      'spotify_url',
      'apple_music_url',
      'youtube_music_url',
      'bandcamp_url',
      'soundcloud_url',
      'artist_bio',
      'artist_wikipedia_url',
      'updated_at',
    ]) {
      expect(sqlText).toMatch(new RegExp(`"${col}"`, 'i'));
    }
  });

  it('filters flowsheet rows by metadata_attempt_at IS NOT NULL (not by artwork_url IS NOT NULL)', async () => {
    // The narrower URL filter would miss `enriched_no_match` rows — LML
    // succeeded but found no Discogs match, populating only synthesized
    // YouTube/Bandcamp/SoundCloud URLs (BS#873 fallback). The filter must be
    // on the enrichment-success marker, not on any specific URL column.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    const call = findExecuteCallMatching(/INSERT\s+INTO[\s\S]*album_metadata/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/metadata_attempt_at"?\s+IS\s+NOT\s+NULL/i);
    expect(sqlText).toMatch(/album_id"?\s+IS\s+NOT\s+NULL/i);
    // Explicit anti-assertion: the artwork_url / discogs_url URL-filter pattern
    // must not be the gate.
    expect(sqlText).not.toMatch(/artwork_url"?\s+IS\s+NOT\s+NULL\s+OR\s+"?discogs_url/i);
  });

  it('uses DISTINCT ON (album_id) with ORDER BY metadata_attempt_at DESC NULLS LAST to pick the newest enrichment', async () => {
    // For an album played 50 times, we want the most recent enrichment row's
    // data. DISTINCT ON depends on the matching ORDER BY prefix; the tiebreak
    // is metadata_attempt_at DESC. NULLS LAST is defensive against any
    // surviving NULL slipping through the WHERE filter.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    const call = findExecuteCallMatching(/INSERT\s+INTO[\s\S]*album_metadata/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/DISTINCT\s+ON\s*\(\s*"?album_id"?\s*\)/i);
    expect(sqlText).toMatch(/ORDER\s+BY\s+"?album_id"?\s*,\s*"?metadata_attempt_at"?\s+DESC\s+NULLS\s+LAST/i);
  });

  it('uses ON CONFLICT (album_id) DO NOTHING so re-runs are idempotent', async () => {
    // The job is restartable: running again on a partially-populated table
    // must not overwrite existing rows. D3 (#899)'s live writer owns later
    // updates via its own UPSERT with a setWhere race guard.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    const call = findExecuteCallMatching(/INSERT\s+INTO[\s\S]*album_metadata/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/ON\s+CONFLICT\s*\(\s*"?album_id"?\s*\)\s+DO\s+NOTHING/i);
  });

  it('seeds album_metadata.updated_at from COALESCE(metadata_attempt_at, now()) — preserving enrichment lineage', async () => {
    // Stamping NOW() loses the original enrichment timeline, which D4's
    // 30-day stabilization read of `album_metadata.updated_at < f.metadata_attempt_at`
    // depends on. COALESCE keeps the original timestamp when present and
    // falls back to NOW() only for the rare row missing it.
    (db.execute as jest.Mock).mockResolvedValue({ count: 0 });

    await runBackfill();

    const call = findExecuteCallMatching(/INSERT\s+INTO[\s\S]*album_metadata/i);
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/COALESCE\s*\(\s*"?metadata_attempt_at"?\s*,\s*now\s*\(\s*\)\s*\)/i);
  });

  it('returns the postgres-js result.count as the rows-inserted number', async () => {
    // Two execute calls inside the transaction: SET LOCAL then the INSERT.
    // The second is the one whose count we surface.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 4321 });

    const inserted = await runBackfill();

    expect(inserted).toBe(4321);
  });

  it('returns 0 when the INSERT result has no count property', async () => {
    (db.execute as jest.Mock).mockResolvedValue({});

    const inserted = await runBackfill();

    expect(inserted).toBe(0);
  });
});

describe('album-metadata-backfill: verifyComplete', () => {
  const ORIGINAL_TIMEOUT_ENV = process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS;

  // The verify scan walks the IS NOT NULL partition of flowsheet (~2.6M rows;
  // partial index #660 covers IS NULL only). It must run inside `db.transaction`
  // with a per-tx `SET LOCAL statement_timeout` lifted above the backend's 5 s
  // default, because postgres-js auto-commits per `execute` otherwise — so
  // both `SET LOCAL` and the dual-count `SELECT` have to land on the closure-
  // bound `tx`, not the top-level `db`. The real failure mode the previous
  // PR (#1020) missed wasn't call-ordering; it was the two statements running
  // on different pooled connections. These tests pin the tx-binding by
  // installing a fake `tx` per call and asserting `db.execute` stays untouched.
  const installTx = (results: unknown[]): jest.Mock => {
    const txExecute = jest.fn();
    for (const r of results) {
      txExecute.mockResolvedValueOnce(r);
    }
    (db.transaction as jest.Mock).mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: txExecute })
    );
    return txExecute;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    delete process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS;
    // clearAllMocks resets call history but not queued mockImplementationOnce.
    // If a verify test throws before consuming the transaction (e.g. on
    // invalid-env tests), the unconsumed queued impl would bleed into the
    // next test. Reset + restore the default tx === db pass-through.
    (db.transaction as jest.Mock).mockReset();
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (ORIGINAL_TIMEOUT_ENV === undefined) {
      delete process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS;
    } else {
      process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
    }
  });

  it('runs inside db.transaction with both statements on the closure-bound tx (not db.execute)', async () => {
    const txExecute = installTx([undefined, [{ actual: 7101, expected: 7101 }]]);

    await verifyComplete();

    expect((db.transaction as jest.Mock).mock.calls.length).toBe(1);
    expect(txExecute).toHaveBeenCalledTimes(2);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('issues SET LOCAL statement_timeout as the first transaction statement, then the dual-count SELECT', async () => {
    const txExecute = installTx([undefined, [{ actual: 0, expected: 0 }]]);

    await verifyComplete();

    const firstCall = txExecute.mock.calls[0]?.[0];
    expect(renderSql(firstCall)).toMatch(/SET\s+LOCAL\s+statement_timeout/i);
    const secondCall = txExecute.mock.calls[1]?.[0];
    expect(renderSql(secondCall)).toMatch(/SELECT[\s\S]*count[\s\S]*album_metadata/i);
  });

  it('defaults the verify statement_timeout to 120000ms when ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS is unset', async () => {
    const txExecute = installTx([undefined, [{ actual: 0, expected: 0 }]]);

    await verifyComplete();

    const setLocalSql = renderSql(txExecute.mock.calls[0]?.[0]);
    expect(setLocalSql).toMatch(/120000\s*ms/i);
  });

  it('reads ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS to override the default timeout', async () => {
    process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS = '90000';
    const txExecute = installTx([undefined, [{ actual: 0, expected: 0 }]]);

    await verifyComplete();

    const setLocalSql = renderSql(txExecute.mock.calls[0]?.[0]);
    expect(setLocalSql).toMatch(/90000\s*ms/i);
    expect(setLocalSql).not.toMatch(/120000/);
  });

  it('throws on non-numeric ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS rather than silently defaulting', async () => {
    process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS = 'not-a-number';
    installTx([undefined, [{ actual: 0, expected: 0 }]]);

    await expect(verifyComplete()).rejects.toThrow(/ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS/);
  });

  it('throws on non-positive ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS rather than silently defaulting', async () => {
    process.env.ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS = '0';
    installTx([undefined, [{ actual: 0, expected: 0 }]]);

    await expect(verifyComplete()).rejects.toThrow(/ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS/);
  });

  it('passes when album_metadata count equals the enriched flowsheet album count', async () => {
    installTx([undefined, [{ actual: 7101, expected: 7101 }]]);

    await expect(verifyComplete()).resolves.toBeUndefined();
  });

  it('passes when actual > expected (a concurrent live write between INSERT and verify)', async () => {
    // D3 (#899) will ship a live UPSERT writer into album_metadata. After it
    // lands, a write that arrives between this job's INSERT and the verify
    // produces actual > expected without losing data. A strict equality check
    // would false-fail in that window; `>=` is the correct invariant.
    installTx([undefined, [{ actual: 7102, expected: 7101 }]]);

    await expect(verifyComplete()).resolves.toBeUndefined();
  });

  it('throws with both counts and the idempotent re-run hint when album_metadata is short', async () => {
    installTx([undefined, [{ actual: 6964, expected: 7101 }]]);

    let caught: Error | undefined;
    try {
      await verifyComplete();
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/6964/);
    expect(caught?.message).toMatch(/7101/);
    expect(caught?.message).toMatch(/idempotent/i);
  });

  it('uses a dual-count comparison instead of a LEFT JOIN over flowsheet', async () => {
    const txExecute = installTx([undefined, [{ actual: 0, expected: 0 }]]);

    await verifyComplete();

    const selectSql = renderSql(txExecute.mock.calls[1]?.[0]);
    expect(selectSql).not.toMatch(/LEFT\s+JOIN/i);
    expect(selectSql).toMatch(/count\([\s\S]*\)[\s\S]*album_metadata/i);
    expect(selectSql).toMatch(/count\(\s*DISTINCT[\s\S]*album_id[\s\S]*\)[\s\S]*flowsheet/i);
    expect(selectSql).toMatch(/album_id"?\s+IS\s+NOT\s+NULL/i);
    expect(selectSql).toMatch(/metadata_attempt_at"?\s+IS\s+NOT\s+NULL/i);
  });
});

describe('album-metadata-backfill: analyzeTable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('issues ANALYZE on album_metadata (pairing the bulk insert with planner stats refresh)', async () => {
    // Per docs/bulk-update-playbook.md: every bulk operation pairs with
    // ANALYZE so the planner stops using stale (empty-table) statistics.
    (db.execute as jest.Mock).mockResolvedValueOnce(undefined);

    await analyzeTable();

    const call = findExecuteCallMatching(/ANALYZE/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/ANALYZE\s+"?wxyc_schema"?\."?album_metadata"?/i);
  });
});

describe('album-metadata-backfill: formatDuration', () => {
  it('formats sub-minute durations as "0m Xs"', () => {
    expect(formatDuration(0)).toBe('0m 0s');
    expect(formatDuration(1500)).toBe('0m 2s');
    expect(formatDuration(45_000)).toBe('0m 45s');
  });

  it('formats multi-minute durations as "Xm Ys"', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });
});
