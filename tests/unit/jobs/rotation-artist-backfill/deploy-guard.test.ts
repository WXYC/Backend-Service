/**
 * Unit tests for jobs/rotation-artist-backfill/deploy-guard.ts (BS#1381, BS#1438).
 *
 * Covers the allow/deny shapes:
 *   1. commit_sha matches the gate (GATE_COMMIT_SHA prefix) → allowed.
 *   2. commit_sha descends from the gate (per GitHub compare) → allowed.
 *   3. commit_sha is null AND LOCAL_DEV=1 → allowed (no endpoint probe).
 *   4. commit_sha is null, not LOCAL_DEV, endpoint probe present → allowed (BS#1438).
 *   5. commit_sha is null, not LOCAL_DEV, endpoint probe absent (404/405) → throw (BS#1438).
 *   6. commit_sha does NOT descend from the gate → throw.
 *   7. /health non-2xx, network errors, GitHub compare non-2xx, probe network/timeout → throw.
 */

import { jest } from '@jest/globals';

import {
  DeployGuardError,
  GATE_COMMIT_SHA,
  enforceDeployGuard,
  fetchLmlHealth,
  isDescendantOnGithub,
  probeRefreshEndpoint,
} from '../../../../jobs/rotation-artist-backfill/deploy-guard';

const ORIGINAL_ENV = process.env;

const makeResponse = (body: unknown, init: { status?: number; statusText?: string } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });

const makeFetch = (impls: Array<(url: string) => Response | Promise<Response>>): jest.Mock => {
  let i = 0;
  return jest.fn().mockImplementation((url: string) => {
    const impl = impls[Math.min(i++, impls.length - 1)];
    return Promise.resolve(impl(url));
  });
};

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.LIBRARY_METADATA_URL = 'http://lml.test';
  delete process.env.LOCAL_DEV;
  delete process.env.GITHUB_TOKEN;
  delete process.env.LML_API_KEY;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('fetchLmlHealth', () => {
  it('returns the JSON body on a 200 response', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ status: 'ok', commit_sha: 'abc123' })]);
    const body = await fetchLmlHealth(fetchImpl as unknown as typeof fetch);
    expect(body.commit_sha).toBe('abc123');
  });

  it('throws DeployGuardError on a non-2xx response', async () => {
    const fetchImpl = makeFetch([() => makeResponse({}, { status: 503, statusText: 'Service Unavailable' })]);
    await expect(fetchLmlHealth(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DeployGuardError);
  });

  it('throws DeployGuardError when LIBRARY_METADATA_URL is unset', async () => {
    delete process.env.LIBRARY_METADATA_URL;
    const fetchImpl = jest.fn();
    await expect(fetchLmlHealth(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DeployGuardError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('strips a trailing /api/v1 from LIBRARY_METADATA_URL when building the health URL', async () => {
    process.env.LIBRARY_METADATA_URL = 'http://lml.test/api/v1';
    let seen = '';
    const fetchImpl = makeFetch([
      (url) => {
        seen = url;
        return makeResponse({ status: 'ok', commit_sha: 'abc' });
      },
    ]);
    await fetchLmlHealth(fetchImpl as unknown as typeof fetch);
    expect(seen).toBe('http://lml.test/health');
  });
});

describe('isDescendantOnGithub', () => {
  it('returns true when status=ahead', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ status: 'ahead' })]);
    const ok = await isDescendantOnGithub(GATE_COMMIT_SHA, 'abcdef', fetchImpl as unknown as typeof fetch);
    expect(ok).toBe(true);
  });

  it('returns true when status=identical', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ status: 'identical' })]);
    const ok = await isDescendantOnGithub(GATE_COMMIT_SHA, GATE_COMMIT_SHA, fetchImpl as unknown as typeof fetch);
    expect(ok).toBe(true);
  });

  it('returns false when status=behind', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ status: 'behind' })]);
    const ok = await isDescendantOnGithub(GATE_COMMIT_SHA, 'older', fetchImpl as unknown as typeof fetch);
    expect(ok).toBe(false);
  });

  it('returns false when status=diverged', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ status: 'diverged' })]);
    const ok = await isDescendantOnGithub(GATE_COMMIT_SHA, 'forked', fetchImpl as unknown as typeof fetch);
    expect(ok).toBe(false);
  });

  it('throws on non-2xx compare API responses', async () => {
    const fetchImpl = makeFetch([() => makeResponse({}, { status: 404, statusText: 'Not Found' })]);
    await expect(
      isDescendantOnGithub(GATE_COMMIT_SHA, 'unknown', fetchImpl as unknown as typeof fetch)
    ).rejects.toBeInstanceOf(DeployGuardError);
  });

  it('forwards GITHUB_TOKEN as a bearer header when set', async () => {
    process.env.GITHUB_TOKEN = 'tok_abc';
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(makeResponse({ status: 'ahead' }));
    });
    await isDescendantOnGithub('a', 'b', fetchImpl as unknown as typeof fetch);
    expect(seenHeaders.Authorization).toBe('Bearer tok_abc');
  });

  it('omits Authorization when GITHUB_TOKEN is unset', async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(makeResponse({ status: 'ahead' }));
    });
    await isDescendantOnGithub('a', 'b', fetchImpl as unknown as typeof fetch);
    expect(seenHeaders.Authorization).toBeUndefined();
  });

  it('URL-encodes base and head so a malformed sha cannot reshape the request path', async () => {
    let seenUrl = '';
    const fetchImpl = jest.fn().mockImplementation((url: string) => {
      seenUrl = url;
      return Promise.resolve(makeResponse({ status: 'ahead' }));
    });
    // `?` would otherwise start a query string; `/` would shift the path.
    await isDescendantOnGithub(GATE_COMMIT_SHA, 'abc?foo=bar', fetchImpl as unknown as typeof fetch);
    expect(seenUrl).toContain(`${GATE_COMMIT_SHA}...abc%3Ffoo%3Dbar`);
    expect(seenUrl).not.toContain('?foo=bar');
  });
});

