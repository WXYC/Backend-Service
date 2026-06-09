/**
 * Orchestrator for jobs/rotation-artist-backfill (BS#1361).
 *
 * Two-tier loop:
 *
 *   1. For each rotation release id (loaded by `loadReleaseIds`), call
 *      LML's `/api/v1/discogs/release/{id}` and project the Phase-1
 *      artist id set out of `release.artists` + `release.artist_id`.
 *   2. For each artist id, call LML's `/api/v1/discogs/artist/{id}`.
 *
 * Both endpoints route through LML's fallthrough seam (LML#503: stub rows
 * with `fetched_at IS NULL` are treated as cache misses; LML#510: 404
 * responses tombstone the row server-side). So a re-run after this cron
 * lands is steady-state PG hits.
 *
 * dryRun: the release fan-out still runs (we need it to enumerate artist
 * ids) but the artist tier is skipped. `artists_planned` is populated
 * either way, and the totals Sentry span fires in both modes.
 *
 * Idempotency:
 *   - The same release id appearing twice (across re-runs, or in the same
 *     run via different rotation rows) is deduped by `loadReleaseIds`
 *     (DISTINCT) before we get here.
 *   - The same artist id surfacing on multiple releases in one run is
 *     deduped by a Set so we don't re-fetch within a single run.
 *   - Across runs, dedup is free: every successful or 404'd artist call
 *     now produces a non-null `fetched_at` in LML's PG cache, so a
 *     re-run sees PG hits with no API egress.
 *
 * Concurrency:
 *   - Caller-supplied; defaults to 3. We don't gate egress here on the
 *     runtime side — the `lml-limiter` Semaphore caps in-flight LML
 *     calls (and `TokenBucket` caps attempted-call rate) regardless of
 *     how many promises we kick off from this layer. The local
 *     `Semaphore` here bounds the number of *materialized* pending
 *     promises so a 10k-rotation set doesn't pile up Promise objects
 *     and so the same primitive used inside the limiter handles
 *     orphan-on-throw cancellation: if a task throws, sibling tasks
 *     finish their current `await` and then exit the loop instead of
 *     continuing forever.
 */

import * as Sentry from '@sentry/node';
import { Semaphore } from '@wxyc/lml-client';

import { extractPhase1ArtistIds, fetchArtist, fetchRelease, type FetchOutcome } from './lml-fetch.js';
import { log } from './logger.js';

export type Totals = {
  releases_scanned: number;
  releases_ok: number;
  releases_not_found: number;
  releases_error: number;
  artists_planned: number;
  artists_attempted: number;
  artists_ok: number;
  artists_not_found: number;
  artists_error: number;
};

const initialTotals = (): Totals => ({
  releases_scanned: 0,
  releases_ok: 0,
  releases_not_found: 0,
  releases_error: 0,
  artists_planned: 0,
  artists_attempted: 0,
  artists_ok: 0,
  artists_not_found: 0,
  artists_error: 0,
});

export type RunBackfillDeps = {
  loadReleaseIds: () => Promise<number[]>;
  fetchReleaseFn?: typeof fetchRelease;
  fetchArtistFn?: typeof fetchArtist;
  concurrency?: number;
  dryRun?: boolean;
};

export type RunResult = { totals: Totals };

/**
 * Map `items` through `run` with at most `limit` in-flight at any moment.
 *
 * Uses `Promise.allSettled` so one task throwing does NOT cause sibling
 * tasks to be orphaned mid-flight: if a callback throws, the other
 * tasks still drain to completion (releasing their semaphore permits)
 * and the wrapper rethrows the first failure once everything is done.
 * Without this, a `Promise.all([w1, w2, w3])` rejection on w2 would
 * leave w1/w3 mid-`await` and their LML responses unobserved — wasting
 * rate-limit budget and risking writes after the caller has moved on.
 */
const runWithConcurrency = async <T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> => {
  if (limit < 1) throw new Error(`concurrency must be >= 1, got ${limit}`);
  if (items.length === 0) return;
  const sem = new Semaphore(Math.min(limit, items.length));
  const tasks = items.map(async (item) => {
    await sem.acquire();
    try {
      await run(item);
    } finally {
      sem.release();
    }
  });
  const settled = await Promise.allSettled(tasks);
  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    }
  }
};

