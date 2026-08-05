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
 * `routers/health.py:268`). This module polls that signal on a deliberately
 * low duty cycle (once per batch, never per row — see orchestrate.ts's
 * `waitForClosedBreaker`) and reports a result the orchestrator gates the
 * drain on: a `closed` (or `unconfigured` — no Discogs upstream to protect)
 * breaker lets the batch proceed; `open` / `half_open` pauses it.
 *
 * Fails OPEN by design: a `/health` request that times out, network-errors,
 * or returns a non-2xx is reported as `probe_error` and treated exactly like
 * `closed` — the drain keeps running. A health-probe outage must never wedge
 * the drain; that would trade one incident (an unnoticed breaker flap) for a
 * worse one (a stuck cron). The probe failure is logged so an operator can
 * still notice a persistently-unreachable LML.
 *
 * Structurally mirrors `jobs/rotation-artist-backfill/deploy-guard.ts`'s
 * `fetchLmlHealth` (same base-URL resolution, same AbortController +
 * timeout + error-translation scaffold) rather than inventing a second LML
 * `/health` client shape in the tree.
 */

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
 * `Number()`-based env-int parser, warn-and-fallback on invalid — matches
 * `lml-fetch.ts` / `lml-limiter.ts`'s convention (not the throw-on-invalid
 * `requireNonNegativeInt` family `orchestrate.ts`'s own resolvers use for
 * the pre-existing cooperative-pause knobs). This gate is new and
 * operationally low-stakes enough that a bad env value should degrade to
 * the safe default with a loud warning, not abort the cron at startup.
 */
const envPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`lml-health: ${name}=${raw} is invalid (must be a positive number); using fallback ${fallback}`);
  return fallback;
};

/**
 * Same shape as `envPositiveInt`, but accepts `0` — `0` is how
 * `BACKFILL_BREAKER_PROBE_INTERVAL_BATCHES` disables the gate entirely,
 * mirroring the "0 disables" convention `LIVE_ACTIVITY_LOOKBACK_SECONDS`
 * already uses elsewhere in this job.
 */
const envNonNegativeInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  console.warn(`lml-health: ${name}=${raw} is invalid (must be a non-negative number); using fallback ${fallback}`);
  return fallback;
};

export const BREAKER_PROBE_INTERVAL_BATCHES_DEFAULT = 1;
export const BREAKER_PAUSE_MS_DEFAULT = 30_000;
export const BREAKER_PROBE_TIMEOUT_MS_DEFAULT = 5_000;

/**
 * How many batches elapse between breaker probes. `1` (default) probes
 * every batch — already "per batch, not per row." `0` disables the gate
 * entirely (no probes are ever made; the drain always fails open). Read
 * fresh on every call (not cached at module scope) so tests can drive it
 * without a process restart.
 */
export const resolveBreakerProbeIntervalBatches = (): number =>
  envNonNegativeInt('BACKFILL_BREAKER_PROBE_INTERVAL_BATCHES', BREAKER_PROBE_INTERVAL_BATCHES_DEFAULT);

/** Sleep between re-probes while the breaker stays non-`closed`. */
export const resolveBreakerPauseMs = (): number =>
  envNonNegativeInt('BACKFILL_BREAKER_PAUSE_MS', BREAKER_PAUSE_MS_DEFAULT);

/** `/health` request's own abort budget — deliberately small; this is a cheap read. */
export const resolveBreakerProbeTimeoutMs = (): number =>
  envPositiveInt('BACKFILL_BREAKER_PROBE_TIMEOUT_MS', BREAKER_PROBE_TIMEOUT_MS_DEFAULT);

/**
 * Fetch and parse LML's `/health` body. Throws on network failure, abort,
 * or a non-2xx response — callers that want fail-open behavior (i.e.
 * everyone in this job) should go through `probeDiscogsBreaker` instead,
 * which catches this.
 */
export const fetchLmlHealthSnapshot = async (
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = resolveBreakerProbeTimeoutMs()
): Promise<LmlHealthSnapshot> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl()}${HEALTH_PATH}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`LML /health responded ${response.status} ${response.statusText}`);
    }
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
