/**
 * Legacy-mirror reconciliation cron (BS#1707).
 *
 * Self-heals tubafrenzy mirror rows orphaned when the Backend-Service →
 * tubafrenzy live mirror's single `res.finish` attempt was skipped: the
 * PostHog `backend-mirror` flag was off for the caller, a PostHog eval hiccup,
 * a transient tubafrenzy HTTP failure, a mid-show flag flip (the one-shot
 * handler already ran and won't re-fire), or a BS process restart mid-request.
 * Because the live mirror has no retry and no reconciliation, those rows stay
 * orphaned forever. This cron reads the durable NULL-surrogate-key signal
 * (`shows.legacy_show_id IS NULL` / `flowsheet.legacy_entry_id IS NULL`)
 * straight from Postgres and re-drives the missing tubafrenzy rows, so it
 * heals regardless of *why* the live attempt was skipped and survives
 * restarts. See `orchestrate.ts` for the two-sweep mechanism.
 *
 * This entrypoint layers two net-new steps onto the standard job skeleton
 * (init logger → try/catch/finally): a `pg_try_advisory_lock` single-flight
 * acquire on a dedicated `max:1` client, and a `posthog-node` `shutdown()` in
 * `finally` (posthog-node keeps background flush timers; a short-lived cron
 * that doesn't shut it down may hang on exit).
 *
 * Run procedure: registered as a cron via `deploy-base.yml`'s job-type=cron
 * pathway; schedule from package.json's `cron-schedule` (`0 8 * * *` UTC ≈
 * 03:00 ET, off-peak). Cooperative pause (#735) defers each sweep/show while
 * a DJ is live, which also keeps the sweep away from still-in-flight live
 * mirrors.
 */

import {
  checkLiveActivity,
  closeDatabaseConnection,
  createPostgresClient,
  requireNonNegativeInt,
  requirePositiveInt,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
} from '@wxyc/database';
import {
  isActiveRotationMatch,
  mapEntryToTubafrenzy,
  mapShowToTubafrenzy,
  mirrorCreateEntry,
  mirrorCreateShow,
  mirrorSignoffShow,
} from '@wxyc/legacy-mirror';
import { PostHog } from 'posthog-node';
import {
  persistLegacyEntryId,
  persistLegacyShowId,
  runReconcile,
  selectDj,
  selectEntrySweepShows,
  selectOrphanEntries,
  selectPartialShows,
  selectShowsToCreate,
  type ReconcileOptions,
  type ReconcilePorts,
} from './orchestrate.js';
import { captureError, captureWarning, closeLogger, initLogger, log } from './logger.js';

const JOB_NAME = 'legacy-mirror-reconcile';

/**
 * Fixed single-flight advisory-lock key for this cron. Held on the dedicated
 * `max:1` client (below) for the whole run so a second reconcile invocation —
 * a manual run beside the cron, or a long run spilling past the next schedule
 * — bails immediately instead of double-POSTing the same NULL-legacy rows.
 * Arbitrary but stable; no other job takes an advisory lock today.
 */
export const ADVISORY_LOCK_KEY = 17071707;

// ── Env knobs ───────────────────────────────────────────────────────────────

/** Bounded recent window (hours). Older orphans are the historical-remediation
 * class, deliberately out of scope for this recurring sweep. */
export const RECONCILE_WINDOW_HOURS_ENV = 'RECONCILE_WINDOW_HOURS';
export const RECONCILE_WINDOW_HOURS_DEFAULT = 48;

/** Settle window (minutes): don't race a still-in-flight live mirror by
 * touching shows started within the last few minutes. Applies to the
 * show-create sweep only. */
export const RECONCILE_SETTLE_MINUTES_ENV = 'RECONCILE_SETTLE_MINUTES';
export const RECONCILE_SETTLE_MINUTES_DEFAULT = 15;

/** Sentry-warning threshold: escalate when orphan_shows+orphan_entries+
 * partial_shows exceeds this. Default 0 → alert whenever anything was found. */
