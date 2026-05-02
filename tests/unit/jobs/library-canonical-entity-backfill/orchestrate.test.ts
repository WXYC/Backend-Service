/**
 * Unit tests for the B-1.2 backfill orchestrator.
 *
 * The orchestrator iterates library rows where the canonical entity is
 * unresolved, calls LML per row, and writes the resolution. Tests cover:
 *
 *   - applyResolution writes the right columns for each Resolution branch
 *     (auto_accept stamps id+confidence+resolved_at; review stamps
 *     resolved_at only; no_match stamps nothing so the row is retried).
 *   - processRow stitches the lookup → resolve → write pipeline and degrades
 *     gracefully on LML errors (no stamping, error logged).
 *   - runBackfill loops until loadBatch returns empty, paginates by id, and
 *     respects the inter-call throttle.
 */

import { db } from '@wxyc/database';
import {
  applyResolution,
  processRow,
  resolvePartitionFilter,
  runBackfill,
  BATCH_SIZE,
  THROTTLE_MS,
} from '../../../../jobs/library-canonical-entity-backfill/orchestrate';
import type { Resolution } from '../../../../jobs/library-canonical-entity-backfill/resolve';
import type { LmlLookupResponse } from '../../../../jobs/library-canonical-entity-backfill/lml-types';

/**
 * Render a drizzle `sql` template object to a string for substring
 * assertions. Drizzle's `db.execute(sql\`...\`)` argument serializes to
 * `{ sql: string[], values: unknown[] }` where `sql` is the literal
 * template fragments and `values` is the interpolated parameters in
 * positional order. Reconstruct the rendered SQL by interleaving them.
 *
 * Each value can itself be a nested `sql.raw(...)` chunk (whose
 * `queryChunks` re-fold into `value: string[]`), or a parameter, or
 * another nested SQL template — recurse where applicable.
 */
type SqlChunk = {
  value?: string | string[];
  queryChunks?: SqlChunk[];
  raw?: string;
};
type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<string | SqlChunk>;
  raw?: string;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) {
    const fragments = obj.sql;
    const values = obj.values ?? [];
    let out = '';
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

/** Render a single interpolated value: strings/numbers verbatim, nested SQL recursively. */
const renderValue = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as SqlChunk & SqlLike;
    // sql.raw(...) serializes to { raw: string }
    if (typeof o.raw === 'string') return o.raw;
    if (Array.isArray(o.queryChunks) || Array.isArray(o.sql)) return renderSql(o);
    if (Array.isArray(o.value)) return o.value.join('');
    if (typeof o.value === 'string') return o.value;
  }
  return '';
};

const findExecuteCallMatching = (pattern: RegExp): unknown[] | undefined => {
  const calls = (db.execute as jest.Mock).mock.calls;
  return calls.find((call) => pattern.test(renderSql(call[0])));
};

const directResponse = (releaseId: number): LmlLookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id: releaseId } }],
  search_type: 'direct',
});

const fallbackResponse = (releaseId: number): LmlLookupResponse => ({
  results: [{ library_item: { id: 1 }, artwork: { release_id: releaseId } }],
  search_type: 'fallback',
});

const emptyResponse = (): LmlLookupResponse => ({
  results: [],
  search_type: 'none',
});

