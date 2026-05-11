/**
 * Unit tests for the library-identity-consumer orchestrator (BS#802).
 *
 *   - Happy path: mix of single_artist / unresolved / compilation
 *     translates to the right counters.
 *   - LML error path: an LML failure on a batch counts every row in the
 *     batch as `rows_skipped { lml_error }` and continues with the next
 *     batch (no retry inside the orchestrator — retry is the next run via
 *     the SELECT predicate).
 *   - DRY_RUN locked JSON output schema is honored.
 */
import { db } from '@wxyc/database';

import type { BulkResolveResponse, BulkResolveResult } from '../../../../jobs/library-identity-consumer/lml-types';
import {
  runConsumer,
  type BulkResolveFn,
  type DryRunReport,
  type WriteSingleArtistFn,
} from '../../../../jobs/library-identity-consumer/orchestrate';

describe('runConsumer — happy path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dispatches single_artist → writer, unresolved → counter, compilation → skipped', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 100, artist_name: 'Juana Molina', album_title: 'DOGA' },
        { id: 101, artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again' },
        { id: 102, artist_name: 'Various Artists', album_title: 'A Compilation' },
        { id: 103, artist_name: 'Some Indie Band', album_title: 'A Record' },
      ])
      .mockResolvedValue([]);

    const lmlResponse: BulkResolveResponse = {
      results: [
        {
          kind: 'single_artist',
          library_id: 100,
          main: { wikidata_qid: 'Q-juana' },
          method: 'exact_match',
          confidence: 1.0,
          provenance: [{ source: 'wikidata', method: 'exact_match', confidence: 1.0, external_id: 'Q-juana' }],
        },
        {
          kind: 'single_artist',
          library_id: 101,
          main: { wikidata_qid: 'Q-jess' },
          method: 'cross_source_agreement',
          confidence: 0.95,
          provenance: [
            { source: 'wikidata', method: 'cross_source_agreement', confidence: 0.95, external_id: 'Q-jess' },
          ],
        },
        {
          kind: 'compilation',
          library_id: 102,
          provenance: [],
        },
        {
          kind: 'unresolved',
          library_id: 103,
          provenance: [],
        },
      ],
    };
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue(lmlResponse);
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 1,
      source_rows_skipped_null_confidence: 0,
    });

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    expect(bulkResolve).toHaveBeenCalledTimes(1);
    expect(bulkResolve.mock.calls[0][0]).toHaveLength(4);
    expect(writeSingleArtist).toHaveBeenCalledTimes(2);

    expect(result.totals.scanned).toBe(4);
    expect(result.totals.rows_resolved).toBe(2);
    expect(result.totals.rows_unresolved).toBe(1);
    expect(result.totals.rows_skipped.compilation).toBe(1);
    expect(result.totals.rows_skipped.lml_error).toBe(0);
    expect(result.totals.rows_skipped.writer_error).toBe(0);
    expect(result.totals.lml_total_calls).toBe(1);
  });

  it('paginates by id-cursor across multiple batches', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([{ id: 1, artist_name: 'A', album_title: 'a' }])
      .mockResolvedValueOnce([{ id: 2, artist_name: 'B', album_title: 'b' }])
      .mockResolvedValueOnce([]);

    const bulkResolve = jest.fn<BulkResolveFn>().mockImplementation((inputs) =>
      Promise.resolve({
        results: inputs.map((i) => ({
          kind: 'unresolved' as const,
          library_id: i.library_id,
          provenance: [],
        })),
      })
    );
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });

    await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 1,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    expect(bulkResolve).toHaveBeenCalledTimes(2);
    expect(writeSingleArtist).not.toHaveBeenCalled();
  });
});

describe('runConsumer — LML error path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts every row in a failed batch as rows_skipped { lml_error } and continues', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValueOnce([{ id: 3, artist_name: 'C', album_title: 'c' }])
      .mockResolvedValueOnce([]);

    const bulkResolve = jest
      .fn<BulkResolveFn>()
      .mockRejectedValueOnce(new Error('LML responded 500 Internal Server Error'))
      .mockResolvedValueOnce({
        results: [
          {
            kind: 'unresolved',
            library_id: 3,
            provenance: [],
          },
        ],
      });
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 2,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    // First batch failed entirely → 2 scanned, 2 skipped { lml_error }.
    // Second batch succeeded with 1 unresolved.
    expect(result.totals.scanned).toBe(3);
    expect(result.totals.rows_skipped.lml_error).toBe(2);
    expect(result.totals.rows_unresolved).toBe(1);
    expect(result.totals.rows_resolved).toBe(0);
    // lml_total_calls counts every attempt — error included — so the
    // operator can see the failure ratio.
    expect(result.totals.lml_total_calls).toBe(2);
    expect(bulkResolve).toHaveBeenCalledTimes(2);
  });

  it('counts a writer error as rows_skipped { writer_error } without aborting the batch', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValue([]);

    const singleArtist = (libraryId: number): BulkResolveResult => ({
      kind: 'single_artist',
      library_id: libraryId,
      main: { wikidata_qid: `Q-${libraryId}` },
      method: 'exact_match',
      confidence: 1.0,
      provenance: [{ source: 'wikidata', method: 'exact_match', confidence: 1.0, external_id: `Q-${libraryId}` }],
    });
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue({
      results: [singleArtist(1), singleArtist(2)],
    });
    const writeSingleArtist = jest
      .fn<WriteSingleArtistFn>()
      .mockRejectedValueOnce(new Error('transaction deadlock'))
      .mockResolvedValueOnce({ source_rows_written: 1, source_rows_skipped_null_confidence: 0 });

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 2,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    expect(result.totals.scanned).toBe(2);
    expect(result.totals.rows_resolved).toBe(1);
    expect(result.totals.rows_skipped.writer_error).toBe(1);
  });
});

