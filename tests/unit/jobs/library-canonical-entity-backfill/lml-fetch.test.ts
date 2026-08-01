/**
 * Unit tests for library-canonical-entity-backfill lml-fetch.ts (BS#1910,
 * limiter threading BS#1911 review).
 *
 * Pins the post-migration thin-wrapper contract, replacing the pre-BS#1910
 * raw-`fetch()` behavior:
 *   1. `lookupMetadata` delegates to `@wxyc/lml-client.lookupMetadata` —
 *      NOT a raw `fetch()` — forwarding artist/album positionally and
 *      `song` as `undefined` (this job never has a track title).
 *   2. Every call carries the registered class-5 `caller` label
 *      (`library-canonical-entity-backfill`), closing the LML
 *      location-union D4 gate (see `shared/lml-client/src/policy.ts`).
 *   3. `timeoutMs: 30000` is passed explicitly, preserving this job's
 *      pre-migration per-call abort budget exactly (see this module's own
 *      docstring for why 30s, not the class-5 default of 29s).
 *   4. Every call also carries this job's own dedicated `defaultLmlLimiter`
 *      (`./lml-limiter.js`) — per the class-5 convention in
 *      `shared/lml-client/src/policy.ts`, a class-5 caller must never ride
 *      the shared process-wide `defaultLimiter`.
 *   5. The module never touches the global `fetch` directly — the raw
 *      `fetch()` this file used to hand-roll is gone.
 */
import { jest } from '@jest/globals';

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const loadModule = async (
  mockLookup: jest.Mock
): Promise<{
  lookupMetadata: typeof import('../../../../jobs/library-canonical-entity-backfill/lml-fetch.js').lookupMetadata;
  limiterMock: { run: jest.Mock };
}> => {
  // Mock the local limiter module — we only care about the args passed to
  // sharedLookupMetadata. Avoids needing to fully stub all of
  // @wxyc/lml-client's exports (Semaphore, TokenBucket, createLmlLimiter)
  // that lml-limiter.ts pulls in at module-load. Capture the mock object
  // itself (not just its shape) so tests can assert the exact same
  // reference was threaded through as `options.limiter`.
  const limiterMock = { run: jest.fn() };
  jest.doMock('../../../../jobs/library-canonical-entity-backfill/lml-limiter.js', () => ({
    defaultLmlLimiter: limiterMock,
  }));
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
  }));
  const mod = await import('../../../../jobs/library-canonical-entity-backfill/lml-fetch.js');
  return { lookupMetadata: mod.lookupMetadata, limiterMock };
};

describe('jobs/library-canonical-entity-backfill/lml-fetch', () => {
  it('delegates to @wxyc/lml-client.lookupMetadata with artist/album, the registered caller, timeoutMs=30000, and the dedicated limiter', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    await lookupMetadata('Juana Molina', 'DOGA');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    // Exact-object pin (not expect.any(Object)/toHaveProperty): a stray
    // extra option (e.g. a leaked discogsUnavailable) would pass unnoticed
    // under the looser assertions this replaces.
    expect(mockLookup).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, {
      caller: 'library-canonical-entity-backfill',
      timeoutMs: 30000,
      limiter: limiterMock,
    });
  });

  it('forwards album omission (album-less lookups still call through)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    await lookupMetadata('Jessica Pratt');

    expect(mockLookup).toHaveBeenCalledWith('Jessica Pratt', undefined, undefined, {
      caller: 'library-canonical-entity-backfill',
      timeoutMs: 30000,
      limiter: limiterMock,
    });
  });

  it('resolves with whatever the shared client returns (pass-through, no local reshaping)', async () => {
    const response = {
      results: [{ library_item: { id: 1 }, artwork: { release_id: 987654 } }],
      search_type: 'direct' as const,
    };
    const mockLookup = jest.fn().mockResolvedValue(response);

    const { lookupMetadata } = await loadModule(mockLookup);
    const result = await lookupMetadata('Duke Ellington & John Coltrane', 'Duke Ellington & John Coltrane');

    expect(result).toBe(response);
  });

  it('propagates a rejection from the shared client unchanged (orchestrate.ts counts it as an error row)', async () => {
    const mockLookup = jest.fn().mockRejectedValue(new Error('LML request timed out'));

    const { lookupMetadata } = await loadModule(mockLookup);

    await expect(lookupMetadata('Stereolab', 'Dots and Loops')).rejects.toThrow('LML request timed out');
  });

  it('never calls the global fetch directly (transport swap: no more raw fetch())', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Cat Power', 'Moon Pix');

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
