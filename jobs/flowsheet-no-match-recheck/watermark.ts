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
 * UPDATE (BS#2222): that trade stopped holding — a 2026-09-19 replay found
 * ~1 in 4 fresh no-match rows resolves cleanly under the worker's own
 * auto-persist rule, so the deferral was hiding a real, live-visible miss.
 * `job.ts` now reads `query.ts`'s `HEAD_SLICE_DEFAULT` rows near the front of
 * the ordering every run, in addition to `batchSize - headSlice` at this
 * cursor, so the head is sampled every run without giving up the wraparound
 * guarantee below. The advance rule itself (below) is unchanged, just run
 * against the smaller tail window, which stretches the wrap period by
 * `batchSize / (batchSize - headSlice)` (+11% at the defaults — see README
 * "HEAD_SLICE derivation").
 *
 * THE HEAD SLICE GETS ITS OWN ROTATING CURSOR, for the same reason the tail
 * has one. An unguarded `OFFSET 0` head read has exactly the defect this
 * module exists to remove: a front-of-ordering row that transients on every
 * call keeps ordering position 0 forever (the marker is deliberately left
 * untouched — BS#1977 / BS#2179 review HIGH 2), so the head would re-ask the
 * identical 20 rows every run, permanently burning ~10% of the per-run LML
 * budget on rows that can never progress. `headCursorWindow` +
 * `nextHeadCursorPosition` give the head a second offset that advances by
 * `headSlice` each run and wraps modulo a SMALL recent window
 * (`query.ts`'s `HEAD_CURSOR_WINDOW_DEFAULT`, 200 rows ≈ 5 days of measured
 * inflow) rather than modulo the whole cohort — the head's job is same-week
 * coverage of the newest rows, and wrapping it against the full 137k-row
 * count would just make it a second tail. Stamping the marker on a transient
 * head attempt was considered and REJECTED: it violates the BS#1977 contract
 * and manufactures false no-match TTL gating. Persisted under its own
 * `cronjob_runs` row (`HEAD_CURSOR_JOB_NAME`, the `<job>:<sub-key>` idiom
 * `library-etl` already uses for its per-pass watermarks), so no new column
 * and no change to the tail cursor's own row.
 *
 * THE TAIL ADVANCE SUBTRACTS THE HEAD'S DEPARTURES. A head row that gets a
 * definitive answer leaves the candidate set from an ordering position BELOW
 * the tail cursor, which pulls every later row — including unread ones —
 * one position toward the front. An advance computed from the tail totals
 * alone therefore over-advances by up to `headSlice` positions per run,
 * stepping over that many never-read rows: the exact double-count class this
 * module's "still candidates, not scanned" rule exists to prevent,
 * reintroduced from a second source of shrinkage. `nextCursorPosition` takes
 * that correction as its `headDeparturesBelowCursor` argument; see
 * `headDeparturesBelowCursor` below for why the head rows the tail read
 * already covered are excluded from it.
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

/**
 * `cronjob_runs` key for the BS#2222 head cursor — a sibling row, not a new
 * column, following the `<job>:<sub-key>` idiom `library-etl` already uses
 * for its per-pass watermarks (`library-etl:artist-crossref`, …). Keeping it
 * off `JOB_NAME`'s own row means the tail cursor's `cursor_position`
 * semantics are byte-unchanged and a full reset of either cursor is a
 * single-row DELETE.
 */
export const HEAD_CURSOR_JOB_NAME = `${JOB_NAME}:head`;

type DbClient = typeof db;

/** The stored `cronjob_runs.cursor_position` for `jobName`, or `null` when no row exists yet, or when the row exists (written by a heartbeat that predates this cursor) but never had a cursor stamped. Either case means "start from offset 0". `jobName` defaults to the tail cursor's row; pass `HEAD_CURSOR_JOB_NAME` for the head cursor. */
export const getCursorPosition = async (jobName: string = JOB_NAME): Promise<number | null> => {
  const rows = await db
    .select({ cursorPosition: cronjob_runs.cursor_position })
    .from(cronjob_runs)
    .where(eq(cronjob_runs.job_name, jobName))
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
 *
 * `jobName` defaults to the tail cursor's row; the head cursor passes
 * `HEAD_CURSOR_JOB_NAME`. Both rows carry a `last_run`, which is harmless —
 * the liveness recipe reads one `job_name` at a time — and keeps either row
 * honest if it is ever the one someone greps.
 */
export const setCursorPosition = async (
  dbClient: DbClient,
  position: number,
  jobName: string = JOB_NAME
): Promise<void> => {
  const now = new Date();
  await dbClient
    .insert(cronjob_runs)
    .values({ job_name: jobName, cursor_position: position, last_run: now })
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
 * How many of a run's candidates LEFT the candidate set: `resolved` flipped
 * `metadata_status` off `enriched_no_match`; `unresolved` and
 * `trust_rejected` stamped `no_match_recheck_attempted_at = now()`, which
 * fails `query.ts`'s TTL predicate; `raced` means another writer already
 * moved the row off that status.
 *
 * Spelled as the departures rather than as the equivalent-today
 * `lml_error + db_error` stayers so the fail-safe direction is the right one:
 * a bucket added to `Totals` later and not classified here counts as having
 * stayed. `resolved_dry` is deliberately not counted: it only increments
 * under `DRY_RUN`, and a dry run never persists a cursor at all.
 */
export const departedCandidates = (totals: Totals): number =>
  totals.resolved + totals.unresolved + totals.trust_rejected + totals.raced;

/**
 * How many of this run's candidates still match `query.ts`'s predicate now
 * that the run is over — the cursor's advance amount, and the number to
 * watch if the queue ever looks stalled again (a run where this equals
 * `scanned` disposed of nothing, which is the BS#2218 signature).
 *
 * Because it is `scanned - departedCandidates`, an unclassified future bucket
 * makes the cursor advance FURTHER than necessary. That over-advances — a row
 * read one wrap later than it could have been — where the opposite spelling
 * would under-advance and re-read the same window, which is the starvation
 * this whole module exists to prevent.
 */
export const stillCandidates = (totals: Totals): number => totals.scanned - departedCandidates(totals);

/**
 * The head pass's departures that removed an ordering position BELOW the tail
 * cursor — the correction `nextCursorPosition` subtracts (BS#2222 review
 * finding 1).
 *
 * `headRowsInTailWindow` is how many of the head read's rows also appeared in
 * the tail read before `orchestrate.ts`'s `excludeCandidateIds` dropped them
 * (non-zero only when the two windows overlap). Those rows are NOT subtracted
 * here, because dropping them already shrank `tailTotals.scanned` by the same
 * amount — subtracting them again would double-count and under-advance the
 * cursor into re-reading rows it just read. Clamped at `>= 0` so an overlap
 * larger than the head's departure count (head rows that transiented) can
 * never push the correction negative and turn it into an over-advance.
 *
 * This is a correction, not an exact accounting, and it is deliberately
 * spelled to err toward under-advancing. The one case it over-corrects is a
 * head window sitting entirely PAST the tail window — reachable for a run or
 * two right after the tail cursor wraps, e.g. head at 180 while the tail reads
 * [0, 180): those head departures are above the cursor and outside the tail
 * read, so `headRowsInTailWindow` is 0 and up to `headSlice` departures are
 * subtracted that removed no position below the cursor. The cost is bounded at
 * `headSlice` re-read rows, which is the safe direction (this module's rule is
 * "re-read leftovers, never skip unread rows"); the alternative — reasoning
 * about each head row's position relative to the cursor — would need the
 * positions themselves, which an OFFSET read does not return.
 */
export const headDeparturesBelowCursor = (headTotals: Totals, headRowsInTailWindow: number): number =>
  Math.max(departedCandidates(headTotals) - headRowsInTailWindow, 0);

/**
 * This run's OFFSET advanced past its leftovers and wrapped into range — see
 * the module doc comment for why the advance is "what stayed" rather than
 * "what was scanned", and why the head pass's below-cursor departures
 * (`headDeparturesBelowCursor`) come back off it.
 *
 * `totals` is the TAIL run's totals only. The head slice never occupied a
 * position at this cursor, so folding its `scanned` in would advance past
 * tail rows nobody read; its DEPARTURES still have to come off, because they
 * shrink the ordering ahead of the cursor. Clamped at `>= 0` before wrapping:
 * a run whose head departures exceed its tail leftovers would otherwise wrap
 * a negative offset to near the END of the cohort, skipping the whole
 * remainder of the traversal.
 */
export const nextCursorPosition = (
  currentOffset: number,
  totals: Totals,
  totalCandidates: number,
  headDeparturesBelowCursorCount = 0
): number =>
  wrapCursor(Math.max(currentOffset + stillCandidates(totals) - headDeparturesBelowCursorCount, 0), totalCandidates);

/**
 * The head cursor's modulus: `window` rows, or the whole cohort when it is
 * smaller than that (so a head offset can never land past the end of a small
 * cohort and read nothing). Never negative.
 */
export const headCursorWindow = (totalCandidates: number, window: number): number =>
  Math.max(Math.min(window, totalCandidates), 0);

/**
 * The head cursor advanced one head slice and wrapped inside its small recent
 * window — so a persistently-transient front-of-ordering row is re-asked once
 * per rotation instead of once per run.
 *
 * `window <= 0` (an empty cohort) returns 0 via `wrapCursor`. A `window` that
 * is not an exact multiple of `headSlice` is fine: the offsets drift rather
 * than repeating a fixed set, which still covers the window. A `headSlice`
 * that IS an exact multiple of `window` is the degenerate case — see
 * `headRotationIsInert`, which `job.ts` warns off.
 *
 * COVERAGE IS CONDITIONAL, and the condition is `headSlice > arrivals per run`
 * (BS#2222 review). An OFFSET is a position in an ordering that MOVES: new
 * `enriched_no_match` rows land at position 0 (`query.ts` sorts never-attempted
 * rows `id DESC`), so every existing row's position grows by the arrival count
 * `A` each run while this cursor grows by `headSlice`. A row therefore closes
 * on the head window at `headSlice - A` positions per run:
 *
 *   A <  headSlice   the cursor gains; any row in the window is read within
 *                    `window / (headSlice - A)` runs. At the defaults
 *                    (headSlice 20, A = 40/day / 4 runs = 10, window 200) that
 *                    is <= 20 runs, ~5 days — inside the window's ~5 days of
 *                    residency, but not by much.
 *   A >= headSlice   the gap never closes. A row that entered above the cursor
 *                    is carried out of the window unread and falls back to the
 *                    tail cursor's ~191-day wrap — the deferral BS#2222 exists
 *                    to remove.
 *
 * So `HEAD_SLICE_COVERAGE_MARGIN` (2) is not only volume headroom, it IS the
 * coverage condition: margin > 1 means `headSlice > A`. A sustained doubling of
 * the measured inflow consumes it exactly, which is why `query.test.ts` pins
 * `margin > 1` rather than treating it as a comfort factor, and why the README
 * names re-measuring inflow as the response to a head-coverage complaint.
 * Escaping the condition entirely needs a keyset (`id`-anchored) head cursor
 * rather than an OFFSET one, which is a different mechanism than the one BS#2222
 * settled on and is left to that ticket.
 */
export const nextHeadCursorPosition = (currentOffset: number, headSlice: number, window: number): number =>
  wrapCursor(currentOffset + headSlice, window);

/**
 * Whether the head rotation stands still — `nextHeadCursorPosition` returns the
 * offset it was given, every run, forever (BS#2222 review finding 2).
 *
 * True when `headSlice` is an exact multiple of `window`, `headSlice` being a
 * multiple of the modulus meaning the advance is congruent to zero. `headSlice`
 * 0 (the `batchSize` 1 degenerate, see `resolveHeadSliceConfig`) counts, since a
 * head that reads nothing rotates nowhere either.
 *
 * Reachable in production through the supported `HEAD_SLICE` knob without
 * tripping the batch-share clamp: `BATCH_SIZE=400` + `HEAD_SLICE=200` passes the
 * half-batch ceiling exactly, and the window is a hardcoded 200. Nothing relates
 * the two constants, so `job.ts` warns rather than either constant silently
 * defeating the other. The cost is not lost coverage — a head slice that wide
 * reads the whole window every run — it is the re-ask cadence: a permanently
 * transient front-of-ordering row, whose marker the BS#1977 contract
 * deliberately leaves untouched, is re-asked every run instead of once per
 * rotation, spending LML budget on rows that cannot progress with nothing in the
 * counters to distinguish it from healthy churn.
 *
 * The small-cohort case is NOT this defect and must not warn: when the cohort is
 * smaller than the window, `headCursorWindow` clamps the window down to the
 * cohort, and a head slice covering all of it is the intended behaviour at that
 * size. `job.ts` gates the warning on the window not having been cohort-clamped.
 */
export const headRotationIsInert = (headSlice: number, window: number): boolean =>
  window > 0 && headSlice % window === 0;

/**
 * Whether an inert rotation is worth warning an operator about.
 *
 * Inertness alone is not — two configurations reach it without being
 * misconfigured, and warning on either sends the operator to the wrong knob
 * (`/code-review` on PR #2608):
 *
 *   - **A disabled head slice** (`headSlice === 0`, reachable only at
 *     `BATCH_SIZE=1`, see `resolveHeadSliceConfig`). Inert by definition — a
 *     head that reads nothing rotates nowhere — but `job.ts` already emits
 *     `head_slice_disabled` for it, and the inert warning's advice ("the window
 *     is fully covered every run; lower HEAD_SLICE") is both false and aimed at
 *     the wrong variable. Two contradictory remediations for one condition is
 *     worse than one.
 *   - **A cohort smaller than the window**, where `headCursorWindow` clamps the
 *     window down to the cohort and a head slice covering all of it is the
 *     intended behaviour at that size. Detected by the window having been
 *     clamped below `windowDefault`.
 *
 * What is left is the genuine case: a full-width window and a head slice that
 * is a multiple of it — e.g. `BATCH_SIZE=400` + `HEAD_SLICE=200`, which passes
 * the half-batch ceiling exactly while standing the rotation still.
 */
export const headRotationWarrantsWarning = (headSlice: number, window: number, windowDefault: number): boolean =>
  headSlice > 0 && window >= windowDefault && headRotationIsInert(headSlice, window);

/** One cursor write: which `cronjob_runs` row, and the offset to stamp on it. */
export type CursorWrite = { jobName: string; position: number };

/**
 * Both cursor advances for a completed run, as data.
 *
 * This exists because `main`'s inline wiring was the one place the two cursors
 * were actually distinguished — which `Totals` feeds the tail advance, which
 * modulus the head wraps against, and which `cronjob_runs` row each is stamped
 * on — and being inside an unexported `main` it was reachable by no test
 * (BS#2222 review finding 1). A mutation probe on the pre-extraction shape
 * reintroduced BOTH defects the prior review iterations fixed — the tail
 * advancing on the MERGED head+tail totals, and the head rotation written onto
 * the tail's own row — with all 128 tests still passing. Returning the writes as
 * data means `main` cannot name a row or a modulus of its own, so the whole
 * wiring is pinned in `watermark.test.ts` instead of only its arithmetic.
 *
 * Pure: the caller performs the writes. Not called in dry-run mode.
 */
export const planCursorAdvance = (input: {
  tailCursorOffset: number;
  headCursorOffset: number;
  /** The TAIL pass's totals only — never the merged pair. See `nextCursorPosition`. */
  tailTotals: Totals;
  headTotals: Totals;
  headRowsInTailWindow: number;
  headSlice: number;
  /** The whole cohort: the tail cursor's modulus. */
  totalCandidates: number;
  /** The small recent window: the head cursor's modulus. */
  headWindow: number;
}): { writes: readonly CursorWrite[]; logFields: Record<string, number> } => {
  const headDepartures = headDeparturesBelowCursor(input.headTotals, input.headRowsInTailWindow);
  const nextCursor = nextCursorPosition(
    input.tailCursorOffset,
    input.tailTotals,
    input.totalCandidates,
    headDepartures
  );
  const nextHeadCursor = nextHeadCursorPosition(input.headCursorOffset, input.headSlice, input.headWindow);
  return {
    writes: [
      { jobName: JOB_NAME, position: nextCursor },
      { jobName: HEAD_CURSOR_JOB_NAME, position: nextHeadCursor },
    ],
    logFields: {
      cursor_offset: input.tailCursorOffset,
      next_cursor: nextCursor,
      tail_scanned: input.tailTotals.scanned,
      still_candidates: stillCandidates(input.tailTotals),
      head_departures_below_cursor: headDepartures,
      head_rows_in_tail_window: input.headRowsInTailWindow,
      head_cursor_offset: input.headCursorOffset,
      next_head_cursor: nextHeadCursor,
      head_cursor_window: input.headWindow,
      total_candidates: input.totalCandidates,
    },
  };
};