describe('runConsumer — counter unit cleanliness', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('source_rows_skipped_null_confidence lives outside rows_skipped (library_id-level accounting stays clean)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValue([]);

    const lmlResponse: BulkResolveResponse = {
      results: [
        {
          kind: 'single_artist',
          library_id: 1,
          main: { wikidata_qid: 'Q-1' },
          method: 'exact_match',
          confidence: 1.0,
          provenance: [{ source: 'wikidata', method: 'exact_match', confidence: 1.0, external_id: 'Q-1' }],
        },
        {
          kind: 'single_artist',
          library_id: 2,
          main: { wikidata_qid: 'Q-2' },
          method: 'exact_match',
          confidence: 1.0,
          provenance: [{ source: 'wikidata', method: 'exact_match', confidence: 1.0, external_id: 'Q-2' }],
        },
      ],
    };
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue(lmlResponse);
    // Both writes succeed, but each one's provenance has 2 null-confidence
    // entries that the writer had to skip. The aggregate counter should be 4,
    // and both library_ids should still count as `rows_resolved` — the
    // library_id-level invariant (resolved + unresolved + sum(rows_skipped))
    // does not include this source-row counter.
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 1,
      source_rows_skipped_null_confidence: 2,
    });

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    expect(result.totals.rows_resolved).toBe(2);
    expect(result.totals.source_rows_skipped_null_confidence).toBe(4);
    const libraryIdLevelSkipSum =
      result.totals.rows_skipped.compilation +
      result.totals.rows_skipped.lml_error +
      result.totals.rows_skipped.writer_error +
      result.totals.rows_skipped.lml_cardinality_mismatch;
    expect(
      result.totals.scanned === result.totals.rows_resolved + result.totals.rows_unresolved + libraryIdLevelSkipSum
    ).toBe(true);
  });

  it('counts under-cardinality LML responses as rows_skipped { lml_cardinality_mismatch }', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
        { id: 3, artist_name: 'C', album_title: 'c' },
      ])
      .mockResolvedValue([]);

    // Send 3 inputs, get back 2 results (under-cardinality).
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue({
      results: [
        { kind: 'unresolved', library_id: 1, provenance: [] },
        { kind: 'unresolved', library_id: 2, provenance: [] },
      ],
    });
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    expect(result.totals.scanned).toBe(3);
    expect(result.totals.rows_unresolved).toBe(2);
    expect(result.totals.rows_skipped.lml_cardinality_mismatch).toBe(1);
  });
});

describe('runConsumer — DRY_RUN', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('calls LML but suppresses writes and emits the locked JSON schema on stdout', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 100, artist_name: 'A', album_title: 'a' },
        { id: 101, artist_name: 'B', album_title: 'b' },
        { id: 102, artist_name: 'C', album_title: 'c' },
      ])
      .mockResolvedValue([]);

    const lmlResponse: BulkResolveResponse = {
      results: [
        {
          kind: 'single_artist',
          library_id: 100,
          main: { wikidata_qid: 'Q-100' },
          method: 'exact_match',
          confidence: 1.0,
          provenance: [{ source: 'wikidata', method: 'exact_match', confidence: 1.0, external_id: 'Q-100' }],
        },
        { kind: 'unresolved', library_id: 101, provenance: [] },
        { kind: 'compilation', library_id: 102, provenance: [] },
      ],
    };
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue(lmlResponse);
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });

    let captured: DryRunReport | undefined;
    await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: true,
      onDryRunReport: (r) => {
        captured = r;
      },
    });

    // LML is called honestly in DRY_RUN to make the count predictive.
    expect(bulkResolve).toHaveBeenCalledTimes(1);
    expect(writeSingleArtist).not.toHaveBeenCalled();

    if (!captured) throw new Error('expected a dry-run report');
    expect(Object.keys(captured).sort()).toEqual(
      [
        'lml_total_calls',
        'lml_total_latency_ms',
        'scanned',
        'source_rows_skipped_null_confidence',
        'would_resolve',
        'would_skip',
        'would_unresolved',
      ].sort()
    );
    expect(Object.keys(captured.would_skip).sort()).toEqual(
      ['compilation', 'lml_cardinality_mismatch', 'lml_error'].sort()
    );
    expect(captured.scanned).toBe(3);
    expect(captured.would_resolve).toBe(1);
    expect(captured.would_unresolved).toBe(1);
    expect(captured.would_skip.compilation).toBe(1);
    expect(captured.would_skip.lml_error).toBe(0);
    expect(captured.would_skip.lml_cardinality_mismatch).toBe(0);
    expect(captured.source_rows_skipped_null_confidence).toBe(0);
    expect(captured.lml_total_calls).toBe(1);
  });

  it('counts an LML-failed batch under would_skip.lml_error in DRY_RUN', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 100, artist_name: 'A', album_title: 'a' },
        { id: 101, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValue([]);

    const bulkResolve = jest.fn<BulkResolveFn>().mockRejectedValueOnce(new Error('LML 503'));
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });

    let captured: DryRunReport | undefined;
    await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: true,
      onDryRunReport: (r) => {
        captured = r;
      },
    });

    if (!captured) throw new Error('expected a dry-run report');
    expect(captured.would_skip.lml_error).toBe(2);
    expect(captured.would_resolve).toBe(0);
  });
});
