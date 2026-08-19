/**
 * `cronjob_runs.cursor_position` cursor for jobs/flowsheet-no-match-recheck
 * (BS#2218) — the starvation guard layered on top of `query.ts`'s ordering.
 *
 * WHY this job needs a cursor at all, and why `cronjob_runs.last_run` alone
 * (the fleet-standard "since last run" watermark every other consumer of
 * this table uses — see `jobs/metadata-no-match-digest/watermark.ts`) can't
 * serve it: those jobs filter their candidate query by a timestamp column
 * that advances monotonically as new qualifying rows arrive, so "everything
 * since the last watermark" is a well-defined, ever-shrinking-then-refilling
 * window. This job's candidate query (`query.ts`) orders by
 * `no_match_recheck_attempted_at ASC NULLS FIRST, ...`, and that marker is
 * deliberately left UNTOUCHED on a transient LML response (BS#1977 /
 * BS#2179 review HIGH 2 — see `orchestrate.ts` and `lml-fetch.ts`). A row
 * that transients on every single call therefore never changes position in
 * that ordering: `query.ts` alone would re-select the identical head of the
 * candidate set forever, no matter how many runs pass. A `last_run`-only
 * watermark can't fix this by skipping ahead in time, because skipping
 * ahead is exactly what would let a row's TTL rotation silently lapse
 * unnoticed — the one thing this job exists to prevent.
 *
 * MECHANISM: an OFFSET into the SAME ordered candidate set `query.ts`
 * already computes (`loadCandidates`'s `cursorOffset` param), advanced every
 * run by however many candidates that run actually scanned
 * (`RunResult.totals.scanned` — incremented for EVERY candidate regardless
 * of outcome, so a 100%-transient batch still counts, per `orchestrate.ts`'s
 * loop) and wrapped modulo a fresh `countCandidates` total. This guarantees
 * two things at once:
 *   - A persistently-transient head cannot occupy every future run's
 *     candidate window — the offset moves past it next run regardless of
 *     what happened to those specific rows.
 *   - Every matching row still cycles back into view within one full wrap
 *     (`ceil(total / scanned-per-run)` runs), so this is a starvation GUARD
 *     layered on top of the TTL rotation, never a replacement for it — a
 *     row's TTL still governs when it becomes eligible again; the cursor
 *     only governs which eligible slice of the ordering a given run reads.
 *
 * Persisted on the fleet-standard `cronjob_runs` table (migration 0152)
 * rather than a new per-job table, under this job's own `JOB_NAME` row —
 * `cursor_position` is NULL for every job that doesn't opt in, so adding it
 * here doesn't touch any other job's watermark semantics. `getCursorPosition`
 * / `setCursorPosition` mirror `metadata-no-match-digest/watermark.ts`'s
 * `getLastRun` / `updateLastRun` upsert idiom (a drizzle query-builder chain,
 * not raw SQL) for the same reasons that module documents.
 */
import { eq } from 'drizzle-orm';
import { db, cronjob_runs } from '@wxyc/database';

export const JOB_NAME = 'flowsheet-no-match-recheck';

type DbClient = typeof db;

/** The stored `cronjob_runs.cursor_position` for `JOB_NAME`, or `null` when no row exists yet, or when the row exists (written by a heartbeat that predates this cursor) but never had a cursor stamped. Either case means "start from offset 0". */
export const getCursorPosition = async (): Promise<number | null> => {
  const rows = await db
    .select({ cursorPosition: cronjob_runs.cursor_position })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, JOB_NAME))
    .limit(1);
  return rows[0]?.cursorPosition ?? null;
};

/** Upsert `cronjob_runs.cursor_position` for `JOB_NAME`. `dbClient` is a parameter (not the module-level singleton) so a future caller can run this inside a transaction, mirroring `metadata-no-match-digest/watermark.ts`'s `updateLastRun`. Only `cursor_position` is written — `last_run` (NOT NULL, `defaultNow()`) is left to its column default on first insert and untouched on conflict, since this job has no heartbeat semantics to define here. */
export const setCursorPosition = async (dbClient: DbClient, position: number): Promise<void> => {
  await dbClient
    .insert(cronjob_runs)
    .values({ job_name: JOB_NAME, cursor_position: position })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { cursor_position: position },
    });
};

/**
 * Wrap `value` into `[0, totalCandidates)`. Used both to clamp a stored
 * cursor into range before using it as this run's OFFSET (the matching
 * cohort shrinks between runs as rows resolve or get marked, so a stale
 * cursor can land past the current end) and to compute the NEXT cursor from
 * `storedOrClampedOffset + totals.scanned`. `totalCandidates <= 0` (nothing
 * left to offset into, or `countCandidates` raced to zero) returns 0 rather
 * than dividing by zero.
 */
export const wrapCursor = (value: number, totalCandidates: number): number => {
  if (totalCandidates <= 0) return 0;
  const wrapped = value % totalCandidates;
  return wrapped < 0 ? wrapped + totalCandidates : wrapped;
};
