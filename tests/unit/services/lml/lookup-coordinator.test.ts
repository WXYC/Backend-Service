/**
 * Unit tests for LmlLookupCoordinator.
 *
 * Verifies the three coordinator behaviors that matter:
 *   1. In-flight coalescing — two concurrent same-key calls hit the wire once.
 *   2. Response caching — settled calls within TTL serve from cache.
 *   3. Error propagation — throws reach all waiters; no cache poisoning.
 *
 * Plus the supporting semantics: cache-key normalization, `warm_cache` union,
 * `extended: true` forced on the wire call.
 */
import { jest } from '@jest/globals';

import type { LookupResponse } from '@wxyc/lml-client';

const mockLookupMetadata = jest.fn<(...args: unknown[]) => Promise<LookupResponse>>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  envInt: (_name: string, fallback: number) => fallback,
}));

import {
  LmlLookupCoordinator,
  _resetLmlLookupCoordinatorForTest,
  lmlLookupCoordinator,
} from '../../../../apps/backend/services/lml/lookup-coordinator';

function fakeResponse(artwork_url = 'https://i.discogs.com/a.jpg'): LookupResponse {
  return {
    results: [
      {
        library_item: { id: 1, title: 'Confield', artist: 'Autechre' },
        artwork: {
          release_id: 1,
          release_url: '',
          artwork_url,
          album: 'Confield',
          artist: 'Autechre',
          confidence: 0.9,
        },
      },
    ],
    search_type: 'direct',
    song_not_found: false,
    found_on_compilation: false,
  } as LookupResponse;
}

