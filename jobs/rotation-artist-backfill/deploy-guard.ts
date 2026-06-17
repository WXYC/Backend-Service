/**
 * Deploy guard for rotation-artist-backfill (BS#1381, BS#1438).
 *
 * The job is a no-op against any LML deploy that predates LML#525's
 * `POST /api/v1/cache/refresh-for-identities` endpoint (`8a1344c`,
 * library-metadata-lookup PR #559) — without it the cron has nothing
 * to call against. So before scanning any rotation rows we hit LML's
 * `/health` and verify that its `commit_sha` is `8a1344c` or a descendant
 * of it.
 *
 * BS#1438: LML prod serves `commit_sha: null` permanently — it deploys via
 * `railway up`, whose CLI source-deploys carry no git metadata (LML#509). The
 * SHA-descendant check can therefore never succeed against prod, so when the
 * sha is null (and not LOCAL_DEV) the guard falls back to probing the endpoint
 * directly rather than aborting. See `probeRefreshEndpoint`. The probe is the
 * path that actually runs in production until LML#509 changes LML's deploy
 * method.
 *
 * Why gate on the endpoint and not the `fetched_at` discriminator that
 * the previous incarnation (BS#1361, PR #1376) gated on: the discriminator
 * is still load-bearing under the hood — LML#525's per-source release
 * refresh multiplexes onto the same fallthrough seam — but BS no longer
 * touches `/discogs/release/{id}` or `/discogs/artist/{id}` directly,
 * so gating on the discriminator's commit would let an older LML deploy
 * (without the refresh endpoint) sneak past as "descendant" and 404 every
 * batch. Gating on the endpoint's introducing commit catches both: it
 * descends from LML#503, and from the LML#525 prep commits (LML PR #557
 * and #558).
 *
 * Surfaces:
 *   - `commit_sha` is null AND `LOCAL_DEV=1` is set → allowed (local dev,
 *     CI, and unit tests, where Railway's `RAILWAY_GIT_COMMIT_SHA` is
 *     unset). The flag must be explicit so an accidental
 *     production env-var drop doesn't silently neuter the guard. Short-
 *     circuits before the endpoint probe.
 *   - `commit_sha` is null AND `LOCAL_DEV` is not set → probe the endpoint
 *     (BS#1438): mounted → allowed; absent (404/405) → ABORT; network /
 *     timeout → ABORT.
 *   - `commit_sha` is the gate sha itself OR a descendant → allowed.
 *   - `commit_sha` is anything else → ABORT.
 *
 * The descendant check uses GitHub's `repos/.../compare/<base>...<head>` API.
 * `status: "identical" | "ahead"` means `head` is `base` or a descendant of
 * it. The cron container does not ship a git clone, so this is the only
 * mechanism that doesn't add a clone-the-repo step.
 *
 * GitHub auth: optional. The compare API works unauthenticated for public
 * repos at 60 req/h, which is fine for a once-a-day cron. If `GITHUB_TOKEN`
 * is set we send it for the 5000 req/h tier (and to dodge any future
 * rate-limit tightening).
 */

const LML_BASE_URL_ENV = 'LIBRARY_METADATA_URL';
const HEALTH_PATH = '/health';
const REFRESH_PATH = '/api/v1/cache/refresh-for-identities';

const HEALTH_TIMEOUT_MS = 10_000;
const COMPARE_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * HTTP statuses that mean `POST /api/v1/cache/refresh-for-identities` is NOT
 * present as a POST handler on this LML deploy:
 *   - 404 — the route isn't mounted (a deploy predating LML#525).
 *   - 405 — the path resolves but POST isn't allowed (i.e. not the handler
 *     LML#525 introduced).
 * Every other status — 422 (Pydantic `min_length=1` rejects the empty batch),
 * 400 (manual malformed/over-cap reject), 401/403 (`LML_REQUIRE_AUTH` gate),
 * 200 (no-op), 503 (entity store / Discogs degraded) — proves the route IS
 * mounted, which is the only question this probe answers. See `probeRefreshEndpoint`.
 */
