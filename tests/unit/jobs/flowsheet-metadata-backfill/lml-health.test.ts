/**
 * Unit tests for jobs/flowsheet-metadata-backfill/lml-health.ts (BS#1995 Arm 2,
 * updated for the review B1/B3 redesign).
 *
 * Covers:
 *   1. fetchLmlHealthSnapshot parses discogs_breaker_state / discogs_live_requests_total
 *      regardless of HTTP status (B1/D1 review follow-up — LML's /health returns
 *      503 only on a core-service failure, not a Discogs-breaker-only degradation,
 *      but a genuinely degraded body may still carry a readable state); throws on
 *      network failure / timeout / an unreadable body / missing LIBRARY_METADATA_URL.
 *   2. probeDiscogsBreaker never throws: closed/open/half_open pass through;
 *      a null breaker state (Discogs unconfigured) maps to 'unconfigured';
 *      any fetchLmlHealthSnapshot throw maps to 'probe_error' with the message captured.
 *   3. shouldPauseForBreaker is true only for open/half_open.
 *   4. resolveBreakerProbeIntervalMs / resolveBreakerPauseMs / resolveBreakerProbeTimeoutMs /
 *      resolveBreakerMaxPauseMs read their env vars via the shared parseEnvInt helper.
 */

import { jest } from '@jest/globals';

import {
  BREAKER_MAX_PAUSE_MS_DEFAULT,
  BREAKER_PAUSE_MS_DEFAULT,
  BREAKER_PROBE_INTERVAL_MS_DEFAULT,
  BREAKER_PROBE_TIMEOUT_MS_DEFAULT,
  BreakerPauseCeilingExceededError,
  fetchLmlHealthSnapshot,
  probeDiscogsBreaker,
  resolveBreakerMaxPauseMs,
  resolveBreakerPauseMs,
  resolveBreakerProbeIntervalMs,
  resolveBreakerProbeTimeoutMs,
  shouldPauseForBreaker,
} from '../../../../jobs/flowsheet-metadata-backfill/lml-health';

const ORIGINAL_ENV = process.env;

const makeResponse = (body: unknown, init: { status?: number; statusText?: string } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });

const makeFetch = (impl: (url: string) => Response | Promise<Response>): jest.Mock =>
  jest.fn().mockImplementation((url: string) => Promise.resolve(impl(url)));

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.LIBRARY_METADATA_URL = 'http://lml.test';
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('fetchLmlHealthSnapshot', () => {
  it('parses discogs_breaker_state and discogs_live_requests_total from a 200 body', async () => {
    const fetchImpl = makeFetch(() =>
      makeResponse({ status: 'ok', discogs_breaker_state: 'closed', discogs_live_requests_total: 42 })
    );

    const snapshot = await fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000);

    expect(snapshot).toEqual({ discogs_breaker_state: 'closed', discogs_live_requests_total: 42 });
  });

  it('parses a null discogs_breaker_state (Discogs unconfigured) as null, not a throw', async () => {
    const fetchImpl = makeFetch(() => makeResponse({ discogs_breaker_state: null, discogs_live_requests_total: null }));

    const snapshot = await fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000);

    expect(snapshot).toEqual({ discogs_breaker_state: null, discogs_live_requests_total: null });
  });

  it('treats an unrecognized breaker_state string as null (forward-compatible, not a crash)', async () => {
    const fetchImpl = makeFetch(() => makeResponse({ discogs_breaker_state: 'some_future_state' }));

    const snapshot = await fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000);

    expect(snapshot.discogs_breaker_state).toBeNull();
  });

  it('strips a trailing /api/v1 from LIBRARY_METADATA_URL when building the health URL', async () => {
    process.env.LIBRARY_METADATA_URL = 'http://lml.test/api/v1';
    let seen = '';
    const fetchImpl = makeFetch((url) => {
      seen = url;
      return makeResponse({ discogs_breaker_state: 'closed' });
    });

    await fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000);

    expect(seen).toBe('http://lml.test/health');
  });

  // BS#1995 review follow-up (B1/D1 discussion): the reviewer's original claim
  // that "LML returns 503 with a valid discogs_breaker_state, so the gate
  // fails open precisely when LML is worst off" does not hold — LML returns
  // 503 only when its CORE (database) probe fails, and a non-closed Discogs
  // breaker alone keeps the overall response at 200. Still, parsing the body
  // regardless of status is a cheap robustness win: a genuinely degraded LML,
  // or an intermediary proxy relaying LML's body under its own status code,
  // may still carry a readable breaker state, and refusing to look would
  // blind the gate for no reason.
  it('parses a readable discogs_breaker_state from a non-2xx (503) body instead of throwing', async () => {
    const fetchImpl = makeFetch(() =>
      makeResponse(
        { status: 'degraded', discogs_breaker_state: 'open', discogs_live_requests_total: 12 },
        { status: 503, statusText: 'Service Unavailable' }
      )
    );

    const snapshot = await fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000);

    expect(snapshot).toEqual({ discogs_breaker_state: 'open', discogs_live_requests_total: 12 });
  });

  it('a non-2xx body with no readable discogs_breaker_state parses to null, not a throw', async () => {
    const fetchImpl = makeFetch(() =>
      makeResponse({ status: 'unhealthy' }, { status: 503, statusText: 'Service Unavailable' })
    );

    const snapshot = await fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000);

    expect(snapshot).toEqual({ discogs_breaker_state: null, discogs_live_requests_total: null });
  });

  it('throws when LIBRARY_METADATA_URL is unset', async () => {
    delete process.env.LIBRARY_METADATA_URL;
    const fetchImpl = jest.fn();

    await expect(fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000)).rejects.toThrow(
      /LIBRARY_METADATA_URL/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates an aborted request into a timeout message', async () => {
    const fetchImpl = jest.fn().mockImplementation(() => {
      const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
      return Promise.reject(abortErr);
    });

    await expect(fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 5)).rejects.toThrow(
      /timed out after 5ms/
    );
  });

  it('propagates a plain network failure', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000)).rejects.toThrow('ECONNREFUSED');
  });

  it('throws when the body cannot be parsed as JSON at all (e.g. a Railway 502 HTML page)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })
      );

    await expect(fetchLmlHealthSnapshot(fetchImpl as unknown as typeof fetch, 1000)).rejects.toThrow();
  });
});

