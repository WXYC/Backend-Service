/**
 * Unit tests for the library-identity-backfill orchestrator (sub-PR 2.0).
 *
 *   - Partition resolver (mirrors library-canonical-entity-backfill).
 *   - DRY_RUN env-var path produces a stable JSON object on stdout and skips
 *     all writes (per §4 "Dry-run mechanism (locked)").
 *   - Real-run path delegates to writeIdentity for matched rows and counts
 *     skip categories accurately.
 */

import { db } from '@wxyc/database';
import {
  resolvePartitionFilter,
  runBackfill,
  resolveDryRun,
  type DryRunReport,
} from '../../../../jobs/library-identity-backfill/orchestrate';

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

  it('rejects non-integer or negative count', () => {
    expect(() => resolvePartitionFilter('0', '0')).toThrow();
    expect(() => resolvePartitionFilter('0', '-1')).toThrow();
  });

  it('rejects out-of-range index', () => {
    expect(() => resolvePartitionFilter('4', '4')).toThrow();
    expect(() => resolvePartitionFilter('-1', '2')).toThrow();
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
  });
});

describe('runBackfill — real run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes one source row + one main row per matched library row', async () => {
    const writes: Array<{ libraryId: number; sourceCount: number }> = [];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        // Real-run rows: already_in_library_identity is always false because
        // the SQL filter excludes those rows before they reach this struct.
        {
          id: 100,
          canonical_entity_id: 'discogs:987654',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
        {
          id: 101,
          canonical_entity_id: 'discogs:111',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
      ])
      .mockResolvedValue([]);
    const writeIdentity = jest.fn((libraryId: number, rows: Array<unknown>) => {
      writes.push({ libraryId, sourceCount: rows.length });
      return Promise.resolve();
    });

    const result = await runBackfill({
      writeIdentity,
      throttleMs: 0,
      batchSize: 500,
    });

    expect(writes).toEqual([
      { libraryId: 100, sourceCount: 1 },
      { libraryId: 101, sourceCount: 1 },
    ]);
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.wrote).toBe(2);
    expect(result.totals.skipped_already_in_library_identity).toBe(0);
    expect(result.totals.skipped_no_canonical_entity_id).toBe(0);
    expect(result.totals.skipped_non_discogs_namespace).toBe(0);
  });

  it('counts non-discogs rows as skipped_non_discogs_namespace and does not write', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 200,
          canonical_entity_id: 'mb:abc-123',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
        {
          id: 201,
          canonical_entity_id: 'discogs:bogus',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
      ])
      .mockResolvedValue([]);
    const writeIdentity = jest.fn(async () => {});

    const result = await runBackfill({ writeIdentity, throttleMs: 0, batchSize: 500 });

    expect(writeIdentity).not.toHaveBeenCalled();
    expect(result.totals.scanned).toBe(2);
    expect(result.totals.skipped_non_discogs_namespace).toBe(2);
    expect(result.totals.wrote).toBe(0);
  });
});

describe('runBackfill — DRY_RUN', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits a stable JSON object on stdout and never calls writeIdentity', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 100,
          canonical_entity_id: 'discogs:987654',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
        {
          id: 101,
          canonical_entity_id: 'mb:other',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
        {
          id: 102,
          canonical_entity_id: null,
          canonical_entity_resolved_at: null,
          already_in_library_identity: false,
        },
      ])
      .mockResolvedValue([]);
    const writeIdentity = jest.fn(async () => {});

    let capturedReport: DryRunReport | undefined;
    const result = await runBackfill({
      writeIdentity,
      throttleMs: 0,
      batchSize: 500,
      dryRun: true,
      onDryRunReport: (report) => {
        capturedReport = report;
      },
    });

    expect(writeIdentity).not.toHaveBeenCalled();
    expect(result.totals.wrote).toBe(0);
    expect(capturedReport).toBeDefined();
    if (!capturedReport) throw new Error('expected a dry-run report');
    expect(capturedReport.source).toBe('S1');
    expect(capturedReport.scanned).toBe(3);
    expect(capturedReport.would_write_sources).toBe(1);
    expect(capturedReport.would_upsert_mains).toBe(1);
    expect(capturedReport.skipped.already_in_library_identity).toBe(0);
    expect(capturedReport.skipped.no_canonical_entity_id).toBe(1);
    expect(capturedReport.skipped.non_discogs_namespace).toBe(1);
    // §4 acceptance: scanned == would_write_sources + sum(skipped.values())
    const skippedSum =
      capturedReport.skipped.already_in_library_identity +
      capturedReport.skipped.no_canonical_entity_id +
      capturedReport.skipped.non_discogs_namespace;
    expect(capturedReport.scanned).toBe(capturedReport.would_write_sources + skippedSum);
  });

  it('counts rerun-overlap rows as already_in_library_identity (regression)', async () => {
    // Regression for the DRY_RUN over-count bug: in DRY_RUN the SQL filter
    // is relaxed so the EXISTS subselect returns rows that the real run
    // would have skipped via NOT EXISTS. Without the bucket, those rows
    // counted as `would_write_sources` and the operator's prediction of the
    // real run's writes was inflated.
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 700,
          canonical_entity_id: 'discogs:1',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: true,
        },
        {
          id: 701,
          canonical_entity_id: 'discogs:2',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: true,
        },
        {
          id: 702,
          canonical_entity_id: 'discogs:3',
          canonical_entity_resolved_at: new Date(),
          already_in_library_identity: false,
        },
      ])
      .mockResolvedValue([]);
    const writeIdentity = jest.fn(async () => {});

    let capturedReport: DryRunReport | undefined;
    await runBackfill({
      writeIdentity,
      throttleMs: 0,
      batchSize: 500,
      dryRun: true,
      onDryRunReport: (r) => {
        capturedReport = r;
      },
    });

    if (!capturedReport) throw new Error('expected a dry-run report');
    expect(capturedReport.scanned).toBe(3);
    expect(capturedReport.skipped.already_in_library_identity).toBe(2);
    expect(capturedReport.would_write_sources).toBe(1);
    expect(capturedReport.would_upsert_mains).toBe(1);
    expect(writeIdentity).not.toHaveBeenCalled();
  });

  it('preserves the locked dry-run JSON schema (stable keys)', async () => {
    // Locked per §4 "Dry-run mechanism (locked)". Future sub-PRs may add new
    // top-level fields but MUST NOT remove or rename these.
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValue([]);
    const writeIdentity = jest.fn(async () => {});

    let capturedReport: DryRunReport | undefined;
    await runBackfill({
      writeIdentity,
      throttleMs: 0,
      batchSize: 500,
      dryRun: true,
      onDryRunReport: (report) => {
        capturedReport = report;
      },
    });

    if (!capturedReport) throw new Error('expected a dry-run report');
    expect(Object.keys(capturedReport).sort()).toEqual(
      ['scanned', 'skipped', 'source', 'would_upsert_mains', 'would_write_sources'].sort()
    );
    expect(Object.keys(capturedReport.skipped).sort()).toEqual(
      ['already_in_library_identity', 'no_canonical_entity_id', 'non_discogs_namespace'].sort()
    );
  });
});
