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
import { db, rotation } from '@wxyc/database';
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
  /** Rows skipped after the wall-clock budget elapsed. */
  budgetSkipped: number;
  /** Wall-clock duration of the walk in ms. */
  elapsedMs: number;
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
export async function warmRotationTracksCache(): Promise<WarmCounters> {
  const startTime = Date.now();
  const startSizes = __rotationLmlCacheSizesForWarm();

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
    elapsedMs: 0,
  };

  console.log(`${LOG_PREFIX} starting walk over ${rows.length} active rotation row(s)`);

  for (const row of rows) {
    const rotationId = row.id as unknown as number;

    if (Date.now() - startTime > WARM_PASS_BUDGET_MS) {
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
