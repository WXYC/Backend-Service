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
  isCompilationTracksAttempted,
  type BulkResolveFn,
  type DryRunReport,
  type StampUnresolvedFn,
  type WriteCompilationTracksFn,
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
      result.totals.rows_skipped.lml_cardinality_mismatch +
      result.totals.rows_skipped.lml_untrusted_library_id;
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

  it('skips a result whose library_id is not present in the batch input set', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValue([]);

    // LML returns a result for library_id=999, which was never part of
    // this batch's inputs. Length still matches rows.length, so the
    // cardinality check alone would miss this.
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue({
      results: [
        { kind: 'unresolved', library_id: 1, provenance: [] },
        { kind: 'unresolved', library_id: 999, provenance: [] },
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

    expect(result.totals.scanned).toBe(2);
    expect(result.totals.rows_unresolved).toBe(1);
    expect(result.totals.rows_skipped.lml_untrusted_library_id).toBe(1);
  });

  it('skips a result whose library_id is missing from the batch input set (short response)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValue([]);

    // LML drops library_id=2 entirely (short response) — caught by the
    // pre-existing cardinality-mismatch check, not the membership check.
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue({
      results: [{ kind: 'unresolved', library_id: 1, provenance: [] }],
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

    expect(result.totals.scanned).toBe(2);
    expect(result.totals.rows_unresolved).toBe(1);
    expect(result.totals.rows_skipped.lml_cardinality_mismatch).toBe(1);
    expect(result.totals.rows_skipped.lml_untrusted_library_id).toBe(0);
  });

  it('flags a duplicated library_id that compensates for a dropped one (length matches, membership does not)', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 1, artist_name: 'A', album_title: 'a' },
        { id: 2, artist_name: 'B', album_title: 'b' },
      ])
      .mockResolvedValue([]);

    // LML returns library_id=1 twice and drops library_id=2, keeping
    // response.results.length === rows.length. The length-only cardinality
    // check would see nothing wrong; the membership check must flag the
    // duplicate.
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue({
      results: [
        { kind: 'unresolved', library_id: 1, provenance: [] },
        { kind: 'unresolved', library_id: 1, provenance: [] },
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

    expect(result.totals.scanned).toBe(2);
    expect(result.totals.rows_unresolved).toBe(1);
    expect(result.totals.rows_skipped.lml_cardinality_mismatch).toBe(0);
    expect(result.totals.rows_skipped.lml_untrusted_library_id).toBe(1);
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
        'would_resolve_compilation',
        'would_skip',
        'would_unresolved',
      ].sort()
    );
    expect(Object.keys(captured.would_skip).sort()).toEqual(
      ['compilation', 'lml_cardinality_mismatch', 'lml_error', 'lml_untrusted_library_id'].sort()
    );
    expect(captured.scanned).toBe(3);
    expect(captured.would_resolve).toBe(1);
    expect(captured.would_unresolved).toBe(1);
    expect(captured.would_skip.compilation).toBe(1);
    expect(captured.would_skip.lml_error).toBe(0);
    expect(captured.would_skip.lml_cardinality_mismatch).toBe(0);
    expect(captured.would_skip.lml_untrusted_library_id).toBe(0);
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

describe('runConsumer — BS#974 unresolved-marker stamping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // One batch: 2 single_artist (100, 101), 1 compilation (102), 1 unresolved (103).
  const wireOneBatch = () => {
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
          method: 'exact_match',
          confidence: 1.0,
          provenance: [{ source: 'wikidata', method: 'exact_match', confidence: 1.0, external_id: 'Q-jess' }],
        },
        { kind: 'compilation', library_id: 102, provenance: [] },
        { kind: 'unresolved', library_id: 103, provenance: [] },
      ],
    };
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue(lmlResponse);
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 1,
      source_rows_skipped_null_confidence: 0,
    });
    return { bulkResolve, writeSingleArtist };
  };

  const baseOpts = (bulkResolve: BulkResolveFn, writeSingleArtist: WriteSingleArtistFn) => ({
    bulkResolve,
    writeSingleArtist,
    batchSize: 500,
    throttleMs: 0,
    staleDays: 7,
    partition: { sqlFragment: null, description: 'partition=none' },
  });

  it('flag-on stamps ONLY the unresolved + compilation ids (not resolved rows)', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneBatch();
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockResolvedValue(undefined);

    await runConsumer({
      ...baseOpts(bulkResolve, writeSingleArtist),
      dryRun: false,
      includeNullCanonical: true,
      stampUnresolvedAttemptedAt,
    });

    expect(stampUnresolvedAttemptedAt).toHaveBeenCalledTimes(1);
    // compilation (102) pushed before unresolved (103), following results order.
    expect(stampUnresolvedAttemptedAt).toHaveBeenCalledWith([102, 103]);
  });

  it('flag-off (default) never stamps, even with a stamp fn wired', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneBatch();
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockResolvedValue(undefined);

    await runConsumer({
      ...baseOpts(bulkResolve, writeSingleArtist),
      dryRun: false,
      includeNullCanonical: false,
      stampUnresolvedAttemptedAt,
    });

    expect(stampUnresolvedAttemptedAt).not.toHaveBeenCalled();
  });

  it('dry-run never stamps even with the flag on', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneBatch();
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockResolvedValue(undefined);

    await runConsumer({
      ...baseOpts(bulkResolve, writeSingleArtist),
      dryRun: true,
      includeNullCanonical: true,
      stampUnresolvedAttemptedAt,
    });

    expect(stampUnresolvedAttemptedAt).not.toHaveBeenCalled();
  });

  it('a stamp failure is swallowed — the drain still completes with correct counters', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneBatch();
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockRejectedValue(new Error('stamp 503'));

    const result = await runConsumer({
      ...baseOpts(bulkResolve, writeSingleArtist),
      dryRun: false,
      includeNullCanonical: true,
      stampUnresolvedAttemptedAt,
    });

    expect(stampUnresolvedAttemptedAt).toHaveBeenCalledTimes(1);
    expect(result.totals.rows_resolved).toBe(2);
    expect(result.totals.rows_unresolved).toBe(1);
    expect(result.totals.rows_skipped.compilation).toBe(1);
  });
});

