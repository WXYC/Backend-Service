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
 * dryRun:
 *   - The release fan-out still runs (we need it to enumerate artist ids).
 *   - Artist calls are skipped; counters report `artists_planned` so an
 *     operator can sanity-check cardinality before scheduling.
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
 * Interruptibility:
 *   - The outer loop checkpoints nothing — there is no BS-local state to
 *     advance. A kill mid-run drops in-flight work; the next run picks
 *     up where the cache is cold and finishes what we didn't.
 *
 * Concurrency:
 *   - Caller-supplied; defaults to 3. We don't gate concurrency here on
 *     the runtime side — the `lml-limiter` semaphore caps in-flight LML
 *     calls regardless of how many promises we kick off from this layer.
 *     The local Sema lets us bound the number of *pending* promises so
 *     we don't materialize 10k+ Promise objects for a long rotation set.
 *   - Per the issue, 30s read timeout. Since lml-client owns its own
 *     timeout (30s default), and we don't override it here, the BS-side
 *     wall-clock per call is bounded.
 */

import * as Sentry from '@sentry/node';

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
 * Run N tasks with at most `limit` in-flight at any moment. Resolves once
 * every task has settled. Errors thrown by a task propagate out of the
 * wrapper — callers should catch inside the task body and translate to a
 * counter bump instead, so one bad row can't tear down the whole run.
 */
const runWithConcurrency = async <T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> => {
  if (limit < 1) throw new Error(`concurrency must be >= 1, got ${limit}`);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      await run(items[idx]);
    }
  });
  await Promise.all(workers);
};

const tallyRelease = <T>(totals: Totals, outcome: FetchOutcome<T>): void => {
  totals.releases_scanned += 1;
  if (outcome.kind === 'ok') totals.releases_ok += 1;
  else if (outcome.kind === 'not_found') totals.releases_not_found += 1;
  else totals.releases_error += 1;
};

const tallyArtist = <T>(totals: Totals, outcome: FetchOutcome<T>): void => {
  totals.artists_attempted += 1;
  if (outcome.kind === 'ok') totals.artists_ok += 1;
  else if (outcome.kind === 'not_found') totals.artists_not_found += 1;
  else totals.artists_error += 1;
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

  // Phase 1 of the two-tier loop: fan out the release fetches. Each release
  // result feeds an artist-id set into the second tier. Artist-id dedup is
  // global across the run.
  const seenArtistIds = new Set<number>();
  const artistIds: number[] = [];

  await runWithConcurrency(releaseIds, concurrency, async (releaseId) => {
    const outcome = await fetchReleaseFn(releaseId);
    tallyRelease(totals, outcome);
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
      if (seenArtistIds.has(artistId)) continue;
      seenArtistIds.add(artistId);
      artistIds.push(artistId);
    }
  });

  totals.artists_planned = artistIds.length;
  log('info', 'plan_artists', `release fan-out produced ${artistIds.length} distinct artist ids`, {
    artists_planned: artistIds.length,
  });

  if (dryRun) {
    log('info', 'dry_run', 'dry-run mode: skipping artist fan-out', { artists_planned: artistIds.length });
    return { totals };
  }

  // Phase 2 of the two-tier loop: fan out the artist fetches. Each LML
  // call either returns the cached row, fires `_api_fetch` + write-back
  // (LML#503), or tombstones a 404 (LML#510).
  await runWithConcurrency(artistIds, concurrency, async (artistId) => {
    const outcome = await fetchArtistFn(artistId);
    tallyArtist(totals, outcome);
    if (outcome.kind === 'error') {
      log('warn', 'artist_error', `artist ${artistId} fetch failed`, {
        artist_id: artistId,
        error_message: outcome.error.message,
        retryable: outcome.retryable,
      });
    }
  });

  // Project the run totals onto a Sentry span with numeric attributes set
  // at creation time (per the BS#1081 convention).
  Sentry.startSpan(
    {
      name: 'rotation-artist-backfill.totals',
      attributes: {
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

  return { totals };
};
