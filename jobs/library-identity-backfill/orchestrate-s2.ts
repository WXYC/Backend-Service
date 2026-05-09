/**
 * Backfill orchestrator for §4 step 2 sub-PR 2.1 — S2 (LML-derived artist
 * identity, read from Backend's mirrored `artists` columns).
 *
 * Differences from S1's orchestrator:
 *   - WHERE filter: select `library × artists` rows where ANY of the six
 *     identity columns is non-null AND no S2 row already exists for the
 *     library_id (idempotency at (library_id, source) granularity, not
 *     library_id-level).
 *   - Calls `writeIdentity(libraryId, sourceRows, agreementSources)` once
 *     per library_id with the full S2 source set so the writer's
 *     §3.4.1.1 recompute composes correctly in one transaction.
 *   - DRY_RUN report includes a `would_write_sources` count that fans out
 *     beyond `scanned` (each library row → up to 6 per-source rows) and a
 *     `would_upsert_mains` count bounded by distinct library_ids touched.
 *
 * The provenance index is built once at job start by the caller (job.ts);
 * tests inject a synthetic `ProvenanceIndex`.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { resolveS2, type LibraryArtistRow } from './resolve-s2.js';
import type { SourceRowToWrite } from './resolve.js';
import type { ProvenanceIndex } from './sources/lml-provenance-index.js';
import { log } from './logger.js';

const JOB_NAME = 'library-identity-backfill';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const ARTISTS_TABLE = sql.raw(`"${SCHEMA}"."artists"`);
const LIBRARY_IDENTITY_SOURCE_TABLE = sql.raw(`"${SCHEMA}"."library_identity_source"`);

export const BATCH_SIZE = 500;
export const THROTTLE_MS = 100;

export type WriteIdentityFn = (
  libraryId: number,
  sourceRows: SourceRowToWrite[],
  agreementSources: string[]
) => Promise<void>;

export type Totals = {
  scanned: number;
  wrote: number;
  wrote_sources: number;
  skipped_no_identity_columns: number;
  skipped_artist_name_missing: number;
  skipped_all_sources_already_in_library_identity_source: number;
};

/** Locked schema for the DRY_RUN stdout report (S2 § sub-PR 2.1). */
export type DryRunReportS2 = {
  source: 'S2';
  scanned: number;
  would_write_sources: number;
  would_upsert_mains: number;
  skipped: {
    no_identity_columns: number;
    all_sources_already_in_library_identity_source: number;
  };
};