describe('isCompilationTracksAttempted (BS#1991 / #801 S2)', () => {
  const compilation = (
    overrides: Partial<Extract<BulkResolveResult, { kind: 'compilation' }>> = {}
  ): Extract<BulkResolveResult, { kind: 'compilation' }> => ({
    kind: 'compilation',
    library_id: 1,
    provenance: [],
    ...overrides,
  });

  it('is false when the response lacks tracks_contract_version (producer predates the contract) even if tracks_attempted is true', () => {
    const response: BulkResolveResponse = { results: [] };
    expect(isCompilationTracksAttempted(compilation({ tracks_attempted: true, tracks: [] }), response)).toBe(false);
  });

  it('is false when tracks_contract_version is present but not 1', () => {
    const response: BulkResolveResponse = { results: [], tracks_contract_version: 2 };
    expect(isCompilationTracksAttempted(compilation({ tracks_attempted: true }), response)).toBe(false);
  });

  it('is false for (tracks_attempted: false, tracks: []) — matcher has not reached this row', () => {
    const response: BulkResolveResponse = { results: [], tracks_contract_version: 1 };
    expect(isCompilationTracksAttempted(compilation({ tracks_attempted: false, tracks: [] }), response)).toBe(false);
  });

  it('is false for (tracks_attempted: absent, tracks: absent)', () => {
    const response: BulkResolveResponse = { results: [], tracks_contract_version: 1 };
    expect(isCompilationTracksAttempted(compilation({}), response)).toBe(false);
  });

  it('is true for (tracks_attempted: true, tracks: []) — matcher ran, resolved nothing', () => {
    const response: BulkResolveResponse = { results: [], tracks_contract_version: 1 };
    expect(isCompilationTracksAttempted(compilation({ tracks_attempted: true, tracks: [] }), response)).toBe(true);
  });

  it('is true for (tracks_attempted: true, tracks: [...]) — matcher ran, produced entries', () => {
    const response: BulkResolveResponse = { results: [], tracks_contract_version: 1 };
    const tracks = [
      { artist_name: 'A', track_title: 'T', track_position: null, resolved_artist_name: 'A', confidence: 0.9 },
    ];
    expect(isCompilationTracksAttempted(compilation({ tracks_attempted: true, tracks }), response)).toBe(true);
  });

  it('a producer-bug pairing (tracks_attempted: false, tracks: [...] non-empty) MUST be read as true (api.yaml 1.31.0 Q2 mitigation)', () => {
    const response: BulkResolveResponse = { results: [], tracks_contract_version: 1 };
    const tracks = [
      { artist_name: 'A', track_title: 'T', track_position: null, resolved_artist_name: 'A', confidence: 0.9 },
    ];
    expect(isCompilationTracksAttempted(compilation({ tracks_attempted: false, tracks }), response)).toBe(true);
  });
});

