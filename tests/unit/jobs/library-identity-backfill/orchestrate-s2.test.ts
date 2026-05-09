/**
 * Unit tests for the S2 orchestrator (sub-PR 2.1).
 *
 * Differences from S1's orchestrator:
 *   - Reads Backend's `library × artists` JOIN; selects rows where ANY
 *     identity column is non-null.
 *   - Idempotency at the (library_id, source) granularity, not library_id
 *     (S2 may add new sources to a library_id that S1 already wrote).
 *   - Calls `writeIdentity(libraryId, sourceRows, agreementSources)` once
 *     per library_id with the full set of S2 sources at once — keeps the
 *     transactional writer's recompute consistent.
 *   - DRY_RUN report includes a `would_write_sources` count that fans out
 *     beyond `scanned` because each row produces up to 6 per-source rows.
 */

import { db } from '@wxyc/database';
import { runBackfillS2, type DryRunReportS2 } from '../../../../jobs/library-identity-backfill/orchestrate-s2';
import type { ProvenanceIndex } from '../../../../jobs/library-identity-backfill/sources/lml-provenance-index';

const emptyIndex = (): ProvenanceIndex => ({
  lookup: () => undefined,
  size: 0,
});

describe('runBackfillS2 — real run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('writes one writeIdentity call per matched library row, with all populated sources', async () => {
    const writes: Array<{ libraryId: number; rowCount: number; agreementSources: string[] }> = [];
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 100,
          artist_name: 'Stereolab',
          discogs_artist_id: 12345,
          musicbrainz_artist_id: 'mb-uuid',
          wikidata_qid: 'Q42',
          spotify_artist_id: null,
          apple_music_artist_id: null,
          bandcamp_id: null,
          last_modified: new Date(),
          already_in_library_identity_source: false,
        },
      ])
      .mockResolvedValue([]);

    const writeIdentity = jest.fn(
      (libraryId: number, rows: Array<{ source: string }>, agreement: string[]): Promise<void> => {
        writes.push({ libraryId, rowCount: rows.length, agreementSources: agreement });
        return Promise.resolve();
      }
    );

    const result = await runBackfillS2({
      writeIdentity,
      provenanceIndex: emptyIndex(),
      throttleMs: 0,
      batchSize: 500,
    });

    expect(writes).toEqual([
      {
        libraryId: 100,
        rowCount: 3,
        agreementSources: expect.arrayContaining(['discogs_artist', 'mb_artist', 'wikidata']),
      },
    ]);
    expect(result.totals.scanned).toBe(1);
    expect(result.totals.wrote).toBe(1);
    expect(result.totals.wrote_sources).toBe(3);
  });

  it('skips rows where every identity column is null', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 200,
          artist_name: 'Empty Artist',
          discogs_artist_id: null,
          musicbrainz_artist_id: null,
          wikidata_qid: null,
          spotify_artist_id: null,
          apple_music_artist_id: null,
          bandcamp_id: null,
          last_modified: new Date(),
          already_in_library_identity_source: false,
        },
      ])
      .mockResolvedValue([]);
    const writeIdentity = jest.fn(() => Promise.resolve());

    const result = await runBackfillS2({
      writeIdentity,
      provenanceIndex: emptyIndex(),
      throttleMs: 0,
      batchSize: 500,
    });

    expect(writeIdentity).not.toHaveBeenCalled();
    expect(result.totals.skipped_no_identity_columns).toBe(1);
    expect(result.totals.wrote).toBe(0);
  });
});

describe('runBackfillS2 — DRY_RUN', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('emits the locked DRY_RUN JSON schema and never calls writeIdentity', async () => {
    (db.execute as jest.Mock)
      .mockResolvedValueOnce([
        {
          id: 100,
          artist_name: 'Stereolab',
          discogs_artist_id: 12345,
          musicbrainz_artist_id: 'mb-uuid',
          wikidata_qid: null,
          spotify_artist_id: null,
          apple_music_artist_id: null,
          bandcamp_id: null,
          last_modified: new Date(),
          already_in_library_identity_source: false,
        },
        {
          id: 101,
          artist_name: 'Already Done',
          discogs_artist_id: 99,
          musicbrainz_artist_id: null,
          wikidata_qid: null,
          spotify_artist_id: null,
          apple_music_artist_id: null,
          bandcamp_id: null,
          last_modified: new Date(),
          already_in_library_identity_source: true,
        },
        {
          id: 102,
          artist_name: 'No IDs',
          discogs_artist_id: null,
          musicbrainz_artist_id: null,
          wikidata_qid: null,
          spotify_artist_id: null,
          apple_music_artist_id: null,
          bandcamp_id: null,
          last_modified: new Date(),
          already_in_library_identity_source: false,
        },
      ])
      .mockResolvedValue([]);

    const writeIdentity = jest.fn(() => Promise.resolve());
    let captured: DryRunReportS2 | undefined;
    const result = await runBackfillS2({
      writeIdentity,
      provenanceIndex: emptyIndex(),
      throttleMs: 0,
      batchSize: 500,
      dryRun: true,
      onDryRunReport: (r) => {
        captured = r;
      },
    });

    expect(writeIdentity).not.toHaveBeenCalled();
    expect(result.totals.wrote).toBe(0);
    if (!captured) throw new Error('expected dry-run report');
    expect(captured.source).toBe('S2');
    expect(captured.scanned).toBe(3);
    expect(captured.would_write_sources).toBe(2);
    expect(captured.would_upsert_mains).toBe(1);
    expect(captured.skipped.no_identity_columns).toBe(1);
    expect(captured.skipped.all_sources_already_in_library_identity_source).toBe(1);
  });

  it('preserves the locked dry-run JSON schema (stable keys)', async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce([]).mockResolvedValue([]);
    const writeIdentity = jest.fn(() => Promise.resolve());
    let captured: DryRunReportS2 | undefined;
    await runBackfillS2({
      writeIdentity,
      provenanceIndex: emptyIndex(),
      throttleMs: 0,
      batchSize: 500,
      dryRun: true,
      onDryRunReport: (r) => {
        captured = r;
      },
    });

    if (!captured) throw new Error('expected dry-run report');
    expect(Object.keys(captured).sort()).toEqual(
      ['scanned', 'skipped', 'source', 'would_upsert_mains', 'would_write_sources'].sort()
    );
    expect(Object.keys(captured.skipped).sort()).toEqual(
      ['all_sources_already_in_library_identity_source', 'no_identity_columns'].sort()
    );
  });
});
