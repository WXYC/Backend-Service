/**
 * The one logger instance for flowsheet-metadata-backfill (BS#3537). `log()` is silent until this
 * instance's `initLogger` runs, so every file in the job imports from here; a second
 * `createJobLogger` call elsewhere would drop that file's log lines with no error.
 *
 * Unlike the sibling jobs, this one passes its own `tracesSampler` (below) so the run-totals span
 * stays at 100% while the per-row `lml.lookup` spans are dropped (BS#1566).
 */

import { createJobLogger, resolveTracesSampleRate } from '@wxyc/observability/job-logger';

export { resolveTracesSampleRate };

/**
 * The `op` and `name` of this job's run-totals span
 * (`orchestrate.ts:projectTotalsSpan`). The `tracesSampler` keys on these to
 * hold the totals span at 100% while everything else samples at
 * `NON_TOTALS_SAMPLE_RATE`. Kept in sync with `projectTotalsSpan`'s
 * `${JOB_NAME}.totals` op / `${JOB_NAME}.run.totals` name literals.
 */
export const TOTALS_SPAN_OP = 'flowsheet-metadata-backfill.totals';
export const TOTALS_SPAN_NAME = 'flowsheet-metadata-backfill.run.totals';

/**
 * Sample rate applied to every span that is NOT the totals span. Held at 0 so a
 * drain's per-row `lml.lookup` transactions — op `http.client`, opened by
 * `@wxyc/lml-client.lookupMetadata` on every cache-miss lookup
 * (`shared/lml-client/src/index.ts`), and bounded at ~20/min by the backfill
 * LML limiter, i.e. ≤~1,200/hour while draining — don't flood Sentry ingest.
 * Before BS#1564 flipped the default rate to 1.0 these were zero; the totals
 * span (below) carries this job's entire alerting substrate (#1561/#1563), so
 * the per-row spans add only noise for a job that drains hundreds of thousands
 * of rows over its lifetime (BS#1566). The main `apps/backend` path already
 * traces `lml.lookup` at its own rate, so runtime LML latency stays visible
 * without this cron's per-lookup copies.
 */
export const NON_TOTALS_SAMPLE_RATE = 0;

/** Minimal shape of the Sentry sampling context this sampler reads. */
type TotalsSamplingContext = {
  name?: string;
  attributes?: Record<string, unknown>;
};

/**
 * Sentry `tracesSampler` that decouples the always-on totals span from the bulk
 * per-row spans (BS#1566).
 *
 * `tracesSampler` takes precedence over `tracesSampleRate` in the SDK, so once
 * set it is the single sampling authority. Behavior:
 * - a resolved `envRate` of 0 (an explicit, valid `SENTRY_TRACES_SAMPLE_RATE=0`)
 *   is the kill switch — it silences EVERY span, the totals span included;
 * - otherwise the totals span — matched by its op
 *   (`flowsheet-metadata-backfill.totals`), or by name as a fallback if a future
 *   SDK stops folding `op` into the sampling attributes — is always sampled at
 *   1.0, because it is this job's alerting substrate and must not be
 *   probabilistic;
 * - every other span (notably the per-row `lml.lookup` / `http.client`
 *   transactions) samples at `NON_TOTALS_SAMPLE_RATE`.
 *
 * The `SENTRY_DSN` gate is unaffected — with no DSN the SDK no-ops and never
 * calls this function. `envRate` is injected (resolved once at init) rather than
 * re-read per span; it defaults to `resolveTracesSampleRate()` for direct
 * unit testing.
 */
export const tracesSampler = (
  samplingContext: TotalsSamplingContext,
  envRate: number = resolveTracesSampleRate()
): number => {
  if (envRate === 0) return 0;
  const op = samplingContext.attributes?.['sentry.op'];
  if (op === TOTALS_SPAN_OP || samplingContext.name === TOTALS_SPAN_NAME) return 1;
  return NON_TOTALS_SAMPLE_RATE;
};

// Resolved once and closed over: the sampler runs per span and must not re-read the environment.
// An envRate of 0 (an explicit `SENTRY_TRACES_SAMPLE_RATE=0`) is the kill switch.
const envRate = resolveTracesSampleRate();

export const { initLogger, log, captureError, closeLogger } = createJobLogger({
  jobName: 'flowsheet-metadata-backfill',
  // Runs hourly, so its PostHog budget is 2 a run rather than 10 (BS#3409).
  errorBudget: 2,
  tracesSampler: (samplingContext) => tracesSampler(samplingContext, envRate),
});
