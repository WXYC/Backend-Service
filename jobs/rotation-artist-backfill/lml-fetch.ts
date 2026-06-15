/**
 * LML identity-refresh fetch helper for jobs/rotation-artist-backfill (BS#1381).
 *
 * Wraps `@wxyc/lml-client`'s `refreshForIdentities` (POST
 * `/api/v1/cache/refresh-for-identities`, LML#525) in this job's stricter
 * `defaultLmlLimiter` (BACKFILL_LML_*). The lml-client's own `lmlFetch`
 * chokepoint does NOT thread this endpoint through a limiter today — its
 * default limiter only covers `/lookup` and `/lookup/bulk` — so the wrap
 * here is what bounds the cron's contribution to LML's per-replica
 * Discogs egress cap. A single 50-id batch can fan out internally on LML's
 * side to ~50 release + ~150 artist Discogs calls on cold cache; the
 * BS-side limiter caps how many of *those* batches are in flight, not
 * the per-batch fan-out (which LML manages via its own `discogs_max_concurrent=5`
 * semaphore + `discogs_rate_limit=50/min` AsyncLimiter).
 *
 * The endpoint returns 200-with-per-id-results even when individual
 * identities errored — only batch-level transport failures throw. So the
 * `FetchOutcome` here is coarse: either the parsed body is back, or the
 * whole batch couldn't be retrieved. Per-id status rollup lives in the
 * orchestrator's tally.
 *
 * BS-side per-call timeout is `BATCH_TIMEOUT_MS` (default 5 min, overridable
 * via `BACKFILL_LML_BATCH_TIMEOUT_MS`). LML server-side caps the batch
 * wall-clock at Railway's request-timeout ceiling on cold cache; the cron's
 * timeout sits ≥ that ceiling so a successful LML writeback isn't
 * misclassified as a transport error on first touch — under-timing makes
 * the batch count as `lml_error+batchSize` even though LML completes the
 * work in the background, doubling Discogs egress on the next day's run.
 */

import * as Sentry from '@sentry/node';

import { envInt, type BulkCacheRefreshResponse, LmlClientError, refreshForIdentities } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

/**
 * Per-batch BS-side AbortController budget for `refreshForIdentities`.
 * Sized to cover LML's worst-case cold-cache fan-out (~50 release +
 * ~150 artist Discogs calls at LML's 50 req/min cap ≈ 4 min) PLUS
 * Railway's request-timeout ceiling (~5 min) with a 1-min safety margin
 * so the BS-side AbortController does not race the LML/Railway edge
 * timeout — if BS aborts at exactly the ceiling, a successful LML
 * writeback is misclassified as a transport error and `lml_error`
 * bumps by `batch.length` even though LML completes the work in the
 * background. Operators can dial via `BACKFILL_LML_BATCH_TIMEOUT_MS`
 * without a redeploy (e.g. when LML's Railway timeout changes).
 */
const BATCH_TIMEOUT_MS = envInt('BACKFILL_LML_BATCH_TIMEOUT_MS', 6 * 60 * 1000);

export type FetchOutcome<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: Error; retryable: boolean };

const isLmlClientError = (e: unknown): e is LmlClientError => e instanceof LmlClientError;

const classifyError = (e: unknown): FetchOutcome<never> => {
  const err = e instanceof Error ? e : new Error(String(e));
  // 4xx other than 429 is non-retryable in practice — client misconfiguration
  // (auth, malformed body, batch above the 50-id cap that the orchestrator
  // failed to chunk correctly) that won't change between runs. 5xx, 429, and
  // network/timeout errors are retryable: 429 fires when LML's per-replica
  // 50 req/min Discogs cap collides with foreground traffic; >= 500 covers
  // upstream failures including the 504 that lml-client mints for AbortError.
  const retryable = !isLmlClientError(e) || e.statusCode === 429 || e.statusCode >= 500;
  return { kind: 'error', error: err, retryable };
};

/**
 * Mark the active Sentry span with an explicit OK or ERROR status. Per OTLP
 * semantic conventions, span status is the queryable signal for error-rate
 * dashboards. `@sentry/core`'s `spanToJSON` defaults the status to `ok`
 * when nothing is set, so a successful batch without this call still
 * surfaces as OK in standard Sentry views — the explicit `code: 1` set
 * is defense against custom alert filters of the shape
 * `span.status_code != 1` or query backends that surface `unset`
 * separately, AND it makes the OK case symmetric with the explicit
 * `code: 2` set on failure (so reviewers don't have to grep the SDK to
 * confirm the OK branch is wired).
 *
 * Per-id failures inside a successful batch (`status: 'error'` items)
 * do NOT promote to span-level error here — the orchestrator's tally
 * surfaces them via the `backfill.lml_error` counter on the totals span.
 * Promoting them would inflate `op:http.client` error-rate alerts on
 * steady-state runs where a single stale-identity row would fire an alert.
 *
 * Status codes: 0 = unset, 1 = OK, 2 = ERROR (OTLP / @sentry/core).
 */
const markSpanOutcome = <T>(outcome: FetchOutcome<T>): void => {
  const span = Sentry.getActiveSpan();
  if (!span) return;
  if (outcome.kind === 'ok') {
    span.setStatus({ code: 1, message: 'ok' });
    return;
  }
  span.setStatus({ code: 2, message: outcome.retryable ? 'retryable_error' : 'permanent_error' });
};

export const fetchIdentityRefresh = async (identityIds: number[]): Promise<FetchOutcome<BulkCacheRefreshResponse>> => {
  return Sentry.startSpan(
    {
      name: 'lml.refresh_for_identities',
      op: 'http.client',
      attributes: {
        'lml.batch_size': identityIds.length,
        'lml.batch_timeout_ms': BATCH_TIMEOUT_MS,
      },
    },
    async () => {
      let outcome: FetchOutcome<BulkCacheRefreshResponse>;
      try {
        const value = await defaultLmlLimiter.run(() =>
          refreshForIdentities(identityIds, { timeoutMs: BATCH_TIMEOUT_MS })
        );
        outcome = { kind: 'ok', value };
      } catch (e) {
        outcome = classifyError(e);
      }
      markSpanOutcome(outcome);
      return outcome;
    }
  );
};
