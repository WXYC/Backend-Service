/**
 * Periodic refresh of the `album_plays` materialized view.
 *
 * The MV is the play-weight signal feeding the catalog search ranker (Epic
 * A). It is created and indexed by migration 0059 and re-derived from
 * `flowsheet` here on a recurring timer. Last-run timestamps are recorded
 * in the existing `cronjob_runs` table under the job name
 * `album-plays-refresh`, mirroring the pattern used by the ETL jobs.
 *
 * REFRESH MATERIALIZED VIEW CONCURRENTLY needs the unique index on
 * `album_id` (also created by 0059) and lets concurrent reads keep using
 * the previous snapshot while the new one is built. Measured refresh on
 * the staging clone (2.6M flowsheet rows) is ~98ms.
 *
 * Cadence is configurable via `ALBUM_PLAYS_REFRESH_INTERVAL_MS` (default 1
 * hour). Running more frequently is safe but unnecessary — search ranking
 * is robust to a slightly stale signal, and the MV is cheap to refresh.
 *
 * Exported API:
 *   startAlbumPlaysRefresh()  — schedule the recurring refresh (call at
 *                               startup)
 *   stopAlbumPlaysRefresh()   — cancel the timer (call on shutdown)
 *   refreshAlbumPlays()       — run one refresh and record last-run; useful
 *                               for the start-immediate option in tests
 *                               and for ad-hoc invocation
 */
import { sql } from 'drizzle-orm';
import { db, cronjob_runs, album_plays } from '@wxyc/database';

const JOB_NAME = 'album-plays-refresh';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/**
 * Run a single REFRESH MATERIALIZED VIEW CONCURRENTLY pass and record the
 * completion timestamp in `cronjob_runs`. Safe to call from anywhere; the
 * caller is responsible for catching errors if it cares about them.
 */
export async function refreshAlbumPlays(): Promise<void> {
  await db.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ${album_plays}`);
  const now = new Date();
  await db
    .insert(cronjob_runs)
    .values({ job_name: JOB_NAME, last_run: now })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: now },
    });
}

/**
 * Schedule the recurring refresh. The first refresh fires after one
 * interval — the MV is populated at creation time by the migration, so
 * there is no cold-start gap that requires firing immediately.
 *
 * Self-rescheduling via setTimeout (not setInterval) so a slow refresh
 * cannot stack overlapping runs. If a refresh fails, the error is logged
 * and the next tick is scheduled normally — transient REFRESH failures
 * (e.g. another concurrent refresh, lock contention) recover on the next
 * cycle without operator action.
 */
export function startAlbumPlaysRefresh(intervalMs: number = readIntervalFromEnv()): void {
  if (timer !== null) return;
  stopped = false;
  scheduleNext(intervalMs);
}

/**
 * Cancel any pending refresh. Idempotent and safe to call when not running.
 */
export function stopAlbumPlaysRefresh(): void {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleNext(intervalMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    void runOneRefreshAndReschedule(intervalMs);
  }, intervalMs);
  timer.unref?.();
}

async function runOneRefreshAndReschedule(intervalMs: number): Promise<void> {
  try {
    await refreshAlbumPlays();
  } catch (err) {
    console.error('[album-plays-refresh] refresh failed:', err);
  }
  if (!stopped) scheduleNext(intervalMs);
}

function readIntervalFromEnv(): number {
  const raw = process.env.ALBUM_PLAYS_REFRESH_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

// Exposed for unit tests.
export const __TEST_ONLY__ = {
  JOB_NAME,
  DEFAULT_INTERVAL_MS,
  hasPendingTimer: (): boolean => timer !== null,
};