describe('probeRefreshEndpoint', () => {
  it('returns true when the endpoint rejects the empty batch with 422 (present)', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ detail: 'empty' }, { status: 422 })]);
    const present = await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(present).toBe(true);
  });

  it('returns false on 404 (route not mounted — older LML deploy)', async () => {
    const fetchImpl = makeFetch([
      () => makeResponse({ detail: 'Not Found' }, { status: 404, statusText: 'Not Found' }),
    ]);
    const present = await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(present).toBe(false);
  });

  it('returns false on 405 (path resolves but POST not allowed)', async () => {
    const fetchImpl = makeFetch([() => makeResponse({}, { status: 405, statusText: 'Method Not Allowed' })]);
    const present = await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(present).toBe(false);
  });

  // Every non-404/405 status proves the route is mounted — that is all the gate
  // needs. 401/403 (auth gate), 400 (manual reject), 200 (no-op), 503 (degraded
  // dependency) all mean "present".
  it.each([200, 400, 401, 403, 503])('returns true on %d (route is mounted)', async (status) => {
    const fetchImpl = makeFetch([() => makeResponse({ detail: String(status) }, { status })]);
    const present = await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(present).toBe(true);
  });

  it('POSTs an empty identity_ids batch to the refresh path (zero-work probe)', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    const fetchImpl = jest.fn().mockImplementation((url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init ?? {};
      return Promise.resolve(makeResponse({}, { status: 422 }));
    });
    await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(seenUrl).toBe('http://lml.test/api/v1/cache/refresh-for-identities');
    expect(seenInit.method).toBe('POST');
    expect(JSON.parse(seenInit.body as string)).toEqual({ identity_ids: [] });
  });

  it('attaches the LML_API_KEY bearer header when set', async () => {
    process.env.LML_API_KEY = 'secret-key';
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(makeResponse({}, { status: 422 }));
    });
    await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(seenHeaders.Authorization).toBe('Bearer secret-key');
  });

  it('omits Authorization when LML_API_KEY is unset', async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return Promise.resolve(makeResponse({}, { status: 422 }));
    });
    await probeRefreshEndpoint(fetchImpl as unknown as typeof fetch);
    expect(seenHeaders.Authorization).toBeUndefined();
  });

  it('throws DeployGuardError on a network failure (ABORT, never silently allow)', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(probeRefreshEndpoint(fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(DeployGuardError);
  });

  it('throws DeployGuardError when the probe times out', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = jest.fn().mockImplementation(() => Promise.reject(abortErr));
    await expect(probeRefreshEndpoint(fetchImpl as unknown as typeof fetch, 5)).rejects.toBeInstanceOf(
      DeployGuardError
    );
  });
});

