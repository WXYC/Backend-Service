/**
 * Legacy linkage resolve: link `flowsheet` / `rotation` rows to their library
 * album once the library row exists.
 *
 * Both writer paths resolve `album_id` exactly once, at write time, against
 * whatever `library` held at that instant:
 *
 *   - `/internal/flowsheet-webhook` resolves on INSERT and deliberately never
 *     refreshes on conflict — "linkage is anchored to the first delivery"
 *     (apps/backend/routes/internal.route.ts).
 *   - `/internal/rotation-webhook` resolves once via `resolveAlbumId(rawLibraryId)`.
 *
 * That is a race against `jobs/library-etl/`, which imports the catalog on its
 * own half-hourly schedule, and against the librarian, who routinely files the
 * physical release *after* the MD bins it. Any row whose library row lands
 * second keeps `album_id = NULL` forever unless something re-runs the join.
 *
 * Until Phase 3 of the tubafrenzy decommission that "something" was a tail
 * pass inside `jobs/flowsheet-etl/` and `jobs/rotation-etl/`, which ran every
 * 30 minutes. Those jobs were unscheduled when Backend became canonical
 * (WXYC/wiki#88) because their *import* half now writes backwards — from
 * tubafrenzy's mirror copy onto Backend-canonical rows. Their repair half has
 * no such problem: it reads and writes only Backend's own tables and never
 * contacts tubafrenzy. This job is that repair half, lifted out verbatim so it
 * survives the import's retirement.
 *
 * Both statements are anti-joined on `album_id IS NULL`, so a run with nothing
 * to fix is a no-op and re-running is idempotent. No cooperative live-DJ pause:
 * the candidate set is bounded by the rows a webhook could not link, the writes
 * are narrow, and deferring the repair indefinitely during a long show is worse
 * than the contention it would avoid.
 *
 * LIVENESS (BS#2064). Because a healthy idle run writes nothing and logs
 * `candidates: 0`, a cron that stopped running used to be byte-identical to one
 * that ran and found nothing. Three signals now distinguish them; see
 * `docs/ops-cron-scheduling.md` ("Cron liveness") for the fleet-general recipe.
 *
 *   (a) A Sentry cron monitor check-in (`Sentry.withMonitor`) around the real
 *       run. Sentry raises a *missed check-in* when a run does not happen —
 *       precisely the failure mode a try/catch cannot see (crontab entry
 *       dropped, image pull denied, docker wedged, host rebooted).
 *   (b) A `cronjob_runs` heartbeat row written after a successful run.
 *   (c) A drain check: after the write, the same COUNT is re-run. A nonzero
 *       residual means the UPDATE didn't drain what its own COUNT sees — a run
 *       that reports OK while silently not repairing (BS#2071: measuring the
 *       invariant after the fact, rather than comparing against the pre-UPDATE
 *       COUNT, is what keeps a benign concurrent repair from reading as this).
 *
 * Usage:
 *   node dist/job.js              # resolve (default)
 *   node dist/job.js --dry-run    # report candidate counts, write nothing
 */

import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  flowsheet,
  rotation,
  library,
  closeDatabaseConnection,
  getLastRunTimestamp,
  updateLastRun,
  requirePositiveInt,
} from '@wxyc/database';
import { initLogger, log, captureError, captureWarning, errorMessage, closeLogger } from './logger.js';

export const JOB_NAME = 'legacy-linkage-resolve';

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');

/**
 * Must stay byte-identical to `package.json`'s `cron-schedule`, which is what
 * `deploy-base.yml` installs in the EC2 crontab. Sentry upserts the monitor
 * from this value on the first check-in, so a drift here would make the monitor
 * expect a cadence the host does not run — pinned by a unit test rather than
 * read from `package.json`, which tsup does not bundle into `dist/`.
 */
export const CRON_SCHEDULE = '*/30 * * * *';

/**
 * Minutes past the scheduled slot before Sentry counts a check-in as missed.
 * Sentry's clock starts at the missed slot itself — expected time plus
 * `checkinMargin` — so 10 here flags a skipped run ~10 min after the slot it
 * skipped, not ~40. The 40-minute figure is real, but it's the gap since the
 * *last successful* run (one full 30-minute cadence, plus this 10-minute
 * margin) — a different reference point that makes detection look four times
 * slower than it is. 10 min also absorbs a deploy that recreates the crontab
 * entry a few minutes late.
 */
export const CHECKIN_MARGIN_MINUTES = 10;

