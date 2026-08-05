/**
 * Low-duty-cycle LML `/health` Discogs-breaker probe (BS#1995 Arm 2).
 *
 * The 2026-08-03/04 incident (BS#1995): `BACKFILL_LML_RATE_PER_MIN` is a
 * process-local token bucket counting *this job's LML lookups*, but the
 * constraint that matters is LML's *Discogs* rate ceiling, shared across
 * this drain, live iOS/dj-site traffic, and every other heavy cron in the
 * 04:00-09:00 UTC band. No process-local counter can see that sum. LML
 * itself can, via its Discogs circuit breaker — `GET /health` exposes
 * `discogs_breaker_state` (`closed` / `open` / `half_open`, `null` when
 * Discogs is unconfigured — LML `routers/health.py:255`) and
 * `discogs_live_requests_total` (a monotonic per-process counter,
 * `routers/health.py:268`). This module polls that signal on a
 * deliberately low duty cycle — TIME-driven, not batch-driven (BS#1995
 * review B1): `orchestrate.ts`'s `waitForClosedBreaker` checks a wall-clock
 * interval on every row (a cheap `Date.now()` read), but the actual network
 * call — the thing that must stay rare — only fires once
 * `BACKFILL_BREAKER_PROBE_INTERVAL_MS` has elapsed since the last one. A
 * batch-boundary cadence was tried first and rejected: at this job's own
 * recommended catch-up rate (`BACKFILL_LML_RATE_PER_MIN=6`, see the job
 * README) a 500-row default batch takes ~83 minutes, so a breaker that
 * opened one row into a batch would run the drain, undetected, for the
 * next hour-plus — reproducing the incident at the exact resolution this
 * gate exists to prevent.
 *
 * IMPORTANT COST NOTE: LML's `/health` makes a live Discogs API call
 * whenever the breaker is CLOSED (`routers/health.py`'s `_check_discogs_api`
 * only short-circuits that call when `breaker_state is not CLOSED`) — so
 * every probe spends one of the ~50 req/min ceiling this whole gate exists
 * to protect, and inflates `discogs_live_requests_total`, the very counter
 * this module measures a rate from. `BACKFILL_BREAKER_PROBE_INTERVAL_MS`
 * therefore has a documented floor: keep it on the order of 30-60 seconds,
 * not seconds — a small, unsubtracted floor added to the drain's own
 * Discogs usage, not a signal that costs nothing to read.
 *
 * Reports a result the orchestrator gates the drain on: a `closed` (or
 * `unconfigured` — no Discogs upstream to protect) breaker lets the row
 * proceed; `open` / `half_open` pauses.
 *
 * Fails OPEN by design: a `/health` request that times out, network-errors,
 * or whose body can't be read at all is reported as `probe_error` and
 * treated exactly like `closed` — the drain keeps running. A health-probe
 * outage must never wedge the drain; that would trade one incident (an
 * unnoticed breaker flap) for a worse one (a stuck cron). The probe failure
 * is logged so an operator can still notice a persistently-unreachable LML.
 * `fetchLmlHealthSnapshot` parses the response body regardless of HTTP
 * status (BS#1995 review follow-up) — LML's `/health` returns 503 only
 * when its CORE (database) probe fails, not when only the Discogs breaker
 * is unhealthy (that keeps the overall response at 200 with the breaker
 * state intact), but a genuinely degraded LML or an intermediary proxy MAY
 * still emit a readable `discogs_breaker_state` on a non-2xx body, and
 * refusing to even look would blind the gate in exactly the scenario an
 * operator most wants the signal. Only a body that can't be parsed as JSON
 * at all (network failure, an HTML error page, an empty body) falls
 * through to `probe_error`.
 *
 * Known limitation, deliberately NOT solved here (BS#1995 review D1):
 * `discogs_breaker_state` and `discogs_live_requests_total` are both
 * per-LML-PROCESS signals, read through whatever load balancer sits in
 * front of prod. If more than one LML process is serving traffic (plausible
 * — `docs/env-vars.md`'s `BACKFILL_LML_RATE_PER_MIN` entry documents the
 * measured 51 req/min that first surfaced this), consecutive probes can
 * land on different processes: a `closed` reading while a DIFFERENT
 * process's breaker is open, or a counter delta that's arbitrary or even
 * negative (see `orchestrate.ts`'s `probeBreakerAndMeasure` for how a
 * negative delta is logged as an invalid measurement rather than silently
 * treated as absent). An imperfect gate beats no gate — this is inherent to
 * the signal LML exposes, not a defect in this module, and is documented
 * (not "fixed") in the job README next to the gate's description.
 *
 * Structurally mirrors `jobs/rotation-artist-backfill/deploy-guard.ts`'s
 * `fetchLmlHealth` (same base-URL resolution, same AbortController +
 * timeout + error-translation scaffold) rather than inventing a second LML
 * `/health` client shape in the tree.
 */