export const RECONCILE_ALERT_THRESHOLD_ENV = 'RECONCILE_ALERT_THRESHOLD';
export const RECONCILE_ALERT_THRESHOLD_DEFAULT = 0;

/** Cooperative-pause lookback window (seconds); `0` disables the probe.
 * Reuses the shared env name rather than a RECONCILE_-prefixed fork. */
export const LIVE_ACTIVITY_LOOKBACK_ENV = 'LIVE_ACTIVITY_LOOKBACK_SECONDS';
/** Sleep between re-probes when DJ activity is detected. Shared env name. */
export const LIVE_ACTIVITY_PAUSE_MS_ENV = 'LIVE_ACTIVITY_PAUSE_MS';

export interface JobOptions extends ReconcileOptions {
  liveActivityLookbackSeconds: number;
  liveActivityPauseMs: number;
}

export const resolveOptions = (env: NodeJS.ProcessEnv = process.env): JobOptions => {
  const ctx = { context: JOB_NAME };
  return {
    windowHours: requirePositiveInt(
      env[RECONCILE_WINDOW_HOURS_ENV],
      RECONCILE_WINDOW_HOURS_ENV,
      RECONCILE_WINDOW_HOURS_DEFAULT,
      ctx
    ),
    settleMinutes: requireNonNegativeInt(
      env[RECONCILE_SETTLE_MINUTES_ENV],
      RECONCILE_SETTLE_MINUTES_ENV,
      RECONCILE_SETTLE_MINUTES_DEFAULT,
      ctx
    ),
    alertThreshold: requireNonNegativeInt(
      env[RECONCILE_ALERT_THRESHOLD_ENV],
      RECONCILE_ALERT_THRESHOLD_ENV,
      RECONCILE_ALERT_THRESHOLD_DEFAULT,
      ctx
    ),
    liveActivityLookbackSeconds: requireNonNegativeInt(
      env[LIVE_ACTIVITY_LOOKBACK_ENV],
      LIVE_ACTIVITY_LOOKBACK_ENV,
      LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
      { ...ctx, note: 'Use 0 to disable the live-activity probe.' }
    ),
    liveActivityPauseMs: requirePositiveInt(
      env[LIVE_ACTIVITY_PAUSE_MS_ENV],
      LIVE_ACTIVITY_PAUSE_MS_ENV,
      LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
      ctx
    ),
  };
};

// ── Single-flight advisory lock ──────────────────────────────────────────────

/**
 * Minimal shape of the postgres-js client the lock helpers need. Typed
 * structurally so unit tests can pass a fake with just `unsafe`.
 */
