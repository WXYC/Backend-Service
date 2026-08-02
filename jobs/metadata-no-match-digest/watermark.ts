/**
 * `cronjob_runs` watermark for this job -- the fleet-standard "since last
 * run" pattern (`shared/database/src/schema.ts` `cronjob_runs`). Follows
 * the `jobs/library-etl/job.ts` `getLastRunTimestamp`/`updateLastRun`
 * upsert idiom, with one deliberate divergence: `getLastRun` here returns
 * a `Date | null` (the `last_run` timestamptz directly), NOT an epoch-ms
 * number -- library-etl's `.getTime()` return only works there because it
 * compares against a legacy ms column. This job's watermark binds against
 * `flowsheet.updated_at`, a timestamptz, so a `Date` is what `query.ts`
 * needs.
 */
import { eq } from 'drizzle-orm';
import { db, cronjob_runs, requirePositiveInt } from '@wxyc/database';

/** First run (no `cronjob_runs` row yet): bound the window to the last cadence period rather than dumping full history. */
export const FIRST_RUN_WINDOW_HOURS = 24;

/** Default play-age ceiling: a no-match whose play (`add_time`) is older than this is a
 *  backfill re-touch, not a new play, and is excluded from the digest. 48h is comfortably
 *  above the default 6h C6 gap-recovery window (BACKFILL_RECOVERY_WINDOW_HOURS) so a
 *  legitimately-new play the CDC worker missed and C6 recovered still surfaces. */
export const DIGEST_MAX_PLAY_AGE_HOURS_DEFAULT = 48;

/** Lower bound on `flowsheet.add_time` (play recency) for the digest window. */
export const resolvePlayAgeCutoff = (
  runStart: Date,
  raw: string | undefined = process.env.DIGEST_MAX_PLAY_AGE_HOURS
): Date =>
  new Date(
    runStart.getTime() -
      requirePositiveInt(raw, 'DIGEST_MAX_PLAY_AGE_HOURS', DIGEST_MAX_PLAY_AGE_HOURS_DEFAULT, { unit: 'hours' }) *
        60 *
        60 *
        1000
  );

type DbClient = typeof db;

/** The stored `cronjob_runs.last_run` for `jobName`, or `null` if the job has never run. */
export const getLastRun = async (jobName: string): Promise<Date | null> => {
  const rows = await db
    .select({ lastRun: cronjob_runs.last_run })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, jobName))
    .limit(1);
  return rows[0]?.lastRun ?? null;
};

/** Upsert `cronjob_runs.last_run` for `jobName`. `dbClient` is a parameter (not the module-level singleton) so a future caller can run this inside a transaction. */
export const updateLastRun = async (dbClient: DbClient, jobName: string, lastRun: Date): Promise<void> => {
  await dbClient
    .insert(cronjob_runs)
    .values({ job_name: jobName, last_run: lastRun })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { last_run: lastRun },
    });
};

/**
 * The query window's lower bound. `lastRun` is `null` only on the job's
 * very first run (no `cronjob_runs` row) -- bound to the last
 * `FIRST_RUN_WINDOW_HOURS` instead of scanning the entire `flowsheet`
 * history for `enriched_no_match` rows.
 */
export const resolveWindowStart = (lastRun: Date | null, runStart: Date): Date =>
  lastRun ?? new Date(runStart.getTime() - FIRST_RUN_WINDOW_HOURS * 60 * 60 * 1000);

/**
 * Decide whether this run's watermark should advance, and if so, do it.
 *
 * `runSucceeded` is `true` for a 0-row run (nothing to send) or a
 * successful digest send; `false` only when a send was attempted and
 * failed. A failed send must NOT advance the watermark -- the next run has
 * to re-query and retry the same window, per the plan's "send failure
 * leaves the watermark unchanged" acceptance criterion. Returns whether the
 * watermark was actually advanced, for logging.
 */
export const advanceWatermarkIfSuccessful = async (
  dbClient: DbClient,
  jobName: string,
  runStart: Date,
  runSucceeded: boolean
): Promise<boolean> => {
  if (!runSucceeded) return false;
  await updateLastRun(dbClient, jobName, runStart);
  return true;
};
