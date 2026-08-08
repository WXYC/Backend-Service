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
  resolveIncludeNullCanonical,
  resolvePartitionFilter,
  resolveRecheck,
  resolveStaleThreshold,
  resolveThrottleMs,
  resolveUnresolvedRetryDays,
  resolveVaBatchSize,
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

describe('resolveIncludeNullCanonical', () => {
  it('defaults OFF (undefined / empty / other strings)', () => {
    expect(resolveIncludeNullCanonical(undefined)).toBe(false);
    expect(resolveIncludeNullCanonical('')).toBe(false);
    expect(resolveIncludeNullCanonical('false')).toBe(false);
    expect(resolveIncludeNullCanonical('0')).toBe(false);
  });

  it('treats "true" / "1" / "TRUE" as enabled', () => {
    expect(resolveIncludeNullCanonical('true')).toBe(true);
    expect(resolveIncludeNullCanonical('1')).toBe(true);
    expect(resolveIncludeNullCanonical('TRUE')).toBe(true);
  });
});

describe('resolveVaBatchSize', () => {
  it('defaults to 100 (BS#1991, S0/#1989 payload measurement)', () => {
    expect(resolveVaBatchSize(undefined)).toBe(100);
  });

  it('accepts a positive integer up to the LML cap', () => {
    expect(resolveVaBatchSize('50')).toBe(50);
    expect(resolveVaBatchSize('1000')).toBe(1000);
  });

  it('rejects > 1000 (LML cap) or non-positive/non-integer', () => {
    expect(() => resolveVaBatchSize('1001')).toThrow(/LML cap/);
    expect(() => resolveVaBatchSize('0')).toThrow();
    expect(() => resolveVaBatchSize('abc')).toThrow();
  });
});

describe('resolveRecheck', () => {
  it('defaults OFF (undefined / empty / other strings)', () => {
    expect(resolveRecheck(undefined)).toBe(false);
    expect(resolveRecheck('')).toBe(false);
    expect(resolveRecheck('false')).toBe(false);
  });

  it('treats "true" / "1" / "TRUE" as enabled', () => {
    expect(resolveRecheck('true')).toBe(true);
    expect(resolveRecheck('1')).toBe(true);
    expect(resolveRecheck('TRUE')).toBe(true);
  });
});

