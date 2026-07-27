/**
 * Unit tests for shared/database/src/album-resolve.ts (BS#1829, extracted
 * from apps/backend/services/album-metadata-lookup.service.ts so a `jobs/`
 * workspace — the upcoming `jobs/album-critic-reviews-etl/`, #1830 — can
 * import the resolver without reaching into `apps/backend`).
 *
 * These cases moved verbatim from
 * tests/unit/services/album-metadata-lookup.service.test.ts's
 * `resolveLinkedAlbumId` describe block. That file mocks the whole
 * `@wxyc/database` package (`jest.mock('@wxyc/database', factory)`) to drive
 * `lookupAlbumMetadataById` / `lookupCriticReviewsByAlbumId`, which still live
 * in the service — but `resolveLinkedAlbumId`'s IMPLEMENTATION now lives
 * inside that same mocked package, so a whole-package mock can no longer
 * exercise its real behavior (the mock factory never includes it, so the
 * service's re-export would resolve to `undefined`). Tests the REAL module
 * directly instead, mocking only its `./client.js` dependency — mirroring
 * `tests/unit/database/concerts-recompute.test.ts` (BS#1763, the same
 * @wxyc/database extraction shape) — so `flowsheet` here is the real Drizzle
 * schema.ts column set, not the string stand-ins the service-level mock used.
 * The SQL text itself isn't asserted (that's schema.flowsheet-album-link-
 * lookup-idx.test.ts's job); these pin the JS-side guard/pick behavior.
 */
import { jest } from '@jest/globals';

// --- Drizzle DB chain mock ---
//
// Each `db.select(...)` call returns a fresh chain whose terminal awaitable
// is the next array of rows pushed via `mockRowsQueue`. The mock's
// .from/.where/.orderBy/.limit are also captured on `chainSpy` so tests can
// pin the SQL contract (`ORDER BY` presence per query). Same shape as the
// service-level mock this replaces.

const mockRowsQueue: Array<Array<Record<string, unknown>>> = [];

const mockSelect = jest.fn();
const chainSpy = {
  from: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
};

function makeChain() {
  let resolveValue: Array<Record<string, unknown>> = [];
  const chain = {
    from: (...args: unknown[]) => {
      chainSpy.from(...args);
      return chain;
    },
    where: (...args: unknown[]) => {
      chainSpy.where(...args);
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      chainSpy.orderBy(...args);
      return chain;
    },
    limit: (...args: unknown[]) => {
      chainSpy.limit(...args);
      return Promise.resolve(resolveValue);
    },
  };
  resolveValue = mockRowsQueue.shift() ?? [];
  return chain;
}

mockSelect.mockImplementation(() => makeChain());

// Mocks only the `db` client this module depends on; `flowsheet` resolves to
// the real shared/database/src/schema.ts export (real Drizzle columns), same
// as concerts-recompute.test.ts's treatment of client.js. `virtual: true`
// matters here: without it, jest.unit.config.ts's own moduleNameMapper rule
// (`^.*/shared/database/src/client(\.js)?$`) would redirect THIS registration
// to tests/mocks/database.mock.ts, while album-resolve.ts's own `./client.js`
// (a plain relative specifier that doesn't match that pattern) resolves to
// the real file — a mismatch that leaves the real client.ts loaded and
// throwing on missing DB env vars. `virtual: true` makes jest register this
// mock at the plain-resolved path instead, matching album-resolve.ts's import.
jest.mock(
  '../../../shared/database/src/client.js',
  () => ({
    db: {
      select: (...args: unknown[]) => mockSelect(...args),
    },
  }),
  { virtual: true }
);

import { resolveLinkedAlbumId, resolveLinkedFlowsheetBase } from '../../../shared/database/src/album-resolve';