describe('enforceDeployGuard', () => {
  it('passes when commit_sha is the gate sha itself', async () => {
    const fetchImpl = makeFetch([() => makeResponse({ commit_sha: `${GATE_COMMIT_SHA}deadbeef` })]);
    const result = await enforceDeployGuard({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.allowed).toBe(true);
    expect(result.commit_sha).toBe(`${GATE_COMMIT_SHA}deadbeef`);
    // No second fetch — we short-circuited before the compare call.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes when commit_sha descends from the gate (GitHub compare = ahead)', async () => {
    const fetchImpl = makeFetch([
      () => makeResponse({ commit_sha: 'newer123' }),
      () => makeResponse({ status: 'ahead' }),
    ]);
    const result = await enforceDeployGuard({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.allowed).toBe(true);
    expect(result.commit_sha).toBe('newer123');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects when commit_sha does not descend from the gate', async () => {
    const fetchImpl = makeFetch([
      () => makeResponse({ commit_sha: 'older123' }),
      () => makeResponse({ status: 'behind' }),
    ]);
    await expect(enforceDeployGuard({ fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(
      DeployGuardError
    );
  });

  it('passes when commit_sha is null and LOCAL_DEV=1 without probing the endpoint', async () => {
    process.env.LOCAL_DEV = '1';
    const fetchImpl = makeFetch([() => makeResponse({ commit_sha: null })]);
    const result = await enforceDeployGuard({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // Explicit isLocalDev to keep the test independent of env wiring.
      isLocalDev: () => true,
    });
    expect(result.allowed).toBe(true);
    expect(result.commit_sha).toBeNull();
    // Only /health — LOCAL_DEV short-circuits before the endpoint probe.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes when commit_sha is null, not LOCAL_DEV, and the endpoint probe finds it present', async () => {
    const fetchImpl = makeFetch([
      () => makeResponse({ commit_sha: null }),
      () => makeResponse({ detail: 'empty' }, { status: 422 }),
    ]);
    const result = await enforceDeployGuard({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      isLocalDev: () => false,
    });
    expect(result.allowed).toBe(true);
    expect(result.commit_sha).toBeNull();
    // /health then the endpoint probe — the SHA-descendant path is skipped.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.reason).toMatch(/probe/i);
  });

  it('refuses when commit_sha is null, not LOCAL_DEV, and the endpoint probe finds it absent (404)', async () => {
    const fetchImpl = makeFetch([
      () => makeResponse({ commit_sha: null }),
      () => makeResponse({ detail: 'Not Found' }, { status: 404, statusText: 'Not Found' }),
    ]);
    await expect(
      enforceDeployGuard({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        isLocalDev: () => false,
      })
    ).rejects.toBeInstanceOf(DeployGuardError);
  });

  it('does not hit the compare API when the gate prefix matches', async () => {
    // Regression: a future tightening could accidentally always call compare.
    // The gate prefix check is meant to short-circuit because compare against
    // identical shas is wasted budget and racy on freshly-pushed commits.
    let comparesIssued = 0;
    const fetchImpl = jest.fn().mockImplementation((url: string) => {
      if (url.includes('compare')) comparesIssued += 1;
      if (url.includes('/health')) return Promise.resolve(makeResponse({ commit_sha: `${GATE_COMMIT_SHA}xyz` }));
      return Promise.resolve(makeResponse({ status: 'ahead' }));
    });
    await enforceDeployGuard({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(comparesIssued).toBe(0);
  });
});