/**
 * Minutes a run may stay `in_progress` before Sentry marks it timed out.
 * Under the 30-minute cadence so a wedged run is flagged before the next one
 * fires. Not derived by summing per-statement timeouts — the monitored
 * callback issues up to nine statements in the current worst case (COUNT,
 * UPDATE, a post-write re-COUNT, and a conditional ANALYZE per pass — BS#2071
 * added the re-COUNT — plus the heartbeat upsert), and nine statements against
 * a pool whose image sets `DB_STATEMENT_TIMEOUT_MS=300000` (5 min each) would
 * clear 25 minutes on its own. The real ceiling is the deploy:
 * `deploy-base.yml`'s cron install runs `docker rm -f <target>-cron` ahead of
 * every `docker run`, so the next half-hourly slot SIGKILLs any run still
 * alive from the previous one. No run can legitimately outlive the cadence,
 * so 25 under 30 is the right number regardless of what the statements
 * inside it add up to — and a SIGKILLed run sends no terminal check-in and
 * writes no heartbeat, exactly the "the run did not happen" shape signals
 * (a) and (b) exist to report.
 */
export const MAX_RUNTIME_MINUTES = 25;

type MonitorConfig = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>;

export const MONITOR_CONFIG: MonitorConfig = {
  schedule: { type: 'crontab', value: CRON_SCHEDULE },
  checkinMargin: CHECKIN_MARGIN_MINUTES,
  maxRuntime: MAX_RUNTIME_MINUTES,
  // The crontab on the EC2 host runs in UTC; `deploy-base.yml` installs the
  // `cron-schedule` string verbatim without a TZ line.
  timezone: 'Etc/UTC',
};

/**
 * Hours between two successful runs before the gap is worth a warning. The
 * cadence is 30 minutes, so 4 h is eight consecutive missed runs — far past any
 * deploy, reboot, or maintenance window, and deliberately much looser than (a)'s
 * detection window (~10 min after the missed slot; ~40 min after the last
 * successful run) so the two signals do not double-report the same blip.
 *
 * This is a *backstop* to the Sentry monitor, not a replacement: it can only
 * fire once the job runs again, whereas a missed check-in fires while the job
 * is still down.
 */
export const MAX_RUN_GAP_HOURS_DEFAULT = 4;

export const resolveMaxRunGapHours = (raw: string | undefined = process.env.LINKAGE_RESOLVE_MAX_GAP_HOURS): number =>
  requirePositiveInt(raw, 'LINKAGE_RESOLVE_MAX_GAP_HOURS', MAX_RUN_GAP_HOURS_DEFAULT, { unit: 'hours' });

export type PassResult = { candidates: number; resolved: number; residual: number };
export type RunResult = { flowsheet: PassResult; rotation: PassResult };

/**
 * The flowsheet candidate COUNT, factored out so it can be issued twice —
 * once before the UPDATE, once after — with guaranteed byte-identical SQL.
 * See the no-time-bound note on `resolveFlowsheetAlbumIds` below: this is the
 * one and only cohort query, and the second call exists to re-measure it, not
 * to narrow it.
 */
const countUnresolvedFlowsheetCandidates = async (): Promise<number> => {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${flowsheet} f
    JOIN ${library} l ON f.legacy_release_id = l.legacy_release_id
    WHERE f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  return Number(row?.count ?? 0);
};

/**
 * Link `flowsheet.album_id` by joining `legacy_release_id` to
 * `library.legacy_release_id`. Lifted verbatim from `jobs/flowsheet-etl/`'s
 * `resolveAlbumIds`.
 *
 * `updated_at` is deliberately not set — migration 0084's trigger owns that
 * column on `flowsheet`.
 *
 * NEVER add a time bound to this SELECT (or the rotation one below). The
 * `cronjob_runs` row BS#2064 introduced is a liveness **heartbeat**, not a
 * delta watermark: filtering the cohort on `last_run` would permanently strand
 * every row whose `library` row landed during a window the job missed, which is
 * the exact bug this job exists to prevent. The cohort is defined by
 * `album_id IS NULL` and nothing else.
 */
const resolveFlowsheetAlbumIds = async (dryRun: boolean): Promise<PassResult> => {
  const candidates = await countUnresolvedFlowsheetCandidates();

  if (dryRun || candidates === 0) {
    return { candidates, resolved: 0, residual: 0 };
  }

  const result = await db.execute(sql`
    UPDATE ${flowsheet} f
    SET album_id = l.id
    FROM ${library} l
    WHERE f.legacy_release_id = l.legacy_release_id
      AND f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `);
  const resolved = Number(result.count ?? 0);

  if (resolved > 0) {
    await db.execute(sql.raw(`ANALYZE "${SCHEMA}"."flowsheet"`));
  }

  // BS#2071: re-measure the same invariant after the write instead of trusting
  // the pre-UPDATE snapshot compared against `resolved`. See the
  // `hasUnresolvedResidue` docblock for why the pre/post comparison was wrong.
  const residual = await countUnresolvedFlowsheetCandidates();

  return { candidates, resolved, residual };
};

