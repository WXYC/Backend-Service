/**
 * Entrypoint for jobs/flowsheet-no-match-recheck (BS#2176, BS#2218).
 *
 * Recurring, cause-agnostic re-ask of `flowsheet.metadata_status =
 * 'enriched_no_match'` rows: `enriched_no_match` is a terminal status, but
 * the condition it records is not permanent — a playcut can be a correct
 * no-match at write time and become resolvable days later (a discogs-etl
 * rebuild caches the release, an LML matcher fix ships, the librarian files
 * the album). Nothing else revisits these rows, so this job generalizes the
 * one-shot rescue drains (#1433, #1638, #1979) into a standing mechanism:
 * every run re-asks LML for a bounded, TTL-gated slice of the cohort, ordered
 * per `query.ts` (never-attempted rows newest-first, then TTL-expired rows
 * oldest-attempted-first), so no future freeze cause needs its own one-shot
 * ticket.
 *
 * Idempotent: the SELECT predicate is `metadata_status = 'enriched_no_match'`
 * and the WHERE guard on every write is the same — rerun-safe and race-safe
 * against a concurrent writer (another run of this job; in principle a
 * future writer) that already moved the row off that status.
 *
 * BS#2218's OFFSET cursor is composed here, around `runNoMatchRecheck`,
 * rather than inside `orchestrate.ts`: read the stored cursor + a fresh
 * candidate count, clamp it into range (`watermark.ts`'s `wrapCursor`), load
 * this run's batch at that offset, run the existing per-row loop unchanged,
 * then advance and persist the cursor past however many of this run's
 * candidates are still candidates (`watermark.ts`'s `nextCursorPosition`;
 * that module's doc comment carries the reasoning). Keeping this composition
 * in `job.ts` means `orchestrate.ts`'s `LoadCandidatesFn` stays the simple
 * zero-arg shape its existing tests already pin — no cursor concept leaks
 * into the orchestrator or its transient-handling contract.
 *
 * BS#2222 adds a second, independent read: `query.ts`'s `HEAD_SLICE_DEFAULT`
 * rows read near the front of the ordering every run, so a row the live worker
 * writes today isn't deferred a full cursor wrap for its first recheck. Four
 * things about that composition are load-bearing, and the first BS#2222 draft
 * got three of them wrong (see that issue's review):
 *
 *   1. Both `loadCandidates` calls (head + tail) run BEFORE either
 *      `runNoMatchRecheck` pass, since the first pass's writes would otherwise
 *      shrink the ordering out from under the other pass's OFFSET before its
 *      SELECT issues.
 *   2. The head read has its OWN rotating cursor (`watermark.ts`'s
 *      `HEAD_CURSOR_JOB_NAME` row, advancing by `headSlice` each run inside
 *      `HEAD_CURSOR_WINDOW_DEFAULT`), not a bare OFFSET 0. A transient LML
 *      outcome deliberately leaves `no_match_recheck_attempted_at` untouched
 *      (BS#1977 / BS#2179 review HIGH 2), so an unguarded OFFSET 0 would
 *      re-ask the identical front-of-ordering rows every run forever — the
 *      exact starvation BS#2218's cursor exists to escape.
 *   3. The two passes SHARE one cooperative-pause closure, so they pool one
 *      `LIVE_ACTIVITY_MAX_PAUSE_MS` ceiling instead of splitting it. A split
 *      ceiling let the first pass exhaust its share and throw
 *      `LiveActivityPauseCeilingExceededError` past the second pass entirely;
 *      the tail pass is the starvation guard and the whole historical-cohort
 *      drain, so it runs FIRST and on the full pooled budget.
 *   4. The tail cursor advances on the TAIL run's `Totals` MINUS the head
 *      run's below-cursor departures. The head slice never occupied a tail
 *      cursor position (folding its `scanned` in would over-advance past
 *      unread tail rows), but its departures remove ordering positions below
 *      that cursor, which pulls unread rows behind it — see `watermark.ts`'s
 *      `headDeparturesBelowCursor`. `excludeCandidateIds` drops any tail row
 *      the head read already covered, and the count it dropped is what keeps
 *      that correction from double-counting.
 *
 * Cursor resolution is fail-fast, not best-effort: a `getCursorPosition` /
 * `countCandidates` failure aborts the run before any lookup (same posture
 * as `requireLmlConfigured` below) rather than silently falling back to
 * offset 0 — a DB outage should surface as a failed run, not masquerade as
 * "cohort fully drained, start over from the top" on the next one.
 *
 * Invocation:
 *   docker run --rm --env-file .env <image>
 *
 * Required env: LIBRARY_METADATA_URL (LML host), LML_API_KEY (bearer),
 * DB_* (postgres connection).
 *
 * Optional env:
 *   DRY_RUN=true                                    skip all writes; log planned counts
 *   FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS=N            default 14
 *   FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE=N          default 200 (bounded drip per run)
 *   FLOWSHEET_NO_MATCH_RECHECK_HEAD_SLICE=N          default 20 (see query.ts HEAD_SLICE_DEFAULT)
 *   BACKFILL_LML_MAX_CONCURRENT=N                    default 1
 *   BACKFILL_LML_RATE_PER_MIN=N                      default 20
 *   FLOWSHEET_NO_MATCH_RECHECK_LML_PER_CALL_TIMEOUT_MS=N   default 35000
 *   LIVE_ACTIVITY_LOOKBACK_SECONDS=N                 default 60; 0 disables cooperative pause
 *   LIVE_ACTIVITY_PAUSE_MS=N                         default 30000
 */