describe('applyResolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes id, confidence, and resolved_at on auto_accept', async () => {
    // Auto-accept is the only branch that fills canonical_entity_id. The
    // resolved_at stamp is what makes re-runs idempotent (the WHERE filter
    // skips already-stamped rows).
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });
    const resolution: Resolution = {
      status: 'auto_accept',
      canonical_entity_id: 'discogs:987654',
      confidence: 0.95,
    };

    await applyResolution(42, resolution);

    const call = findExecuteCallMatching(/UPDATE[\s\S]*library/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/canonical_entity_id/i);
    expect(sqlText).toMatch(/canonical_entity_confidence/i);
    expect(sqlText).toMatch(/canonical_entity_resolved_at"?\s*=\s*now\(\)/i);
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('discogs:987654');
    expect(serialized).toContain('42');
  });

  it('stamps resolved_at only on review (canonical_entity_id stays NULL)', async () => {
    // Review-flagged rows are picked up by B-3.1 by querying
    // (canonical_entity_id IS NULL AND canonical_entity_resolved_at IS NOT NULL).
    // Writing a non-null id here would silently auto-accept a fallback hit.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });

    await applyResolution(42, { status: 'review' });

    const call = findExecuteCallMatching(/UPDATE[\s\S]*library/i);
    expect(call).toBeDefined();
    const sqlText = renderSql(call?.[0]);
    expect(sqlText).toMatch(/canonical_entity_resolved_at"?\s*=\s*now\(\)/i);
    expect(sqlText).not.toMatch(/SET[\s\S]*canonical_entity_id"?\s*=/i);
  });

  it('writes nothing on no_match so the next sweep retries', async () => {
    // B-0: empty / unpinable matches are "discard, retry on next sweep". The
    // backfill's WHERE filter is `canonical_entity_id IS NULL AND
    // canonical_entity_resolved_at IS NULL`, so any UPDATE here would
    // remove the row from the retry pool and lose the eventual recovery.
    await applyResolution(42, { status: 'no_match' });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe('processRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls the injected lookup with the row artist and album', async () => {
    // Verifies the wiring between row → lookup. If a future change
    // accidentally swaps artist/album, downstream resolution would still
    // succeed on some inputs but be silently wrong.
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });
    const lookup = jest.fn(() => Promise.resolve(directResponse(123)));

    await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup });

    expect(lookup).toHaveBeenCalledWith('Juana Molina', 'DOGA');
  });

  it('stamps auto_accept on a direct hit', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });
    const lookup = jest.fn(() => Promise.resolve(directResponse(987654)));

    const status = await processRow({ id: 7, artist_name: 'Juana Molina', album_title: 'DOGA' }, { lookup });

    expect(status).toBe('auto_accept');
    const call = findExecuteCallMatching(/UPDATE[\s\S]*library/i);
    const serialized = JSON.stringify(call?.[0]);
    expect(serialized).toContain('discogs:987654');
  });

  it('stamps review on a fallback hit', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ count: 1 });
    const lookup = jest.fn(() => Promise.resolve(fallbackResponse(33)));

    const status = await processRow({ id: 7, artist_name: 'Jessica Pratt', album_title: 'On Your Own' }, { lookup });

    expect(status).toBe('review');
  });

  it('writes nothing and reports no_match on an empty LML response', async () => {
    const lookup = jest.fn(() => Promise.resolve(emptyResponse()));

    const status = await processRow({ id: 7, artist_name: 'Unknown', album_title: 'Unknown' }, { lookup });

    expect(status).toBe('no_match');
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });

  it('returns error on LML failure without stamping the row (so the next sweep retries)', async () => {
    // Failure tolerance: LML timeouts and 5xx must not poison-pill the row.
    // Stamping resolved_at on error would remove the row from the retry
    // pool — the issue's "failure tolerant" requirement.
    const lookup = jest.fn(() => Promise.reject(new Error('LML request timed out')));

    const status = await processRow({ id: 7, artist_name: 'Stereolab', album_title: 'Dots and Loops' }, { lookup });

    expect(status).toBe('error');
    expect((db.execute as jest.Mock).mock.calls.length).toBe(0);
  });
});

