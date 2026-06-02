/**
 * Unit tests for jobs/artist-search-alias-consumer/select.ts.
 *
 * Covers the env-var resolvers (defaults, validation, drift guards against
 * LML's 1000-name cap) and the `loadNameGroups` SELECT predicate (name-
 * grouped, text cursor, hashtext partition, staleness OR-no-rows-yet).
 */
import { db } from '@wxyc/database';
import {
  loadNameGroups,
  resolveBatchSize,
  resolveDryRun,
  resolvePartition,
  resolveStaleThreshold,
  resolveThrottleMs,
} from '../../../../jobs/artist-search-alias-consumer/select';

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

describe('resolvePartition', () => {
  it('returns {index:0, count:1, description:partition=none} when both undefined', () => {
    const p = resolvePartition(undefined, undefined);
    expect(p.index).toBe(0);
    expect(p.count).toBe(1);
    expect(p.description).toBe('partition=none');
  });

  it('returns a labelled partition when count>1', () => {
    const p = resolvePartition('1', '4');
    expect(p.index).toBe(1);
    expect(p.count).toBe(4);
    expect(p.description).toBe('partition=1/4');
  });

  it('rejects out-of-range index', () => {
    expect(() => resolvePartition('4', '4')).toThrow();
    expect(() => resolvePartition('-1', '2')).toThrow();
  });

  it('rejects non-positive count', () => {
    expect(() => resolvePartition('0', '0')).toThrow();
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

describe('loadNameGroups', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues a SELECT whose SQL references the name-grouped predicate, staleness, and the partition modulo', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadNameGroups('', 500, { index: 0, count: 1, description: 'partition=none' }, 7);
    expect((db.execute as jest.Mock).mock.calls.length).toBe(1);
    const call = (db.execute as jest.Mock).mock.calls[0][0];
    const serialized = JSON.stringify(call);
    // Anchor expectations to fragments the SQL must contain.
    expect(serialized).toMatch(/library/);
    expect(serialized).toMatch(/artist_name/);
    expect(serialized).toMatch(/array_agg/);
    expect(serialized).toMatch(/artist_search_alias/);
    expect(serialized).toMatch(/last_verified_at/);
    expect(serialized).toMatch(/hashtext/);
    // Cursor + batch-size positional params land verbatim.
    expect(serialized).toMatch(/""/); // empty-string cursor binding
  });

  it('returns the rows surfaced by db.execute', async () => {
    const fixture = [
      { artist_name: 'Juana Molina', artist_ids: [42] },
      { artist_name: 'Stereolab', artist_ids: [7, 4123] },
    ];
    // The Drizzle execute may return either an array or a wrapper with .rows.
    // Match the implementation's expectation by returning the array directly;
    // the implementation must handle both shapes.
    (db.execute as jest.Mock).mockResolvedValueOnce(fixture);
    const rows = await loadNameGroups('', 500, { index: 0, count: 1, description: 'partition=none' }, 7);
    expect(rows).toEqual(fixture);
  });

  it('passes the supplied cursor through to the query', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadNameGroups('Stereolab', 500, { index: 0, count: 1, description: 'partition=none' }, 7);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/Stereolab/);
  });

  it('uses the per-member EXISTS-NOT-fresh predicate (mixed-coverage gap regression)', async () => {
    // The original two-branch OR (`NOT EXISTS any row OR EXISTS stale row`)
    // silently skipped name groups where one artist_id had fresh coverage
    // and another had none — the new artist_id stayed un-aliased for up to
    // STALE_THRESHOLD_DAYS. The fix uses `EXISTS (unnest(artist_ids) member
    // WHERE NOT EXISTS fresh-row-for-member)` so any member without fresh
    // coverage flips the whole group eligible. Pin the SQL fragments so a
    // future refactor can't regress to the OR shape.
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadNameGroups('', 500, { index: 0, count: 1, description: 'partition=none' }, 7);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    // Per-member iteration via unnest.
    expect(serialized).toMatch(/unnest\(n\.artist_ids\)/);
    // Freshness predicate flipped to `>=` (i.e., the SELECT picks groups
    // whose members have NO row satisfying `last_verified_at >= cutoff`).
    // The serialized SQL JSON-stringifies the table-qualified identifier so
    // the `"` around the column name appears as `\"`.
    expect(serialized).toMatch(/last_verified_at.{0,4}>=/);
  });

  it('uses abs(hashtext(...)::bigint) so negative hash values map into [0, count)', async () => {
    // PG's hashtext() returns signed int4: ~50% of outputs are negative.
    // `%` on a negative dividend produces a non-positive remainder, which
    // never matches `partition.index ∈ [0, count)`. Without `abs(...)`,
    // a 4-way partitioned run silently drops ~37.5% of distinct names.
    // The ::bigint widening matters too — `abs()` on raw int4 overflows on
    // INT_MIN. Codebase precedent: apps/backend/services/library.service.ts:204.
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadNameGroups('', 500, { index: 2, count: 4, description: 'partition=2/4' }, 7);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/abs\(hashtext/);
    expect(serialized).toMatch(/::bigint/);
  });

  it('respects a non-trivial partition (count > 1) by including the modulo predicate in serialized SQL', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadNameGroups('', 500, { index: 2, count: 4, description: 'partition=2/4' }, 7);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    // The plan parameterises both, so the literals should appear in the
    // serialized parameter chunks.
    expect(serialized).toMatch(/4/);
    expect(serialized).toMatch(/2/);
  });
});
