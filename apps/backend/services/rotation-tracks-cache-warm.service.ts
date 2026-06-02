/**
 * One-shot warm pass for the rotation-tracks picker LRU caches in
 * `library.service.ts` (BS#987's `rotationLmlPositiveCache` +
 * `rotationLmlNegativeCache`).
 *
 * Why this lives in the API process and not in a `jobs/` package:
 *   The LRUs are process-local (`new LRUCache(...)` at module scope), so a
 *   sidecar one-shot job would warm its own copy and exit — useless for the
 *   long-lived API process that serves `GET /library/rotation/:id/tracks`.
 *   Tubafrenzy's `RotationTracklistCache.warmCache` does the equivalent on
 *   JVM boot.
 *
 * What gets warmed:
 *   For every active rotation row (`kill_date IS NULL OR kill_date >
 *   CURRENT_DATE` — the same predicate `getRotationFromDB` uses), the warmer
 *   calls `resolveRotationPickerSource` end-to-end so it goes through
 *   the same three-tier resolver real picker opens take. That means the
 *   warm walk shares the LML chokepoint with concurrent user traffic —
 *   `lookupSemaphore` (5 permits) and the rate-limit token bucket throttle
 *   it naturally, and the per-call 5 s budget from #993 caps tail latency.
 *   Rows resolved via tier 1 or tier 2 (DB lookup, no LML call) cost ~1 ms;
 *   rows that fall through to tier 3 spend a semaphore permit but populate
 *   either the positive or the negative LRU so the next picker open is
 *   instant.
 *
 * Fire-and-forget on app boot:
 *   We don't await the warm before `app.listen` resolves — health checks
 *   and live traffic should not pay startup latency for a best-effort
 *   optimization. A single row's failure is captured to Sentry and logged
 *   but does not stop the walk; the warm just continues with the next id.
 *   On process restart, the warmer re-runs (the LRU is in RAM); ~310 rows
 *   × ~few-second tail per LML call ≈ a few minutes of background traffic
 *   per restart, which is acceptable on a process that runs for days.
 *
 * Exported API:
 *   warmRotationTracksCache() — perform a single walk and return the
 *                               counters (used by `start...` and tests).
 *   startRotationTracksCacheWarm() — fire-and-forget kickoff; called once
 *                                   from `app.ts` post-`listen`.
 */
import * as Sentry from '@sentry/node';
import { sql } from 'drizzle-orm';
import {
  db,
  rotation,
  checkLiveActivity as defaultCheckLiveActivity,
  LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT,
  LIVE_ACTIVITY_PAUSE_MS_DEFAULT,
  type CheckLiveActivityFn,
} from '@wxyc/database';
import {
  resolveRotationPickerSource,
  __rotationLmlCacheSizesForWarm,
  getRotationTracksFromRelease,
  __releaseTracklistCacheSizesForWarm,
} from './library.service.js';

const LOG_PREFIX = '[rotation-tracks-cache-warm]';

/**
 * Log progress every N rows. 50 keeps the boot log readable for the prod
 * row count (~310) — about six progress lines plus a final summary.
 */
const PROGRESS_LOG_EVERY = 50;

/**
 * Hard wall-clock cap for the warm pass. Backstop against the LML-monopolization
 * pattern seen in BS#995 / BS#1011 / BS#1064 — if every row falls into a
 * 2-9 s cold-path, 310 rows × 20 s ≈ 100 min of background LML pressure. 30 min
 * keeps the warmer well under the saturation window observed in those
 * incidents; rows skipped by the budget get retried on the next process restart
 * and warm progressively across the deploy cadence.
 */
const WARM_PASS_BUDGET_MS = 30 * 60 * 1000;

/**
 * Per-row pause cap: any single rotation row can hold up the walker for
 * at most this long before we count it as `budgetSkipped` and move on.
 * Prevents a row whose probe-window never clears (long continuous show)
 * from consuming the entire wall-clock budget while later rows starve.
 * Companion to `WARM_PASS_BUDGET_MS` — both are escape hatches.
 */
const PER_ROW_PAUSE_BUDGET_MS = 10 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Warn-and-default on misconfig: boot must succeed even with a bad env var,
 * since the warmer is a best-effort optimization and the API needs to start
 * serving traffic. `0` disables the probe.
 */
const resolveLiveActivityLookback = (
  raw: string | undefined = process.env.WARM_LIVE_ACTIVITY_LOOKBACK_SECONDS
): number => {
  if (raw === undefined) return LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(
      `${LOG_PREFIX} invalid WARM_LIVE_ACTIVITY_LOOKBACK_SECONDS=${JSON.stringify(raw)}; using default ${LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT}`
    );
    return LIVE_ACTIVITY_LOOKBACK_SECONDS_DEFAULT;
  }
  return parsed;
};

