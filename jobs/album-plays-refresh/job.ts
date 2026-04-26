/**
 * Refresh the `album_plays` materialized view created in migration 0056.
 *
 * The MV aggregates flowsheet track plays per album_id. A unique index on
 * album_id lets us refresh CONCURRENTLY so readers in the search service
 * (issue A.5) never see a half-populated view.
 *
 * Run modes:
 *   node dist/job.js          # one-shot (suitable for cron)
 *   node dist/job.js --poll   # continuous loop (for staging diagnostics)
 *
 * Measured refresh time on a 2.6M-row staging clone: ~98 ms. The default
 * cadence in package.json is hourly; sub-minute refreshes are also feasible
 * if a future feature needs closer-to-realtime play counts.
 */

import { sql } from 'drizzle-orm';
import { db, updateLastRun, closeDatabaseConnection } from '@wxyc/database';

export const JOB_NAME = 'album-plays-refresh';

/**
 * Execute the concurrent refresh and record the run timestamp.
 * Throws on failure; the cronjob_runs row is only updated when the
 * refresh succeeds, so a failed attempt doesn't mask a stale view.
 */
export const refreshAlbumPlays = async (): Promise<void> => {
  const startedAt = new Date();
  await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY "wxyc_schema"."album_plays"`);
  await updateLastRun(JOB_NAME, startedAt);
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const runPollingLoop = async (intervalMs: number): Promise<void> => {
  let running = true;
  const shutdown = () => {
    running = false;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.log(`[${JOB_NAME}] Polling every ${intervalMs}ms. PID ${process.pid}`);
  while (running) {
    try {
      await refreshAlbumPlays();
    } catch (e) {
      console.error(`[${JOB_NAME}] Refresh failed:`, e);
    }
    if (!running) break;
    await sleep(intervalMs);
  }
  console.log(`[${JOB_NAME}] Shutting down.`);
};

const main = async () => {
  try {
    if (process.argv.includes('--poll')) {
      const intervalMs = Number(process.env.ALBUM_PLAYS_REFRESH_INTERVAL_MS) || 3_600_000;
      await runPollingLoop(intervalMs);
    } else {
      await refreshAlbumPlays();
      console.log(`[${JOB_NAME}] Refresh complete.`);
    }
  } finally {
    await closeDatabaseConnection();
  }
};

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  // Run when the entrypoint resolves to this module (works for both the
  // bundled dist/job.js and `tsx jobs/album-plays-refresh/job.ts`).
  return entry.endsWith('/job.js') || entry.endsWith('/job.ts');
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[${JOB_NAME}] Failed:`, error);
    process.exitCode = 1;
  });
}
