/**
 * One-shot backfill: populate flowsheet.dj_name on legacy track rows.
 *
 * Splits the large UPDATE that was originally embedded in migration 0053 into
 * batched, individually-committed UPDATEs so a long run cannot hold an
 * AccessExclusiveLock or wedge concurrent reads. Each batch is bounded by
 * `BATCH_SIZE`, ordered by `id`, and naturally restartable via the
 * `dj_name IS NULL` filter (re-running picks up exactly the rows the previous
 * run did not finish).
 *
 * The COALESCE order matches the search service's DJ_NAME_EXPR and the live
 * insert path, so every row carries the same resolved name regardless of
 * which subsystem populated it.
 *
 * Track-only filter: matches the precondition guard in migration 0054, which
 * only requires dj_name on track rows. Non-track entries (talkset, breakpoint,
 * show_start, etc.) keep dj_name NULL — search never reads them.
 *
 * Run procedure: see Backend-Service/CLAUDE.md and issue #511. Build via
 * `Manual Build & Deploy` with `target=flowsheet-dj-name-backfill`, then SSH
 * to EC2 and `docker run --rm --env-file .env <image> 2>&1 | tee log`.
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

const JOB_NAME = 'flowsheet-dj-name-backfill';

/**
 * Resolve `BATCH_SIZE` from the environment, falling back to 5000.
 *
 * Default `5000` was chosen empirically to balance per-batch lock duration
 * (kept under a few seconds when the host is healthy) against per-tx
 * overhead. With `synchronous_commit = off` already eliminating the per-COMMIT
 * fsync wait, larger batches are sometimes preferable: fewer planner cycles,
 * fewer trigger-firing dispatches, fewer round trips. Operators can opt in
 * via `BACKFILL_BATCH_SIZE=20000` when the prod instance has headroom.
 */
const resolveBatchSize = (raw: string | undefined = process.env.BACKFILL_BATCH_SIZE): number => {
  if (raw === undefined) return 5000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid BACKFILL_BATCH_SIZE=${JSON.stringify(raw)}; must be a positive integer.`);
  }
  return parsed;
};

const BATCH_SIZE = resolveBatchSize();
const PROGRESS_LOG_EVERY = 1; // every batch; the operation is rare enough that verbose is fine

/**
 * Apply one batch of dj_name updates and return the number of rows changed.
 * Each call is its own implicit transaction (postgres-js commits per execute
 * unless wrapped in db.transaction). Returning 0 means we have backfilled
 * every track row reachable through a `shows` join.
 */
const applyBatch = async (batchSize: number): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE "wxyc_schema"."flowsheet" AS f
    SET "dj_name" = COALESCE(u."dj_name", s."legacy_dj_name", u."name")
    FROM "wxyc_schema"."shows" AS s
    LEFT JOIN "auth_user" AS u ON u."id" = s."primary_dj_id"
    WHERE f."show_id" = s."id"
      AND f."entry_type" = 'track'
      AND f."dj_name" IS NULL
      AND f."id" IN (
        SELECT "id" FROM "wxyc_schema"."flowsheet"
        WHERE "entry_type" = 'track'
          AND "dj_name" IS NULL
        ORDER BY "id"
        LIMIT ${batchSize}
      )
  `);
  return Number(result.count ?? 0);
};

/**
 * Format a millisecond duration as `Xm Ys` for human-readable progress logs.
 */
const formatDuration = (ms: number): string => {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
};

const runBackfill = async () => {
  console.log(`[${JOB_NAME}] Starting backfill of flowsheet.dj_name (track rows).`);
  console.log(`[${JOB_NAME}] Batch size: ${BATCH_SIZE}.`);

  const startedAt = Date.now();
  let batches = 0;
  let totalUpdated = 0;
  let consecutiveEmpty = 0;

  while (true) {
    const batchStartedAt = Date.now();
    const updated = await applyBatch(BATCH_SIZE);
    batches++;
    totalUpdated += updated;

    if (updated === 0) {
      // One empty batch is the natural end. Log and break. We do not retry on
      // empty because that would loop forever in a fully-backfilled state.
      consecutiveEmpty++;
      if (consecutiveEmpty >= 1) {
        break;
      }
    } else {
      consecutiveEmpty = 0;
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

/**
 * Verify the backfill is complete: 0 track rows with NULL dj_name. Run as a
 * post-flight check so a deploy that follows can apply migration 0054 without
 * tripping its precondition guard. Logs the count and (only) raises if any
 * remain — typical operator-friendly output even on success.
 */
const verifyComplete = async () => {
  const result = await db.execute(
    sql`SELECT count(*)::int AS missing FROM "wxyc_schema"."flowsheet" WHERE entry_type = 'track' AND dj_name IS NULL`
  );
  const missing = Number((result as unknown as Array<{ missing: number }>)[0]?.missing ?? 0);
  if (missing > 0) {
    throw new Error(
      `[${JOB_NAME}] Verification failed: ${missing} track row(s) still have dj_name IS NULL. ` +
        `Re-run the backfill — it is idempotent and will pick up the remaining rows.`
    );
  }
  console.log(`[${JOB_NAME}] Verification passed: 0 track rows with dj_name IS NULL.`);
};

const main = async () => {
  try {
    await runBackfill();
    await verifyComplete();
  } finally {
    await closeDatabaseConnection();
  }
};

main().catch((error) => {
  console.error(`[${JOB_NAME}] Failed:`, error);
  process.exitCode = 1;
});

// Exports for unit tests. Production entry point is the `main()` invocation
// above; tests reach into the individual primitives.
export { applyBatch, runBackfill, verifyComplete, formatDuration, BATCH_SIZE, resolveBatchSize };
