/**
 * Deploy guard for rotation-artist-backfill (BS#1361, acceptance bullet 2).
 *
 * The job is a no-op against any LML deploy that predates LML#503's
 * `fetched_at` discriminator (`3e54907`) — without that discriminator,
 * the bulk-rebuild stub rows never get refreshed and the cron burns
 * Discogs API budget for nothing. So before scanning any rotation rows
 * we hit LML's `/health` and verify that its `commit_sha` is `3e54907`
 * or a descendant of it.
 *
 * Surfaces:
 *   - `commit_sha` is null AND `LOCAL_DEV=1` is set → allowed (local dev,
 *     CI, and unit tests, where Railway's `RAILWAY_GIT_COMMIT_SHA` is
 *     unset). The flag must be explicit so an accidental
 *     production env-var drop doesn't silently neuter the guard.
 *   - `commit_sha` is null AND `LOCAL_DEV` is not set → ABORT (treated as
 *     a misconfigured prod deploy).
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

const HEALTH_TIMEOUT_MS = 10_000;
const COMPARE_TIMEOUT_MS = 15_000;

/** LML#503: stub rows are now treated as cache misses via `fetched_at`. */
export const GATE_COMMIT_SHA = '3e54907';

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
    throw new DeployGuardError(
      'LML /health returned commit_sha=null but LOCAL_DEV is not set. Refusing to run against an LML deploy whose SHA cannot be verified.'
    );
  }

  if (sha.startsWith(GATE_COMMIT_SHA)) {
    return { allowed: true, commit_sha: sha, reason: `commit_sha matches gate ${GATE_COMMIT_SHA}` };
  }

  const ok = await isDescendantOnGithub(GATE_COMMIT_SHA, sha, fetchImpl);
  if (!ok) {
    throw new DeployGuardError(
      `LML commit_sha ${sha} is not a descendant of gate ${GATE_COMMIT_SHA} (LML#503). Refusing to run — the fetched_at discriminator is required for this backfill to make progress.`
    );
  }
  return { allowed: true, commit_sha: sha, reason: `commit_sha ${sha} descends from gate ${GATE_COMMIT_SHA}` };
};