const tally = <T>(totals: Totals, phase: 'releases' | 'artists', outcome: FetchOutcome<T>): void => {
  if (phase === 'releases') {
    totals.releases_scanned += 1;
    if (outcome.kind === 'ok') totals.releases_ok += 1;
    else if (outcome.kind === 'not_found') totals.releases_not_found += 1;
    else totals.releases_error += 1;
  } else {
    totals.artists_attempted += 1;
    if (outcome.kind === 'ok') totals.artists_ok += 1;
    else if (outcome.kind === 'not_found') totals.artists_not_found += 1;
    else totals.artists_error += 1;
  }
};

/**
 * Project the run totals onto a Sentry span with numeric attributes set
 * at creation time (per the BS#1081 convention — late `setAttribute`
 * calls index numbers as strings and break sum/avg/p95 aggregation).
 * Fires on every code path including dryRun so a dry invocation produces
 * the same observability surface as a real one.
 */
const projectTotalsSpan = (totals: Totals, dryRun: boolean): void => {
  Sentry.startSpan(
    {
      name: 'rotation-artist-backfill.totals',
      op: 'job.tally',
      attributes: {
        'backfill.dry_run': dryRun ? 1 : 0,
        'backfill.releases_scanned': totals.releases_scanned,
        'backfill.releases_ok': totals.releases_ok,
        'backfill.releases_not_found': totals.releases_not_found,
        'backfill.releases_error': totals.releases_error,
        'backfill.artists_planned': totals.artists_planned,
        'backfill.artists_attempted': totals.artists_attempted,
        'backfill.artists_ok': totals.artists_ok,
        'backfill.artists_not_found': totals.artists_not_found,
        'backfill.artists_error': totals.artists_error,
      },
    },
    () => {
      /* observability-only span; attributes set at creation */
    }
  );
};

export const runBackfill = async (deps: RunBackfillDeps): Promise<RunResult> => {
  const fetchReleaseFn = deps.fetchReleaseFn ?? fetchRelease;
  const fetchArtistFn = deps.fetchArtistFn ?? fetchArtist;
  const concurrency = deps.concurrency ?? 3;
  const dryRun = deps.dryRun ?? false;
  const totals = initialTotals();

  const releaseIds = await deps.loadReleaseIds();
  log('info', 'plan', `loaded ${releaseIds.length} active rotation release ids`, {
    release_count: releaseIds.length,
    concurrency,
    dry_run: dryRun,
  });

  // Phase 1 of the two-tier loop: fan out the release fetches. Each
  // release result feeds an artist-id set into the second tier; dedup
  // is global across the run.
  const seenArtistIds = new Set<number>();

  await runWithConcurrency(releaseIds, concurrency, async (releaseId) => {
    const outcome = await fetchReleaseFn(releaseId);
    tally(totals, 'releases', outcome);
    if (outcome.kind !== 'ok') {
      if (outcome.kind === 'error') {
        log('warn', 'release_error', `release ${releaseId} fetch failed`, {
          release_id: releaseId,
          error_message: outcome.error.message,
          retryable: outcome.retryable,
        });
      }
      return;
    }
    for (const artistId of extractPhase1ArtistIds(outcome.value)) {
      seenArtistIds.add(artistId);
    }
  });

  // Sort for deterministic iteration order (and so dry-run log lines are
  // stable across runs). The Set was populated in release-completion
  // order, which is non-deterministic under concurrency > 1.
  const artistIds = Array.from(seenArtistIds).sort((a, b) => a - b);
  totals.artists_planned = artistIds.length;
  log('info', 'plan_artists', `release fan-out produced ${artistIds.length} distinct artist ids`, {
    artists_planned: artistIds.length,
  });

  if (dryRun) {
    log('info', 'dry_run', 'dry-run mode: skipping artist fan-out', { artists_planned: artistIds.length });
    projectTotalsSpan(totals, true);
    return { totals };
  }

  // Phase 2 of the two-tier loop: fan out the artist fetches. Each LML
  // call either returns the cached row, fires `_api_fetch` + write-back
  // (LML#503), or tombstones a 404 (LML#510).
  await runWithConcurrency(artistIds, concurrency, async (artistId) => {
    const outcome = await fetchArtistFn(artistId);
    tally(totals, 'artists', outcome);
    if (outcome.kind === 'error') {
      log('warn', 'artist_error', `artist ${artistId} fetch failed`, {
        artist_id: artistId,
        error_message: outcome.error.message,
        retryable: outcome.retryable,
      });
    }
  });

  projectTotalsSpan(totals, false);
  return { totals };
};