import { closeDatabaseConnection, db, requirePositiveInt } from '@wxyc/database';

import {
  runNoMatchRecheck,
  mergeTotals,
  excludeCandidateIds,
  buildRecheckWaitForQuietPeriod,
  type Candidate,
  type LookupFn,
  type MarkAttemptedFn,
  type Totals,
  type WriteFn,
} from './orchestrate.js';
import {
  loadCandidates,
  countCandidates,
  BATCH_SIZE_DEFAULT,
  BATCH_SIZE_ENV,
  HEAD_CURSOR_WINDOW_DEFAULT,
  HEAD_SLICE_DEFAULT,
  HEAD_SLICE_ENV,
  NO_MATCH_TTL_DAYS_DEFAULT,
  NO_MATCH_TTL_DAYS_ENV,
} from './query.js';
import { lookupNoMatchRecheck } from './lml-fetch.js';
import { markRecheckAttempted, writeMatch } from './writer.js';
import {
  HEAD_CURSOR_JOB_NAME,
  JOB_NAME,
  getCursorPosition,
  headCursorWindow,
  headRotationIsInert,
  planCursorAdvance,
  setCursorPosition,
  wrapCursor,
} from './watermark.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const requireLmlConfigured = (): void => {
  if (!process.env.LIBRARY_METADATA_URL) {
    throw new Error('LIBRARY_METADATA_URL is not configured; aborting before any rows are scanned.');
  }
  // BS#2179 review LOW finding: without this, a URL-set/key-missing
  // misconfiguration proceeds and burns ~10 minutes of rate-limited calls
  // failing every row as `lml_error` (silently retryable, so it exits 0
  // with a quiet-looking `resolved: 0`) before anyone notices — the run
  // is indistinguishable from a healthy but empty cohort. Fail fast instead.
  if (!process.env.LML_API_KEY) {
    throw new Error('LML_API_KEY is not configured; aborting before any rows are scanned.');
  }
};

const resolveDryRun = (): boolean => {
  const raw = process.env.DRY_RUN?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
};

/**
 * The most of any batch the head slice may take. The tail read — and with it
 * the BS#2218 cursor's traversal rate — keeps at least the other half.
 *
 * `batchSize - 1` was the first spelling and it satisfied "the tail read stays
 * non-empty" only literally (BS#2222 review): `HEAD_SLICE=200` against the
 * default `BATCH_SIZE=200` left a ONE-row tail, which advances the cursor one
 * row per run — a ~94-year wrap on the measured 137k-row cohort — while the
 * run logged a single `warn` and exited 0. A misconfiguration that disables the
 * starvation guard in practice must not read as healthy in every counter.
 * Halving the traversal rate is the worst this ceiling permits.
 */
export const HEAD_SLICE_MAX_BATCH_SHARE = 0.5;

/**
 * Split `batchSize` into the head slice and the tail the BS#2218 cursor reads.
 *
 * Clamped rather than rejected: this is a cron, and a container that refuses to
 * start does no work at all, where the clamped shape still drains the cohort at
 * half rate. `clamped` is what `main` logs the warning off, and the warning
 * names both the requested and the effective value.
 */
export const resolveHeadSliceConfig = (
  requestedHeadSlice: number,
  batchSize: number
): { headSlice: number; tailBatchSize: number; clamped: boolean } => {
  const ceiling = Math.max(Math.floor(batchSize * HEAD_SLICE_MAX_BATCH_SHARE), 0);
  const headSlice = Math.max(Math.min(requestedHeadSlice, ceiling), 0);
  return { headSlice, tailBatchSize: batchSize - headSlice, clamped: headSlice !== requestedHeadSlice };
};

