/**
 * Unit tests for jobs/rotation-artist-backfill/lml-fetch.ts (BS#1381).
 *
 * Behavior under test:
 *   - fetchIdentityRefresh returns kind=ok with the parsed body on success.
 *   - classifyError: 5xx + timeout + network → kind=error,retryable=true;
 *     4xx other than 429 → kind=error,retryable=false.
 *
 * The endpoint wrapper itself is a thin pass-through to
 * @wxyc/lml-client.refreshForIdentities wrapped in defaultLmlLimiter; the
 * orchestrator's tally + batching logic is covered in orchestrate.test.ts
 * (which injects FetchOutcome directly), so we don't double-test the wrap.
 */

import { jest } from '@jest/globals';
import { LmlClientError } from '@wxyc/lml-client';

describe('jobs/rotation-artist-backfill/lml-fetch', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const loadModule = async (
    overrides: { refreshForIdentities?: jest.Mock; limiterRun?: jest.Mock } = {}
  ): Promise<typeof import('../../../../jobs/rotation-artist-backfill/lml-fetch.js')> => {
    const limiterRun = overrides.limiterRun ?? jest.fn(<T>(fn: () => Promise<T>) => fn());
    jest.doMock('../../../../jobs/rotation-artist-backfill/lml-limiter.js', () => ({
      // Run-through limiter by default; tests can swap in a spy to assert
      // `.run` was actually invoked around refreshForIdentities (regression
      // guard for a refactor that drops the limiter wrap and bypasses
      // BACKFILL_LML_* in prod).
      defaultLmlLimiter: { run: limiterRun },
    }));
    jest.doMock('@wxyc/lml-client', () => ({
      LmlClientError,
      // Stub envInt: the cron module reads BACKFILL_LML_BATCH_TIMEOUT_MS at
      // import time. Tests pass a numeric value so the AbortController budget
      // is finite and deterministic.
      envInt: (_name: string, fallback: number) => fallback,
      refreshForIdentities: overrides.refreshForIdentities ?? jest.fn(),
    }));
    return import('../../../../jobs/rotation-artist-backfill/lml-fetch.js');
  };

  describe('fetchIdentityRefresh', () => {
    it('returns {kind: "ok", value} on success and routes through defaultLmlLimiter.run', async () => {
      const response = {
        results: [
          {
            identity_id: 42,
            status: 'warmed',
            sources: { discogs_release: { release_outcome: 'success', artists: [] } },
          },
        ],
      };
      const refreshForIdentities = jest.fn().mockResolvedValue(response);
      const limiterRun = jest.fn(<T>(fn: () => Promise<T>) => fn());
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities, limiterRun });
      const result = await fetchIdentityRefresh([42]);
      expect(result).toEqual({ kind: 'ok', value: response });
      // The limiter MUST be invoked: regression guard against dropping the
      // BACKFILL_LML_* rate-limit gate in a future refactor.
      expect(limiterRun).toHaveBeenCalledTimes(1);
      // Wrapper threads a timeoutMs override so cold-cache batches don't
      // misclassify as transport errors at the shared 30 s TIMEOUT_MS.
      expect(refreshForIdentities).toHaveBeenCalledWith(
        [42],
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      );
    });

    it('maps a 5xx LmlClientError to {kind: "error", retryable: true}', async () => {
      const refreshForIdentities = jest.fn().mockRejectedValue(new LmlClientError('upstream', 502));
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities });
      const result = await fetchIdentityRefresh([1]);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('expected error');
      expect(result.retryable).toBe(true);
    });

    it('maps a 504 LmlClientError (timeout) to {kind: "error", retryable: true}', async () => {
      const refreshForIdentities = jest.fn().mockRejectedValue(new LmlClientError('timed out', 504));
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities });
      const result = await fetchIdentityRefresh([1]);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('expected error');
      expect(result.retryable).toBe(true);
    });

    it('maps a 429 LmlClientError (rate limit) to {kind: "error", retryable: true}', async () => {
      // 429 means LML's per-replica Discogs cap collided with foreground
      // traffic; treating it as permanent would hide the collision from
      // ops triage.
      const refreshForIdentities = jest.fn().mockRejectedValue(new LmlClientError('rate limited', 429));
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities });
      const result = await fetchIdentityRefresh([1]);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('expected error');
      expect(result.retryable).toBe(true);
    });

    it('maps a 400 LmlClientError (over-cap batch) to {kind: "error", retryable: false}', async () => {
      // Should never happen — the orchestrator chunks at LML_REFRESH_BATCH_CAP.
      // But if it does, the bug is in the orchestrator, not transient.
      const refreshForIdentities = jest.fn().mockRejectedValue(new LmlClientError('batch too large', 400));
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities });
      const result = await fetchIdentityRefresh([1]);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('expected error');
      expect(result.retryable).toBe(false);
    });

    it('maps a 401/403 LmlClientError to {kind: "error", retryable: false}', async () => {
      const refreshForIdentities = jest.fn().mockRejectedValue(new LmlClientError('unauthorized', 401));
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities });
      const result = await fetchIdentityRefresh([1]);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('expected error');
      expect(result.retryable).toBe(false);
    });

    it('maps a non-LmlClientError to {kind: "error", retryable: true}', async () => {
      const refreshForIdentities = jest.fn().mockRejectedValue(new Error('socket hang up'));
      const { fetchIdentityRefresh } = await loadModule({ refreshForIdentities });
      const result = await fetchIdentityRefresh([1]);
      expect(result.kind).toBe('error');
      if (result.kind !== 'error') throw new Error('expected error');
      expect(result.retryable).toBe(true);
    });
  });
});