/**
 * The rotation candidate COUNT, factored out for the same reason as
 * `countUnresolvedFlowsheetCandidates` above: one query, issued twice,
 * guaranteed byte-identical.
 */
const countUnresolvedRotationCandidates = async (): Promise<number> => {
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${rotation} r
    JOIN ${library} l ON r.legacy_library_release_id = l.legacy_release_id
    WHERE r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  return Number(row?.count ?? 0);
};

/**
 * Link `rotation.album_id` by joining `legacy_library_release_id` to
 * `library.legacy_release_id`, clearing the denormalized display columns the
 * row carried while it was unlinked. Lifted verbatim from
 * `jobs/rotation-etl/`'s `resolveAlbumIds`.
 *
 * Same no-time-bound rule as the flowsheet pass above.
 */
const resolveRotationAlbumIds = async (dryRun: boolean): Promise<PassResult> => {
  const candidates = await countUnresolvedRotationCandidates();

  if (dryRun || candidates === 0) {
    return { candidates, resolved: 0, residual: 0 };
  }

  const result = await db.execute(sql`
    UPDATE ${rotation} r
    SET album_id = l.id,
        artist_name = NULL,
        album_title = NULL,
        record_label = NULL
    FROM ${library} l
    WHERE r.legacy_library_release_id = l.legacy_release_id
      AND r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `);
  const resolved = Number(result.count ?? 0);

  if (resolved > 0) {
    await db.execute(sql.raw(`ANALYZE "${SCHEMA}"."rotation"`));
  }

  // BS#2071: same post-write re-measure as the flowsheet pass.
  const residual = await countUnresolvedRotationCandidates();

  return { candidates, resolved, residual };
};

export const runResolve = async (dryRun: boolean): Promise<RunResult> => {
  const flowsheetResult = await resolveFlowsheetAlbumIds(dryRun);
  log('info', 'resolve-flowsheet', 'Flowsheet linkage pass complete.', {
    dry_run: dryRun,
    candidates: flowsheetResult.candidates,
    resolved: flowsheetResult.resolved,
    residual: flowsheetResult.residual,
  });

  const rotationResult = await resolveRotationAlbumIds(dryRun);
  log('info', 'resolve-rotation', 'Rotation linkage pass complete.', {
    dry_run: dryRun,
    candidates: rotationResult.candidates,
    resolved: rotationResult.resolved,
    residual: rotationResult.residual,
  });

  return { flowsheet: flowsheetResult, rotation: rotationResult };
};

// ---- Liveness (BS#2064) ----

/** Elapsed hours (fractional) between the last successful run and this one. */
export const gapHours = (lastRunMs: number, startedAtMs: number): number =>
  (startedAtMs - lastRunMs) / (60 * 60 * 1000);

/**
 * A pass whose post-write residual is nonzero. Signal (c): the job ran,
 * checked in green, and — per this re-check — did not repair what it found.
 *
 * BS#2071: this used to compare the pre-UPDATE `candidates` COUNT against
 * `resolved` and treat `resolved < candidates` as impossible to hit benignly,
 * reasoning that `library.legacy_release_id`'s unique index makes the COUNT
 * and the UPDATE agree. That reasoning only holds under a single snapshot —
 * the COUNT and the UPDATE are two separate `db.execute` calls with no
 * wrapping transaction, so anything that removes a row from the cohort
 * between them (a concurrent `broken-fk-recovery` one-shot run issuing the
 * byte-identical UPDATE, a DJ deleting the flowsheet entry, an MD editing it
 * and picking an album, an MD deleting the `library` row a candidate joins
 * to) used to read as `resolved < candidates`: a warning asserting the job
 * "did not repair what it found," on a run where everything worked.
 *
 * The fix is to measure the invariant after the fact instead of across the
 * race: `resolveFlowsheetAlbumIds`/`resolveRotationAlbumIds` re-run the exact
 * same COUNT after the UPDATE (and any follow-up ANALYZE) and report that as
 * `residual`. Every one of the benign paths above removes the row from the
 * residual exactly as it removed it from contention — a repair concurrent
 * with this job's own UPDATE is repair either way — while a genuine "the
 * UPDATE isn't draining what its own COUNT sees" still leaves rows behind and
 * still fires.
 *
 * `resolved > candidates` stays normal and not a residue on its own —
 * `library-etl` shares the same half-hourly slot, so a matching `library` row
 * can land between this pass's pre-UPDATE COUNT and its UPDATE — but it no
 * longer needs special-casing here: the residual re-count settles it either
 * way.
 *
 * A zero-candidate run (or a dry run, which never reaches the UPDATE or the
 * residual re-count) reports `residual: 0` — a healthy idle run must never
 * alert.
 */
export const hasUnresolvedResidue = ({ residual }: PassResult): boolean => residual > 0;