/** Where this run's two reads sit, resolved from the two persisted cursors. */
export type RecheckPassPlan = {
  noMatchTtlDays: number;
  headSlice: number;
  tailBatchSize: number;
  /** The head cursor's offset, inside its small rotating window. */
  headCursorOffset: number;
  /** The BS#2218 tail cursor's offset, inside the whole cohort. */
  tailCursorOffset: number;
  dryRun: boolean;
};

export type RecheckPassDeps = {
  loadCandidates: (noMatchTtlDays: number, batchSize: number, cursorOffset: number) => Promise<Candidate[]>;
  runRecheck: typeof runNoMatchRecheck;
  lookup: LookupFn;
  write: WriteFn;
  markAttempted: MarkAttemptedFn;
  /** ONE shared accrual closure for both passes — see `buildRecheckWaitForQuietPeriod`. */
  waitForQuietPeriod: () => Promise<boolean>;
};

export type RecheckPassOutcome = {
  headTotals: Totals;
  tailTotals: Totals;
  /** `headTotals` + `tailTotals`, for the run's single `finished` counter line. */
  totals: Totals;
  /** Tail rows `excludeCandidateIds` dropped because the head read already covered them. */
  headRowsInTailWindow: number;
};

/**
 * Both candidate reads, then both `runNoMatchRecheck` passes — the BS#2222
 * composition, with every IO dependency injected so
 * `tests/unit/jobs/flowsheet-no-match-recheck/job.test.ts` can pin the four
 * load-bearing properties in the module doc comment above (read-before-write
 * ordering, the two offsets, the shared pause closure, and the tail-first pass
 * order).
 */
