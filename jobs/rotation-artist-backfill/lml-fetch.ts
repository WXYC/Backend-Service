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
 * BS-side upper bound on a single call is `lmlFetch`'s hard-coded 30 s
 * (shared/lml-client/src/index.ts TIMEOUT_MS — refreshForIdentities accepts
 * a `timeoutMs` override but defaults to TIMEOUT_MS). LML server-side caps
 * the batch wall-clock at ~5 min (Railway's request-timeout ceiling) on
 * cold cache; a BS-side 30 s budget can timeout while LML's background
 * completes and writes back the rows — the per-id counters undercount the
 * actual back-fill rate, and the next day's run picks the rows up as PG
 * hits. Threading a budget that survives the worst-case cold-cache fan-out
 * is the follow-up tracked in the PR description.
 */

import * as Sentry from '@sentry/node';

import { type BulkCacheRefreshResponse, LmlClientError, refreshForIdentities } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';

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
 * Mark the active Sentry span with a non-OK status when the batch call
 * itself fails. Per OTLP semantic conventions, span status is the
 * queryable signal for error-rate dashboards — without this, every span
 * comes back `ok` even when classifyError returned `kind: 'error'`
 * (because the throw was caught and converted to a return value).
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
  if (outcome.kind === 'ok') return;
  const span = Sentry.getActiveSpan();
  if (!span) return;
  span.setStatus({ code: 2, message: outcome.retryable ? 'retryable_error' : 'permanent_error' });
};

export const fetchIdentityRefresh = async (identityIds: number[]): Promise<FetchOutcome<BulkCacheRefreshResponse>> => {
  return Sentry.startSpan(
    {
      name: 'lml.refresh_for_identities',
      op: 'http.client',
      attributes: { 'lml.batch_size': identityIds.length },
    },
    async () => {
      let outcome: FetchOutcome<BulkCacheRefreshResponse>;
      try {
        const value = await defaultLmlLimiter.run(() => refreshForIdentities(identityIds));
        outcome = { kind: 'ok', value };
      } catch (e) {
        outcome = classifyError(e);
      }
      markSpanOutcome(outcome);
      return outcome;
    }
  );
};
