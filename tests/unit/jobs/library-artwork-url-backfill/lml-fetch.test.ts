/**
 * Unit tests for library-artwork-url-backfill lml-fetch.ts (BS#1282).
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
): Promise<typeof import('../../../../jobs/library-artwork-url-backfill/lml-fetch.js')> => {
  jest.doMock('@wxyc/lml-client', () => ({
    lookupMetadata: mockLookup,
  }));
  return import('../../../../jobs/library-artwork-url-backfill/lml-fetch.js');
};

describe('jobs/library-artwork-url-backfill/lml-fetch', () => {
  it('delegates to @wxyc/lml-client.lookupMetadata with artist/album and no opts', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Juana Molina', 'DOGA');

    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup).toHaveBeenCalledWith('Juana Molina', 'DOGA', undefined, undefined);
  });

  it('forwards album omission (album-less lookups still call through)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({ results: [], search_type: 'none' });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Jessica Pratt');

    expect(mockLookup).toHaveBeenCalledWith('Jessica Pratt', undefined, undefined, undefined);
  });

  it('forwards { discogsUnavailable: true } through to the shared client (BS#1293 gate)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({
      results: [],
      search_type: 'none',
      outcome: 'skipped_discogs_unavailable',
    });

    const { lookupMetadata } = await loadModule(mockLookup);
    const result = await lookupMetadata('Natanya', 'Live at the Cave', { discogsUnavailable: true });

    expect(mockLookup).toHaveBeenCalledWith('Natanya', 'Live at the Cave', undefined, { discogsUnavailable: true });
    expect(result).toEqual({ results: [], search_type: 'none', outcome: 'skipped_discogs_unavailable' });
  });

  it('forwards { discogsUnavailable: false } through unchanged (behavior parity)', async () => {
    const mockLookup = jest.fn().mockResolvedValue({
      results: [{ library_item: { id: 1 }, artwork: { release_id: 1, release_url: 'x', artwork_url: 'y' } }],
      search_type: 'direct',
    });

    const { lookupMetadata } = await loadModule(mockLookup);
    await lookupMetadata('Chuquimamani-Condori', 'Edits', { discogsUnavailable: false });

    expect(mockLookup).toHaveBeenCalledWith('Chuquimamani-Condori', 'Edits', undefined, {
      discogsUnavailable: false,
    });
  });

  it('resolves with whatever the shared client returns (pass-through, no local reshaping)', async () => {
    const response = { results: [], search_type: 'none' as const };
    const mockLookup = jest.fn().mockResolvedValue(response);

    const { lookupMetadata } = await loadModule(mockLookup);
    const result = await lookupMetadata('Stereolab', 'Dots and Loops');

    expect(result).toBe(response);
  });
});
