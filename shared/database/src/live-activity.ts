/**
 * Probe `flowsheet` for any track row inserted within the lookback window
 * — `true` while a DJ is actively adding tracks. Backed by migration 0050's
 * partial index `flowsheet_track_add_time_idx ON (add_time DESC) WHERE
 * entry_type='track'` for an index-only single-leaf-page read. The literal
 * `'track'` predicate is what lets the planner match the partial index;
 * keep it inline rather than parameterised.
 *
 * This module is also the shared home (BS#2147) for the cooperative-pause
 * *loop* itself — `buildWaitForQuietPeriod` — and its env resolvers.
 * BS#1241 extracted the probe here but left every job holding its own
 * hand-rolled re-probe loop; that duplication is what let
 * `LIVE_ACTIVITY_PAUSE_MS=0` degrade into an unthrottled hot loop against
 * RDS in ten of them (`0` doesn't disable the pause — it deletes the sleep
 * between re-probes) while an eleventh silently disagreed by treating `0`
 * as a real disable. See the resolver and helper docs below for the fix.
 */
import { sql } from 'drizzle-orm';
import { db } from './client.js';
import { requireNonNegativeInt } from './env-parsers.js';

export const LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT = 60;
export const LIVE_ACTIVITY_PAUSE_MS_DEFAULT = 30_000;

/**
 * Floor for `LIVE_ACTIVITY_PAUSE_MS` (BS#2147). `0` is only the most
 * *reachable* point of a continuous interval of bad values — `PAUSE_MS=1`
 * hot-loops exactly the same way, bounded only by RDS round-trip latency,
 * since the loop's only delay IS the sleep this floor exists to protect.
 * Every value below the floor is rejected at resolve time rather than
 * silently misbehaving. `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` remains the one
 * and only disable knob.
 */
export const LIVE_ACTIVITY_MIN_PAUSE_MS = 1_000;

/**
 * Cumulative-pause-budget ceiling (BS#1636 / BS#2147), value-independent of
 * whatever `pauseMs` holds: `buildWaitForQuietPeriod` accrues measured
 * wall-clock from the TOP of each loop iteration (probe round-trip
 * included, not just the sleep), so even an injected sub-floor `pauseMs`
 * — the only way to reach one now that `resolveLiveActivityPauseMs` floors
 * the env path — stays bounded by real elapsed time. Ported from
 * `jobs/rotation-release-id-pollution-check/job.py`'s `make_pause_probe`.
 * `0` opts out (uncapped): keep it non-zero in production, since under a
 * genuinely sustained live show the loop then pauses for as long as DJs
 * keep adding tracks.
 */
export const LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT = 1_800_000;
export const LIVE_ACTIVITY_MAX_PAUSE_MS_ENV = 'LIVE_ACTIVITY_MAX_PAUSE_MS';

export type CheckLiveActivityFn = (lookbackSeconds: number) => Promise<boolean>;

