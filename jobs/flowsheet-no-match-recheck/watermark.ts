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
 * run by the number of this run's candidates that are STILL candidates
 * afterwards (`nextCursorPosition` below) and wrapped modulo a fresh
 * `countCandidates` total. This guarantees two things at once:
 *   - A persistently-transient head cannot occupy every future run's
 *     candidate window — the offset moves past it next run regardless of
 *     what happened to those specific rows.
 *   - Every matching row still cycles back into view, so this is a
 *     starvation GUARD layered on top of the TTL rotation, never a
 *     replacement for it — a row's TTL still governs when it becomes
 *     eligible again; the cursor only governs which eligible slice of the
 *     ordering a given run reads.
 *
 * WHY "still candidates" AND NOT "scanned": the candidate set is not stable
 * across runs. A row that gets a definitive answer leaves it — `markAttempted`
 * stamps `now()`, which fails `query.ts`'s TTL predicate; a resolved row
 * leaves `enriched_no_match` outright; a raced row was moved off that status
 * by someone else. Removing `m` such rows from BEHIND the cursor pulls `m`
 * rows from ahead of it to behind it, so an offset advanced by the full
 * scanned count steps clean over them. At the measured scale that is not a
 * rounding error: a run that resolves its whole batch would skip the next
 * `BATCH_SIZE` rows entirely, and they would not be read again until the
 * cursor wrapped — hundreds of runs later. That is the same "recent playcuts
 * are months out" failure `query.ts`'s newest-first tiebreak exists to
 * remove, reintroduced one block down the ordering.
 *
 * Advancing instead by the count that REMAINED lands the next offset exactly
 * past this run's leftovers, whatever the mix of outcomes. In the regime this
 * guard exists for — a window where every candidate transients — nothing
 * departs, so the advance is the full scanned count and the guard behaves
 * identically to an outcome-independent one. The two only diverge when the
 * job is making progress, which is the case where stepping over unread rows
 * has a cost and no benefit.
 *
 * KNOWN COST — the cursor defers the head. `query.ts` sorts never-attempted
 * rows newest-first, so a no-match row the live worker writes today lands at
 * ordering position 0. Once the cursor has moved off 0 it does not come back
 * until it wraps, and the wrap period is fixed at `total / BATCH_SIZE` runs
 * regardless of the outcome mix (the cursor climbs by the leftovers while the
 * cohort shrinks by the departures, and those sum to the batch size) — about
 * 687 runs, or ~5.7 months, at the 2026-08-18 numbers. So a row written
 * mid-cycle waits up to one wrap for its first recheck, which is the same
 * order of magnitude as the ~5.5-month figure BS#2218 rejected for the
 * historical backlog.
 *
 * That is accepted here rather than designed around, for two reasons. First,
 * the backlog is what BS#2218 measured and what the newest-first tiebreak
 * rescues: the FIRST pass starts at offset 0 and walks the cohort
 * newest-first, so recent playcuts are recovered in the opening days, not in
 * five months. Second, a freshly-written `enriched_no_match` is a much weaker
 * recheck candidate than a historical one: since BS#1978 the live enrichment
 * worker already asks headerlessly, so a new no-match means a full-cascade
 * lookup ALREADY missed, where the 137,340-row backlog is dominated by rows
 * that only ever failed under the ~4s clamp this ticket removes. Re-asking
 * those promptly buys little.
 *
 * If that trade stops holding — e.g. new-arrival volume rises, or the
 * cohort grows enough to stretch the wrap — the shape to reach for is
 * reserving a slice of each batch for offset 0 and spending the rest at the
 * cursor, so the head is sampled every run without giving up the guard.
 * Deliberately not built here; BS#2218 is scoped to unlocking the queue.
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

import type { Totals } from './orchestrate.js';

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

/**
 * Upsert `cronjob_runs.cursor_position` for `JOB_NAME`, stamping `last_run`
 * alongside it. `dbClient` is a parameter (not the module-level singleton) so
 * a future caller can run this inside a transaction, mirroring
 * `metadata-no-match-digest/watermark.ts`'s `updateLastRun`.
 *
 * `last_run` is written on both the insert and the conflict path even though
 * nothing reads it for this job today. Leaving it to the column's
 * `defaultNow()` would freeze it at whichever run first created the row,
 * and `cronjob_runs.last_run` is the fleet's cron-liveness heartbeat (see
 * `docs/ops-cron-scheduling.md`'s "Cron liveness (BS#2064)") — a row that
 * says this job last ran months ago is worse than no row at all during
 * incident triage. Called only on a completed non-dry-run pass, so the
 * timestamp means "a real run finished", which is what a heartbeat should
 * mean.
 */
export const setCursorPosition = async (dbClient: DbClient, position: number): Promise<void> => {
  const now = new Date();
  await dbClient
    .insert(cronjob_runs)
    .values({ job_name: JOB_NAME, cursor_position: position, last_run: now })
    .onConflictDoUpdate({
      target: cronjob_runs.job_name,
      set: { cursor_position: position, last_run: now },
    });
};

/**
 * Wrap `value` into `[0, totalCandidates)`. Used both to clamp a stored
 * cursor into range before using it as this run's OFFSET (the matching
 * cohort shrinks between runs as rows resolve or get marked, so a stale
 * cursor can land past the current end) and, via `nextCursorPosition`, to
 * wrap the advanced cursor. `totalCandidates <= 0` (nothing left to offset
 * into, or `countCandidates` raced to zero) returns 0 rather than dividing
 * by zero.
 */
export const wrapCursor = (value: number, totalCandidates: number): number => {
  if (totalCandidates <= 0) return 0;
  const wrapped = value % totalCandidates;
  return wrapped < 0 ? wrapped + totalCandidates : wrapped;
};

/**
 * How many of this run's candidates still match `query.ts`'s predicate now
 * that the run is over — the cursor's advance amount, and the number to
 * watch if the queue ever looks stalled again (a run where this equals
 * `scanned` disposed of nothing, which is the BS#2218 signature).
 *
 * Computed by subtracting the buckets that DEPARTED rather than by adding
 * the equivalent-today `lml_error + db_error`, so the fail-safe direction is
 * the right one: a bucket added to `Totals` later and not classified here
 * counts as having stayed, which makes the cursor advance further than
 * necessary. That over-advances — a row read one wrap later than it could
 * have been — where the opposite spelling would under-advance and re-read
 * the same window, which is the starvation this whole module exists to
 * prevent. `resolved_dry` is deliberately not subtracted: it only increments
 * under `DRY_RUN`, and a dry run never persists a cursor at all.
 */
export const stillCandidates = (totals: Totals): number =>
  totals.scanned - (totals.resolved + totals.unresolved + totals.trust_rejected + totals.raced);

/**
 * This run's OFFSET advanced past its leftovers and wrapped into range —
 * see the module doc comment for why the advance is "what stayed" rather
 * than "what was scanned".
 */
export const nextCursorPosition = (currentOffset: number, totals: Totals, totalCandidates: number): number =>
  wrapCursor(currentOffset + stillCandidates(totals), totalCandidates);
