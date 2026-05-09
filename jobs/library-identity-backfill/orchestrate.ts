/**
 * Backfill orchestrator for §4 step 2 sub-PR 2.0 — library_identity from
 * Backend's `library.canonical_entity_id` column (S1).
 *
 * Mirrors `library-canonical-entity-backfill/orchestrate.ts`'s shape:
 *
 *   - WHERE filter:
 *       library.canonical_entity_id IS NOT NULL
 *       AND library.canonical_entity_id LIKE 'discogs:%'
 *       AND NOT EXISTS (SELECT 1 FROM library_identity li WHERE li.library_id = library.id)
 *     The first two scope to S1's universe; the NOT EXISTS gates idempotency
 *     (rows already written are skipped on rerun, per §4).
 *   - id-cursor pagination + PARTITION_INDEX/COUNT modulo for parallel
 *     containers.
 *   - DRY_RUN env var: when true, the SELECT runs but every per-library_id
 *     write is suppressed; the orchestrator emits a single locked-schema JSON
 *     report on stdout.
 *
 * The `writeIdentity` function is injected so tests can drive the loop
 * without exercising the live transaction.
 *
 * Skip categories tracked in counters and the dry-run report:
 *   - already_in_library_identity — `library_identity.library_id` already
 *     present (the WHERE filter usually excludes these; the counter exists
 *     for the DRY_RUN path which intentionally does not enforce the filter
 *     in JOIN form).
 *   - no_canonical_entity_id — column is NULL (excluded by WHERE in real
 *     run; surfaced by DRY_RUN at the resolver step).
 *   - non_discogs_namespace — value is non-NULL but does not match
 *     `discogs:<int>`. Other namespaces (e.g., 'mb:') belong to sub-PRs
 *     2.1+; malformed values are also bucketed here.
 */

import { sql, type SQL } from 'drizzle-orm';
import { db } from '@wxyc/database';
import { resolveS1, type LibraryRow, type SourceRowToWrite } from './resolve.js';
import { log } from './logger.js';

const JOB_NAME = 'library-identity-backfill';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const LIBRARY_TABLE = sql.raw(`"${SCHEMA}"."library"`);
const LIBRARY_IDENTITY_TABLE = sql.raw(`"${SCHEMA}"."library_identity"`);

export const BATCH_SIZE = 500;

/**
 * Default inter-row delay, in ms. Sub-PR 2.0 is DB-only (no LML traffic), so
 * this is purely about not saturating the postgres-js connection pool. Tests
 * pass 0.
 */
export const THROTTLE_MS = 100;

export const resolveBatchSize = (raw: string | undefined = process.env.BATCH_SIZE): number => {
  if (raw === undefined) return BATCH_SIZE;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid BATCH_SIZE=${JSON.stringify(raw)}; must be a positive integer.`);
  }
  return parsed;
};

export const resolveThrottleMs = (raw: string | undefined = process.env.THROTTLE_MS): number => {
  if (raw === undefined) return THROTTLE_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid THROTTLE_MS=${JSON.stringify(raw)}; must be a non-negative integer.`);
  }
  return parsed;
};

/**
 * Resolve PARTITION_INDEX / PARTITION_COUNT into a SQL fragment. N-container
 * deploy pattern matches the existing one-shot jobs.
 */
export const resolvePartitionFilter = (
  rawIndex: string | undefined = process.env.PARTITION_INDEX,
  rawCount: string | undefined = process.env.PARTITION_COUNT
): { sqlFragment: SQL | null; description: string } => {
  const count = rawCount === undefined ? 1 : Number(rawCount);
  const index = rawIndex === undefined ? 0 : Number(rawIndex);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid PARTITION_COUNT=${JSON.stringify(rawCount)}; must be a positive integer.`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(
      `Invalid PARTITION_INDEX=${JSON.stringify(rawIndex)}; must be 0 <= index < PARTITION_COUNT (${count}).`
    );
  }
  if (count === 1) {
    return { sqlFragment: null, description: 'partition=none' };
  }
  // Qualify the column reference against `library` so a future loadBatch
  // change that introduces a JOIN doesn't trigger PG's "column reference
  // ambiguous". Mirrors the fix in `library-canonical-entity-backfill/
  // orchestrate.ts:71`.
  return {
    sqlFragment: sql`AND (${LIBRARY_TABLE}."id" % ${count}) = ${index}`,
    description: `partition=${index}/${count}`,
  };
};

/**
 * Resolve the DRY_RUN env var. Locked truthy values: `true`, `1`, `TRUE`.
 * Anything else (including `false`, `0`, undefined, empty string) is false.
 * Locked per §4 to avoid sloppy operator inputs (`yes`, `on`) silently
 * disabling the writer.
 */
export const resolveDryRun = (raw: string | undefined = process.env.DRY_RUN): boolean => {
  if (raw === undefined) return false;
  const lowered = raw.toLowerCase();
  return lowered === 'true' || lowered === '1';
};

export type WriteIdentityFn = (
  libraryId: number,
  sourceRows: SourceRowToWrite[],
  agreementSources: string[]
) => Promise<void>;

export type Totals = {
  scanned: number;
  wrote: number;
  skipped_already_in_library_identity: number;
  skipped_no_canonical_entity_id: number;
  skipped_non_discogs_namespace: number;
};

/** Locked schema for the DRY_RUN stdout report (sub-PR 2.0 §4). */
export type DryRunReport = {
  source: 'S1';
  scanned: number;
  would_write_sources: number;
  would_upsert_mains: number;
  skipped: {
    already_in_library_identity: number;
    no_canonical_entity_id: number;
    non_discogs_namespace: number;
  };
};

