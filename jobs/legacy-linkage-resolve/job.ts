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
 *   (c) A drain check: a run that saw candidates but wrote fewer rows than it
 *       saw is a job that runs and reports OK while silently not repairing.
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
 * 10 on a 30-minute cadence surfaces a skipped run ~40 min after its slot —
 * "within one cadence plus margin" — while absorbing a deploy that recreates
 * the crontab entry a few minutes late.
 */
export const CHECKIN_MARGIN_MINUTES = 10;

/**
 * Minutes a run may stay `in_progress` before Sentry marks it timed out. Under
 * the 30-minute cadence so a wedged run is flagged before the next one fires,
 * and above the arithmetic worst case: four statements against a pool whose
 * image sets `DB_STATEMENT_TIMEOUT_MS=300000` (5 min each).
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
 * 40-minute detection so the two signals do not double-report the same blip.
 *
 * This is a *backstop* to the Sentry monitor, not a replacement: it can only
 * fire once the job runs again, whereas a missed check-in fires while the job
 * is still down.
 */
export const MAX_RUN_GAP_HOURS_DEFAULT = 4;

export const resolveMaxRunGapHours = (raw: string | undefined = process.env.LINKAGE_RESOLVE_MAX_GAP_HOURS): number =>
  requirePositiveInt(raw, 'LINKAGE_RESOLVE_MAX_GAP_HOURS', MAX_RUN_GAP_HOURS_DEFAULT, { unit: 'hours' });

export type PassResult = { candidates: number; resolved: number };
export type RunResult = { flowsheet: PassResult; rotation: PassResult };

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
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${flowsheet} f
    JOIN ${library} l ON f.legacy_release_id = l.legacy_release_id
    WHERE f.legacy_release_id IS NOT NULL
      AND f.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  const candidates = Number(row?.count ?? 0);

  if (dryRun || candidates === 0) {
    return { candidates, resolved: 0 };
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
  return { candidates, resolved };
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
  const [row] = (await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM ${rotation} r
    JOIN ${library} l ON r.legacy_library_release_id = l.legacy_release_id
    WHERE r.legacy_library_release_id IS NOT NULL
      AND r.album_id IS NULL
  `)) as unknown as Array<{ count: number | string }>;
  const candidates = Number(row?.count ?? 0);

  if (dryRun || candidates === 0) {
    return { candidates, resolved: 0 };
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
  return { candidates, resolved };
};

export const runResolve = async (dryRun: boolean): Promise<RunResult> => {
  const flowsheetResult = await resolveFlowsheetAlbumIds(dryRun);
  log('info', 'resolve-flowsheet', 'Flowsheet linkage pass complete.', {
    dry_run: dryRun,
    candidates: flowsheetResult.candidates,
    resolved: flowsheetResult.resolved,
  });

  const rotationResult = await resolveRotationAlbumIds(dryRun);
  log('info', 'resolve-rotation', 'Rotation linkage pass complete.', {
    dry_run: dryRun,
    candidates: rotationResult.candidates,
    resolved: rotationResult.resolved,
  });

  return { flowsheet: flowsheetResult, rotation: rotationResult };
};

// ---- Liveness (BS#2064) ----

/** Elapsed hours (fractional) between the last successful run and this one. */
export const gapHours = (lastRunMs: number, startedAtMs: number): number =>
  (startedAtMs - lastRunMs) / (60 * 60 * 1000);

/**
 * A pass that saw candidates and wrote fewer rows than it saw. Signal (c): the
 * job ran, checked in green, and did not repair what it found.
 *
 * `resolved > candidates` is normal and NOT a residue — `library-etl` shares
 * the same half-hourly slot, so a matching `library` row can land between this
 * pass's COUNT and its UPDATE. `resolved < candidates` cannot happen benignly:
 * `library.legacy_release_id` carries a unique index
 * (`library_legacy_release_id_idx`), so the COUNT over the join counts exactly
 * the distinct rows the UPDATE targets.
 *
 * A zero-candidate run returns `false` — a healthy idle run must never alert.
 */
export const hasUnresolvedResidue = ({ candidates, resolved }: PassResult): boolean =>
  candidates > 0 && resolved < candidates;

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
    log('warn', `drain-${pass}`, 'Pass wrote fewer rows than it saw candidates.', {
      candidates: passResult.candidates,
      resolved: passResult.resolved,
    });
    captureWarning(`${JOB_NAME}.unresolved_candidates`, `drain-${pass}`, {
      pass,
      candidates: passResult.candidates,
      resolved: passResult.resolved,
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
