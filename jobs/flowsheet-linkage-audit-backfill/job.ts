/**
 * One-shot backfill: classify existing flowsheet linkages into linkage_source
 * (B-1.4).
 *
 * Migration 0062 added linkage_source / linkage_confidence / linked_at as
 * NULL on every row. This job populates those audit columns for rows where
 * `album_id` is already set, using two source labels:
 *
 *   - 'etl_legacy_id' — `legacy_release_id` is non-null. The ETL resolved
 *     this row by matching tubafrenzy's release ID to a library row, which
 *     is the strongest linkage signal we have on legacy data.
 *
 *   - 'dj_bin_pick'  — `legacy_release_id` is null. Best guess for rows
 *     inserted through the live DJ flowsheet UI, where the DJ picked the
 *     album from the catalog at insert time.
 *
 * `linked_at` is set to `add_time` rather than NOW() because that's the
 * closest proxy we have to when the linkage actually happened — both for
 * ETL-imported rows (the play time) and for live DJ inserts (when the row
 * was inserted with album_id set). NOW() would back-stamp every legacy row
 * with the deploy time, which would defeat the audit.
 *
 * `linkage_confidence` stays NULL: ETL legacy-ID matches and human DJ picks
 * are both implicitly high-confidence, but neither has a numeric score we
 * can attach honestly. Future LML-resolved linkages (B-2.x) will set both.
 *
 * Bounded batched UPDATEs match the dj-name-backfill pattern: each batch
 * commits independently, the inner SELECT LIMIT prevents unbounded locks,
 * and `linkage_source IS NULL` makes re-runs idempotent. See issue #511 for
 * the lock-budget incident this pattern was designed around.
 *
 * Run procedure: build via `Manual Build & Deploy` with
 * `target=flowsheet-linkage-audit-backfill`, then SSH to EC2 and
 * `docker run --rm --env-file .env <image> 2>&1 | tee log`.
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

const JOB_NAME = 'flowsheet-linkage-audit-backfill';
const BATCH_SIZE = 5000;
const PROGRESS_LOG_EVERY = 1;

/**
 * Apply one batch of linkage-source classifications and return rows changed.
 * Each call is its own implicit transaction. Returning 0 means every row
 * with `album_id IS NOT NULL` already has `linkage_source` populated.
 */
const applyBatch = async (batchSize: number): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet" AS f
    SET
      "linkage_source" = CASE
        WHEN f."legacy_release_id" IS NOT NULL THEN 'etl_legacy_id'
        ELSE 'dj_bin_pick'
      END,
      "linked_at" = f."add_time"
    WHERE f."id" IN (
      SELECT "id" FROM "wxyc_schema"."flowsheet"
      WHERE "album_id" IS NOT NULL
        AND "linkage_source" IS NULL
      ORDER BY "id"
      LIMIT ${batchSize}
    )
  `);
  return Number(result.count ?? 0);
};

const formatDuration = (ms: number): string => {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
};

const runBackfill = async () => {
  console.log(`[${JOB_NAME}] Starting backfill of flowsheet linkage audit columns.`);
  console.log(`[${JOB_NAME}] Batch size: ${BATCH_SIZE}.`);

  const startedAt = Date.now();
  let batches = 0;
  let totalUpdated = 0;

  while (true) {
    const batchStartedAt = Date.now();
    const updated = await applyBatch(BATCH_SIZE);
    batches++;
    totalUpdated += updated;

    if (updated === 0) {
      // One empty batch is the natural end. Re-running on a fully-backfilled
      // DB must be a no-op, not loop forever.
      break;
    }

    if (batches % PROGRESS_LOG_EVERY === 0) {
      const batchMs = Date.now() - batchStartedAt;
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[${JOB_NAME}] batch ${batches}: ${updated} rows in ${formatDuration(batchMs)} | ` +
          `total ${totalUpdated} rows in ${formatDuration(elapsedMs)}`
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[${JOB_NAME}] Done. Updated ${totalUpdated} rows across ${batches} batches in ${formatDuration(elapsedMs)}.`
  );
};

const main = async () => {
  try {
    await runBackfill();
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});

export { applyBatch, runBackfill, formatDuration, BATCH_SIZE };