export interface AdvisoryLockClient {
  unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/** Try to take the session-scoped advisory lock. Returns true on acquire. */
export const acquireAdvisoryLock = async (client: AdvisoryLockClient, key: number): Promise<boolean> => {
  const rows = await client.unsafe('SELECT pg_try_advisory_lock($1) AS locked', [key]);
  return rows[0]?.locked === true;
};

/** Release the advisory lock. Idempotent; the client's `end()` also releases
 * it when the session closes, so this is belt-and-suspenders. */
export const releaseAdvisoryLock = async (client: AdvisoryLockClient, key: number): Promise<void> => {
  await client.unsafe('SELECT pg_advisory_unlock($1)', [key]);
};

// ── Flag gate ────────────────────────────────────────────────────────────────

/**
 * Per-DJ `backend-mirror` flag evaluator, mirroring the live per-caller gate.
 *   - No PostHog client (POSTHOG_API_KEY unset) → enabled (dev/E2E convention).
 *   - No DJ to key on → enabled (a show that already has a tubafrenzy show but
 *     no `primary_dj_id` is a legacy/shadow show; heal it rather than guess a
 *     synthetic distinctId that a percentage rollout would mis-cohort).
 *   - Otherwise evaluate `isFeatureEnabled('backend-mirror', djId)`.
 */
export const makeFlagEvaluator =
  (client: PostHog | null) =>
  async (djId: string | null): Promise<boolean> => {
    if (client == null) return true;
    if (djId == null) return true;
    const enabled = await client.isFeatureEnabled('backend-mirror', djId);
    return enabled ?? false;
  };

// ── Cooperative pause ────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loop: probe the shared schema-aware `checkLiveActivity` → if a DJ is live,
 * sleep `pauseMs` → re-probe. Returns when quiet. Reuses the shared probe
 * (honors `WXYC_SCHEMA_NAME`) rather than a job-local copy.
 */
export const awaitQuietWindow = async (lookbackSeconds: number, pauseMs: number): Promise<void> => {
  while (await checkLiveActivity(lookbackSeconds)) {
    log('info', 'live_activity_pause', `live DJ activity within ${lookbackSeconds}s; deferring ${pauseMs}ms`, {
      lookback_seconds: lookbackSeconds,
      pause_ms: pauseMs,
    });
    await sleep(pauseMs);
  }
};

// ── Port wiring ──────────────────────────────────────────────────────────────

export const buildPorts = (client: PostHog | null, options: JobOptions): ReconcilePorts => ({
  selectShowsToCreate,
  selectEntrySweepShows,
  selectPartialShows,
  selectDj,
  selectOrphanEntries,
  persistLegacyShowId,
  persistLegacyEntryId,
  mirrorCreateShow,
  mirrorCreateEntry,
  mirrorSignoffShow,
  mapShowToTubafrenzy: (show, dj) => mapShowToTubafrenzy(show, dj),
  mapEntryToTubafrenzy: (entry, radioShowID, isRotationMatch) =>
    mapEntryToTubafrenzy(entry, radioShowID, isRotationMatch),
  isActiveRotationMatch: (entry) => isActiveRotationMatch(entry),
  isMirrorEnabledForDj: makeFlagEvaluator(client),
  awaitQuiet: () => awaitQuietWindow(options.liveActivityLookbackSeconds, options.liveActivityPauseMs),
  log,
  captureWarning,
});

// ── Entrypoint ────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  const options = resolveOptions();
  const posthog = process.env.POSTHOG_API_KEY
    ? new PostHog(process.env.POSTHOG_API_KEY, { host: 'https://us.i.posthog.com' })
    : null;
  // Dedicated single-purpose client that HOLDS the advisory lock for the whole
  // run (not the pooled `db`, whose other connections would break the
  // session-scoped lock's deterministic release).
  const lockClient = createPostgresClient({ max: 1, applicationName: 'wxyc-legacy-mirror-reconcile' });

  try {
    const locked = await acquireAdvisoryLock(lockClient, ADVISORY_LOCK_KEY);
    if (!locked) {
      log('info', 'lock_not_acquired', `${JOB_NAME}: another reconcile holds the advisory lock; exiting 0`);
      return;
    }

    log('info', 'started', `${JOB_NAME} starting`, {
      window_hours: options.windowHours,
      settle_minutes: options.settleMinutes,
      alert_threshold: options.alertThreshold,
      live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
      posthog_configured: posthog != null,
    });

    const totals = await runReconcile(buildPorts(posthog, options), options);
    log('info', 'finished', `${JOB_NAME} done`, { ...totals });

    await releaseAdvisoryLock(lockClient, ADVISORY_LOCK_KEY);
  } catch (err) {
    captureError(err, 'main');
    log('error', 'failed', `${JOB_NAME} failed: ${err instanceof Error ? err.message : String(err)}`, {
      error_message: err instanceof Error ? err.message : String(err),
      error_name: err instanceof Error ? err.name : null,
    });
    process.exitCode = 1;
  } finally {
    // Order matters (review Medium #4 + R2 Medium): posthog-node keeps flush
    // timers alive → shut it down first or the process hangs. Then release the
    // advisory lock by ending its dedicated client, then close the pooled DB,
    // then flush Sentry.
    if (posthog) await posthog.shutdown();
    await lockClient.end();
    await closeDatabaseConnection();
    await closeLogger();
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run against
// the mocked DB. Jest sets NODE_ENV='test'; production runs leave it
// 'production' (per Dockerfile) or unset, both of which execute main().
if (process.env.NODE_ENV !== 'test') {
  void main();
}
