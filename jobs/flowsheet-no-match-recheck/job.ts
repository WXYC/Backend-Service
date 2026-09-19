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
 * rows always read at OFFSET 0, so a row the live worker writes today isn't
 * deferred a full cursor wrap for its first recheck. Both `loadCandidates`
 * calls (head + tail) run BEFORE either `runNoMatchRecheck` pass, since the
 * head pass's writes would otherwise shrink the ordering's front out from
 * under `cursorOffset` before the tail SELECT issues. The head slice runs
 * as its own `runNoMatchRecheck` pass so `nextCursorPosition` sees only the
 * tail run's `Totals` (folding the head's in would over-advance past unread
 * tail rows — see `watermark.ts`); `excludeCandidateIds` drops any tail row
 * the head read already covered, and each pass gets its own slice of
 * `LIVE_ACTIVITY_MAX_PAUSE_MS` so the two together don't double the ceiling.
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

import { runNoMatchRecheck, mergeTotals, excludeCandidateIds, resolveLiveActivityMaxPauseMs } from './orchestrate.js';
import {
  loadCandidates,
  countCandidates,
  BATCH_SIZE_DEFAULT,
  BATCH_SIZE_ENV,
  HEAD_SLICE_DEFAULT,
  HEAD_SLICE_ENV,
  NO_MATCH_TTL_DAYS_DEFAULT,
  NO_MATCH_TTL_DAYS_ENV,
} from './query.js';
import { lookupNoMatchRecheck } from './lml-fetch.js';
import { markRecheckAttempted, writeMatch } from './writer.js';
import {
  JOB_NAME,
  getCursorPosition,
  nextCursorPosition,
  setCursorPosition,
  stillCandidates,
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
    // BS#2222: rows always read at OFFSET 0 — see query.ts's HEAD_SLICE_DEFAULT derivation.
    const requestedHeadSlice = requirePositiveInt(process.env[HEAD_SLICE_ENV], HEAD_SLICE_ENV, HEAD_SLICE_DEFAULT, {
      context: JOB_NAME,
    });
    // Clamp so the tail read (and with it the BS#2218 cursor advance) never
    // drops to zero rows — a HEAD_SLICE >= BATCH_SIZE would otherwise
    // silently disable the starvation guard.
    const headSlice = Math.min(requestedHeadSlice, batchSize - 1);
    const tailBatchSize = batchSize - headSlice;
    if (headSlice !== requestedHeadSlice) {
      log(
        'warn',
        'head_slice_clamped',
        `${HEAD_SLICE_ENV} (${requestedHeadSlice}) >= batch size (${batchSize}); clamped to ${headSlice} so the tail read stays non-empty`,
        {
          requested_head_slice: requestedHeadSlice,
          head_slice: headSlice,
          batch_size: batchSize,
        }
      );
    }

    // Split the cooperative-pause ceiling proportionally across the two
    // runNoMatchRecheck calls below -- each otherwise resolves and enforces
    // its own full LIVE_ACTIVITY_MAX_PAUSE_MS budget, which would let one
    // run pause up to 2x the configured ceiling.
    const totalLiveActivityMaxPauseMs = resolveLiveActivityMaxPauseMs();
    const headLiveActivityMaxPauseMs =
      totalLiveActivityMaxPauseMs > 0
        ? Math.max(Math.round((totalLiveActivityMaxPauseMs * headSlice) / batchSize), 1)
        : 0;
    const tailLiveActivityMaxPauseMs =
      totalLiveActivityMaxPauseMs > 0 ? Math.max(totalLiveActivityMaxPauseMs - headLiveActivityMaxPauseMs, 0) : 0;

    // BS#2218 starvation guard: resolve this run's OFFSET from the stored
    // cursor, clamped into the current candidate count's range (the cohort
    // shrinks between runs as rows resolve, so a stale cursor can otherwise
    // land past the current end) — see `watermark.ts`'s module doc comment
    // for the full mechanism.
    const totalCandidates = await countCandidates(noMatchTtlDays);
    const storedCursor = await getCursorPosition();
    const cursorOffset = wrapCursor(storedCursor ?? 0, totalCandidates);

    log('info', 'init', `${JOB_NAME} initialized`, {
      dry_run: dryRun,
      no_match_ttl_days: noMatchTtlDays,
      batch_size: batchSize,
      head_slice: headSlice,
      tail_batch_size: tailBatchSize,
      total_candidates: totalCandidates,
      cursor_offset: cursorOffset,
    });

    const onLivePause = (): void => {
      log('info', 'live_activity_pause', 'live flowsheet activity detected; pausing');
    };

    // Both reads happen against the SAME pre-write snapshot -- running the
    // head pass first would shrink the ordering's front before the tail
    // SELECT issues, landing cursorOffset past unread rows every run.
    const headCandidates = await loadCandidates(noMatchTtlDays, headSlice, 0);
    const tailCandidatesRaw =
      tailBatchSize > 0 ? await loadCandidates(noMatchTtlDays, tailBatchSize, cursorOffset) : [];
    const tailCandidates = excludeCandidateIds(
      tailCandidatesRaw,
      new Set(headCandidates.map((candidate) => candidate.id))
    );

    const { totals: headTotals } = await runNoMatchRecheck({
      loadCandidates: () => Promise.resolve(headCandidates),
      lookup: lookupNoMatchRecheck,
      write: writeMatch,
      markAttempted: markRecheckAttempted,
      dryRun,
      onLivePause,
      liveActivityMaxPauseMs: headLiveActivityMaxPauseMs,
    });
    const { totals: tailTotals } = await runNoMatchRecheck({
      loadCandidates: () => Promise.resolve(tailCandidates),
      lookup: lookupNoMatchRecheck,
      write: writeMatch,
      markAttempted: markRecheckAttempted,
      dryRun,
      onLivePause,
      liveActivityMaxPauseMs: tailLiveActivityMaxPauseMs,
    });

    const totals = mergeTotals(headTotals, tailTotals);

    // Advance past however many of the TAIL run's candidates are still
    // candidates — the head slice's totals are deliberately excluded (see
    // watermark.ts): it never occupied a cursor position, so folding it in
    // would over-advance past unread tail rows. Skipped in dry-run mode.
    //
    // Not reached when a run throws (a lookup failure is isolated per-row,
    // but `orchestrate.ts`'s cooperative-pause ceiling aborts the whole
    // loop). Leaving the cursor unmoved there is the safe direction under
    // this advance rule: the rows the aborted run did dispose of have left
    // the candidate set, so the stored offset is a lower bound on where the
    // next run should start — it re-reads leftovers, never skips unread
    // rows. The aborted run still exits non-zero and captures to Sentry.
    if (!dryRun) {
      const nextCursor = nextCursorPosition(cursorOffset, tailTotals, totalCandidates);
      await setCursorPosition(db, nextCursor);
      log('info', 'cursor_advanced', "persisted the next run's OFFSET cursor", {
        cursor_offset: cursorOffset,
        next_cursor: nextCursor,
        tail_scanned: tailTotals.scanned,
        still_candidates: stillCandidates(tailTotals),
        total_candidates: totalCandidates,
      });
    }

    log('info', 'finished', `${JOB_NAME} done`, { dry_run: dryRun, head_slice: headSlice, ...totals });
  } catch (error) {
    log('error', 'failed', `${JOB_NAME} failed`, { error_message: (error as Error).message });
    captureError(error, 'failed');
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
};

void main();
