/**
 * Unit tests for library-canonical-entity-backfill lml-fetch.ts (BS#1910).
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
 *   4. The module never touches the global `fetch` directly — the raw
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
): Promise<typeof import('../../../../jobs/library-canonical-entity-backfill/lml-fetch.js')> => {
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
  }));
  return import('../../../../jobs/library-canonical-entity-backfill/lml-fetch.js');
};

describe('jobs/library-canonical-entity-backfill/lml-fetch', () => {
  it('delegates to @wxyc/lml-client.lookupMetadata with artist/album, the registered caller, and timeoutMs=30000', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Juana Molina', 'DOGA');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, {
      caller: 'library-canonical-entity-backfill',
      timeoutMs: 30000,
    });
  });

  it('forwards album omission (album-less lookups still call through)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Jessica Pratt');

    expect(mockLookup).toHaveBeenCalledWith('Jessica Pratt', undefined, undefined, {
      caller: 'library-canonical-entity-backfill',
      timeoutMs: 30000,
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
