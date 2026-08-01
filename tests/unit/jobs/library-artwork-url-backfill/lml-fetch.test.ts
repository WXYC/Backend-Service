/**
 * Unit tests for library-artwork-url-backfill lml-fetch.ts (BS#1282, BS#1910,
 * limiter threading BS#1911 review).
 *
 * Pins the thin-wrapper contract:
 *   1. `lookupMetadata` delegates to `@wxyc/lml-client.lookupMetadata`,
 *      forwarding artist/album positionally and `song` as `undefined` (this
 *      job never has a track title — it enriches `library`, not
 *      `flowsheet`).
 *   2. `opts.discogsUnavailable` is forwarded verbatim into the shared
 *      client's options bag — the BS#1293 gate lives entirely in
 *      `@wxyc/lml-client`; this wrapper's only job is to thread the flag
 *      through.
 *   3. Omitting `opts` (the pre-migration call shape every existing test
 *      exercises) still works — `opts` is optional.
 *   4. BS#1910: every call also carries `caller: 'library-artwork-url-backfill'`
 *      — the registered class-5 label that closes the LML location-union
 *      D4 gate (see `shared/lml-client/src/policy.ts`).
 *   5. BS#1911 review (third commit): every call also carries this job's own
 *      dedicated `defaultLmlLimiter` (`./lml-limiter.js`) — per the class-5
 *      convention in `shared/lml-client/src/policy.ts`, a class-5 caller
 *      must never ride the shared process-wide `defaultLimiter`.
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
  lookupMetadata: typeof import('../../../../jobs/library-artwork-url-backfill/lml-fetch.js').lookupMetadata;
  limiterMock: { run: jest.Mock };
}> => {
  // Mock the local limiter module — we only care about the args passed to
  // sharedLookupMetadata. Avoids needing to fully stub all of
  // @wxyc/lml-client's exports (Semaphore, TokenBucket, createLmlLimiter)
  // that lml-limiter.ts pulls in at module-load. Capture the mock object
  // itself (not just its shape) so tests can assert the exact same
  // reference was threaded through as `options.limiter`.
  const limiterMock = { run: jest.fn() };
  jest.doMock('../../../../jobs/library-artwork-url-backfill/lml-limiter.js', () => ({
    defaultLmlLimiter: limiterMock,
  }));
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
  }));
  const mod = await import('../../../../jobs/library-artwork-url-backfill/lml-fetch.js');
  return { lookupMetadata: mod.lookupMetadata, limiterMock };
};

describe('jobs/library-artwork-url-backfill/lml-fetch', () => {
  it('delegates to @wxyc/lml-client.lookupMetadata with artist/album, no discogsUnavailable, the registered caller, and the dedicated limiter', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    await lookupMetadata('Juana Molina', 'DOGA');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, {
      caller: 'library-artwork-url-backfill',
      limiter: limiterMock,
    });
  });

  it('forwards album omission (album-less lookups still call through)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    await lookupMetadata('Jessica Pratt');

    expect(mockLookup).toHaveBeenCalledWith('Jessica Pratt', undefined, undefined, {
      caller: 'library-artwork-url-backfill',
      limiter: limiterMock,
    });
  });

  it('forwards { discogsUnavailable: true } through to the shared client (BS#1293 gate)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({
      results: [],
      search_type: 'none',
      outcome: 'skipped_discogs_unavailable',
    });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    const result = await lookupMetadata('Natanya', 'Live at the Cave', { discogsUnavailable: true });

    expect(mockLookup).toHaveBeenCalledWith('Natanya', 'Live at the Cave', undefined, {
      discogsUnavailable: true,
      caller: 'library-artwork-url-backfill',
      limiter: limiterMock,
    });
    expect(result).toEqual({ results: [], search_type: 'none', outcome: 'skipped_discogs_unavailable' });
  });

  it('forwards { discogsUnavailable: false } through unchanged (behavior parity)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({
      results: [{ library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'x', artwork_url: 'y' } }],
      search_type: 'direct',
    });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    await lookupMetadata('Chuquimamani-Condori', 'Edits', { discogsUnavailable: false });

    expect(mockLookup).toHaveBeenCalledWith('Chuquimamani-Condori', 'Edits', undefined, {
      discogsUnavailable: false,
      caller: 'library-artwork-url-backfill',
      limiter: limiterMock,
    });
  });

  it('always carries the registered class-5 caller label (BS#1910, closes the LML location-union D4 gate)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Stereolab', 'Aluminum Tunes');

    const [, , , opts] = mockLookup.mock.calls[0] as [unknown, unknown, unknown, { caller?: string }];
    expect(opts?.caller).toBe('library-artwork-url-backfill');
  });

  it('always carries the dedicated limiter (BS#1911 review: class-5 callers must never ride defaultLimiter)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata, limiterMock } = await loadModule(mockLookup);
    await lookupMetadata('Stereolab', 'Aluminum Tunes');

    const [, , , opts] = mockLookup.mock.calls[0] as [unknown, unknown, unknown, { limiter?: unknown }];
    expect(opts?.limiter).toBe(limiterMock);
  });

  it('resolves with whatever the shared client returns (pass-through, no local reshaping)', async () => {
    const response = { results: [], search_type: 'none' as const };
    const mockLookup = jest.fn().mockResolvedValue(response);

    const { lookupMetadata } = await loadModule(mockLookup);
    const result = await lookupMetadata('Stereolab', 'Dots and Loops');

    expect(result).toBe(response);
  });
});
