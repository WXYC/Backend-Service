/**
 * Unit tests for select.ts — env-var resolvers and the SELECT predicate.
 *
 * The orchestrator uses the resolvers to map env vars to runtime values and
 * `loadBatch` to fan out the SELECT. The resolvers must reject invalid
 * inputs eagerly so the operator sees a clear error instead of the loop
 * silently doing the wrong thing.
 */
import { db } from '@wxyc/database';
import {
  loadBatch,
  resolveBatchSize,
  resolveDryRun,
  resolvePartitionFilter,
  resolveStaleThreshold,
  resolveThrottleMs,
} from '../../../../jobs/library-identity-consumer/select';

describe('resolveBatchSize', () => {
  it('defaults to 500', () => {
    expect(resolveBatchSize(undefined)).toBe(500);
  });

  it('accepts a positive integer up to LML cap', () => {
    expect(resolveBatchSize('250')).toBe(250);
    expect(resolveBatchSize('1000')).toBe(1000);
  });

  it('rejects > 1000 (LML cap)', () => {
    expect(() => resolveBatchSize('1001')).toThrow(/LML cap/);
  });

  it('rejects non-integer or non-positive', () => {
    expect(() => resolveBatchSize('0')).toThrow();
    expect(() => resolveBatchSize('-1')).toThrow();
    expect(() => resolveBatchSize('abc')).toThrow();
  });
});

describe('resolveThrottleMs', () => {
  it('defaults to 100', () => {
    expect(resolveThrottleMs(undefined)).toBe(100);
  });

  it('accepts zero and positive integers', () => {
    expect(resolveThrottleMs('0')).toBe(0);
    expect(resolveThrottleMs('500')).toBe(500);
  });

  it('rejects negative or non-integer', () => {
    expect(() => resolveThrottleMs('-1')).toThrow();
    expect(() => resolveThrottleMs('abc')).toThrow();
  });
});

describe('resolveStaleThreshold', () => {
  it('defaults to 7 days', () => {
    expect(resolveStaleThreshold(undefined)).toBe(7);
  });

  it('accepts a positive integer', () => {
    expect(resolveStaleThreshold('14')).toBe(14);
  });

  it('rejects zero or non-integer', () => {
    expect(() => resolveStaleThreshold('0')).toThrow();
    expect(() => resolveStaleThreshold('abc')).toThrow();
  });
});

describe('resolvePartitionFilter', () => {
  it('returns no-op when count=1', () => {
    const result = resolvePartitionFilter(undefined, undefined);
    expect(result.sqlFragment).toBeNull();
    expect(result.description).toBe('partition=none');
  });

  it('returns a modulo SQL fragment when count>1', () => {
    const result = resolvePartitionFilter('1', '4');
    expect(result.sqlFragment).not.toBeNull();
    expect(result.description).toBe('partition=1/4');
  });

  it('rejects out-of-range index', () => {
    expect(() => resolvePartitionFilter('4', '4')).toThrow();
    expect(() => resolvePartitionFilter('-1', '2')).toThrow();
  });

  it('rejects non-positive count', () => {
    expect(() => resolvePartitionFilter('0', '0')).toThrow();
  });
});

describe('resolveDryRun', () => {
  it('treats "true" / "1" / "TRUE" as enabled', () => {
    expect(resolveDryRun('true')).toBe(true);
    expect(resolveDryRun('1')).toBe(true);
    expect(resolveDryRun('TRUE')).toBe(true);
  });

  it('treats undefined / empty / other strings as disabled', () => {
    expect(resolveDryRun(undefined)).toBe(false);
    expect(resolveDryRun('')).toBe(false);
    expect(resolveDryRun('false')).toBe(false);
    expect(resolveDryRun('0')).toBe(false);
    expect(resolveDryRun('yes')).toBe(false);
  });
});

describe('loadBatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues a SELECT that honors the post-#800 predicate (canonical_entity_id AND (no identity row OR stale))', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    const call = (db.execute as jest.Mock).mock.calls[0][0];
    const serialized = JSON.stringify(call);
    // Look for the key clauses; the SQL string is rendered as Drizzle SQL
    // queryChunks so check the embedded fragments.
    expect(serialized).toMatch(/canonical_entity_id/);
    expect(serialized).toMatch(/library_identity/);
    expect(serialized).toMatch(/last_verified_at/);
    expect(serialized).toMatch(/artist_name/);
  });

  it('gates on a freshness guard so canonicalized rows are not unconditionally re-fetched (BS#1144)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7);
    const call = (db.execute as jest.Mock).mock.calls[0][0];
    const serialized = JSON.stringify(call);
    // The predicate must gate canonicalized rows behind a freshness check
    // (NOT EXISTS a library_identity row, or the existing one is stale) —
    // not just an unconditional `canonical_entity_id IS NOT NULL OR ...`.
    expect(serialized).toMatch(/NOT EXISTS/);
  });

  it('returns the rows surfaced by db.execute', async () => {
    const fixture = [
      { id: 1, artist_name: 'Juana Molina', album_title: 'DOGA' },
      { id: 2, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
    ];
    (db.execute as jest.Mock).mockResolvedValueOnce(fixture);
    const rows = await loadBatch(0, 500, null, 7);
    expect(rows).toEqual(fixture);
  });
});