export type RunResult = {
  totals: Totals;
  dryRunReport: DryRunReport | null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-batch row shape. In DRY_RUN mode the SELECT additionally surfaces an
 * `already_in_library_identity` flag so the orchestrator can bin rows that
 * would have been excluded by the real-run NOT EXISTS filter. In real-run
 * mode the flag is always false (those rows are filtered out at the SQL
 * layer and never reach this struct).
 */
type BatchRow = LibraryRow & { already_in_library_identity: boolean };

const loadBatch = async (
  afterId: number,
  batchSize: number,
  partitionFilter: SQL | null,
  dryRun: boolean
): Promise<BatchRow[]> => {
  const partitionClause = partitionFilter ?? sql``;
  // In real-run mode the WHERE filter does the heavy lifting (excludes rows
  // already in library_identity, NULLs, and non-discogs namespaces). DRY_RUN
  // relaxes the second/third filters so the report can break out skip
  // categories, and surfaces an `already_in_library_identity` flag (via
  // EXISTS subselect) so the rerun-overlap count is honest. Without the
  // flag, `would_write_sources` over-counts on any rerun where prior runs
  // already wrote some rows.
  const filterClause = dryRun
    ? sql``
    : sql`AND "canonical_entity_id" IS NOT NULL
           AND "canonical_entity_id" LIKE 'discogs:%'
           AND NOT EXISTS (
             SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li WHERE li."library_id" = "id"
           )`;
  const presenceFlag = dryRun
    ? sql`,
      EXISTS (
        SELECT 1 FROM ${LIBRARY_IDENTITY_TABLE} li WHERE li."library_id" = "id"
      ) AS "already_in_library_identity"`
    : sql`,
      false AS "already_in_library_identity"`;
  const rows = (await db.execute(sql`
    SELECT
      "id",
      "canonical_entity_id",
      "canonical_entity_resolved_at"${presenceFlag}
    FROM ${LIBRARY_TABLE}
    WHERE "id" > ${afterId}
      ${filterClause}
      ${partitionClause}
    ORDER BY "id" ASC
    LIMIT ${batchSize}
  `)) as unknown as BatchRow[];
  return rows ?? [];
};

const formatTotals = (t: Totals): string =>
  `scanned=${t.scanned} wrote=${t.wrote} ` +
  `skipped_already_in_library_identity=${t.skipped_already_in_library_identity} ` +
  `skipped_no_canonical_entity_id=${t.skipped_no_canonical_entity_id} ` +
  `skipped_non_discogs_namespace=${t.skipped_non_discogs_namespace}`;

export const runBackfill = async (opts: {
  writeIdentity: WriteIdentityFn;
  batchSize?: number;
  throttleMs?: number;
  partition?: { sqlFragment: SQL | null; description: string };
  dryRun?: boolean;
  onDryRunReport?: (report: DryRunReport) => void;
}): Promise<RunResult> => {
  const batchSize = opts.batchSize ?? resolveBatchSize();
  const throttleMs = opts.throttleMs ?? resolveThrottleMs();
  const partition = opts.partition ?? resolvePartitionFilter();
  const dryRun = opts.dryRun ?? resolveDryRun();

  log('info', 'started', `${JOB_NAME} starting`, {
    batch_size: batchSize,
    throttle_ms: throttleMs,
    partition: partition.description,
    dry_run: dryRun,
  });

  const totals: Totals = {
    scanned: 0,
    wrote: 0,
    skipped_already_in_library_identity: 0,
    skipped_no_canonical_entity_id: 0,
    skipped_non_discogs_namespace: 0,
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

      const outcome = resolveS1(row);
      if (outcome.status === 'no_canonical_entity_id') {
        totals.skipped_no_canonical_entity_id += 1;
        continue;
      }
      if (outcome.status === 'non_discogs_namespace') {
        totals.skipped_non_discogs_namespace += 1;
        continue;
      }
      // DRY_RUN-only bucket: rows that have a discogs:<id> canonical but are
      // already represented in library_identity. Real-run path filters these
      // out at the SQL layer, so the flag is always false and the bucket
      // stays at 0; in DRY_RUN the SELECT relaxes the filter and surfaces
      // them so the report's would_write_sources is honest on rerun.
      if (row.already_in_library_identity) {
        totals.skipped_already_in_library_identity += 1;
        continue;
      }

      if (!dryRun) {
        await opts.writeIdentity(row.id, outcome.sourceRows, []);
        totals.wrote += 1;
      }
      if (throttleMs > 0) await sleep(throttleMs);
    }

    log('info', 'batch_done', `batch ${batchIndex} done`, {
      batch_index: batchIndex,
      last_id: lastId,
      ...totals,
    });
  }

  const dryRunReport: DryRunReport | null = dryRun
    ? {
        source: 'S1',
        scanned: totals.scanned,
        would_write_sources:
          totals.scanned -
          totals.skipped_already_in_library_identity -
          totals.skipped_no_canonical_entity_id -
          totals.skipped_non_discogs_namespace,
        would_upsert_mains:
          totals.scanned -
          totals.skipped_already_in_library_identity -
          totals.skipped_no_canonical_entity_id -
          totals.skipped_non_discogs_namespace,
        skipped: {
          already_in_library_identity: totals.skipped_already_in_library_identity,
          no_canonical_entity_id: totals.skipped_no_canonical_entity_id,
          non_discogs_namespace: totals.skipped_non_discogs_namespace,
        },
      }
    : null;

  if (dryRunReport) {
    process.stdout.write(JSON.stringify(dryRunReport) + '\n');
    if (opts.onDryRunReport) opts.onDryRunReport(dryRunReport);
  }

  log('info', 'finished', `${JOB_NAME} done. ${formatTotals(totals)}`, { ...totals });
  return { totals, dryRunReport };
};
