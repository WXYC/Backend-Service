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
 * then advance and persist the cursor by however many rows this run actually
 * scanned (`totals.scanned` — outcome-independent, see `watermark.ts`'s
 * module doc comment). Keeping this composition in `job.ts` means
 * `orchestrate.ts`'s `LoadCandidatesFn` stays the simple zero-arg shape its
 * existing tests already pin — no cursor concept leaks into the orchestrator
 * or its transient-handling contract.
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
 *   BACKFILL_LML_MAX_CONCURRENT=N                    default 1
 *   BACKFILL_LML_RATE_PER_MIN=N                      default 20
 *   FLOWSHEET_NO_MATCH_RECHECK_LML_PER_CALL_TIMEOUT_MS=N   default 35000
 *   LIVE_ACTIVITY_LOOKBACK_SECONDS=N                 default 60; 0 disables cooperative pause
 *   LIVE_ACTIVITY_PAUSE_MS=N                         default 30000
 */

import { closeDatabaseConnection, db, requirePositiveInt } from '@wxyc/database';

import { runNoMatchRecheck } from './orchestrate.js';
import {
  loadCandidates,
  countCandidates,
  BATCH_SIZE_DEFAULT,
  BATCH_SIZE_ENV,
  NO_MATCH_TTL_DAYS_DEFAULT,
  NO_MATCH_TTL_DAYS_ENV,
} from './query.js';
import { lookupNoMatchRecheck } from './lml-fetch.js';
import { markRecheckAttempted, writeMatch } from './writer.js';
import { getCursorPosition, setCursorPosition, wrapCursor } from './watermark.js';
import { initLogger, log, captureError, closeLogger } from './logger.js';

const JOB_NAME = 'flowsheet-no-match-recheck';

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
      total_candidates: totalCandidates,
      cursor_offset: cursorOffset,
    });
    const { totals } = await runNoMatchRecheck({
      loadCandidates: () => loadCandidates(noMatchTtlDays, batchSize, cursorOffset),
      lookup: lookupNoMatchRecheck,
      write: writeMatch,
      markAttempted: markRecheckAttempted,
      dryRun,
      onLivePause: () => {
        log('info', 'live_activity_pause', 'live flowsheet activity detected; pausing');
      },
    });

    // Advance by `totals.scanned` (every candidate this run visited,
    // regardless of outcome — including a row that transiented and left its
    // retry marker untouched), not `batchSize`: a tail page can return fewer
    // rows than a full batch when `cursorOffset + batchSize` overruns
    // `totalCandidates`, and advancing by the actual count lands the next
    // cursor exactly at the end instead of overshooting past it. Skipped
    // entirely in dry-run mode — a preview run must stay side-effect-free,
    // including for the next REAL run's starting offset.
    if (!dryRun) {
      const nextCursor = wrapCursor(cursorOffset + totals.scanned, totalCandidates);
      await setCursorPosition(db, nextCursor);
      log('info', 'cursor_advanced', "persisted the next run's OFFSET cursor", {
        cursor_offset: cursorOffset,
        next_cursor: nextCursor,
        scanned: totals.scanned,
        total_candidates: totalCandidates,
      });
    }

    log('info', 'finished', `${JOB_NAME} done`, { dry_run: dryRun, ...totals });
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