const ENDPOINT_ABSENT_STATUSES = new Set([404, 405]);

/** LML#525: `POST /api/v1/cache/refresh-for-identities` shipped (LML PR #559). */
export const GATE_COMMIT_SHA = '8a1344c';

/** Owner/repo for the GitHub compare API. */
export const LML_REPO = 'WXYC/library-metadata-lookup';

export type HealthResponse = {
  commit_sha?: string | null;
  [key: string]: unknown;
};

export class DeployGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployGuardError';
  }
}

const baseUrl = (): string => {
  const url = process.env[LML_BASE_URL_ENV];
  if (!url) {
    throw new DeployGuardError(`${LML_BASE_URL_ENV} is not configured`);
  }
  return url.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
};

type FetchLike = typeof fetch;

export type DeployGuardDeps = {
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injected for tests. Defaults to `process.env.LOCAL_DEV === '1'`. */
  isLocalDev?: () => boolean;
};

const defaultIsLocalDev = (): boolean => process.env.LOCAL_DEV === '1';

/**
 * Fetch LML's `/health` body. Throws on non-2xx, abort, or network failure.
 */
export const fetchLmlHealth = async (
  fetchImpl: FetchLike = fetch,
  signalTimeoutMs: number = HEALTH_TIMEOUT_MS
): Promise<HealthResponse> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalTimeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl()}${HEALTH_PATH}`, { signal: controller.signal });
    if (!response.ok) {
      throw new DeployGuardError(`LML /health responded ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as HealthResponse;
  } catch (e) {
    if (e instanceof DeployGuardError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new DeployGuardError(`LML /health timed out after ${signalTimeoutMs}ms`);
    }
    throw new DeployGuardError(`LML /health request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Probe whether LML exposes `POST /api/v1/cache/refresh-for-identities`
 * (the endpoint LML#525 introduced, which this backfill needs to make any
 * progress). Returns `true` when the route is mounted, `false` when it is
 * absent (404/405); throws `DeployGuardError` on network failure or timeout.
 *
 * Why this exists: LML prod serves `/health.commit_sha = null` permanently
 * (it deploys via `railway up`, whose CLI source-deploys carry no git
 * metadata — LML#509 / BS#1438), so the SHA-descendant gate can never succeed
 * against prod. The probe asks the real question the SHA was only a proxy for:
 * does the endpoint exist? The path was introduced by the gate commit itself,
 * so "route mounted" is equivalent to "this LML has LML#525" — no older
 * same-named endpoint exists to confuse the signal.
 *
 * The probe sends an empty `identity_ids: []` batch. That body is genuinely
 * zero-work: LML rejects it at request-model validation (`min_length=1` → 422)
 * before reading provenance or touching Discogs, so the probe warms no cache
 * and burns no Discogs budget (verified against `cache/router.py` /
 * `cache/models.py` in library-metadata-lookup). The `LML_API_KEY` bearer is
 * attached when set (mirroring the lml-client chokepoint) so an
 * `LML_REQUIRE_AUTH=true` prod returns 422 rather than 401 — though either is
 * treated as "present" since only 404/405 mean absent.
 */
export const probeRefreshEndpoint = async (
  fetchImpl: FetchLike = fetch,
  signalTimeoutMs: number = PROBE_TIMEOUT_MS
): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalTimeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.LML_API_KEY;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${baseUrl()}${REFRESH_PATH}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ identity_ids: [] }),
      signal: controller.signal,
    });
    return !ENDPOINT_ABSENT_STATUSES.has(response.status);
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new DeployGuardError(`LML cache-refresh probe timed out after ${signalTimeoutMs}ms`);
    }
    throw new DeployGuardError(`LML cache-refresh probe request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Ask GitHub whether `head` is the same as `base` or a descendant of it.
 *
 * Returns true iff the compare API reports `status` of `identical` or
 * `ahead` — the only two cases where every commit in `base..head` is on
 * `head`'s history. `behind` and `diverged` mean `head` is missing one or
 * more commits from `base`, which is exactly what we need to refuse.
 */
export const isDescendantOnGithub = async (
  base: string,
  head: string,
  fetchImpl: FetchLike = fetch,
  signalTimeoutMs: number = COMPARE_TIMEOUT_MS
): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), signalTimeoutMs);
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    // URL-encode `base` and `head` so a malformed sha containing `?`, `#`,
    // `/`, or `..` can't change the request path semantics. `compare`
    // treats the basehead range as opaque ref strings — encoding is safe
    // for the all-hex case AND defensive against an LML /health regression
    // that emits a non-sha value.
    const range = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const response = await fetchImpl(`https://api.github.com/repos/${LML_REPO}/compare/${range}`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new DeployGuardError(
        `GitHub compare ${base}...${head} responded ${response.status} ${response.statusText}`
      );
    }
    const body = (await response.json()) as { status?: string };
    return body.status === 'identical' || body.status === 'ahead';
  } catch (e) {
    if (e instanceof DeployGuardError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new DeployGuardError(`GitHub compare timed out after ${signalTimeoutMs}ms`);
    }
    throw new DeployGuardError(`GitHub compare request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
};

export type DeployGuardResult = { allowed: true; commit_sha: string | null; reason: string };

/**
 * Enforce the deploy gate. Returns a structured allow record on success;
 * throws `DeployGuardError` on any abort condition.
 */
export const enforceDeployGuard = async (deps: DeployGuardDeps = {}): Promise<DeployGuardResult> => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const isLocalDev = deps.isLocalDev ?? defaultIsLocalDev;

  const health = await fetchLmlHealth(fetchImpl);
  const sha = health.commit_sha ?? null;

  if (sha === null) {
    if (isLocalDev()) {
      return { allowed: true, commit_sha: null, reason: 'LOCAL_DEV=1; commit_sha unavailable' };
    }
    // LML prod serves commit_sha=null permanently (deploys via `railway up`,
    // which carries no git metadata — LML#509 / BS#1438), so the SHA-descendant
    // path below can never succeed against prod. Fall back to asking the real
    // question the SHA was only a proxy for: is the LML#525 endpoint actually
    // mounted? A network/timeout failure rethrows from the probe (ABORT); only
    // a definitive 404/405 (endpoint absent) reaches the throw here.
    const present = await probeRefreshEndpoint(fetchImpl);
    if (!present) {
      throw new DeployGuardError(
        'LML /health returned commit_sha=null and the endpoint probe found ' +
          'POST /api/v1/cache/refresh-for-identities absent (404/405). Refusing to run — ' +
          'the LML#525 endpoint is required for this backfill to make progress.'
      );
    }
    return {
      allowed: true,
      commit_sha: null,
      reason: 'commit_sha null; endpoint probe confirms POST /api/v1/cache/refresh-for-identities is present',
    };
  }

  if (sha.startsWith(GATE_COMMIT_SHA)) {
    return { allowed: true, commit_sha: sha, reason: `commit_sha matches gate ${GATE_COMMIT_SHA}` };
  }

  const ok = await isDescendantOnGithub(GATE_COMMIT_SHA, sha, fetchImpl);
  if (!ok) {
    throw new DeployGuardError(
      `LML commit_sha ${sha} is not a descendant of gate ${GATE_COMMIT_SHA} (LML#525). Refusing to run — POST /api/v1/cache/refresh-for-identities is required for this backfill to make progress.`
    );
  }
  return { allowed: true, commit_sha: sha, reason: `commit_sha ${sha} descends from gate ${GATE_COMMIT_SHA}` };
};