export type RunResult = {
  totals: Totals;
  dryRunReport: DryRunReportS2 | null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type BatchRow = LibraryArtistRow & { already_in_library_identity_source: boolean };

const loadBatch = async (
  afterId: number,
  batchSize: number,
  partitionFilter: SQL | null,
  dryRun: boolean
): Promise<BatchRow[]> => {
  const partitionClause = partitionFilter ?? sql``;
  // Real-run filter excludes rows where every (library_id, source='*_artist')
  // pair already has a library_identity_source entry — equivalent to "every
  // S2 source we'd write was already written". The DRY_RUN flavor relaxes
  // this so the report can break out the rerun-overlap bucket honestly.
  //
  // S2 is artist-level — one row per distinct (library_id, sourceName). The
  // six sources are a fixed set; the most efficient way to express "all S2
  // sources already written" is a count comparison. But we don't actually
  // want to skip when SOME are written; we want to write the missing ones
  // and let ON CONFLICT no-op the rest. So the real-run filter is just
  // "exists at least one populated identity column AND no S2 row yet".
  // The flag below carries the binary "all/none" signal for DRY_RUN.
  const sourcesNotAllWrittenClause = sql`AND NOT EXISTS (
    SELECT 1 FROM ${LIBRARY_IDENTITY_SOURCE_TABLE} lis
    WHERE lis."library_id" = l."id"
      AND lis."source" IN ('discogs_artist','mb_artist','wikidata','spotify','apple_music','bandcamp')
    HAVING count(*) >= (
      (CASE WHEN a."discogs_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN a."musicbrainz_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN a."wikidata_qid" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN a."spotify_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN a."apple_music_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN a."bandcamp_id" IS NOT NULL THEN 1 ELSE 0 END)
    )
  )`;
  const hasAnyIdentityClause = sql`AND (
    a."discogs_artist_id" IS NOT NULL
    OR a."musicbrainz_artist_id" IS NOT NULL
    OR a."wikidata_qid" IS NOT NULL
    OR a."spotify_artist_id" IS NOT NULL
    OR a."apple_music_artist_id" IS NOT NULL
    OR a."bandcamp_id" IS NOT NULL
  )`;
  const filterClause = dryRun
    ? sql``
    : sql`${hasAnyIdentityClause}
    ${sourcesNotAllWrittenClause}`;

  const presenceFlag = dryRun
    ? sql`,
      (
        SELECT count(*) >= (
          (CASE WHEN a."discogs_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN a."musicbrainz_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN a."wikidata_qid" IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN a."spotify_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN a."apple_music_artist_id" IS NOT NULL THEN 1 ELSE 0 END)
          + (CASE WHEN a."bandcamp_id" IS NOT NULL THEN 1 ELSE 0 END)
        )
        FROM ${LIBRARY_IDENTITY_SOURCE_TABLE} lis
        WHERE lis."library_id" = l."id"
          AND lis."source" IN ('discogs_artist','mb_artist','wikidata','spotify','apple_music','bandcamp')
      ) AS "already_in_library_identity_source"`
    : sql`,
      false AS "already_in_library_identity_source"`;

  const rows = (await db.execute(sql`
    SELECT
      l."id"                       AS "id",
      a."artist_name"              AS "artist_name",
      a."discogs_artist_id"        AS "discogs_artist_id",
      a."musicbrainz_artist_id"    AS "musicbrainz_artist_id",
      a."wikidata_qid"             AS "wikidata_qid",
      a."spotify_artist_id"        AS "spotify_artist_id",
      a."apple_music_artist_id"    AS "apple_music_artist_id",
      a."bandcamp_id"              AS "bandcamp_id",
      a."last_modified"            AS "last_modified"${presenceFlag}
    FROM ${LIBRARY_TABLE} l
    JOIN ${ARTISTS_TABLE} a ON a."id" = l."artist_id"
    WHERE l."id" > ${afterId}
      ${filterClause}
      ${partitionClause}
    ORDER BY l."id" ASC
    LIMIT ${batchSize}
  `)) as unknown as BatchRow[];
  return rows ?? [];
};

const formatTotals = (t: Totals): string =>
  `scanned=${t.scanned} wrote=${t.wrote} wrote_sources=${t.wrote_sources} ` +
  `skipped_no_identity_columns=${t.skipped_no_identity_columns} ` +
  `skipped_artist_name_missing=${t.skipped_artist_name_missing} ` +
  `skipped_all_sources_already_in_library_identity_source=${t.skipped_all_sources_already_in_library_identity_source}`;

export const runBackfillS2 = async (opts: {
  writeIdentity: WriteIdentityFn;
  provenanceIndex: ProvenanceIndex;
  batchSize?: number;
  throttleMs?: number;
  partition?: { sqlFragment: SQL | null; description: string };
  dryRun?: boolean;
  onDryRunReport?: (report: DryRunReportS2) => void;
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  const partition = opts.partition ?? { sqlFragment: null, description: 'partition=none' };
  const dryRun = opts.dryRun ?? false;

  log('info', 'started', `${JOB_NAME} S2 starting`, {
    leg: 'S2',
    batch_size: batchSize,
    throttle_ms: throttleMs,
    partition: partition.description,
    dry_run: dryRun,
    provenance_index_size: opts.provenanceIndex.size,
  });

  const totals: Totals = {
    scanned: 0,
    wrote: 0,
    wrote_sources: 0,
    skipped_no_identity_columns: 0,
    skipped_artist_name_missing: 0,
    skipped_all_sources_already_in_library_identity_source: 0,
  };
  let lastId = 0;
  let batchIndex = 0;

  while (true) {
    const rows = await loadBatch(lastId, batchSize, partition.sqlFragment, dryRun);
    if (rows.length === 0) break;
    batchIndex += 1;

    for (const row of rows) {
      totals.scanned += 1;
      lastId = row.id;

      const outcome = resolveS2(row, opts.provenanceIndex);
      if (outcome.status === 'no_identity_columns') {
        totals.skipped_no_identity_columns += 1;
        continue;
      }
      if (outcome.status === 'artist_name_missing') {
        totals.skipped_artist_name_missing += 1;
        continue;
      }

      // DRY_RUN-only bucket: every S2 source for this library_id is already
      // written. Real-run path filters these at the SQL layer; DRY_RUN
      // surfaces them so would_write_sources is honest on rerun.
      if (row.already_in_library_identity_source) {
        totals.skipped_all_sources_already_in_library_identity_source += 1;
        continue;
      }

      if (!dryRun) {
        await opts.writeIdentity(row.id, outcome.sourceRows, outcome.agreementSources);
        totals.wrote += 1;
        totals.wrote_sources += outcome.sourceRows.length;
      } else {
        totals.wrote_sources += outcome.sourceRows.length;
      }
      if (throttleMs > 0) await sleep(throttleMs);
    }

    log('info', 'batch_done', `${JOB_NAME} S2 batch ${batchIndex} done`, {
      batch_index: batchIndex,
      last_id: lastId,
      ...totals,
    });
  }

  const writableLibraries =
    totals.scanned -
    totals.skipped_no_identity_columns -
    totals.skipped_artist_name_missing -
    totals.skipped_all_sources_already_in_library_identity_source;

  const dryRunReport: DryRunReportS2 | null = dryRun
    ? {
        source: 'S2',
        scanned: totals.scanned,
        would_write_sources: totals.wrote_sources,
        would_upsert_mains: writableLibraries,
        skipped: {
          no_identity_columns: totals.skipped_no_identity_columns,
          all_sources_already_in_library_identity_source: totals.skipped_all_sources_already_in_library_identity_source,
        },
      }
    : null;

  if (dryRunReport) {
    process.stdout.write(JSON.stringify(dryRunReport) + '\n');
    if (opts.onDryRunReport) opts.onDryRunReport(dryRunReport);
  }

  log('info', 'finished', `${JOB_NAME} S2 done. ${formatTotals(totals)}`, { ...totals });
  return { totals, dryRunReport };
};