describe('probeDiscogsBreaker (fail-open contract)', () => {
  it('passes through closed', async () => {
    const fetchImpl = makeFetch(() =>
      makeResponse({ discogs_breaker_state: 'closed', discogs_live_requests_total: 10 })
    );

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result).toEqual({ outcome: 'closed', liveRequestsTotal: 10 });
  });

  it('passes through open', async () => {
    const fetchImpl = makeFetch(() => makeResponse({ discogs_breaker_state: 'open', discogs_live_requests_total: 5 }));

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result).toEqual({ outcome: 'open', liveRequestsTotal: 5 });
  });

  it('passes through half_open', async () => {
    const fetchImpl = makeFetch(() =>
      makeResponse({ discogs_breaker_state: 'half_open', discogs_live_requests_total: 7 })
    );

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result).toEqual({ outcome: 'half_open', liveRequestsTotal: 7 });
  });

  it('maps a null breaker state (Discogs unconfigured) to unconfigured — fails open', async () => {
    const fetchImpl = makeFetch(() => makeResponse({ discogs_breaker_state: null, discogs_live_requests_total: null }));

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result).toEqual({ outcome: 'unconfigured', liveRequestsTotal: null });
  });

  it('maps a network failure to probe_error with the message captured — fails open', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result.outcome).toBe('probe_error');
    expect(result.liveRequestsTotal).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('maps an unreadable (non-JSON) body to probe_error — fails open', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('nope', { status: 502 }));

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result.outcome).toBe('probe_error');
  });

  it('maps a missing LIBRARY_METADATA_URL to probe_error — fails open, never throws', async () => {
    delete process.env.LIBRARY_METADATA_URL;
    const fetchImpl = jest.fn();

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result.outcome).toBe('probe_error');
  });

  it('a non-2xx WITH a readable breaker state still surfaces the real state, not probe_error', async () => {
    const fetchImpl = makeFetch(() => makeResponse({ discogs_breaker_state: 'open' }, { status: 503 }));

    const result = await probeDiscogsBreaker(fetchImpl as unknown as typeof fetch, 1000);

    expect(result.outcome).toBe('open');
  });
});

describe('shouldPauseForBreaker', () => {
  it('is true for open and half_open', () => {
    expect(shouldPauseForBreaker({ outcome: 'open', liveRequestsTotal: null })).toBe(true);
    expect(shouldPauseForBreaker({ outcome: 'half_open', liveRequestsTotal: null })).toBe(true);
  });

  it('is false for closed, unconfigured, and probe_error (all fail open)', () => {
    expect(shouldPauseForBreaker({ outcome: 'closed', liveRequestsTotal: null })).toBe(false);
    expect(shouldPauseForBreaker({ outcome: 'unconfigured', liveRequestsTotal: null })).toBe(false);
    expect(shouldPauseForBreaker({ outcome: 'probe_error', liveRequestsTotal: null })).toBe(false);
  });
});