/**
 * Signal (b), read side. `getLastRunTimestamp` is called here **only** to
 * report how long the job was away; the value never reaches a repair predicate.
 * See the no-time-bound note on `resolveFlowsheetAlbumIds`.
 */
const reportRunGap = async (startedAt: Date): Promise<void> => {
  const lastRunMs = await getLastRunTimestamp(JOB_NAME);
  if (lastRunMs === null) {
    log('info', 'gap-check', 'No prior heartbeat; first run since liveness landed.', { last_run: null });
    return;
  }

  const gap = gapHours(lastRunMs, startedAt.getTime());
  const maxGap = resolveMaxRunGapHours();
  log('info', 'gap-check', 'Elapsed since last successful run.', {
    last_run: new Date(lastRunMs).toISOString(),
    gap_hours: Number(gap.toFixed(2)),
    max_gap_hours: maxGap,
  });

  if (gap > maxGap) {
    captureWarning(`${JOB_NAME}.run_gap_exceeded`, 'gap-check', {
      last_run: new Date(lastRunMs).toISOString(),
      gap_hours: Number(gap.toFixed(2)),
      max_gap_hours: maxGap,
      cron_schedule: CRON_SCHEDULE,
    });
  }
};

/** Signal (c). Emits at most one warning per pass, fingerprinted by step. */
const reportDrain = (result: RunResult): void => {
  const passes = [
    ['flowsheet', result.flowsheet],
    ['rotation', result.rotation],
  ] as const;

  for (const [pass, passResult] of passes) {
    if (!hasUnresolvedResidue(passResult)) continue;
    log('warn', `drain-${pass}`, 'Post-write re-check still finds unresolved candidates.', {
      candidates: passResult.candidates,
      resolved: passResult.resolved,
      residual: passResult.residual,
    });
    captureWarning(`${JOB_NAME}.unresolved_candidates`, `drain-${pass}`, {
      pass,
      candidates: passResult.candidates,
      resolved: passResult.resolved,
      residual: passResult.residual,
    });
  }
};

/**
 * One execution with its liveness signals attached.
 *
 * A dry run deliberately skips all three: it must not send a check-in Sentry
 * would read as a scheduled execution, must not advance the heartbeat, and
 * would trip (c) trivially (it counts candidates and writes nothing by design).
 */
export const runOnce = async (dryRun: boolean): Promise<RunResult> => {
  if (dryRun) return runResolve(true);

  const startedAt = new Date();
  // Fail-open: the repair is the job, the gap report is telemetry about it. A
  // malformed LINKAGE_RESOLVE_MAX_GAP_HOURS or an unreachable `cronjob_runs`
  // must not stop the run — and must not skip the check-in below, which would
  // turn an observability fault into a phantom "cron is down" alert.
  try {
    await reportRunGap(startedAt);
  } catch (error) {
    log('warn', 'gap-check', 'Gap check failed; continuing with the repair.', { error: errorMessage(error) });
    captureError(error, 'gap-check');
  }

  // (a) + (b). The heartbeat is inside the monitored callback so the check-in
  // reports `ok` only when the whole unit of work — repair and heartbeat —
  // committed. `withMonitor` re-throws, so the caller's catch is unchanged.
  const result = await Sentry.withMonitor(
    JOB_NAME,
    async () => {
      const passes = await runResolve(false);
      await updateLastRun(JOB_NAME, startedAt);
      return passes;
    },
    MONITOR_CONFIG
  );

  log('info', 'heartbeat', 'Recorded cronjob_runs heartbeat.', { last_run: startedAt.toISOString() });
  reportDrain(result);
  return result;
};

// ---- Main ----

const run = async () => {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });
  log('info', 'start', dryRun ? 'Starting linkage resolve (dry run).' : 'Starting linkage resolve.', {
    dry_run: dryRun,
  });

  let exitCode = 0;
  try {
    const result = await runOnce(dryRun);
    log('info', 'complete', 'Linkage resolve complete.', {
      dry_run: dryRun,
      flowsheet_resolved: result.flowsheet.resolved,
      rotation_resolved: result.rotation.resolved,
    });
  } catch (error) {
    exitCode = 1;
    log('error', 'failed', 'Linkage resolve failed.', { error: errorMessage(error) });
    captureError(error, 'failed');
  } finally {
    await closeDatabaseConnection();
    await closeLogger();
  }
  process.exit(exitCode);
};

// `run` catches everything internally and exits with its own code, so there is
// no rejection to handle here. Guard the auto-invoke so jest's module load
// doesn't fire a stray run (and a `process.exit`) against the mocked DB — jest
// sets NODE_ENV='test'; production runs leave it unset, which executes `run()`.
if (process.env.NODE_ENV !== 'test') {
  void run();
}