describe('runConsumer — BS#1991 kind:compilation per-track resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const trackEntry = () => ({
    artist_name: 'Various Artists',
    track_title: 'Some Track',
    track_position: null,
    resolved_artist_name: 'Some Artist',
    confidence: 0.8,
  });

  const wireOneCompilationBatch = (): {
    bulkResolve: BulkResolveFn;
    writeSingleArtist: WriteSingleArtistFn;
    lmlResponse: BulkResolveResponse;
  } => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 200, artist_name: 'Various Artists', album_title: 'A Compilation', legacy_release_id: 5000200 },
        { id: 201, artist_name: 'Various Artists', album_title: 'Another Comp', legacy_release_id: 5000201 },
      ])
      .mockResolvedValue([]);

    const lmlResponse: BulkResolveResponse = {
      results: [
        { kind: 'compilation', library_id: 200, provenance: [], tracks_attempted: true, tracks: [trackEntry()] },
        { kind: 'compilation', library_id: 201, provenance: [], tracks_attempted: false, tracks: [] },
      ],
      tracks_contract_version: 1,
    };
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue(lmlResponse);
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });
    return { bulkResolve, writeSingleArtist, lmlResponse };
  };

  it('a resolved compilation (tracks_attempted=true) is written via writeCompilationTracks and counted as rows_resolved_compilation, not rows_skipped.compilation', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneCompilationBatch();
    const writeCompilationTracks = jest.fn<WriteCompilationTracksFn>().mockResolvedValue({
      rows_written: 3,
      rows_skipped_librarian: 1,
      rows_skipped_no_cta_match: 0,
      rows_skipped_no_catalog_artist: 0,
      position_rows_written: 0,
      position_rows_skipped_ambiguous: 0,
    });

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      writeCompilationTracks,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
    });

    // library_id 200 (attempted) is written; 201 (not yet askable) stays in
    // the pre-existing skip bucket unchanged.
    expect(writeCompilationTracks).toHaveBeenCalledTimes(1);
    expect(writeCompilationTracks.mock.calls[0][0]).toHaveLength(1);
    expect(writeCompilationTracks.mock.calls[0][0][0].library_id).toBe(200);

    expect(result.totals.rows_resolved_compilation).toBe(1);
    expect(result.totals.compilation_track_rows_written).toBe(3);
    expect(result.totals.compilation_track_rows_skipped_librarian).toBe(1);
    expect(result.totals.rows_skipped.compilation).toBe(1);
    expect(result.totals.scanned).toBe(2);
  });

  it('dry-run counts a resolved compilation without calling writeCompilationTracks', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneCompilationBatch();
    const writeCompilationTracks = jest.fn<WriteCompilationTracksFn>();

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      writeCompilationTracks,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: true,
    });

    expect(writeCompilationTracks).not.toHaveBeenCalled();
    expect(result.totals.rows_resolved_compilation).toBe(1);
    expect(result.dryRunReport?.would_resolve_compilation).toBe(1);
  });

  it('throws a clear error when a resolved compilation appears but no writeCompilationTracks was configured', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneCompilationBatch();

    await expect(
      runConsumer({
        bulkResolve,
        writeSingleArtist,
        batchSize: 500,
        throttleMs: 0,
        staleDays: 7,
        partition: { sqlFragment: null, description: 'partition=none' },
        dryRun: false,
      })
    ).rejects.toThrow(/writeCompilationTracks/);
  });

  it('a writeCompilationTracks failure counts writer_error and leaves the row retryable (not stamped)', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneCompilationBatch();
    const writeCompilationTracks = jest.fn<WriteCompilationTracksFn>().mockRejectedValue(new Error('db boom'));
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockResolvedValue(undefined);

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      writeCompilationTracks,
      stampUnresolvedAttemptedAt,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
      includeNullCanonical: true,
    });

    expect(result.totals.rows_skipped.writer_error).toBe(1);
    expect(result.totals.rows_resolved_compilation).toBe(0);
    // 201 (not-yet-askable) is stamped; 200 (write failed) is NOT — a local
    // write failure is retryable, not a definitive LML verdict.
    expect(stampUnresolvedAttemptedAt).toHaveBeenCalledWith([201]);
  });

  it('BS#1991 D10 interplay: a resolved compilation is kept OUT of the not-yet-askable skip bucket, but IS included in the stampUnresolvedAttemptedAt call so a later manual re-run does not re-burn LML on it', async () => {
    const { bulkResolve, writeSingleArtist } = wireOneCompilationBatch();
    const writeCompilationTracks = jest.fn<WriteCompilationTracksFn>().mockResolvedValue({
      rows_written: 1,
      rows_skipped_librarian: 0,
      rows_skipped_no_cta_match: 0,
      rows_skipped_no_catalog_artist: 0,
      position_rows_written: 0,
      position_rows_skipped_ambiguous: 0,
    });
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockResolvedValue(undefined);

    const result = await runConsumer({
      bulkResolve,
      writeSingleArtist,
      writeCompilationTracks,
      stampUnresolvedAttemptedAt,
      batchSize: 500,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
      includeNullCanonical: true,
    });

    // Both ids get stamped (200 resolved, 201 not-yet-askable) — but 200 is
    // NOT counted under rows_skipped.compilation, only 201 is.
    expect(stampUnresolvedAttemptedAt).toHaveBeenCalledWith([201, 200]);
    expect(result.totals.rows_skipped.compilation).toBe(1);
    expect(result.totals.rows_resolved_compilation).toBe(1);
  });

  it('cohort="va" and recheck thread through to loadBatch (SQL carries the va-cohort condition)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValue([]);
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue({ results: [] });
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });

    await runConsumer({
      bulkResolve,
      writeSingleArtist,
      batchSize: 100,
      throttleMs: 0,
      staleDays: 7,
      partition: { sqlFragment: null, description: 'partition=none' },
      dryRun: false,
      cohort: 'va',
    });

    const serialized = JSON.stringify((db.execute as jest.Mock).mock.calls[0][0]);
    expect(serialized).toMatch(/code_volume_letters/);
  });
});

