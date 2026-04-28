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
 * the previous snapshot while the new one is built.
 *
 * Per-statement timeout: this service runs inside the API container, which
 * sets `DB_STATEMENT_TIMEOUT_MS=5000` to cap orphaned request-path queries.
 * The REFRESH legitimately takes longer than that on prod — the bare
 * aggregating SELECT is ~100ms on a staging clone (2.6M flowsheet rows),
 * but `REFRESH ... CONCURRENTLY` adds a diff/apply pass of roughly 2-3×
 * the SELECT cost, and prod's smaller instance plus concurrent flowsheet
 * write traffic compounds it past the 5s cap (issue #632). Mutating the
 * shared pool's timeout would defeat the orphan-query protection it exists
 * for, so the refresh runs against a dedicated single-connection client
 * (`max: 1`) with its own `statement_timeout` override. The dedicated
 * client is lazy-initialized on the first refresh and torn down by
 * `stopAlbumPlaysRefresh()`. Tunable via `ALBUM_PLAYS_REFRESH_TIMEOUT_MS`
 * (default 5 min, matching the ETL containers).
 *
 * Cadence is configurable via `ALBUM_PLAYS_REFRESH_INTERVAL_MS` (default 1
 * hour). Running more frequently is safe but unnecessary — search ranking
 * is robust to a slightly stale signal, and the MV is cheap to refresh.
 *
 * Exported API:
 *   startAlbumPlaysRefresh()  — schedule the recurring refresh (call at
 *                               startup)
 *   stopAlbumPlaysRefresh()   — cancel the timer and tear down the
 *                               dedicated connection (call on shutdown)
 *   refreshAlbumPlays()       — run one refresh and record last-run; useful
 *                               for the start-immediate option in tests
 *                               and for ad-hoc invocation
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import type postgres from 'postgres';
import { db, cronjob_runs, album_plays, createPostgresClient } from '@wxyc/database';

const JOB_NAME = 'album-plays-refresh';
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 5 * 60 * 1000;
const APPLICATION_NAME = 'wxyc-album-plays-refresh';

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

let refreshClient: ReturnType<typeof postgres> | null = null;
let refreshDb: ReturnType<typeof drizzle> | null = null;

/**
 * Lazy-initialize the dedicated refresh connection. Pool size 1 because
 * the refresh is serial (self-rescheduling timer cannot stack), and a
 * distinct `application_name` so this connection is obvious in
 * `pg_stat_activity` during incident triage. Recreated after a teardown.
 */
function getRefreshDb(timeoutMs: number): ReturnType<typeof drizzle> {
  if (refreshDb !== null) return refreshDb;
  refreshClient = createPostgresClient({
    statementTimeoutMs: timeoutMs,
    applicationName: APPLICATION_NAME,
    max: 1,
  });
  refreshDb = drizzle(refreshClient);
  return refreshDb;
}

/**
 * Run a single REFRESH MATERIALIZED VIEW CONCURRENTLY pass and record the
 * completion timestamp in `cronjob_runs`. Safe to call from anywhere; the
 * caller is responsible for catching errors if it cares about them.
 */
export async function refreshAlbumPlays(): Promise<void> {
  const refreshDbInstance = getRefreshDb(readRefreshTimeoutFromEnv());
  await refreshDbInstance.execute(sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ${album_plays}`);
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
 * Cancel any pending refresh and tear down the dedicated connection.
 * Idempotent and safe to call when not running.
 */
export function stopAlbumPlaysRefresh(): void {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (refreshClient !== null) {
    // Fire-and-forget — `end()` returns a promise but shutdown callers
    // (process exit, test cleanup) don't need to await it. The pool has
    // `max: 1`, so at most one connection is being closed.
    void refreshClient.end();
    refreshClient = null;
    refreshDb = null;
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

function readRefreshTimeoutFromEnv(): number {
  const raw = process.env.ALBUM_PLAYS_REFRESH_TIMEOUT_MS;
  if (!raw) return DEFAULT_REFRESH_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REFRESH_TIMEOUT_MS;
}

// Exposed for unit tests.
export const __TEST_ONLY__ = {
  JOB_NAME,
  DEFAULT_INTERVAL_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  APPLICATION_NAME,
  hasPendingTimer: (): boolean => timer !== null,
  hasDedicatedClient: (): boolean => refreshClient !== null,
};
