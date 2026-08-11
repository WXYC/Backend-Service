/**
 * Observability for legacy-mirror-reconcile: Sentry init + JSON logs.
 *
 * Every log line carries the four tags `repo`, `tool`, `step`, `run_id` so
 * downstream consumers (CloudWatch / Loki) can filter by step without a regex
 * over free-form prose. Sentry stays inactive when SENTRY_DSN is unset (the
 * @sentry/node SDK silently no-ops in that case), so this module is safe to
 * call from any environment.
 *
 * Mirrors `jobs/concerts-artist-lml-resolver/logger.ts` — the contract is
 * identical, and the duplication is the established pattern for keeping each
 * job's build graph independent of the others. Adds `captureWarning` for the
 * BS#1707 detection signal (orphan-count threshold + partial-mirror report),
 * which routes through `Sentry.captureMessage` at `warning` level.
 */

import * as Sentry from '@sentry/node';
import { randomUUID } from 'crypto';

export type LoggerConfig = {
  repo: string;
  tool: string;
  /** Optional run id; a random UUID is generated when omitted. */
  runId?: string;
};

export type LogLevel = 'info' | 'warn' | 'error';

type BaseTags = { repo: string; tool: string; run_id: string };

let baseTags: BaseTags | null = null;

// `@sentry/node` v10 silently produces zero spans when tracesSampleRate is unset.
export const resolveTracesSampleRate = (raw: string | undefined = process.env.SENTRY_TRACES_SAMPLE_RATE): number => {
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
  return parsed;
};

/**
 * Initialize Sentry and the structured logger. Call once at the top of the
 * entrypoint, before any other logic. Returns the resolved `run_id` so the
 * caller can pass it to subprocesses or persist it for cross-system tracing.
 */
export const initLogger = (config: LoggerConfig): string => {
  const runId = config.runId ?? randomUUID();
  baseTags = { repo: config.repo, tool: config.tool, run_id: runId };

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: resolveTracesSampleRate(),
  });
  Sentry.setTag('repo', config.repo);
  Sentry.setTag('tool', config.tool);
  Sentry.setTag('run_id', runId);

  return runId;
};

/**
 * Emit a JSON log line. `info`/`warn` go to stdout, `error` goes to stderr
 * so container log shippers can split streams by severity.
 *
 * Silently no-ops when called before `initLogger()` so unit tests that
 * exercise library functions directly (without invoking the entrypoint)
 * don't have to thread an init call through every fixture.
 */
export const log = (level: LogLevel, step: string, message: string, fields: Record<string, unknown> = {}): void => {
  if (!baseTags) return;
  const line =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      step,
      message,
      ...baseTags,
      ...fields,
    }) + '\n';
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

/**
 * Steps where a fingerprint OVERRIDE is warranted for `captureError` — i.e.
 * where different error SHAPES at the same call site (a statement timeout
 * one night, a connection reset the next) should still roll up into one
 * stable Sentry issue across runs, because the call site's identity — not
 * the specific exception — is what an on-call reader needs grouped. Today
 * that's exactly the BS#2065/#2069 stale-open-show detector's two narrow
 * arms (`orchestrate.ts`'s `runStaleOpenShowReport`).
 *
 * Every OTHER `captureError` call site — most importantly the catch-all
 * `'main'` step in `job.ts` — must NOT get this treatment (BS#2098 review
 * finding 1): folding every top-level failure into one fingerprinted group
 * meant a tubafrenzy-outage week could archive/ignore that one Sentry issue,
 * and a LATER, unrelated failure (a DB connection loss, an advisory-lock
 * error, a mirror 401 after token rotation) would silently append to the
 * same archived issue instead of alerting on its own. Sentry's DEFAULT
 * (exception-shape-based) grouping is what those call sites want, so
 * `captureError` leaves `fingerprint` unset for any step not in this set —
 * two genuinely different exceptions at `'main'` land in two different
 * issues, while repeated identical failures still collapse the way Sentry
 * always collapses identical stack traces.
 *
 * An alternative considered: keep every `captureError` call fingerprinted,
 * but prefix `['{{ default }}', 'legacy-mirror-reconcile', step]` so Sentry
 * mixes its own exception-shape grouping back in. Rejected: that would ALSO
 * apply to the two detector steps below, defeating the reason they're
 * fingerprinted in the first place — a statement timeout and a connection
 * reset at the SAME detector call site have different default shapes, so
 * `{{ default }}` would split them right back into separate issues, exactly
 * what this file's original docblock (see `captureError` below) built the
 * per-step fingerprint to prevent. Scoping the override to the two call
 * sites that actually want cross-shape rollup, and leaving every other step
 * (including `'main'`) on Sentry's default grouping, gets both properties at
 * once without a signature change to `captureError` or its `ReconcilePorts`
 * call sites.
 */
const ROLLUP_ERROR_STEPS = new Set<string>(['stale_open_show_detector', 'stale_open_show_historical_count']);

/**
 * Capture an exception to Sentry with the current run's tags + an extra
 * `step`. For the two steps in `ROLLUP_ERROR_STEPS` (see that constant),
 * fingerprinted per `step` so a persistently-failing call site rolls up into
 * one stable Sentry issue across runs instead of fanning out into a fresh
 * issue per distinct error message/stack — Sentry's default grouping is
 * exception-shape-based, not step-based, so two different DB errors from the
 * same call site (e.g. a statement timeout one night, a connection reset the
 * next) would otherwise group separately. Every other step (including the
 * `job.ts` catch-all `'main'`) gets no fingerprint override, so Sentry's
 * default exception-shape grouping applies instead — see the constant's
 * comment for why that split is deliberate.
 *
 * The fingerprint's second element is the literal `'error'`, disambiguating
 * this namespace from `captureWarning`'s (below): both used to fingerprint
 * as bare `['legacy-mirror-reconcile', step]`, so a future step string
 * shared between an error and a warning call site would have merged them
 * into one Sentry issue despite one being a hard failure and the other a
 * detection signal. No such collision exists today (error steps are
 * `main`/`stale_open_show_detector`/`stale_open_show_historical_count`;
 * warning steps are `stale_open_show`/`partial_mirror`/`detection`), but
 * nothing enforced that the two sets stay disjoint.
 */
export const captureError = (error: unknown, step: string, extra: Record<string, unknown> = {}): void => {
  const fingerprint = ROLLUP_ERROR_STEPS.has(step) ? ['legacy-mirror-reconcile', 'error', step] : undefined;
  Sentry.captureException(error, { tags: { step }, fingerprint, extra });
};

/**
 * Capture a warning-level message to Sentry (the BS#1707 detection signal).
 * Fingerprinted per `step` so the two signals — the aggregate orphan-count
 * threshold and the per-show partial-mirror report — each roll up into a
 * single, stable issue rather than fanning out per run or per show_id. The
 * `show_id` travels as `extra`, not part of the group hash.
 *
 * The fingerprint's second element is the literal `'warning'` — see
 * `captureError`'s doc comment for why the two capture functions no longer
 * share a bare `['legacy-mirror-reconcile', step]` namespace.
 */
export const captureWarning = (message: string, step: string, extra: Record<string, unknown> = {}): void => {
  Sentry.captureMessage(message, {
    level: 'warning',
    fingerprint: ['legacy-mirror-reconcile', 'warning', step],
    tags: { subsystem: 'legacy-mirror', step },
    extra,
  });
};

/** Flush pending Sentry events. Call from the entrypoint's `finally`. */
export const closeLogger = async (): Promise<void> => {
  await Sentry.close(2000);
  baseTags = null;
};