import { parseEnvInt } from './env-int.js';

const LML_BASE_URL_ENV = 'LIBRARY_METADATA_URL';
const HEALTH_PATH = '/health';

/** LML's `BreakerState` enum, mirrored here (LML `routers/health.py:255`). */
export type DiscogsBreakerState = 'closed' | 'open' | 'half_open';

const VALID_BREAKER_STATES: ReadonlySet<string> = new Set(['closed', 'open', 'half_open']);

export type LmlHealthSnapshot = {
  discogs_breaker_state: DiscogsBreakerState | null;
  discogs_live_requests_total: number | null;
};

/**
 * The gate's read of a single probe:
 *   - `closed` / `open` / `half_open` — LML answered and reported a real
 *     breaker state.
 *   - `unconfigured` — LML answered with `discogs_breaker_state: null`
 *     (Discogs isn't configured on this LML deploy). Fail open: nothing to
 *     protect.
 *   - `probe_error` — the `/health` request itself failed (network, abort,
 *     non-2xx, bad body). Fail open: an unreachable health endpoint must
 *     not stop the drain. `error` carries the failure message for logging.
 */
export type BreakerProbeOutcome = DiscogsBreakerState | 'unconfigured' | 'probe_error';

export type BreakerProbeResult = {
  outcome: BreakerProbeOutcome;
  liveRequestsTotal: number | null;
  error?: string;
};

export type CheckDiscogsBreakerFn = () => Promise<BreakerProbeResult>;

/**
 * Thrown by `orchestrate.ts`'s `waitForClosedBreaker` (BS#1995 review B3)
 * when cumulative pause time exceeds `BACKFILL_BREAKER_MAX_PAUSE_MS`. A
 * pause loop with no ceiling is invisible exactly when it matters: because
 * the gate runs before the first `batch_done`, a run that pauses for its
 * entire lifetime emits no `batch_done`, no `finished`, and no Sentry
 * totals span — the July 2026 incident had LML's breaker stuck HALF_OPEN
 * for ~8h, and the next cron tick's `docker rm -f` would have ended that as
 * a silent zero-progress run. A wedged breaker must be loud: this error
 * propagates out of `runBackfill` uncaught, to `job.ts`'s top-level catch,
 * setting `process.exitCode = 1`.
 */
export class BreakerPauseCeilingExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BreakerPauseCeilingExceededError';
  }
}

type FetchLike = typeof fetch;

const baseUrl = (): string => {
  const url = process.env[LML_BASE_URL_ENV];
  if (!url) {
    throw new Error(`${LML_BASE_URL_ENV} is not configured`);
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
};

const parseBreakerState = (value: unknown): DiscogsBreakerState | null =>
  typeof value === 'string' && VALID_BREAKER_STATES.has(value) ? (value as DiscogsBreakerState) : null;

const parseLiveRequestsTotal = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * `Number()`-based, warn-and-fallback env-int parsers — matches
 * `lml-fetch.ts` / `lml-limiter.ts`'s convention (not the throw-on-invalid
 * `requireNonNegativeInt` family `orchestrate.ts`'s own resolvers use for
 * the pre-existing cooperative-pause knobs). This gate is new and
 * operationally low-stakes enough that a bad env value should degrade to
 * the safe default with a loud warning, not abort the cron at startup.
 * Delegates the actual parsing to the shared `parseEnvInt` (BS#1995 review
 * S1+S2) so the whitespace/decimal/hex validation bug found in review only
 * needs fixing in one place, shared with `lml-fetch.ts` / `lml-limiter.ts`.
 */
const envPositiveInt = (name: string, fallback: number): number =>
  parseEnvInt(
    name,
    fallback,
    'positive',
    (raw) => `lml-health: ${name}=${raw} is invalid (must be a positive number); using fallback ${fallback}`
  );

/**
 * Same shape as `envPositiveInt`, but accepts `0` — `0` is how several of
 * this module's knobs disable their gate/ceiling entirely, mirroring the
 * "0 disables" convention `LIVE_ACTIVITY_LOOKBACK_SECONDS` already uses
 * elsewhere in this job.
 */
const envNonNegativeInt = (name: string, fallback: number): number =>
  parseEnvInt(
    name,
    fallback,
    'non-negative',
    (raw) => `lml-health: ${name}=${raw} is invalid (must be a non-negative number); using fallback ${fallback}`
  );

