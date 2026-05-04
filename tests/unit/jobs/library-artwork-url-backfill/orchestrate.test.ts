/**
 * Unit tests for library-artwork-url-backfill orchestrate.ts.
 *
 * Pins the orchestrator's contract:
 *   1. The loadBatch SELECT carries the canonical filter (library JOIN
 *      artists, l.artwork_url IS NULL, a.discogs_artist_id IS NOT NULL,
 *      id-cursor, ORDER BY id ASC, LIMIT batchSize).
 *   2. processRow returns 'lml_error' on a thrown lookup; the orchestrator
 *      counts it and continues. The row stays artwork_url IS NULL via
 *      `applyEnrichment` *not* being called on the error path.
 *   3. Match → enriched_match outcome; no-match → enriched_no_match outcome;
 *      raced match → enriched_match_raced. Totals are bumped on the right
 *      counter.
 *   4. resolvePartitionFilter handles default (no-op), valid N/M, and
 *      throws on bad inputs.
 *   5. The id-cursor advances across batches and the loop terminates when
 *      a batch returns empty.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import {
  BATCH_SIZE,
  THROTTLE_MS,
  processRow,
  resolveBatchSize,
  resolvePartitionFilter,
  resolveThrottleMs,
  runBackfill,
  type EnrichFn,
  type LookupFn,
} from '../../../../jobs/library-artwork-url-backfill/orchestrate';
import type { LmlLookupResponse } from '../../../../jobs/library-artwork-url-backfill/lml-types';

type SqlLike = { sql?: string | string[]; queryChunks?: Array<string | { value?: string | string[] }> };
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

const matchedResponse: LmlLookupResponse = {
  results: [{ library_item: { id: 1 }, artwork: { artwork_url: 'https://i.discogs.com/art.jpg' } }],
  search_type: 'direct',
};

const noMatchResponse: LmlLookupResponse = {
  results: [],
  search_type: 'none',
};

describe('resolvePartitionFilter', () => {
  it('returns no-op when neither env var set', () => {
    const got = resolvePartitionFilter(undefined, undefined);
    expect(got.sqlFragment).toBeNull();
    expect(got.description).toBe('partition=none');
  });

  it('returns mod-N filter for valid PARTITION_INDEX/PARTITION_COUNT', () => {
    const got = resolvePartitionFilter('1', '4');
    expect(got.sqlFragment).not.toBeNull();
    expect(got.description).toBe('partition=1/4');
    const rendered = renderSql(got.sqlFragment);
    expect(rendered).toMatch(/AND.*%/);
  });

  it('throws on PARTITION_COUNT=0', () => {
    expect(() => resolvePartitionFilter('0', '0')).toThrow(/PARTITION_COUNT/);
  });

  it('throws on PARTITION_INDEX out of range', () => {
    expect(() => resolvePartitionFilter('4', '4')).toThrow(/PARTITION_INDEX/);
    expect(() => resolvePartitionFilter('-1', '4')).toThrow(/PARTITION_INDEX/);
  });

  it('throws on non-integer inputs', () => {
    expect(() => resolvePartitionFilter('1', 'abc')).toThrow(/PARTITION_COUNT/);
    expect(() => resolvePartitionFilter('1.5', '4')).toThrow(/PARTITION_INDEX/);
  });
});

describe('resolveBatchSize', () => {
  it('falls back to BATCH_SIZE when env var is unset', () => {
    expect(resolveBatchSize(undefined)).toBe(BATCH_SIZE);
  });

  it('returns the parsed value for a valid positive integer', () => {
    expect(resolveBatchSize('1000')).toBe(1000);
    expect(resolveBatchSize('1')).toBe(1);
  });

  it('throws on zero, negative, non-integer, or garbage input', () => {
    expect(() => resolveBatchSize('0')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('-100')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('1.5')).toThrow(/BACKFILL_BATCH_SIZE/);
    expect(() => resolveBatchSize('abc')).toThrow(/BACKFILL_BATCH_SIZE/);
  });
});

describe('resolveThrottleMs', () => {
  it('falls back to THROTTLE_MS when env var is unset', () => {
    expect(resolveThrottleMs(undefined)).toBe(THROTTLE_MS);
  });

  it('accepts 0 (pilot/CI runs may want no inter-row sleep)', () => {
    expect(resolveThrottleMs('0')).toBe(0);
  });

  it('returns the parsed value for a positive integer', () => {
    expect(resolveThrottleMs('250')).toBe(250);
  });

  it('throws on negative, non-integer, or garbage input', () => {
    expect(() => resolveThrottleMs('-50')).toThrow(/BACKFILL_THROTTLE_MS/);
    expect(() => resolveThrottleMs('1.5')).toThrow(/BACKFILL_THROTTLE_MS/);
    expect(() => resolveThrottleMs('abc')).toThrow(/BACKFILL_THROTTLE_MS/);
  });
});

describe('processRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const row = { id: 42, artist_name: 'Juana Molina', album_title: 'DOGA' };

  it('returns enriched_match and calls enrich on LML success-with-match', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResponse);
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

    const outcome = await processRow(row, { lookup, enrich });

    expect(outcome).toBe('enriched_match');
    expect(lookup).toHaveBeenCalledWith('Juana Molina', 'DOGA');
    expect(enrich).toHaveBeenCalledWith(row, matchedResponse);
  });

  it('returns enriched_no_match and calls enrich on LML no-match', async () => {
    const lookup = jest.fn<LookupFn>().mockResolvedValue(noMatchResponse);
    const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_no_match');

    const outcome = await processRow(row, { lookup, enrich });

    expect(outcome).toBe('enriched_no_match');
    expect(enrich).toHaveBeenCalledWith(row, noMatchResponse);
  });

  it('returns lml_error and does NOT call enrich on LML throw (row stays retryable)', async () => {
    const lookup = jest.fn<LookupFn>().mockRejectedValue(new Error('LML 502'));
    const enrich = jest.fn<EnrichFn>();

    const outcome = await processRow(row, { lookup, enrich });

    expect(outcome).toBe('lml_error');
    // Critical: the row's artwork_url stays NULL because we never call
    // enrich. The next sweep can re-attempt transient LML failures.
    expect(enrich).not.toHaveBeenCalled();
  });
});

describe('runBackfill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const lookup = jest.fn<LookupFn>().mockResolvedValue(matchedResponse);
  const enrich = jest.fn<EnrichFn>().mockResolvedValue('enriched_match');

  it('issues a SELECT joining library + artists with the canonical WHERE filter', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);

    await runBackfill({ lookup, enrich, throttleMs: 0 });

    const call = (db.execute as jest.Mock).mock.calls[0];
    expect(call).toBeDefined();
    // Note: table names come from sql.raw(...) (schema-qualified at module
    // load) and don't render through the test helper. The structural assertions
    // below — JOIN keyword, FROM/JOIN aliases, filter predicates, cursor,
    // ORDER BY, LIMIT — pin everything that matters; the sql.raw table names
    // would fail at runtime if mis-wired.
    const sql = renderSql(call?.[0]);
    expect(sql).toMatch(/JOIN/i);
    expect(sql).toMatch(/FROM\s+AS\s+l/i);
    expect(sql).toMatch(/JOIN\s+AS\s+a\s+ON\s+a\."id"\s*=\s*l\."artist_id"/i);
    expect(sql.toLowerCase()).toMatch(/"artwork_url"\s+is\s+null/);
    expect(sql.toLowerCase()).toMatch(/"discogs_artist_id"\s+is\s+not\s+null/);
    expect(sql).toMatch(/l\."id"\s*>/);
    expect(sql).toMatch(/ORDER BY[\s\S]*l\."id"\s+ASC/i);
    expect(sql).toMatch(/LIMIT/i);
  });

  it('composes the partition fragment into the SELECT WHERE when partitioning is active', async () => {
    // resolvePartitionFilter returns an `AND (l."id" % N) = M` SQL fragment
    // when PARTITION_COUNT > 1. The orchestrator must splice it into the
    // loadBatch query so each container scans a disjoint slice of ids.
    // Default (count=1) is exercised by the canonical-WHERE test above.
    //
    // The fragment's SQL text doesn't render through this test helper because
    // it's a nested drizzle SQL object. The drizzle params live in the outer
    // query's `values` array as a nested SQL object whose own `values` carry
    // the partition's count/index — flatten and check both are present.
    (db.execute as jest.Mock).mockResolvedValue([]);

    const partition = resolvePartitionFilter('1', '4');
    await runBackfill({ lookup, enrich, throttleMs: 0, partition });

    const call = (db.execute as jest.Mock).mock.calls[0];
    const flattenValues = (v: unknown): unknown[] => {
      if (Array.isArray(v)) return v.flatMap(flattenValues);
      if (v && typeof v === 'object' && 'values' in v) return flattenValues((v as { values: unknown[] }).values);
      return [v];
    };
    const flat = flattenValues((call?.[0] as { values?: unknown[] })?.values ?? []);
    expect(flat).toContain(4); // PARTITION_COUNT
    expect(flat).toContain(1); // PARTITION_INDEX
  });

  it('advances the id-cursor across batches and terminates on empty', async () => {
    const batch1 = [
      { id: 10, artist_name: 'a', album_title: 'a1' },
      { id: 20, artist_name: 'b', album_title: 'b1' },
    ];
    const batch2 = [{ id: 30, artist_name: 'c', album_title: 'c1' }];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2).mockResolvedValueOnce([]);

    const result = await runBackfill({ lookup, enrich, throttleMs: 0 });

    expect((db.execute as jest.Mock).mock.calls.length).toBe(3);
    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(3);
    expect(result.totals.lml_error).toBe(0);

    // Cursor values are passed as drizzle params, so they appear in `values`
    // not `sql`. Pull them out.
    const values2 = ((db.execute as jest.Mock).mock.calls[1]?.[0] as { values?: unknown[] })?.values;
    const values3 = ((db.execute as jest.Mock).mock.calls[2]?.[0] as { values?: unknown[] })?.values;
    expect(values2).toContain(20);
    expect(values3).toContain(30);
  });

  it('counts lml_error when LML throws and continues processing', async () => {
    const batch = [
      { id: 10, artist_name: 'a', album_title: 'a1' },
      { id: 20, artist_name: 'b', album_title: 'b1' },
      { id: 30, artist_name: 'c', album_title: 'c1' },
    ];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const lookupFlaky = jest
      .fn<LookupFn>()
      .mockResolvedValueOnce(matchedResponse)
      .mockRejectedValueOnce(new Error('LML 502'))
      .mockResolvedValueOnce(noMatchResponse);
    const enrichLocal = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('enriched_match')
      .mockResolvedValueOnce('enriched_no_match');

    const result = await runBackfill({ lookup: lookupFlaky, enrich: enrichLocal, throttleMs: 0 });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.enriched_no_match).toBe(1);
    expect(result.totals.lml_error).toBe(1);
    // enrich is called twice (once per non-error row) — the LML-throw row
    // skips enrich entirely so its artwork_url stays NULL.
    expect(enrichLocal).toHaveBeenCalledTimes(2);
  });

  it('exposes BATCH_SIZE and THROTTLE_MS constants for ops tuning', () => {
    expect(BATCH_SIZE).toBe(500);
    expect(THROTTLE_MS).toBe(100);
  });

  it('counts enriched_match_raced separately from enriched_match', async () => {
    // Race scenario at the orchestrator level: enrich returns the *_raced
    // variant when 0 rows updated. The orchestrator must bump the matching
    // counter rather than treating it as a regular match.
    const batch = [
      { id: 10, artist_name: 'a', album_title: 'a1' },
      { id: 20, artist_name: 'b', album_title: 'b1' },
    ];

    (db.execute as jest.Mock).mockResolvedValueOnce(batch).mockResolvedValueOnce([]);

    const enrichWithRaces = jest
      .fn<EnrichFn>()
      .mockResolvedValueOnce('enriched_match')
      .mockResolvedValueOnce('enriched_match_raced');

    const result = await runBackfill({ lookup, enrich: enrichWithRaces, throttleMs: 0 });

    expect(result.totals.scanned).toBe(2);
    expect(result.totals.enriched_match).toBe(1);
    expect(result.totals.enriched_match_raced).toBe(1);
    expect(result.totals.lml_error).toBe(0);
  });
});