describe('BreakerPauseCeilingExceededError', () => {
  it('is a named Error subclass', () => {
    const err = new BreakerPauseCeilingExceededError('breaker wedged');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BreakerPauseCeilingExceededError');
    expect(err.message).toBe('breaker wedged');
  });
});

describe('env resolvers (Number()-based, warn-and-fallback via the shared parseEnvInt)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('default to the *_DEFAULT constants when unset', () => {
    delete process.env.BACKFILL_BREAKER_PROBE_INTERVAL_MS;
    delete process.env.BACKFILL_BREAKER_PAUSE_MS;
    delete process.env.BACKFILL_BREAKER_PROBE_TIMEOUT_MS;
    delete process.env.BACKFILL_BREAKER_MAX_PAUSE_MS;

    expect(resolveBreakerProbeIntervalMs()).toBe(BREAKER_PROBE_INTERVAL_MS_DEFAULT);
    expect(resolveBreakerPauseMs()).toBe(BREAKER_PAUSE_MS_DEFAULT);
    expect(resolveBreakerProbeTimeoutMs()).toBe(BREAKER_PROBE_TIMEOUT_MS_DEFAULT);
    expect(resolveBreakerMaxPauseMs()).toBe(BREAKER_MAX_PAUSE_MS_DEFAULT);
  });

  it('reads valid values from env', () => {
    process.env.BACKFILL_BREAKER_PROBE_INTERVAL_MS = '45000';
    process.env.BACKFILL_BREAKER_PAUSE_MS = '15000';
    process.env.BACKFILL_BREAKER_PROBE_TIMEOUT_MS = '2000';
    process.env.BACKFILL_BREAKER_MAX_PAUSE_MS = '600000';

    expect(resolveBreakerProbeIntervalMs()).toBe(45000);
    expect(resolveBreakerPauseMs()).toBe(15000);
    expect(resolveBreakerProbeTimeoutMs()).toBe(2000);
    expect(resolveBreakerMaxPauseMs()).toBe(600000);
  });

  it('BACKFILL_BREAKER_PROBE_INTERVAL_MS=0 is accepted (disables the gate) — no warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_PROBE_INTERVAL_MS = '0';

    expect(resolveBreakerProbeIntervalMs()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('BACKFILL_BREAKER_PAUSE_MS=0 is accepted (no pause sleep) — no warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_PAUSE_MS = '0';

    expect(resolveBreakerPauseMs()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('BACKFILL_BREAKER_MAX_PAUSE_MS=0 is accepted (uncapped) — no warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_MAX_PAUSE_MS = '0';

    expect(resolveBreakerMaxPauseMs()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('BACKFILL_BREAKER_PROBE_TIMEOUT_MS=0 falls back with a warn (must stay positive)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_PROBE_TIMEOUT_MS = '0';

    expect(resolveBreakerProbeTimeoutMs()).toBe(BREAKER_PROBE_TIMEOUT_MS_DEFAULT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BACKFILL_BREAKER_PROBE_TIMEOUT_MS=0'));
  });

  it('rejects partial-parse strings like "3banana" (no silent coercion, falls back with warn)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_PROBE_INTERVAL_MS = '3banana';

    expect(resolveBreakerProbeIntervalMs()).toBe(BREAKER_PROBE_INTERVAL_MS_DEFAULT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BACKFILL_BREAKER_PROBE_INTERVAL_MS=3banana'));
  });

  it('rejects a negative BACKFILL_BREAKER_PAUSE_MS with a warn', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_PAUSE_MS = '-5';

    expect(resolveBreakerPauseMs()).toBe(BREAKER_PAUSE_MS_DEFAULT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BACKFILL_BREAKER_PAUSE_MS=-5'));
  });

  // S1 (via the shared parseEnvInt — pinned in detail in env-int.test.ts;
  // this just confirms the wiring carries the fix through).
  it('S1: rejects a whitespace-only BACKFILL_BREAKER_PROBE_INTERVAL_MS instead of silently disabling the gate', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKFILL_BREAKER_PROBE_INTERVAL_MS = '   ';

    expect(resolveBreakerProbeIntervalMs()).toBe(BREAKER_PROBE_INTERVAL_MS_DEFAULT);
    expect(warn).toHaveBeenCalled();
  });
});