const SCHEMA = (process.env.WXYC_SCHEMA_NAME || 'wxyc_schema').replace(/"/g, '""');
const FLOWSHEET_TABLE = sql.raw(`"${SCHEMA}"."flowsheet"`);

export const checkLiveActivity: CheckLiveActivityFn = async (lookbackSeconds) => {
  if (lookbackSeconds <= 0) return false;
  const rows = (await db.execute(sql`
    SELECT 1
    FROM ${FLOWSHEET_TABLE}
    WHERE "entry_type" = 'track'
      AND "add_time" > now() - (interval '1 second' * ${lookbackSeconds})
    LIMIT 1
  `)) as unknown as Array<unknown>;
  return rows.length > 0;
};

/**
 * Shared env resolver for `LIVE_ACTIVITY_PAUSE_MS` (BS#2147). Delegates to
 * `requireNonNegativeInt` for the integer/format checks, then enforces
 * `LIVE_ACTIVITY_MIN_PAUSE_MS` as a second, named-error gate. A bare
 * `requirePositiveInt` swap (rejecting only `0`) would leave the hot-loop
 * defect reachable at `PAUSE_MS=1` — the floor closes the whole bad
 * interval, not just its most common value. `envName` is threaded through
 * so a caller reusing this resolver under a differently-named env var (e.g.
 * a job-scoped fork) still gets that var's own name in the error.
 */
export const resolveLiveActivityPauseMs = (
  raw: string | undefined,
  envName: string = 'LIVE_ACTIVITY_PAUSE_MS'
): number => {
  const resolved = requireNonNegativeInt(raw, envName, LIVE_ACTIVITY_PAUSE_MS_DEFAULT, { unit: 'ms' });
  if (resolved < LIVE_ACTIVITY_MIN_PAUSE_MS) {
    throw new Error(
      `Invalid ${envName}=${JSON.stringify(raw)}: must be >= ${LIVE_ACTIVITY_MIN_PAUSE_MS} (ms), or unset for the ` +
        `${LIVE_ACTIVITY_PAUSE_MS_DEFAULT}ms default. A value below the floor turns the cooperative-pause re-probe ` +
        'loop into a hot loop against the database instead of disabling it — use LIVE_ACTIVITY_LOOKBACK_SECONDS=0 ' +
        'to disable the pause.'
    );
  }
  return resolved;
};

/** Shared env resolver for `LIVE_ACTIVITY_MAX_PAUSE_MS` (BS#2147/BS#1636). `0` = uncapped. */
export const resolveLiveActivityMaxPauseMs = (
  raw: string | undefined,
  envName: string = LIVE_ACTIVITY_MAX_PAUSE_MS_ENV
): number =>
  requireNonNegativeInt(raw, envName, LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT, {
    unit: 'ms',
    note: 'Cumulative pause budget for one waitForQuietPeriod call chain. 0 = uncapped; keep non-zero in production.',
  });

/**
 * Thrown by `buildWaitForQuietPeriod`'s returned closure (BS#2147 review
 * round 2, findings 1+2) once cumulative pause time reaches
 * `maxTotalPauseMs`. The first cut of this ceiling made exhaustion a
 * sticky, silent "give up and proceed at full speed" flag: a long show
 * exhausted the 30-minute default mid-run and the pause switched off
 * permanently — for the rest of that run — while DJs were still live,
 * which is the exact outcome `maxTotalPauseMs` exists to prevent. This
 * module already has the correct outcome for a ceiling of this shape, in
 * `jobs/flowsheet-metadata-backfill/lml-health.ts`'s
 * `BreakerPauseCeilingExceededError`: a wedged pause must be loud, not a
 * silent throughput cliff. `onBudgetExhausted` fires with the accrued
 * `pausedMs` FIRST — so a caller can log/capture its own context (resume
 * cursors, batch state) before the stack unwinds — and only then does this
 * throw, uncaught, out of the closure. Every existing caller already has a
 * top-level catch for programming errors (structured log + Sentry capture +
 * non-zero exit); this reuses that path rather than inventing a second one.
 */
export class LiveActivityPauseCeilingExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveActivityPauseCeilingExceededError';
  }
}

export interface WaitForQuietPeriodPauseInfo {
  lookbackSeconds: number;
  pauseMs: number;
  /** Cumulative pause time accrued so far in THIS call chain, before this iteration's sleep. */
  pausedMs: number;
}

export interface WaitForQuietPeriodOptions {
  lookbackSeconds: number;
  pauseMs: number;
  /** Defaults to the shared `checkLiveActivity`. */
  probe?: CheckLiveActivityFn;
  /** Defaults to `() => false` (no cooperative-stop awareness). */
  shouldStop?: () => boolean;
  onPause?: (info: WaitForQuietPeriodPauseInfo) => void;
  /** Fail-open: fired on a probe throw, which the loop then treats as "no activity" for that iteration. */
  onProbeError?: (err: unknown) => void;
  onBudgetExhausted?: (pausedMs: number) => void;
  /** Cumulative-pause-budget ceiling; 0 = uncapped. Defaults to `LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT`. */
  maxTotalPauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Stop-aware default sleep: ticks in `min(500, remaining)` slices via
 * real timers and bails early on `shouldStop()`, so a SIGTERM-aware caller
 * responds within one tick instead of riding out the full pause. `ms <= 0`
 * returns immediately without scheduling a timer at all — an explicit
 * guard rather than an artifact of the loop condition happening to be
 * false on first check, so the behavior doesn't depend on the floor making
 * that value unreachable via env.
 */
const buildDefaultSleep = (shouldStop: () => boolean): ((ms: number) => Promise<void>) => {
  return async (ms: number): Promise<void> => {
    if (ms <= 0) return;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (shouldStop()) return;
      const remaining = deadline - Date.now();
      const tick = Math.min(500, remaining);
      await new Promise<void>((resolve) => setTimeout(resolve, tick));
    }
  };
};