describe('album-resolve (shared/database)', () => {
  beforeEach(() => {
    mockRowsQueue.length = 0;
    mockSelect.mockClear();
    chainSpy.from.mockClear();
    chainSpy.where.mockClear();
    chainSpy.orderBy.mockClear();
    chainSpy.limit.mockClear();
  });

  describe('resolveLinkedAlbumId', () => {
    describe('empty-key guard', () => {
      // Pin the contract that the guard prevents *any* DB call: a regression
      // that removes the guard would shift these from `select=0` to `select=1`,
      // letting `'-'`-keyed requests reach the partial index and resolve an
      // arbitrary album_id.
      it('returns null without touching the DB when artistName is empty', async () => {
        expect(await resolveLinkedAlbumId('', 'Some Album')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when artistName is whitespace-only', async () => {
        expect(await resolveLinkedAlbumId('   ', 'Some Album')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is undefined (artist-card surfaces fall through to LML)', async () => {
        expect(await resolveLinkedAlbumId('Some Artist', undefined)).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is empty', async () => {
        expect(await resolveLinkedAlbumId('Some Artist', '')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is whitespace-only', async () => {
        expect(await resolveLinkedAlbumId('Some Artist', '\t  ')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });
    });

    it('returns null on the cold case (no matching album_id-bearing flowsheet row)', async () => {
      mockRowsQueue.push([]);
      expect(await resolveLinkedAlbumId('Unknown Artist', 'Unknown Album')).toBeNull();
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('returns the album_id and issues ORDER BY for a deterministic row-pick on multi-album_id keys', async () => {
      // Pin BS#1331 round-2 review fix: dropping the ORDER BY here would
      // re-introduce iOS-visible flapping between distinct album_metadata
      // payloads when a lookup key resolves to multiple album_ids
      // (V/A multi-format, dual-pressings, librarian duplicates — empirically
      // present in the live `album_id` corpus).
      mockRowsQueue.push([{ album_id: 42 }]);
      const albumId = await resolveLinkedAlbumId('Multi Artist', 'Same Title Different Pressings');
      expect(albumId).toBe(42);
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  // BS#1827 (local-first playcut details): record_label/label_id/
  // metadata_status live on the SAME flowsheet row `resolveLinkedAlbumId`
  // resolves its album_id from — written at play time, never LML-derived —
  // so they survive independent of `album_metadata` enrichment / LML health.
  // Shares the identical WHERE/ORDER BY/LIMIT (same partial index), so a
  // given key always describes the same row across both functions.
  describe('resolveLinkedFlowsheetBase', () => {
    describe('empty-key guard', () => {
      it('returns null without touching the DB when artistName is empty', async () => {
        expect(await resolveLinkedFlowsheetBase('', 'Some Album')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when artistName is whitespace-only', async () => {
        expect(await resolveLinkedFlowsheetBase('   ', 'Some Album')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is undefined', async () => {
        expect(await resolveLinkedFlowsheetBase('Some Artist', undefined)).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is empty', async () => {
        expect(await resolveLinkedFlowsheetBase('Some Artist', '')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });

      it('returns null when releaseTitle is whitespace-only', async () => {
        expect(await resolveLinkedFlowsheetBase('Some Artist', '\t  ')).toBeNull();
        expect(mockSelect).not.toHaveBeenCalled();
      });
    });

    it('returns null on the cold case (no matching album_id-bearing flowsheet row)', async () => {
      mockRowsQueue.push([]);
      expect(await resolveLinkedFlowsheetBase('Unknown Artist', 'Unknown Album')).toBeNull();
      expect(mockSelect).toHaveBeenCalledTimes(1);
    });

    it('returns record_label/label_id/metadata_status on a hit', async () => {
      mockRowsQueue.push([{ record_label: 'Drag City', label_id: 7, metadata_status: 'enriched_match' }]);
      const result = await resolveLinkedFlowsheetBase('Jessica Pratt', 'On Your Own Love Again');
      expect(result).toEqual({ record_label: 'Drag City', label_id: 7, metadata_status: 'enriched_match' });
    });

    it('issues ORDER BY for a deterministic row-pick on multi-album_id keys', async () => {
      mockRowsQueue.push([{ record_label: 'Sonamos', label_id: 3, metadata_status: 'pending' }]);
      await resolveLinkedFlowsheetBase('Multi Artist', 'Same Title Different Pressings');
      expect(chainSpy.orderBy).toHaveBeenCalledTimes(1);
    });

    it('passes through a null record_label/label_id (free-text-entered label never captured)', async () => {
      mockRowsQueue.push([{ record_label: null, label_id: null, metadata_status: 'pending' }]);
      const result = await resolveLinkedFlowsheetBase('Some Artist', 'Some Album');
      expect(result).toEqual({ record_label: null, label_id: null, metadata_status: 'pending' });
    });
  });
});