describe('runConsumer — BS#1991 bounce-1 fixes (stamp split + counter projection)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const fullOutcome = {
    rows_written: 3,
    rows_skipped_unchanged: 5,
    rows_skipped_librarian: 1,
    rows_skipped_no_cta_match: 2,
    rows_skipped_no_catalog_artist: 4,
    position_rows_written: 6,
    position_rows_skipped_ambiguous: 7,
  };

  const wire = () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        { id: 200, artist_name: 'Various Artists', album_title: 'A Compilation', legacy_release_id: 5000200 },
        { id: 201, artist_name: 'Various Artists', album_title: 'Another Comp', legacy_release_id: 5000201 },
        { id: 203, artist_name: 'Csillagrablók', album_title: 'Nem Comp', legacy_release_id: 5000203 },
      ])
      .mockResolvedValue([]);
    const lmlResponse: BulkResolveResponse = {
      results: [
        {
          kind: 'compilation',
          library_id: 200,
          provenance: [],
          tracks_attempted: true,
          tracks: [
            {
              artist_name: 'Various Artists',
              track_title: 'Some Track',
              track_position: null,
              resolved_artist_name: 'Some Artist',
              confidence: 0.8,
            },
          ],
        },
        { kind: 'compilation', library_id: 201, provenance: [], tracks_attempted: false, tracks: [] },
        { kind: 'unresolved', library_id: 203, provenance: [] },
      ],
      tracks_contract_version: 1,
    };
    const bulkResolve = jest.fn<BulkResolveFn>().mockResolvedValue(lmlResponse);
    const writeSingleArtist = jest.fn<WriteSingleArtistFn>().mockResolvedValue({
      source_rows_written: 0,
      source_rows_skipped_null_confidence: 0,
    });
    const writeCompilationTracks = jest.fn<WriteCompilationTracksFn>().mockResolvedValue(fullOutcome);
    const stampUnresolvedAttemptedAt = jest.fn<StampUnresolvedFn>().mockResolvedValue(undefined);
    return { bulkResolve, writeSingleArtist, writeCompilationTracks, stampUnresolvedAttemptedAt };
  };

  const baseOpts = () => ({
    batchSize: 500,
    throttleMs: 0,
    staleDays: 7,
    partition: { sqlFragment: null, description: 'partition=none' },
  });

  it('flag-off (default) still stamps a RESOLVED compilation — its resolved-exit has no other durable marker — while not-yet-askable and unresolved ids stay unstamped', async () => {
    const w = wire();

    await runConsumer({ ...baseOpts(), ...w, dryRun: false, includeNullCanonical: false });

    expect(w.stampUnresolvedAttemptedAt).toHaveBeenCalledTimes(1);
    expect(w.stampUnresolvedAttemptedAt).toHaveBeenCalledWith([200]);
  });

  it('flag-on stamps the union: resolved compilations + not-yet-askable compilations + unresolved', async () => {
    const w = wire();

    await runConsumer({ ...baseOpts(), ...w, dryRun: false, includeNullCanonical: true });

    expect(w.stampUnresolvedAttemptedAt).toHaveBeenCalledTimes(1);
    const stamped = w.stampUnresolvedAttemptedAt.mock.calls[0][0];
    expect([...stamped].sort()).toEqual([200, 201, 203]);
  });

  it('dry-run never stamps a resolved compilation either', async () => {
    const w = wire();

    await runConsumer({ ...baseOpts(), ...w, dryRun: true, includeNullCanonical: false });

    expect(w.stampUnresolvedAttemptedAt).not.toHaveBeenCalled();
  });

  it('projects every CompilationWriteOutcome counter into Totals — a systematic echo-match gap must be visible', async () => {
    const w = wire();

    const result = await runConsumer({ ...baseOpts(), ...w, dryRun: false, includeNullCanonical: false });

    expect(result.totals.compilation_track_rows_written).toBe(3);
    expect(result.totals.compilation_track_rows_skipped_unchanged).toBe(5);
    expect(result.totals.compilation_track_rows_skipped_librarian).toBe(1);
    expect(result.totals.compilation_track_rows_skipped_no_cta_match).toBe(2);
    expect(result.totals.compilation_track_rows_skipped_no_catalog_artist).toBe(4);
    expect(result.totals.compilation_track_position_rows_written).toBe(6);
    expect(result.totals.compilation_track_position_rows_skipped_ambiguous).toBe(7);
  });
});
