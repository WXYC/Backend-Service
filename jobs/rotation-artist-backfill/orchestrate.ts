/**
 * Orchestrator for jobs/rotation-artist-backfill (BS#1381).
 *
 * One-tier loop:
 *
 *   for batch in chunk(identity_ids, LML_REFRESH_BATCH_CAP):
 *     POST /api/v1/cache/refresh-for-identities { identity_ids: batch }
 *
 * LML handles the source fan-out (per-identity (source, external_id) →
 * release refresh) AND the walk-to-artists step (release.artists[*].artist_id →
 * artist refresh) internally. Multiplexes onto LML's fallthrough seam
 * (LML#503 `fetched_at` discriminator + LML#510 404 tombstones), so a
 * steady-state re-run is PG hits with no Discogs egress.
 *
 * Idempotency:
 *   - The same identity_id appearing twice (across re-runs, or within a
 *     single run via different rotation rows) is deduped by `loadIdentityIds`
 *     (DISTINCT) before we get here.
 *   - LML's endpoint accepts duplicate identity_ids in a single batch
 *     (per LML#525) — second occurrence hits the in-process cache from
 *     the first. We don't rely on that; we dedup upstream.
 *
 * Batch size:
 *   - `LML_REFRESH_BATCH_CAP = 50` is a HARD constant, not a tunable.
 *     LML returns 400 on batches above 50. The cap is derived from
 *     Discogs rate-limit × cold-cache fan-out ≤ Railway's request-timeout
 *     ceiling — recalibration only lands alongside an ingress change. We
 *     do not expose an env override; raising it would only ever produce
 *     400s, and lowering it has no operational lever to pull
 *     (concurrency + rate are the cron-side tunables).
 *
 * Concurrency:
 *   - Caller-supplied; defaults to 3. The `lml-limiter` Semaphore +
 *     TokenBucket inside `fetchIdentityRefresh` caps in-flight LML calls
 *     and attempted-call rate regardless of how many promises we kick
 *     off from this layer. The local `Semaphore` here bounds the number
 *     of *materialized* pending promises so a 10k-identity set doesn't
 *     pile up Promise objects and so orphan-on-throw cancellation works
 *     correctly under AggregateError.
 *
 * dryRun: skip the actual refresh calls; counters reflect identities_scanned
 * only (no per-source/per-artist data without a real LML response). The
 * totals span fires in both modes.
 */

import * as Sentry from '@sentry/node';
import {
  type BulkCacheRefreshResponse,
  type CacheRefreshResultItem,
  REFRESH_FOR_IDENTITIES_BATCH_CAP,
  Semaphore,
} from '@wxyc/lml-client';

import { fetchIdentityRefresh, type FetchOutcome } from './lml-fetch.js';
import { log } from './logger.js';

/**
 * LML#525's per-request batch cap. Hard contract — see file header.
 * Re-exported from `@wxyc/lml-client` so the wrapper's runtime guard and
 * the cron's chunker agree on the same value.
 */
export const LML_REFRESH_BATCH_CAP = REFRESH_FOR_IDENTITIES_BATCH_CAP;

export type Totals = {
  identities_scanned: number;
  identities_resolved: number;
  warmed_releases: number;
  warmed_artists: number;
  not_found: number;
  not_implemented: number;
  lml_error: number;
};

const initialTotals = (): Totals => ({
  identities_scanned: 0,
  identities_resolved: 0,
  warmed_releases: 0,
  warmed_artists: 0,
  not_found: 0,
  not_implemented: 0,
  lml_error: 0,
});