export const BREAKER_PROBE_INTERVAL_MS_DEFAULT = 30_000;
export const BREAKER_PAUSE_MS_DEFAULT = 30_000;
export const BREAKER_PROBE_TIMEOUT_MS_DEFAULT = 5_000;
/**
 * 30 minutes — mirrors the `LIVE_ACTIVITY_MAX_PAUSE_MS` precedent
 * (`jobs/rotation-release-id-pollution-check`, BS#1636): "cumulative pause
 * budget per run, added so a sustained live show can't wedge the run."
 * Same shape, different trigger (a non-closed breaker instead of DJ
 * activity) — a wedged breaker gets the same loud-abort treatment a
 * wedged cooperative-pause loop already gets elsewhere in this fleet.
 */
export const BREAKER_MAX_PAUSE_MS_DEFAULT = 1_800_000;

/**
 * BS#1995 review B1: wall-clock milliseconds between breaker probes,
 * checked cheaply on every row but only actually firing the `/health`
 * network call once the interval has elapsed (see `orchestrate.ts`'s
 * `waitForClosedBreaker`). `0` disables the gate entirely (no probes are
 * ever made; the drain always fails open). Keep this at or above ~30s in
 * production — see the module docstring's cost note: every probe is a live
 * Discogs call when the breaker is closed. Read fresh on every call (not
 * cached at module scope) so tests can drive it without a process restart.
 */
export const resolveBreakerProbeIntervalMs = (): number =>
  envNonNegativeInt('BACKFILL_BREAKER_PROBE_INTERVAL_MS', BREAKER_PROBE_INTERVAL_MS_DEFAULT);

/** Sleep between re-probes while the breaker stays non-`closed`. */
export const resolveBreakerPauseMs = (): number =>
  envNonNegativeInt('BACKFILL_BREAKER_PAUSE_MS', BREAKER_PAUSE_MS_DEFAULT);

/** `/health` request's own abort budget — deliberately small; this is a cheap read. */
export const resolveBreakerProbeTimeoutMs = (): number =>
  envPositiveInt('BACKFILL_BREAKER_PROBE_TIMEOUT_MS', BREAKER_PROBE_TIMEOUT_MS_DEFAULT);

/**
 * BS#1995 review B3: cumulative pause-time ceiling across the whole run.
 * `0` uncapped (not recommended in production — mirrors
 * `LIVE_ACTIVITY_MAX_PAUSE_MS`'s own "keep non-zero in production" note).
 */
export const resolveBreakerMaxPauseMs = (): number =>
  envNonNegativeInt('BACKFILL_BREAKER_MAX_PAUSE_MS', BREAKER_MAX_PAUSE_MS_DEFAULT);

/**
 * Fetch and parse LML's `/health` body. Throws on network failure, abort,
 * or an unreadable (non-JSON) body — callers that want fail-open behavior
 * (i.e. everyone in this job) should go through `probeDiscogsBreaker`
 * instead, which catches this. Deliberately does NOT throw on a non-2xx
 * status — see the module docstring's cost note for why: LML's `/health`
 * only returns non-2xx when its CORE probe fails, and a genuinely degraded
 * response MAY still carry a readable `discogs_breaker_state`.
 */
export const fetchLmlHealthSnapshot = async (
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = resolveBreakerProbeTimeoutMs()
): Promise<LmlHealthSnapshot> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl()}${HEALTH_PATH}`, { signal: controller.signal });
    const body = (await response.json()) as Record<string, unknown>;
    return {
      discogs_breaker_state: parseBreakerState(body.discogs_breaker_state),
      discogs_live_requests_total: parseLiveRequestsTotal(body.discogs_live_requests_total),
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new Error(`LML /health probe timed out after ${timeoutMs}ms`, { cause: e });
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Probe the Discogs breaker, never throwing — network/timeout/non-2xx/bad
 * body all collapse to `{ outcome: 'probe_error' }` so a health-probe
 * outage fails open instead of wedging the drain (see module docstring).
 */
export const probeDiscogsBreaker = async (
  fetchImpl: FetchLike = fetch,
  timeoutMs?: number
): Promise<BreakerProbeResult> => {
  try {
    const snapshot = await fetchLmlHealthSnapshot(fetchImpl, timeoutMs ?? resolveBreakerProbeTimeoutMs());
    if (snapshot.discogs_breaker_state === null) {
      return { outcome: 'unconfigured', liveRequestsTotal: snapshot.discogs_live_requests_total };
    }
    return { outcome: snapshot.discogs_breaker_state, liveRequestsTotal: snapshot.discogs_live_requests_total };
  } catch (error) {
    return {
      outcome: 'probe_error',
      liveRequestsTotal: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** `true` only for a confirmed non-`closed` breaker — every other outcome fails open. */
export const shouldPauseForBreaker = (result: BreakerProbeResult): boolean =>
  result.outcome === 'open' || result.outcome === 'half_open';