describe('LmlLookupCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetLmlLookupCoordinatorForTest();
  });

  describe('basic delegation', () => {
    it('forwards a single call to lookupMetadata with extended=true forced', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      const result = await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'test',
        budgetMs: 5000,
      });

      expect(result).toBeDefined();
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
      expect(mockLookupMetadata).toHaveBeenCalledWith(
        'Autechre',
        'Confield',
        undefined,
        expect.objectContaining({ extended: true, caller: 'test', budgetMs: 5000 })
      );
    });

    it('propagates undefined artist (Various-Artists convention)', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await lmlLookupCoordinator.lookup(undefined, 'Soul Jazz Comp', undefined, { caller: 'test' });

      expect(mockLookupMetadata).toHaveBeenCalledWith(
        undefined,
        'Soul Jazz Comp',
        undefined,
        expect.objectContaining({ extended: true })
      );
    });
  });

  describe('in-flight coalescing', () => {
    it('two concurrent same-key calls produce one outbound fetch', async () => {
      let resolveFn: (r: LookupResponse) => void = () => {};
      mockLookupMetadata.mockImplementation(
        () =>
          new Promise<LookupResponse>((resolve) => {
            resolveFn = resolve;
          })
      );

      const p1 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' });
      const p2 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'b' });

      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);

      resolveFn(fakeResponse());

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(r2);
    });

    it('three concurrent same-key calls all receive the same response object', async () => {
      const response = fakeResponse();
      mockLookupMetadata.mockImplementation(() => Promise.resolve(response));

      const results = await Promise.all([
        lmlLookupCoordinator.lookup('Beatles', 'Abbey Road', undefined, { caller: 'a' }),
        lmlLookupCoordinator.lookup('Beatles', 'Abbey Road', undefined, { caller: 'b' }),
        lmlLookupCoordinator.lookup('Beatles', 'Abbey Road', undefined, { caller: 'c' }),
      ]);

      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
      expect(results[0]).toBe(response);
      expect(results[1]).toBe(response);
      expect(results[2]).toBe(response);
    });

    it('different keys do not coalesce', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await Promise.all([
        lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' }),
        lmlLookupCoordinator.lookup('Beatles', 'Abbey Road', undefined, { caller: 'b' }),
      ]);

      expect(mockLookupMetadata).toHaveBeenCalledTimes(2);
    });
  });

  describe('response caching', () => {
    it('serves a settled prior call from cache (zero outbound fetches)', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' });
      mockLookupMetadata.mockClear();

      await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'b' });
      expect(mockLookupMetadata).not.toHaveBeenCalled();
    });

    it('re-fetches after TTL elapses', async () => {
      const coord = new LmlLookupCoordinator({ ttlMs: 50 });
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await coord.lookup('Autechre', 'Confield', undefined, { caller: 'a' });
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 80));

      await coord.lookup('Autechre', 'Confield', undefined, { caller: 'b' });
      expect(mockLookupMetadata).toHaveBeenCalledTimes(2);
    });

    it('a same-key caller arriving immediately after the wire settles hits cache (no race window)', async () => {
      // Regression test for the cache-set vs inflight-delete ordering race.
      // A naive `.finally(() => inflight.delete(key))` runs *before* the
      // outer `await promise` resumes to set the cache, so a same-key
      // caller arriving in the microtask gap would miss both cache and
      // inflight and issue a redundant wire call. The coordinator's
      // `.then(setCache).finally(deleteInflight)` ordering closes the gap.
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      const firstSettle = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' });
      await firstSettle;
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);

      // Immediately after `await firstSettle` resumes, the cache must
      // already contain the result. A second call must not issue a wire.
      await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'b' });
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
    });
  });

  describe('cache key normalization', () => {
    it('treats case + leading/trailing whitespace as the same key', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await lmlLookupCoordinator.lookup('Beatles', 'Abbey Road', undefined, { caller: 'a' });
      await lmlLookupCoordinator.lookup('  BEATLES ', 'abbey road  ', undefined, { caller: 'b' });

      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
    });

    it('collapses internal whitespace runs', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await lmlLookupCoordinator.lookup('The   Beatles', 'Abbey  Road', undefined, { caller: 'a' });
      await lmlLookupCoordinator.lookup('The Beatles', 'Abbey Road', undefined, { caller: 'b' });

      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
    });

    it('undefined fields key distinctly from empty strings', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await lmlLookupCoordinator.lookup(undefined, 'Album', undefined, { caller: 'a' });
      await lmlLookupCoordinator.lookup('', 'Album', undefined, { caller: 'b' });

      // Both should map to the same key — undefined and empty string both
      // normalize to the empty sentinel. This is the conservative call;
      // if a caller passes '' they almost certainly meant "no artist."
      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
    });
  });

  describe('error semantics', () => {
    it('propagates throws to all coalescing waiters', async () => {
      const err = new Error('LML 502');
      let rejectFn: (e: Error) => void = () => {};
      mockLookupMetadata.mockImplementation(
        () =>
          new Promise<LookupResponse>((_, reject) => {
            rejectFn = reject;
          })
      );

      const p1 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' });
      const p2 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'b' });

      rejectFn(err);

      await expect(p1).rejects.toThrow('LML 502');
      await expect(p2).rejects.toThrow('LML 502');
    });

    it('does not cache errors — retry issues a fresh wire call', async () => {
      mockLookupMetadata.mockRejectedValueOnce(new Error('LML 502')).mockResolvedValueOnce(fakeResponse());

      await expect(lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' })).rejects.toThrow(
        'LML 502'
      );

      const result = await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'b' });
      expect(result).toBeDefined();
      expect(mockLookupMetadata).toHaveBeenCalledTimes(2);
    });

    it('after error, in-flight entry is cleared (next call is not coalesced into a dead Promise)', async () => {
      mockLookupMetadata.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(fakeResponse());

      await expect(lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'a' })).rejects.toThrow(
        'boom'
      );

      // Should succeed (not coalesce into the dead Promise).
      await expect(
        lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, { caller: 'b' })
      ).resolves.toBeDefined();
    });
  });

  describe('warm_cache passthrough (first-caller-wins)', () => {
    // The wire request body is serialized and in flight by the time a
    // coalescing caller arrives — there's no opportunity to union flags
    // onto it. So warm_cache, like every other LookupOptions field, is
    // decided by whichever caller arrived first.

    it('passes warm_cache=false on the wire when the first caller did not request it', async () => {
      let resolveFn: (r: LookupResponse) => void = () => {};
      mockLookupMetadata.mockImplementation(
        () =>
          new Promise<LookupResponse>((resolve) => {
            resolveFn = resolve;
          })
      );

      const p1 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'read-path',
        warm_cache: false,
      });
      const p2 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'write-path',
        warm_cache: true,
      });

      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
      expect(mockLookupMetadata).toHaveBeenCalledWith(
        'Autechre',
        'Confield',
        undefined,
        expect.objectContaining({ warm_cache: false })
      );

      resolveFn(fakeResponse());
      await Promise.all([p1, p2]);
    });

    it('passes warm_cache=true when the first caller is the write-path caller', async () => {
      mockLookupMetadata.mockResolvedValue(fakeResponse());

      await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'write-path',
        warm_cache: true,
      });

      expect(mockLookupMetadata).toHaveBeenCalledWith(
        'Autechre',
        'Confield',
        undefined,
        expect.objectContaining({ warm_cache: true })
      );
    });
  });

  describe('first-caller-wins on the wire', () => {
    it('the wire call inherits the first caller tag, budget, and timeout', async () => {
      let resolveFn: (r: LookupResponse) => void = () => {};
      mockLookupMetadata.mockImplementation(
        () =>
          new Promise<LookupResponse>((resolve) => {
            resolveFn = resolve;
          })
      );

      const p1 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'first-caller',
        budgetMs: 3000,
        timeoutMs: 5000,
      });
      const p2 = lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'second-caller',
        budgetMs: 10000,
        timeoutMs: 15000,
      });

      expect(mockLookupMetadata).toHaveBeenCalledTimes(1);
      expect(mockLookupMetadata).toHaveBeenCalledWith(
        'Autechre',
        'Confield',
        undefined,
        expect.objectContaining({ caller: 'first-caller', budgetMs: 3000, timeoutMs: 5000 })
      );

      resolveFn(fakeResponse());
      await Promise.all([p1, p2]);
    });
  });
});