/**
 * Build a cooperative-pause `waitForQuietPeriod` closure (BS#2147).
 * Consolidates the ten independent copies of this loop (BS#1241's
 * unfinished half) into one shared shape with two guards a hand-rolled
 * per-job copy can't skip:
 *
 *   1. `resolveLiveActivityPauseMs` floors `pauseMs` at init, so the env
 *      path can no longer reach a sub-floor value.
 *   2. Even so, an injected `pauseMs` (tests, or a caller that bypasses the
 *      resolver) is bounded by `maxTotalPauseMs` — cumulative wall-clock
 *      measured from the TOP of each iteration (probe round-trip
 *      included), ported from
 *      `jobs/rotation-release-id-pollution-check/job.py`'s
 *      `make_pause_probe`. On exhaustion, `onBudgetExhausted` fires with
 *      the accrued `pausedMs`, then the closure throws
 *      `LiveActivityPauseCeilingExceededError` (review round 2, findings
 *      1+2) — there is no sticky "give up and proceed" state; a caller that
 *      invokes the closure again after it threw gets the same loud failure,
 *      not a quiet fallback to full-speed.
 *
 * Returns `true` iff the caller should stop (per `shouldStop`), matching
 * the existing shape-A jobs' `Promise<boolean>` contract — callers that
 * don't track a stop flag can ignore the return value. `lookbackSeconds <=
 * 0` short-circuits to `false` without probing, exactly as every existing
 * copy does — `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` remains the sole disable
 * knob.
 *
 * The probe is always fail-open: a throw is swallowed and treated as "no
 * activity" for that iteration (reported via `onProbeError`, if provided).
 * This is a deliberate behavior change for the callers that previously let
 * a probe throw escape and abort the run — see the BS#2147 PR description.
 */
export const buildWaitForQuietPeriod = (opts: WaitForQuietPeriodOptions): (() => Promise<boolean>) => {
  const {
    lookbackSeconds,
    pauseMs,
    probe = checkLiveActivity,
    shouldStop = () => false,
    onPause,
    onProbeError,
    onBudgetExhausted,
    maxTotalPauseMs = LIVE_ACTIVITY_MAX_PAUSE_MS_DEFAULT,
    sleep = buildDefaultSleep(shouldStop),
    // BS#2147 review round 2, finding 8: `performance.now()` is Node's
    // monotonic clock. `Date.now()` can step backward (NTP correction) or
    // forward (clock slew) mid-run; either one corrupts `pausedMs` accrual
    // below. `buildDefaultSleep` deliberately keeps `Date.now()` — it only
    // computes a real-timer deadline, which is wall-clock by nature and
    // pre-existing behavior this fix doesn't touch. Wrapped in an arrow
    // (not `now = performance.now` directly) because destructuring the
    // bare method off its object loses the `this` binding `Performance`'s
    // native implementation requires.
    now = () => performance.now(),
  } = opts;

  let pausedMs = 0;

  const safeProbe = async (): Promise<boolean> => {
    try {
      return await probe(lookbackSeconds);
    } catch (err) {
      onProbeError?.(err);
      return false;
    }
  };

  return async (): Promise<boolean> => {
    if (lookbackSeconds <= 0) return false;

    while (true) {
      const loopStart = now();
      const active = await safeProbe();
      if (!active) return shouldStop();
      if (shouldStop()) return true;

      if (maxTotalPauseMs > 0 && pausedMs >= maxTotalPauseMs) {
        // BS#2147 review round 2, findings 1+2: fire the context hook FIRST,
        // then throw. There is no sticky "exhausted" flag to swallow later
        // calls into silent full-speed proceeding — see the class doc above.
        onBudgetExhausted?.(pausedMs);
        throw new LiveActivityPauseCeilingExceededError(
          `Cooperative-pause budget exceeded: paused ${pausedMs}ms against a ${maxTotalPauseMs}ms ceiling ` +
            '(LIVE_ACTIVITY_MAX_PAUSE_MS); aborting instead of pausing indefinitely while DJs remain active.'
        );
      }

      onPause?.({ lookbackSeconds, pauseMs, pausedMs });
      await sleep(pauseMs);
      pausedMs += now() - loopStart;
    }
  };
};