export type RunBackfillDeps = {
  loadIdentityIds: () => Promise<number[]>;
  fetchFn?: typeof fetchIdentityRefresh;
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
 * and the wrapper rethrows once everything is done.
 *
 * When MULTIPLE tasks reject, the rethrow is wrapped in `AggregateError`
 * so the caller's catch block sees the full set, not just the first —
 * losing 2nd+3rd failures would hide real bugs (e.g., a shared decoder
 * regression affecting many batches). Sentry capture is the caller's
 * responsibility: capturing here AND in the top-level catch would
 * double-fire events (N leaves + 1 wrapper = N+1 issues per failed run)
 * and fragment grouping across step tags. `@sentry/core`'s default
 * exception serialization walks `AggregateError.errors[]`, so a single
 * outer capture preserves the leaves.
 */
const runWithConcurrency = async <T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> => {
  if (limit < 1) throw new Error(`concurrency must be >= 1, got ${limit}`);
  if (items.length === 0) return;
  const sem = new Semaphore(limit);
  const tasks = items.map(async (item) => {
    await sem.acquire();
    try {
      await run(item);
    } finally {
      sem.release();
    }
  });
  const settled = await Promise.allSettled(tasks);
  const errors: Error[] = [];
  for (const result of settled) {
    if (result.status === 'rejected') {
      const e = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${errors.length} tasks failed in runWithConcurrency`);
};

/**
 * Chunk `items` into arrays of at most `size`. Deterministic order
 * (input order preserved) so dry-run and batch log lines are stable
 * across runs.
 */
export const chunk = <T>(items: T[], size: number): T[][] => {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * Tally a single batch's response onto the run totals. Counter semantics
 * mirror BS#1381's acceptance criteria:
 *
 *   - identities_resolved : per-id `status != 'error'` (any useful work)
 *   - warmed_releases     : sum of per-source `release_outcome == 'success'`
 *   - warmed_artists      : sum of per-source artist `outcome == 'success'`
 *   - not_found           : per-id `status == 'not_found'` (stale handle)
 *   - not_implemented     : per-id `status == 'not_implemented'`
 *   - lml_error           : per-id `status == 'error'` (batch-level
 *                           failures bumped separately in the catch arm)
 *
 * Cache hit vs fresh-fetch distinction is intentionally not surfaced as
 * a BS-side counter — LML#525's response body deliberately omits per-id
 * cache_stats, and LML's internal recorders are aggregate. Hit/miss
 * observability lives on LML-side Sentry dashboards (BS#1402 issue notes).
 */
const tallyBatch = (totals: Totals, response: BulkCacheRefreshResponse, batchSize: number): void => {
  // Defend against response-shape drift. `BulkCacheRefreshResponse` is a TS
  // cast (lml-client does no runtime validation), so a malformed 200 body
  // would otherwise throw `Symbol.iterator` mid-batch and leave the batch's
  // identity_ids uncounted, corrupting the BS#1402 not_found/identities_scanned
  // denominator. Treat malformed-but-200 as a batch-level failure.
  if (!Array.isArray(response?.results)) {
    log('warn', 'malformed_response', `LML returned 200 with non-array results (${batchSize} ids)`, {
      batch_size: batchSize,
    });
    tallyBatchError(totals, batchSize);
    return;
  }
  for (const item of response.results) {
    totals.identities_scanned += 1;
    switch (item.status) {
      case 'warmed':
        totals.identities_resolved += 1;
        tallySources(totals, item);
        break;
      case 'not_found':
        totals.identities_resolved += 1;
        totals.not_found += 1;
        break;
      case 'not_implemented':
        totals.identities_resolved += 1;
        totals.not_implemented += 1;
        // Some not_implemented rollups carry source-level outcomes too
        // (e.g. a row with `discogs_master` only — the source slot is
        // populated, even though no warm happened). Don't tally those:
        // `warmed_releases` is reserved for `release_outcome == 'success'`.
        // Sources with `release_outcome == 'not_implemented'` contribute
        // to the per-id `not_implemented` counter only.
        break;
      case 'error':
        totals.lml_error += 1;
        // Still walk sources — if one leg succeeded *and* another errored
        // we'd already be in `warmed`, not `error`. By the rollup rule,
        // `error` means no source was `success`, so the warmed_* counters
        // stay at zero here. We don't tally sources for that reason.
        break;
      default:
        // Future LML versions may add a status (e.g. 'partial_warmed'). Bump
        // `lml_error` so the invariant `identities_scanned ==
        // identities_resolved + lml_error` is preserved and the BS#1402 alert
        // denominator doesn't silently inflate without a matching numerator.
        totals.lml_error += 1;
        log('warn', 'unknown_status', `LML returned unknown per-id status; counted as lml_error`, {
          status: String((item as { status?: unknown }).status),
        });
        break;
    }
  }
};

const tallySources = (totals: Totals, item: CacheRefreshResultItem): void => {
  if (!item.sources) return;
  for (const source of Object.values(item.sources)) {
    // Defend against per-source null values — type contract excludes them,
    // but the wrapper does no runtime validation, and a single null entry
    // would otherwise throw TypeError mid-batch.
    if (!source) continue;
    if (source.release_outcome === 'success') {
      totals.warmed_releases += 1;
    }
    for (const artist of source.artists ?? []) {
      if (artist?.outcome === 'success') {
        totals.warmed_artists += 1;
      }
    }
  }
};

/**
 * Account for batch-level failures: every identity in a failed batch is
 * counted as `identities_scanned` (we attempted to refresh it) but does
 * NOT count toward `identities_resolved` (no useful work happened).
 * `lml_error` bumps by batch size since the failure obscured the per-id
 * shape; the orchestrator can't distinguish which sub-fanned-out fine
 * and which didn't.
 *
 * Keeping `identities_scanned` truthful even on batch failure is what
 * makes the `not_found / identities_scanned` ratio alert (BS#1402)
 * resilient to transient LML outages — a 100% batch-failure day still
 * produces a well-defined denominator instead of dividing by zero.
 */
const tallyBatchError = (totals: Totals, batchSize: number): void => {
  totals.identities_scanned += batchSize;
  totals.lml_error += batchSize;
};

/**
 * Project the run totals onto a Sentry child span with numeric attributes
 * set at creation time (per the BS#1081 convention — late `setAttribute`
 * calls index numbers as strings and break sum/avg/p95 aggregation).
 * Span name follows the sibling artist-search-alias-consumer's
 * `${JOB_NAME}.run.totals` shape so dashboards filtering by span name
 * pattern can group all backfill totals consistently.
 */
const projectTotalsSpan = (totals: Totals, dryRun: boolean): void => {
  Sentry.startSpan(
    {
      name: 'rotation-artist-backfill.run.totals',
      attributes: {
        'backfill.dry_run': dryRun ? 1 : 0,
        'backfill.identities_scanned': totals.identities_scanned,
        'backfill.identities_resolved': totals.identities_resolved,
        'backfill.warmed_releases': totals.warmed_releases,
        'backfill.warmed_artists': totals.warmed_artists,
        'backfill.not_found': totals.not_found,
        'backfill.not_implemented': totals.not_implemented,
        'backfill.lml_error': totals.lml_error,
      },
    },
    () => {
      /* observability-only span; attributes set at creation */
    }
  );
};

export const runBackfill = async (deps: RunBackfillDeps): Promise<RunResult> => {
  const fetchFn = deps.fetchFn ?? fetchIdentityRefresh;
  const concurrency = deps.concurrency ?? 3;
  const dryRun = deps.dryRun ?? false;
  const totals = initialTotals();
  // Sentinel so we don't fire an all-zero totals span when loadIdentityIds
  // itself throws — that span shape is indistinguishable from a clean
  // empty-rotation day on the dashboard.
  let didLoadIds = false;

  // Fire the totals span no matter how the run ends past loadIdentityIds:
  // success, dryRun, or fan-out throw. The accumulated counters are real
  // and the dashboard pulling on them shouldn't go blank because one
  // batch rejected near the end of the run.
  try {
    const identityIds = await deps.loadIdentityIds();
    didLoadIds = true;

    const batches = chunk(identityIds, LML_REFRESH_BATCH_CAP);
    log('info', 'plan', `loaded ${identityIds.length} active rotation identity ids`, {
      identity_count: identityIds.length,
      batch_count: batches.length,
      batch_cap: LML_REFRESH_BATCH_CAP,
      concurrency,
      dry_run: dryRun,
    });

    if (dryRun) {
      // Surface the same identity_scanned counter so dashboards stay
      // populated in dry-run; warmed_* / not_* stay at zero by definition.
      totals.identities_scanned = identityIds.length;
      log('info', 'dry_run', 'dry-run mode: skipping refresh calls', {
        identities_scanned: identityIds.length,
        batch_count: batches.length,
      });
      return { totals };
    }

    await runWithConcurrency(batches, concurrency, async (batch) => {
      const outcome: FetchOutcome<BulkCacheRefreshResponse> = await fetchFn(batch);
      if (outcome.kind === 'ok') {
        tallyBatch(totals, outcome.value, batch.length);
      } else {
        tallyBatchError(totals, batch.length);
        log('warn', 'batch_error', `identity refresh batch failed (${batch.length} ids)`, {
          batch_size: batch.length,
          error_message: outcome.error.message,
          retryable: outcome.retryable,
        });
      }
    });

    return { totals };
  } finally {
    if (didLoadIds) {
      // Wrap in its own try/catch so a Sentry SDK fault here can't
      // shadow the original error from the try block — the orchestrator
      // paid AggregateError-construction cost specifically so failures
      // surface, and finally-clause swallowing would undo that.
      try {
        projectTotalsSpan(totals, dryRun);
      } catch (e) {
        log('warn', 'totals_span_failed', 'projectTotalsSpan threw; original error preserved', {
          error_message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
};
