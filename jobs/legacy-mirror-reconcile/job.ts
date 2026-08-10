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
 * The run also carries a read-only third arm (BS#2065): the stale-open-show
 * detector, which reports shows still holding `end_time IS NULL` past a
 * plausible show duration — the residue of a dropped INBOUND tubafrenzy
 * `show_end` webhook delivery. It rides this job rather than a new cron
 * because both mechanisms are tubafrenzy-lifetime: they are retired together
 * at Phase 6a, so neither leaves standing machinery behind. See
 * `STALE_OPEN_SHOW_HOURS_DEFAULT` below for the threshold's derivation and
 * `runStaleOpenShowReport` in `orchestrate.ts` for what it does NOT do (it
 * never repairs — #1543's final-dump pass owns that).
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
  countHistoricalOpenShows,
  persistLegacyEntryId,
  persistLegacyShowId,
  runReconcile,
  selectDj,
  selectEntrySweepShows,
  selectOrphanEntries,
  selectPartialShows,
  selectShowsToCreate,
  selectStaleOpenShows,
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
 * Arbitrary but stable. This is not the only advisory lock in the codebase:
 * `apps/backend/routes/internal-slack-moderators.route.ts` takes
 * `SLACK_MODERATORS_ADVISORY_LOCK_KEY` (BS#2045). Single-bigint
 * `pg_try_advisory_lock` and `pg_advisory_xact_lock` share one lock space
 * database-wide, so any new key must be checked against both.
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

/**
 * BS#2065 stale-open-show detector: hours a show may hold `end_time IS NULL`
 * before the run reports it.
 *
 * DERIVED, NOT GUESSED. Measured on prod `wxyc_schema.shows` on 2026-08-09
 * over the 3,477 shows completed in the trailing 365 days
 * (`end_time IS NOT NULL AND end_time > start_time`):
 *
 *   p50 2.02h · p95 3.10h · p99 5.93h · p99.9 14.12h · max 19.03h
 *   >6h: 33 (0.95%) · >8h: 19 · >10h: 10 · >12h: 5 (0.14%) · >24h: 0
 *
 * 12h sits at ~2x p99 and above 99.86% of real completed shows, so a show
 * still open at 12h is far outside the normal duration envelope — while
 * staying under the 19h observed maximum matters less than it looks, because
 * the threshold is not the only guard: `selectStaleOpenShows` also excludes
 * the show `getLatestShow()` calls current AND any show with flowsheet
 * activity since the same cutoff. An overnight or special-programming block
 * that genuinely runs past 12h is still logging tracks and is still the newest
 * show, so it is excluded twice over. The threshold's real job is to let the
 * routine sign-off/go-live handoff settle before a non-current open show is
 * called stale.
 *
 * The same query found the current open-show population: 2,814 rows with
 * `end_time IS NULL`, of which exactly 1 was under 6h old (the live show) and
 * 2,813 were over 30 days old — the #1543 repair cohort, held out of the
 * report by `RECONCILE_WINDOW_HOURS` and counted instead. Nothing sat between
 * 6h and 30 days, so the detector starts from a clean in-window baseline.
 *
 * BS#2068 correction: the "excluded twice over" reasoning two paragraphs up is
 * about a GENUINELY live show (still logging tracks, so its newest entry is a
 * track, not a marker) and remains true after that fix. But do not read "is
 * still the newest show" there as implying the id-based exclusion in
 * `selectStaleOpenShows` is unconditional — it no longer is. That bound used
 * to veto reporting for ANY show holding `max(id)`, including one whose
 * sign-off marker had already landed with `end_time` never stamped — the
 * exact dropped-webhook residue this detector exists to catch — so a show
 * that never stopped being `max(id)` could sit in the reportable band for its
 * entire life and never be reported, aging silently into the historical
 * cohort instead. The bound is now conditioned on the newest flowsheet entry
 * NOT being a `show_end` marker (see `orchestrate.ts`), which is why a
 * genuinely-live show is still excluded (its newest entry is never a marker)
 * while the dropped-delivery case is not.
 */
export const STALE_OPEN_SHOW_HOURS_ENV = 'STALE_OPEN_SHOW_HOURS';
export const STALE_OPEN_SHOW_HOURS_DEFAULT = 12;

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
    staleAfterHours: requirePositiveInt(
      env[STALE_OPEN_SHOW_HOURS_ENV],
      STALE_OPEN_SHOW_HOURS_ENV,
      STALE_OPEN_SHOW_HOURS_DEFAULT,
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
  selectStaleOpenShows,
  countHistoricalOpenShows,
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

/**
 * Run one best-effort shutdown step in isolation. A rejection is logged and
 * swallowed so a single failing step (e.g. `posthog.shutdown()` hanging on a
 * dead flush socket) can't skip the remaining teardown — most importantly the
 * Sentry flush in `closeLogger`, which must always run so a failed run is
 * actually reported (BS#1707 review).
 */
const runShutdownStep = async (label: string, step: () => Promise<unknown>): Promise<void> => {
  try {
    await step();
  } catch (e) {
    console.error(`[${JOB_NAME}] shutdown step '${label}' failed:`, e);
  }
};

const main = async (): Promise<void> => {
  initLogger({ repo: 'Backend-Service', tool: JOB_NAME });

  const options = resolveOptions();
  const posthog = process.env.POSTHOG_API_KEY
    ? new PostHog(process.env.POSTHOG_API_KEY, { host: 'https://us.i.posthog.com' })
    : null;
  // Dedicated single-purpose client that HOLDS the advisory lock for the whole
  // run (not the pooled `db`, whose other connections would break the
  // session-scoped lock's deterministic release). `maxLifetimeSeconds: 0`
  // disables postgres-js's idle-connection recycling (default: a random
  // 30–60 min): the lock connection sits idle through the cooperative pause
  // and a slow sweep, and a mid-run recycle would silently drop the advisory
  // lock — defeating the single-flight guard exactly on a long run, the case
  // it exists to cover.
  const lockClient = createPostgresClient({
    max: 1,
    maxLifetimeSeconds: 0,
    applicationName: 'wxyc-legacy-mirror-reconcile',
  });
  let locked = false;

  try {
    locked = await acquireAdvisoryLock(lockClient, ADVISORY_LOCK_KEY);
    if (!locked) {
      log('info', 'lock_not_acquired', `${JOB_NAME}: another reconcile holds the advisory lock; exiting 0`);
      return;
    }

    log('info', 'started', `${JOB_NAME} starting`, {
      window_hours: options.windowHours,
      settle_minutes: options.settleMinutes,
      alert_threshold: options.alertThreshold,
      stale_after_hours: options.staleAfterHours,
      live_activity_lookback_seconds: options.liveActivityLookbackSeconds,
      posthog_configured: posthog != null,
    });

    const totals = await runReconcile(buildPorts(posthog, options), options);
    log('info', 'finished', `${JOB_NAME} done`, { ...totals });
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
    // advisory lock (explicit unlock when we hold it, then end its dedicated
    // client — end() also drops the session lock, so the explicit call is
    // belt-and-suspenders), then close the pooled DB, then flush Sentry
    // (closeLogger). Releasing in `finally` rather than the try body means a
    // failed unlock round-trip can't mask the run's result (it used to throw
    // and flip a clean run to exitCode 1) or skip later teardown — each step
    // is isolated via runShutdownStep so one rejection can't skip the rest,
    // and the Sentry flush must always run.
    if (posthog) await runShutdownStep('posthog', () => posthog.shutdown());
    if (locked) {
      await runShutdownStep('advisory-unlock', () => releaseAdvisoryLock(lockClient, ADVISORY_LOCK_KEY));
    }
    await runShutdownStep('advisory-lock-client', () => lockClient.end());
    await runShutdownStep('database', () => closeDatabaseConnection());
    await runShutdownStep('logger', () => closeLogger());
  }
};

// Guard the auto-invoke so jest's module load doesn't fire a stray run against
// the mocked DB. Jest sets NODE_ENV='test'; production runs leave it
// 'production' (per Dockerfile) or unset, both of which execute main().
if (process.env.NODE_ENV !== 'test') {
  void main();
}
