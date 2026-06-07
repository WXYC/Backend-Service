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

// Capture span attribute writes so the requireSearchType tests can assert
// `lml.coordinator.trust_reject_reason` lands on the per-lookup span. The
// real Sentry SDK is uninitialized in unit tests and `startSpan` would pass
// a no-op span — useless for verifying observability output.
const mockSpanSetAttribute = jest.fn();
const mockSpanSetAttributes = jest.fn();
type StartSpanCallback<T> = (span: {
  setAttribute: typeof mockSpanSetAttribute;
  setAttributes: typeof mockSpanSetAttributes;
}) => T | Promise<T>;
jest.mock('@sentry/node', () => ({
  ...jest.requireActual<object>('@sentry/node'),
  startSpan: <T>(_opts: unknown, cb: StartSpanCallback<T>) =>
    cb({ setAttribute: mockSpanSetAttribute, setAttributes: mockSpanSetAttributes }),
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

    // Note on the cache-set vs inflight-delete race window: the bug was a
    // microtask-ordering hazard between `.finally(deleteInflight)` and
    // `cache.set`; the fix sequences them inside one `.then(cacheSet)
    // .finally(deleteInflight)` chain so an arriving same-key caller
    // always sees either inflight (before fetchUncached resolves) or
    // cache (after). The race is documented in source at
    // `lookup-coordinator.ts:lookup()`. A faithful regression test
    // would need to inject a caller in the microtask gap between
    // `fetchUncached` resolving and the coordinator's chained handlers
    // firing — the test scaffold for that is fragile (depends on Jest's
    // microtask scheduling and breaks if the SDK changes how spans
    // wrap async). The cache-hit test above (`serves a settled prior
    // call from cache`) pins the post-settle invariant the fix
    // delivers; that is the load-bearing check.
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

    it('undefined and empty string normalize to the same key (both map to the ∅ sentinel)', async () => {
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

  describe('requireSearchType gate', () => {
    // The BS-side trust policy for librarian-typed write paths: LML's `direct`
    // search_type is the only result shape that confirms the typed (artist,
    // album) exists in Discogs as typed. Non-direct values (alternative,
    // compilation, fallback, song_as_artist, none) are candidate matches LML
    // returned when the typed album wasn't found; persisting them off a
    // librarian-typed row writes the wrong release. Gate lives at the
    // coordinator so the rejection attribute lands on the per-lookup span
    // co-located with `lml.coordinator.hit` and `.caller`. BS#1355.

    function withSearchType(search_type: LookupResponse['search_type']): LookupResponse {
      return { ...fakeResponse(), search_type };
    }

    it('returns the response unchanged when requireSearchType is not set (legacy callers)', async () => {
      mockLookupMetadata.mockResolvedValue(withSearchType('alternative'));

      const result = await lmlLookupCoordinator.lookup('Noura', 'Yenbett', undefined, {
        caller: 'metadata-service',
      });

      expect(result).not.toBeNull();
      expect(result?.search_type).toBe('alternative');
    });

    it('returns null and emits trust_reject_reason when search_type does not match', async () => {
      mockLookupMetadata.mockResolvedValue(withSearchType('alternative'));

      const result = await lmlLookupCoordinator.lookup('Noura', 'Yenbett', undefined, {
        caller: 'library-rotation-picker',
        requireSearchType: 'direct',
      });

      expect(result).toBeNull();
      expect(mockSpanSetAttribute).toHaveBeenCalledWith(
        'lml.coordinator.trust_reject_reason',
        'search_type:alternative'
      );
    });

    it('passes the response through when search_type matches and emits no reject attribute', async () => {
      mockLookupMetadata.mockResolvedValue(withSearchType('direct'));

      const result = await lmlLookupCoordinator.lookup('Autechre', 'Confield', undefined, {
        caller: 'library-rotation-picker',
        requireSearchType: 'direct',
      });

      expect(result).not.toBeNull();
      expect(result?.search_type).toBe('direct');
      expect(mockSpanSetAttribute).not.toHaveBeenCalledWith('lml.coordinator.trust_reject_reason', expect.anything());
    });

    it.each<LookupResponse['search_type']>(['alternative', 'compilation', 'fallback', 'song_as_artist', 'none'])(
      'rejects %s with the expected reason string',
      async (search_type) => {
        mockLookupMetadata.mockResolvedValue(withSearchType(search_type));

        const result = await lmlLookupCoordinator.lookup('Noura', 'Yenbett', undefined, {
          caller: 'library-rotation-picker',
          requireSearchType: 'direct',
        });

        expect(result).toBeNull();
        expect(mockSpanSetAttribute).toHaveBeenCalledWith(
          'lml.coordinator.trust_reject_reason',
          `search_type:${search_type}`
        );
      }
    );

    it('caches the raw response — a strict caller after a permissive caller still gates per-call', async () => {
      mockLookupMetadata.mockResolvedValue(withSearchType('alternative'));

      // First caller has no gate — receives the response.
      const permissive = await lmlLookupCoordinator.lookup('Noura', 'Yenbett', undefined, {
        caller: 'metadata-service',
      });
      expect(permissive?.search_type).toBe('alternative');

      mockLookupMetadata.mockClear();

      // Second caller wants direct — gets null off the cached response,
      // without a fresh wire fetch.
      const strict = await lmlLookupCoordinator.lookup('Noura', 'Yenbett', undefined, {
        caller: 'library-rotation-picker',
        requireSearchType: 'direct',
      });
      expect(strict).toBeNull();
      expect(mockLookupMetadata).not.toHaveBeenCalled();
      expect(mockSpanSetAttribute).toHaveBeenCalledWith(
        'lml.coordinator.trust_reject_reason',
        'search_type:alternative'
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