describe('resolveUnresolvedRetryDays', () => {
  it('defaults to 30 (separate from the 7-day identity-freshness window)', () => {
    expect(resolveUnresolvedRetryDays(undefined)).toBe(30);
  });

  it('accepts a positive integer', () => {
    expect(resolveUnresolvedRetryDays('14')).toBe(14);
  });

  it('rejects zero or non-integer', () => {
    expect(() => resolveUnresolvedRetryDays('0')).toThrow();
    expect(() => resolveUnresolvedRetryDays('abc')).toThrow();
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

  it("BS#1991: projects legacy_release_id (the id-space bridge to LML's per-track store)", async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/legacy_release_id/);
  });

  it('BS#1991: cohort="va" ANDs the code_volume_letters/EXISTS(compilation_track_artist) condition onto the predicate', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 100, null, 7, false, 30, 'va');
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/code_volume_letters/);
    expect(serialized).toMatch(/compilation_track_artist/);
    expect(serialized).not.toMatch(/NOT \(/);
  });

  it('BS#1991: the va-cohort condition is NULL-safe (COALESCEs code_volume_letters before LIKE), so the two cohorts partition every row exactly — including NULL code_volume_letters', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 100, null, 7, false, 30, 'va');
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    // A NULL code_volume_letters row with no CTA row must resolve to a real
    // FALSE in the va branch (excluded) and a real TRUE in NOT(...) for
    // non_va (included) — three-valued NULL-LIKE-NULL logic would silently
    // drop it from both. COALESCE pins the comparand to a non-null default.
    expect(serialized).toMatch(/COALESCE/);
  });

  it('BS#1991: cohort="non_va" negates the same va condition', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7, false, 30, 'non_va');
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/code_volume_letters/);
    expect(serialized).toMatch(/NOT \(/);
  });

  it('BS#1991: cohort=null (the pre-existing single-drain shape) omits the va condition entirely', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).not.toMatch(/code_volume_letters/);
  });

  it('BS#1991: recheck=true replaces the eligibility predicate with va-cohort rows that have a prior attempted-at stamp, ignoring the retry-day TTL', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 100, null, 7, false, 30, 'va', true);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/code_volume_letters/);
    expect(serialized).toMatch(/unresolved_attempted_at/);
    expect(serialized).toMatch(/IS NOT NULL/);
    // recheck ignores the normal freshness/no-match predicate entirely.
    expect(serialized).not.toMatch(/canonical_entity_id/);
    expect(serialized).not.toMatch(/last_verified_at/);
  });

  it('flag-off (default) keeps the canonical filter and does NOT read the unresolved marker (BS#974 no-change guarantee)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7); // includeNullCanonical defaults to false
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/canonical_entity_id/);
    expect(serialized).not.toMatch(/unresolved_attempted_at/);
  });

  it('flag-on drops the canonical filter and gates first-timers on the unresolved marker (BS#974)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7, true, 30);
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    // NULL-canonical rows are now in scope → the canonical filter is gone...
    expect(serialized).not.toMatch(/canonical_entity_id/);
    // ...and the no-match marker gate is present, alongside the stale re-verify.
    expect(serialized).toMatch(/unresolved_attempted_at/);
    expect(serialized).toMatch(/last_verified_at/);
    expect(serialized).toMatch(/NOT EXISTS/);
  });

  it('gates on a freshness guard so canonicalized rows are not unconditionally re-fetched (BS#1144)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7);
    const call = (db.execute as jest.Mock).mock.calls[0][0];
    const serialized = JSON.stringify(call);
    // Structural regression check only -- this can't distinguish the fixed
    // predicate from the pre-#1144 bug (`canonical_entity_id IS NOT NULL OR
    // ...`, an unconditional disjunct that also contains "NOT EXISTS" deeper
    // in its OR branch), so it's necessary but not sufficient. The genuine
    // behavioral fixture (a FRESH identity row excluded; an ABSENT or STALE
    // one included) lives in
    // tests/integration/library-identity-consumer-select.spec.js against a
    // real Postgres -- a mocked db.execute here can't observe selection
    // behavior, only the SQL text passed to it.
    expect(serialized).toMatch(/NOT EXISTS/);
    // Post-BS#1800 simplification (library_identity.library_id is a PK, so
    // `NOT EXISTS(any) OR EXISTS(stale)` === `NOT EXISTS(fresh)` -- see the
    // module docstring): the flag-off branch is now a single NOT EXISTS, not
    // the two-subquery `OR EXISTS` shape.
    expect(serialized).not.toMatch(/OR EXISTS/);
  });

  it('returns the rows surfaced by db.execute', async () => {
    const fixture = [
      { id: 1, artist_name: 'Juana Molina', album_title: 'DOGA', legacy_release_id: 1000001 },
      {
        id: 2,
        artist_name: 'Jessica Pratt',
        album_title: 'On Your Own Love Again',
        legacy_release_id: 1000002,
      },
    ];
    (db.execute as jest.Mock).mockResolvedValueOnce(fixture);
    const rows = await loadBatch(0, 500, null, 7);
    expect(rows).toEqual(fixture);
  });
});

describe('loadBatch — BS#1991 bounce-1: flag-off va cohort honors the no-match marker TTL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flag-off cohort="va" gates on unresolved_attempted_at (a resolved compilation writes no library_identity row, so the marker is its only durable exit)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 100, null, 7, false, 30, 'va');
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/unresolved_attempted_at/);
  });

  it('flag-off cohort="non_va" keeps the pre-BS#1991 predicate (no marker clause)', async () => {
    (db.execute as jest.Mock).mockResolvedValue([]);
    await loadBatch(0, 500, null, 7, false, 30, 'non_va');
    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).not.toMatch(/unresolved_attempted_at/);
  });
});
