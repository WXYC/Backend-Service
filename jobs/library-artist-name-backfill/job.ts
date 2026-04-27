/**
 * One-shot backfill: populate library.artist_name from the artists join (Epic A.2).
 *
 * Migration 0058 (Epic A.1) added library.artist_name as a nullable column and
 * the STORED `search_doc` tsvector that depends on it. Until artist_name is
 * populated, search_doc reflects only album_title — the new tsvector search
 * path (A.5) cannot match by artist for legacy rows. This job populates every
 * library row from the existing artist_id FK in batched, individually-committed
 * UPDATEs so a long run cannot hold an AccessExclusiveLock or wedge concurrent
 * reads. Each batch is bounded by `BATCH_SIZE`, ordered by `id`, and naturally
 * restartable via the `artist_name IS NULL` filter (re-running picks up exactly
 * the rows the previous run did not finish).
 *
 * The NULL guard also makes this safe to interleave with A.3's live-write
 * path: if A.3 has already written artist_name on an insert, this job leaves
 * it untouched.
 *
 * Run procedure: see Backend-Service/CLAUDE.md and issue #511. Build via
 * `Manual Build & Deploy` with `target=library-artist-name-backfill`, then SSH
 * to EC2 and `docker run --rm --env-file .env <image> 2>&1 | tee log`.
 */

import { sql } from 'drizzle-orm';
import { db, closeDatabaseConnection } from '@wxyc/database';

const JOB_NAME = 'library-artist-name-backfill';
const BATCH_SIZE = 5000;
const PROGRESS_LOG_EVERY = 1; // every batch; the operation is rare enough that verbose is fine

/**
 * Apply one batch of artist_name updates and return the number of rows changed.
 * Each call is its own implicit transaction (postgres-js commits per execute
 * unless wrapped in db.transaction). Returning 0 means we have backfilled
 * every library row reachable through an `artists` join.
 */
const applyBatch = async (batchSize: number): Promise<number> => {
  const result = await db.execute(sql`
    UPDATE "wxyc_schema"."library" AS l
    SET "artist_name" = a."artist_name"
    FROM "wxyc_schema"."artists" AS a
    WHERE a."id" = l."artist_id"
      AND l."artist_name" IS NULL
      AND l."id" IN (
        SELECT "id" FROM "wxyc_schema"."library"
        WHERE "artist_name" IS NULL
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
  console.log(`[${JOB_NAME}] Starting backfill of library.artist_name.`);
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
 * Verify the backfill is complete: 0 library rows with NULL artist_name. Logs
 * the count and (only) raises if any remain — operator-friendly output even on
 * success.
 */
const verifyComplete = async () => {
  const result = await db.execute(
    sql`SELECT count(*)::int AS missing FROM "wxyc_schema"."library" WHERE artist_name IS NULL`
  );
  const missing = Number((result as unknown as Array<{ missing: number }>)[0]?.missing ?? 0);
  if (missing > 0) {
    throw new Error(
      `[${JOB_NAME}] Verification failed: ${missing} library row(s) still have artist_name IS NULL. ` +
        `Re-run the backfill — it is idempotent and will pick up the remaining rows.`
    );
  }
  console.log(`[${JOB_NAME}] Verification passed: 0 library rows with artist_name IS NULL.`);
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
export { applyBatch, runBackfill, verifyComplete, formatDuration, BATCH_SIZE };