export const runRecheckPasses = async (plan: RecheckPassPlan, deps: RecheckPassDeps): Promise<RecheckPassOutcome> => {
  // Both reads issue BEFORE either pass writes -- running one pass first would
  // shrink the ordering before the other SELECT issues, landing its offset past
  // unread rows every run.
  //
  // Deliberately NOT stated as "one snapshot": these are two statements, so
  // each takes its own Postgres snapshot and the live CDC worker's writes can
  // land between them (docs/ops-cron-scheduling.md, BS#2071). The property this
  // ordering buys is only that neither PASS's writes intervene. A concurrent
  // writer moving a row between the two reads costs at most a dropped dedupe or
  // a slightly-off `headRowsInTailWindow`, both of which land on the
  // under-advance (re-read) side of the cursor math.
  const headCandidates =
    plan.headSlice > 0 ? await deps.loadCandidates(plan.noMatchTtlDays, plan.headSlice, plan.headCursorOffset) : [];
  const tailCandidatesRaw =
    plan.tailBatchSize > 0
      ? await deps.loadCandidates(plan.noMatchTtlDays, plan.tailBatchSize, plan.tailCursorOffset)
      : [];
  const tailCandidates = excludeCandidateIds(
    tailCandidatesRaw,
    new Set(headCandidates.map((candidate) => candidate.id))
  );

  const runPass = (pass: 'head' | 'tail', candidates: Candidate[]): Promise<{ totals: Totals }> =>
    deps.runRecheck({
      loadCandidates: () => Promise.resolve(candidates),
      lookup: deps.lookup,
      write: deps.write,
      markAttempted: deps.markAttempted,
      dryRun: plan.dryRun,
      waitForQuietPeriod: deps.waitForQuietPeriod,
      // Discriminates the two `candidates_loaded` lines a run now emits --
      // without it the BS#2176 "report the candidate count / projected LML call
      // volume" line reads as the whole run's projection when it is one pass's.
      pass,
    });

  // Tail FIRST: it is the starvation guard and the historical-cohort drain, so
  // if the shared pause budget is exhausted mid-run it is the head that loses
  // its turn, not the drain. The head loses little by yielding -- its cursor
  // stays put, so the same window is read next run.
  const { totals: tailTotals } = await runPass('tail', tailCandidates);
  const { totals: headTotals } = await runPass('head', headCandidates);

  return {
    headTotals,
    tailTotals,
    totals: mergeTotals(headTotals, tailTotals),
    headRowsInTailWindow: tailCandidatesRaw.length - tailCandidates.length,
  };
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  const dryRun = resolveDryRun();
  try {
    requireLmlConfigured();
    // Parsed inside the try so a misconfigured value routes through the
    // catch's Sentry capture + non-zero exit + the finally's cleanup,
    // rather than throwing before any of that is wired up.
    const noMatchTtlDays = requirePositiveInt(
      process.env[NO_MATCH_TTL_DAYS_ENV],
      NO_MATCH_TTL_DAYS_ENV,
      NO_MATCH_TTL_DAYS_DEFAULT,
      { context: JOB_NAME }
    );
    const batchSize = requirePositiveInt(process.env[BATCH_SIZE_ENV], BATCH_SIZE_ENV, BATCH_SIZE_DEFAULT, {
      context: JOB_NAME,
      note: 'This bounds the LML call volume per run — the whole point of the recurring drip.',
    });
    // BS#2222: rows read at the head cursor every run, and the amount that
    // cursor rotates by — see query.ts's HEAD_SLICE_DEFAULT derivation.
    const requestedHeadSlice = requirePositiveInt(process.env[HEAD_SLICE_ENV], HEAD_SLICE_ENV, HEAD_SLICE_DEFAULT, {
      context: JOB_NAME,
    });
    const { headSlice, tailBatchSize, clamped } = resolveHeadSliceConfig(requestedHeadSlice, batchSize);
    if (clamped) {
      // `headSlice === 0` is reachable only at `batchSize` 1, where the half-
      // batch ceiling floors to zero. It is a different event from a clamp:
      // the whole BS#2222 head mechanism is OFF, not narrowed, and "clamped to
      // 0" reads as a tuning note rather than as "the feature this job exists
      // for is disabled". Same rule as the ceiling itself — a misconfiguration
      // that disables the mechanism must not read as healthy.
      const disabled = headSlice === 0;
      log(
        'warn',
        disabled ? 'head_slice_disabled' : 'head_slice_clamped',
        disabled
          ? `batch size (${batchSize}) is too small to reserve any head slice at ${HEAD_SLICE_MAX_BATCH_SHARE * 100}%, so the BS#2222 head read is DISABLED for this run and the head cursor will not move; raise ${BATCH_SIZE_ENV} to at least 2 (${requestedHeadSlice} was requested)`
          : `${HEAD_SLICE_ENV} (${requestedHeadSlice}) exceeds ${HEAD_SLICE_MAX_BATCH_SHARE * 100}% of batch size (${batchSize}); clamped to ${headSlice} so the tail read keeps at least half the batch and the BS#2218 cursor keeps traversing`,
        {
          requested_head_slice: requestedHeadSlice,
          head_slice: headSlice,
          batch_size: batchSize,
        }
      );
    }

    // BS#2218 starvation guard: resolve this run's OFFSET from the stored
    // cursor, clamped into the current candidate count's range (the cohort
    // shrinks between runs as rows resolve, so a stale cursor can otherwise
    // land past the current end) — see `watermark.ts`'s module doc comment
    // for the full mechanism. BS#2222's head cursor is the same mechanism at
    // a smaller modulus: its own `cronjob_runs` row, wrapped inside a recent
    // window rather than the whole cohort.
    const totalCandidates = await countCandidates(noMatchTtlDays);
    const storedCursor = await getCursorPosition();
    const tailCursorOffset = wrapCursor(storedCursor ?? 0, totalCandidates);
    const headWindow = headCursorWindow(totalCandidates, HEAD_CURSOR_WINDOW_DEFAULT);
    const storedHeadCursor = await getCursorPosition(HEAD_CURSOR_JOB_NAME);
    const headCursorOffset = wrapCursor(storedHeadCursor ?? 0, headWindow);

    // The batch-share clamp and the head window are unrelated constants, so a
    // config can satisfy the clamp and still stand the rotation still — e.g.
    // BATCH_SIZE=400 + HEAD_SLICE=200 against the hardcoded 200-row window,
    // where every run re-reads [0, 200). Coverage is unaffected (a slice that
    // wide reads the whole window); what is lost is the once-per-rotation
    // re-ask cadence, so a permanently-transient row burns LML budget every
    // run. Warn rather than clamp: the operator asked for a wide head, and a
    // silently narrowed one would be the same class of surprise.
    //
    // Gated on the window NOT having been cohort-clamped. On a cohort smaller
    // than the window `headCursorWindow` shrinks the window to the cohort, and
    // a head slice covering all of it is correct at that size, not a
    // misconfiguration — see `headRotationIsInert`.
    if (headRotationIsInert(headSlice, headWindow) && headWindow === HEAD_CURSOR_WINDOW_DEFAULT) {
      log(
        'warn',
        'head_rotation_inert',
        `head slice (${headSlice}) is a multiple of the ${headWindow}-row head cursor window, so the head cursor never moves; the window is fully covered every run, but a persistently-transient row is re-asked every run instead of once per rotation — lower ${HEAD_SLICE_ENV} below ${headWindow}`,
        {
          head_slice: headSlice,
          head_cursor_window: headWindow,
          total_candidates: totalCandidates,
        }
      );
    }

    log('info', 'init', `${JOB_NAME} initialized`, {
      dry_run: dryRun,
      no_match_ttl_days: noMatchTtlDays,
      batch_size: batchSize,
      head_slice: headSlice,
      tail_batch_size: tailBatchSize,
      total_candidates: totalCandidates,
      cursor_offset: tailCursorOffset,
      head_cursor_offset: headCursorOffset,
      head_cursor_window: headWindow,
    });

    // ONE accrual closure for both passes, so they pool a single
    // LIVE_ACTIVITY_MAX_PAUSE_MS ceiling instead of each enforcing its own
    // (2x the configured ceiling) or splitting it (the first pass's
    // exhaustion throwing past the second) — see orchestrate.ts.
    const waitForQuietPeriod = buildRecheckWaitForQuietPeriod({
      onLivePause: () => {
        log('info', 'live_activity_pause', 'live flowsheet activity detected; pausing');
      },
    });

    const { headTotals, tailTotals, totals, headRowsInTailWindow } = await runRecheckPasses(
      { noMatchTtlDays, headSlice, tailBatchSize, headCursorOffset, tailCursorOffset, dryRun },
      {
        loadCandidates,
        runRecheck: runNoMatchRecheck,
        lookup: lookupNoMatchRecheck,
        write: writeMatch,
        markAttempted: markRecheckAttempted,
        waitForQuietPeriod,
      }
    );

    // Advance past however many of the TAIL run's candidates are still
    // candidates, less the head run's below-cursor departures — the head's
    // `scanned` is deliberately excluded (it never occupied a cursor
    // position, so folding it in would over-advance past unread tail rows)
    // while its DEPARTURES are deliberately subtracted (they remove ordering
    // positions below the cursor, pulling unread rows behind it). See
    // watermark.ts. Skipped in dry-run mode.
    //
    // Not reached when a run throws (a lookup failure is isolated per-row,
    // but `orchestrate.ts`'s cooperative-pause ceiling aborts the whole
    // loop). Leaving both cursors unmoved there is the safe direction: the
    // rows the aborted run did dispose of have left the candidate set, so the
    // stored offset is a lower bound on where the next run should start — it
    // re-reads leftovers, never skips unread rows. The aborted run still
    // exits non-zero and captures to Sentry.
    if (!dryRun) {
      // Both advances come from `planCursorAdvance` as data — which row, which
      // modulus, which totals — rather than being spelled out here. `main` is
      // unexported and so untestable, and the BS#2222 review's mutation probe
      // showed that both defects the earlier iterations fixed could be
      // reintroduced at exactly this spot with a fully green suite. Nothing in
      // this block may name a `cronjob_runs` row or a modulus of its own.
      const { writes, logFields } = planCursorAdvance({
        tailCursorOffset,
        headCursorOffset,
        tailTotals,
        headTotals,
        headRowsInTailWindow,
        headSlice,
        totalCandidates,
        headWindow,
      });
      for (const write of writes) {
        await setCursorPosition(db, write.position, write.jobName);
      }
      log('info', 'cursor_advanced', "persisted the next run's OFFSET cursors", logFields);
    }

    // The head/tail split is reported alongside the merged totals, and OUTSIDE
    // the dry-run branch above, because the whole premise of BS#2222 ("~1 in 4
    // fresh no-match rows resolves cleanly") is only verifiable from a
    // head-vs-tail resolution rate — including from a dry run, which persists
    // no cursor and so logs no `cursor_advanced` line at all.
    log('info', 'finished', `${JOB_NAME} done`, {
      dry_run: dryRun,
      head_slice: headSlice,
      ...totals,
      head_scanned: headTotals.scanned,
      head_resolved: headTotals.resolved,
      head_resolved_dry: headTotals.resolved_dry,
      head_unresolved: headTotals.unresolved,
      head_trust_rejected: headTotals.trust_rejected,
      head_lml_error: headTotals.lml_error,
      tail_scanned: tailTotals.scanned,
      tail_resolved: tailTotals.resolved,
      tail_resolved_dry: tailTotals.resolved_dry,
    });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

// Gated so the unit suite can import this module's exported helpers without
// executing a run, the same guard 17+ sibling jobs use.
if (process.env.NODE_ENV !== 'test') {
  void main();
}