export interface WarmCounters {
  /** Total rows walked. */
  scanned: number;
  /** Rows that resolved via tier 1 or 2 (no LML call). */
  preResolved: number;
  /** Rows that hit LML and got a release id (positive cache populated). */
  lmlPositive: number;
  /** Rows that hit LML and got nothing (negative cache populated). */
  lmlNegative: number;
  /** Rows where `resolveRotationPickerSource` threw. */
  errors: number;
  /** Release-fetch follow-ups that grew the release-tracklist positive LRU. */
  releaseFetchPositive: number;
  /** Release-fetch follow-ups that grew the release-tracklist negative LRU (LML 404). */
  releaseFetchNegative: number;
  /** Release-fetch follow-ups that found the release already cached cross-row. */
  releaseFetchAlreadyWarm: number;
  /** Release-fetch follow-ups that threw (5xx, network, parse). */
  releaseFetchErrors: number;
  /** Rows skipped after the wall-clock budget or per-row pause cap elapsed. */
  budgetSkipped: number;
  /** Number of times the walker yielded to live DJ activity (per-row, may repeat for the same row). */
  liveActivityPauseCount: number;
  /** Cumulative wall-clock time spent paused for live DJ activity, ms. */
  liveActivityPauseMs: number;
  /** Wall-clock duration of the walk in ms. */
  elapsedMs: number;
}

/**
 * Options for `warmRotationTracksCache` — exists so tests can inject the
 * `checkLiveActivity` probe + a 0 `pauseMs` to skip the real-time `setTimeout`.
 */
export interface WarmOptions {
  checkLiveActivity?: CheckLiveActivityFn;
  liveActivityLookbackSeconds?: number;
  liveActivityPauseMs?: number;
}

/**
 * Walk every active rotation row, calling `resolveRotationPickerSource`
 * for each so the per-`rotation_id` LRUs in `library.service.ts` are populated.
 *
 * Sequential by design — `resolveRotationPickerSource` itself acquires
 * the `lookupSemaphore` permit when it falls through to LML, so the upper
 * bound on outstanding LML calls remains 5. Driving extra concurrency here
 * would only deepen the semaphore queue without raising throughput, while
 * stealing fairness from concurrent user requests.
 *
 * The before/after delta of the positive + negative LRU sizes (read via the
 * test-only sizes accessor) reconstructs the LML-positive vs LML-negative
 * tally without coupling this service to the LRU internals or requiring a
 * second pass.
 */
