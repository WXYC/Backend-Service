import { describe, it, expect } from '@jest/globals';
import { db } from '@wxyc/database';
import { getAlbumIdByLegacyId, getAlbumByLegacyId } from '../../../apps/backend/services/library.service';

// The legacy→serial bridge (BS#1880). `getAlbumIdByLegacyId` is shaped
// `await db.select({ id }).from(library).where(...).limit(1)` — `.limit()` is the
// terminal step the await resolves, so we swap a thenable into that position via
// the shared mock chain (`mockReturnValueOnce`), matching
// library.catalogLastModifiedAt.test.ts. `getAlbumByLegacyId` composes this with
// `getAlbumFromDB`; the happy path (a real join → serialized album) is covered by
// tests/integration/library-legacy-info.spec.js, so here we pin only the cheap,
// db-light branches the endpoint tests don't reach directly.

const mockDb = db as unknown as {
  _chain: Record<string, jest.Mock>;
};

describe('library.service: getAlbumIdByLegacyId / getAlbumByLegacyId', () => {
  it('returns the serial library.id when a row carries the legacy_release_id', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([{ id: 7100 }]));
    expect(await getAlbumIdByLegacyId(65880)).toBe(7100);
  });

  it('returns null when no row carries the legacy_release_id', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));
    expect(await getAlbumIdByLegacyId(999999999)).toBeNull();
  });

  it('short-circuits to null for a 0/falsy legacy id without querying', async () => {
    const before = mockDb._chain.limit.mock.calls.length;
    expect(await getAlbumIdByLegacyId(0)).toBeNull();
    expect(mockDb._chain.limit.mock.calls.length).toBe(before);
  });

  it('getAlbumByLegacyId resolves to undefined when the legacy id maps to no row', async () => {
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));
    expect(await getAlbumByLegacyId(999999999)).toBeUndefined();
  });

  it('getAlbumByLegacyId short-circuits to undefined for a 0/falsy legacy id', async () => {
    expect(await getAlbumByLegacyId(0)).toBeUndefined();
  });
});