describe('runBackfill', () => {
  beforeEach(() => {
    // mockReset (not just clearAllMocks) — runBackfill tests queue per-test
    // mockResolvedValueOnce values, and clearAllMocks leaves queued values
    // intact. Without reset, an unused queued value from one test feeds the
    // next test's first db.execute call.
    (db.execute as jest.Mock).mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a sensible BATCH_SIZE (bounded reads — never SELECT *)', () => {
    // The library has tens of thousands of rows. An unbounded SELECT would
    // pin a connection for minutes; a too-small batch would explode the
    // round-trip overhead per row.
    expect(BATCH_SIZE).toBeGreaterThanOrEqual(50);
    expect(BATCH_SIZE).toBeLessThanOrEqual(2000);
  });

  it('throttles between LML calls (THROTTLE_MS > 0)', () => {
    // Throttle is a real LML rate-limit guard, not a configuration hook —
    // dropping it to 0 risks stampeding LML when the backfill runs.
    expect(THROTTLE_MS).toBeGreaterThan(0);
  });

  describe('resolvePartitionFilter', () => {
    it('returns no fragment when partitioning is disabled (default count=1)', () => {
      const r = resolvePartitionFilter(undefined, undefined);
      expect(r.sqlFragment).toBeNull();
      expect(r.description).toBe('partition=none');
    });

    it('returns a modulo fragment when count > 1', () => {
      const r = resolvePartitionFilter('2', '4');
      expect(r.sqlFragment).not.toBeNull();
      const serialized = JSON.stringify(r.sqlFragment);
      expect(serialized).toContain('%');
      expect(r.description).toBe('partition=2/4');
    });

    it('rejects out-of-range partition index', () => {
      expect(() => resolvePartitionFilter('4', '4')).toThrow(/PARTITION_INDEX/);
      expect(() => resolvePartitionFilter('-1', '4')).toThrow(/PARTITION_INDEX/);
    });

    it('rejects non-positive partition count', () => {
      expect(() => resolvePartitionFilter('0', '0')).toThrow(/PARTITION_COUNT/);
      expect(() => resolvePartitionFilter('0', '-1')).toThrow(/PARTITION_COUNT/);
    });

    it('rejects non-integer values', () => {
      expect(() => resolvePartitionFilter('1.5', '4')).toThrow(/PARTITION_INDEX/);
      expect(() => resolvePartitionFilter('0', '2.5')).toThrow(/PARTITION_COUNT/);
      expect(() => resolvePartitionFilter('abc', '4')).toThrow(/PARTITION_INDEX/);
    });
  });

  it('plumbs the partition fragment into loadBatch when count > 1', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await runBackfill({
      lookup: jest.fn(),
      throttleMs: 0,
      partition: resolvePartitionFilter('1', '3'),
    });

    const select = findExecuteCallMatching(/SELECT/i);
    const serialized = JSON.stringify(select?.[0]);
    // The partition fragment is parameterized with `id % count = index`.
    // Both numbers appear among the bound values.
    expect(serialized).toContain('%');
  });

  it('qualifies the partition column as l."id" so it does not collide with artists.id', async () => {
    // Regression for the first prod run with PARTITIONS=4: every container
    // crashed with `column reference "id" is ambiguous` because the
    // partition fragment used unqualified "id" while loadBatch joins
    // library against artists (both have an `id` column). The default
    // qualifier in B-1.2's resolvePartitionFilter must be `l."id"`.
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await runBackfill({
      lookup: jest.fn(),
      throttleMs: 0,
      partition: resolvePartitionFilter('1', '3'),
    });

    const select = findExecuteCallMatching(/SELECT/i);
    const serialized = JSON.stringify(select?.[0]);
    // Qualified `l."id"` survives JSON serialization as `l.\\"id\\"`.
    expect(serialized).toContain('l.\\"id\\"');
  });

  it('iterates batches until loadBatch returns empty', async () => {
    // First batch: two rows. Second batch: one row. Third batch: empty → terminate.
    // 3 SELECTs (loadBatch) + (2 + 1) UPDATEs = 6 db.execute calls in this scenario.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'Andy Stott', album_title: 'Faith In Strangers' },
        { id: 2, artist_name: 'Loney Dear', album_title: 'Dear John' },
      ])
      .mockResolvedValueOnce({ count: 1 }) // UPDATE for id=1
      .mockResolvedValueOnce({ count: 1 }) // UPDATE for id=2
      .mockResolvedValueOnce([{ id: 3, artist_name: 'Cat Power', album_title: 'Sun' }])
      .mockResolvedValueOnce({ count: 1 }) // UPDATE for id=3
      .mockResolvedValueOnce([]); // empty → terminate

    const lookup = jest.fn(() => Promise.resolve(directResponse(111)));

    const result = await runBackfill({ lookup, throttleMs: 0 });

    expect(lookup).toHaveBeenCalledTimes(3);
    expect(result.totals.auto_accept).toBe(3);
    expect(result.totals.scanned).toBe(3);
  });

  it('exits cleanly on the first empty batch (already-backfilled state)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]);
    const lookup = jest.fn();

    const result = await runBackfill({ lookup, throttleMs: 0 });

    expect(lookup).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(0);
  });

  it('joins library against artists to read artist_name (denormalized library column is NULL)', async () => {
    // Regression: the library schema has both `artist_id` (FK) and a
    // denormalized `artist_name` column. The denormalized column is NULL
    // on every row in production; the source of truth is
    // `wxyc_schema.artists.artist_name` reached via the FK. Without the
    // JOIN, processRow short-circuits to no_match for every row and the
    // job runs at throttle speed without ever calling LML.
    (db.execute as jest.Mock).mockResolvedValueOnce([]);

    await runBackfill({ lookup: jest.fn(), throttleMs: 0 });

    const select = findExecuteCallMatching(/SELECT/i);
    const sqlText = renderSql(select?.[0]);
    expect(sqlText).toMatch(/FROM\s+"wxyc_schema"\."library"/i);
    expect(sqlText).toMatch(/JOIN\s+"wxyc_schema"\."artists"/i);
    expect(sqlText).toMatch(/a\."artist_name"/i);
    expect(sqlText).toMatch(/a\."id"\s*=\s*l\."artist_id"/i);
  });

  it('paginates forward by id (last-id cursor restartable across batches)', async () => {
    // The second loadBatch must filter `id > 2` (the last id from batch 1)
    // — otherwise we'd re-scan the same rows forever (the WHERE filter on
    // canonical_entity_id IS NULL still matches a row that we just updated
    // to review-status).
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
      ])
      .mockResolvedValueOnce({ count: 1 }) // UPDATE for id=1
      .mockResolvedValueOnce({ count: 1 }) // UPDATE for id=2
      .mockResolvedValueOnce([]);

    const lookup = jest.fn(() => Promise.resolve(directResponse(111)));
    await runBackfill({ lookup, throttleMs: 0 });

    const selectCalls = (db.execute as jest.Mock).mock.calls
      .map((c) => renderSql(c[0]))
      .filter((s) => /SELECT/i.test(s));
    // Two SELECTs: initial scan (id > 0 or no lower bound), and second scan
    // bounded by the last-seen id from batch 1.
    expect(selectCalls.length).toBe(2);
    const secondSelectSerialized = JSON.stringify(
      (db.execute as jest.Mock).mock.calls.filter((c) => /SELECT/i.test(renderSql(c[0])))[1]?.[0]
    );
    expect(secondSelectSerialized).toContain('2');
  });

  it('counts each Resolution branch separately for the run report', async () => {
    // The summary the operator sees is what tells us whether B-3.1's review
    // queue is going to have anything in it. Counting auto_accept separately
    // from review separately from no_match is the whole point of running the
    // job.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
        { id: 3, artist_name: 'c', album_title: 'c' },
      ])
      .mockResolvedValueOnce({ count: 1 }) // auto_accept update
      .mockResolvedValueOnce({ count: 1 }) // review update
      .mockResolvedValueOnce([]);

    let call = 0;
    const lookup = jest.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(directResponse(111));
      if (call === 2) return Promise.resolve(fallbackResponse(222));
      return Promise.resolve(emptyResponse());
    });

    const result = await runBackfill({ lookup, throttleMs: 0 });

    expect(result.totals.auto_accept).toBe(1);
    expect(result.totals.review).toBe(1);
    expect(result.totals.no_match).toBe(1);
    expect(result.totals.error).toBe(0);
    expect(result.totals.scanned).toBe(3);
  });

  it('keeps going when a single row errors (failure-tolerant — does not abort the run)', async () => {
    // One LML failure must not poison the run. The error count goes up; the
    // scan continues. Operationally the row stays NULL (no resolved_at)
    // and gets retried on the next sweep.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'a', album_title: 'a' },
        { id: 2, artist_name: 'b', album_title: 'b' },
      ])
      .mockResolvedValueOnce({ count: 1 }) // UPDATE for id=2 (id=1 errored, no UPDATE)
      .mockResolvedValueOnce([]);

    let call = 0;
    const lookup = jest.fn(() => {
      call += 1;
      if (call === 1) return Promise.reject(new Error('LML 502'));
      return Promise.resolve(directResponse(222));
    });

    const result = await runBackfill({ lookup, throttleMs: 0 });

    expect(result.totals.error).toBe(1);
    expect(result.totals.auto_accept).toBe(1);
    expect(result.totals.scanned).toBe(2);
  });
});