export async function warmRotationTracksCache(opts: WarmOptions = {}): Promise<WarmCounters> {
  const startTime = Date.now();
  const startSizes = __rotationLmlCacheSizesForWarm();
  const probe = opts.checkLiveActivity ?? defaultCheckLiveActivity;
  const lookbackSeconds = opts.liveActivityLookbackSeconds ?? resolveLiveActivityLookback();
  const pauseMs = opts.liveActivityPauseMs ?? LIVE_ACTIVITY_PAUSE_MS_DEFAULT;

  const rows = await db
    .select({ id: rotation.id })
    .from(rotation)
    .where(sql`${rotation.kill_date} > CURRENT_DATE OR ${rotation.kill_date} IS NULL`);

  const counters: WarmCounters = {
    scanned: 0,
    preResolved: 0,
    lmlPositive: 0,
    lmlNegative: 0,
    errors: 0,
    releaseFetchPositive: 0,
    releaseFetchNegative: 0,
    releaseFetchAlreadyWarm: 0,
    releaseFetchErrors: 0,
    budgetSkipped: 0,
    liveActivityPauseCount: 0,
    liveActivityPauseMs: 0,
    elapsedMs: 0,
  };

  console.log(`${LOG_PREFIX} starting walk over ${rows.length} active rotation row(s)`);

  for (const row of rows) {
    const rotationId = row.id as unknown as number;

    if (Date.now() - startTime > WARM_PASS_BUDGET_MS) {
      counters.budgetSkipped += 1;
      continue;
    }

    // Cooperative pause: yield while a DJ is active so the walker stops
    // competing for LML semaphore slots during the picker UX-critical window.
    // Two escape hatches — global `WARM_PASS_BUDGET_MS` and `PER_ROW_PAUSE_BUDGET_MS`
    // — both route over-budget rows to `budgetSkipped + continue` so we DON'T
    // fire LML right after confirming a DJ is active (which would defeat the pause).
    let pauseExceededBudget = false;
    if (lookbackSeconds > 0) {
      const pauseLoopStart = Date.now();
      while (await probe(lookbackSeconds)) {
        if (Date.now() - startTime > WARM_PASS_BUDGET_MS || Date.now() - pauseLoopStart > PER_ROW_PAUSE_BUDGET_MS) {
          pauseExceededBudget = true;
          break;
        }
        counters.liveActivityPauseCount += 1;
        console.log(
          `${LOG_PREFIX} live_activity_pause: deferring rotation_id=${rotationId} for ${pauseMs}ms (lookback=${lookbackSeconds}s)`
        );
        const pauseStart = Date.now();
        if (pauseMs > 0) await sleep(pauseMs);
        counters.liveActivityPauseMs += Date.now() - pauseStart;
      }
    }
    if (pauseExceededBudget) {
      counters.budgetSkipped += 1;
      continue;
    }

    counters.scanned += 1;

    let result: Awaited<ReturnType<typeof resolveRotationPickerSource>> = null;
    try {
      const beforeSizes = __rotationLmlCacheSizesForWarm();
      result = await resolveRotationPickerSource(rotationId);
      const afterSizes = __rotationLmlCacheSizesForWarm();

      // Per-row LRU-delta classifier: if a positive entry was added during
      // this iteration the row was a fresh tier-3 hit; same for negative.
      // No size change means the row resolved via tier 1 or tier 2 (or hit
      // a previously-cached LML result, which only happens on a duplicate
      // rotation_id — impossible from this query but cheap to handle as
      // "pre-resolved" since we did no LML work).
      if (afterSizes.positive > beforeSizes.positive) {
        counters.lmlPositive += 1;
      } else if (afterSizes.negative > beforeSizes.negative) {
        counters.lmlNegative += 1;
      } else if (result !== null) {
        counters.preResolved += 1;
      } else {
        // Null with no LRU growth: tier 1+2 missed and LML was either
        // unconfigured, returned the same negative we'd already cached, or
        // declined the row due to NULL artist_name/album_title. None of
        // these populate either LRU, so we fold them into preResolved for
        // the summary (the picker won't pay an LML round-trip on next open
        // either way — it'll degrade to free-text immediately).
        counters.preResolved += 1;
      }
    } catch (err) {
      counters.errors += 1;
      Sentry.captureException(err, {
        tags: { subsystem: 'rotation-tracks-cache-warm' },
        extra: { rotation_id: rotationId },
      });
      console.warn(`${LOG_PREFIX} row ${rotationId} failed: ${(err as Error).message}`);
    }

    // Mirror the picker controller's fall-through: getRotationTracksFromRelease
    // iff inlineTracklist is null.
    if (result && result.releaseId !== null && result.inlineTracklist === null) {
      try {
        const beforeReleaseSizes = __releaseTracklistCacheSizesForWarm();
        await getRotationTracksFromRelease(result.releaseId);
        const afterReleaseSizes = __releaseTracklistCacheSizesForWarm();
        if (afterReleaseSizes.positive > beforeReleaseSizes.positive) {
          counters.releaseFetchPositive += 1;
        } else if (afterReleaseSizes.negative > beforeReleaseSizes.negative) {
          counters.releaseFetchNegative += 1;
        } else {
          counters.releaseFetchAlreadyWarm += 1;
        }
      } catch (err) {
        counters.releaseFetchErrors += 1;
        Sentry.captureException(err, {
          tags: { subsystem: 'rotation-tracks-cache-warm', phase: 'release_fetch' },
          extra: { rotation_id: rotationId, release_id: result.releaseId },
        });
        console.warn(
          `${LOG_PREFIX} row ${rotationId} release_fetch (release_id=${result.releaseId}) failed: ${(err as Error).message}`
        );
      }
    }

    if (counters.scanned % PROGRESS_LOG_EVERY === 0) {
      console.log(
        `${LOG_PREFIX} progress: scanned=${counters.scanned}/${rows.length} ` +
          `preResolved=${counters.preResolved} lmlPositive=${counters.lmlPositive} ` +
          `lmlNegative=${counters.lmlNegative} ` +
          `releaseFetchPositive=${counters.releaseFetchPositive} ` +
          `releaseFetchNegative=${counters.releaseFetchNegative} ` +
          `releaseFetchAlreadyWarm=${counters.releaseFetchAlreadyWarm} ` +
          `errors=${counters.errors} releaseFetchErrors=${counters.releaseFetchErrors}`
      );
    }
  }

  counters.elapsedMs = Date.now() - startTime;

  console.log(
    `${LOG_PREFIX} done: scanned=${counters.scanned} preResolved=${counters.preResolved} ` +
      `lmlPositive=${counters.lmlPositive} lmlNegative=${counters.lmlNegative} ` +
      `releaseFetchPositive=${counters.releaseFetchPositive} ` +
      `releaseFetchNegative=${counters.releaseFetchNegative} ` +
      `releaseFetchAlreadyWarm=${counters.releaseFetchAlreadyWarm} ` +
      `budgetSkipped=${counters.budgetSkipped} ` +
      `liveActivityPauseCount=${counters.liveActivityPauseCount} ` +
      `liveActivityPauseMs=${counters.liveActivityPauseMs} ` +
      `errors=${counters.errors} releaseFetchErrors=${counters.releaseFetchErrors} ` +
      `elapsedMs=${counters.elapsedMs} ` +
      `(starting cache sizes positive=${startSizes.positive} negative=${startSizes.negative})`
  );

  return counters;
}

/**
 * Fire-and-forget kickoff for app boot. Returns immediately; the walk runs
 * in the background. A top-level walk failure (DB outage, for instance) is
 * captured to Sentry and logged — boot should not depend on the walk
 * succeeding.
 */
export function startRotationTracksCacheWarm(): void {
  void warmRotationTracksCache().catch((err) => {
    Sentry.captureException(err, {
      tags: { subsystem: 'rotation-tracks-cache-warm' },
    });
    console.error(`${LOG_PREFIX} walk aborted:`, err);
  });
}
