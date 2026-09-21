/**
 * Pins the shelf-slot key's volume-letter fold on both sides of the
 * TypeScript/SQL boundary, and pins `findLibrarySlotOccupant` to the SQL side
 * rather than to a restatement of it.
 *
 * What each case buys, stated plainly, because the guarantee is narrower than
 * "the two folds are checked against each other":
 *
 *   - `librarySlotKey`'s JS fold is pinned against literal keys, so dropping
 *     its `.toUpperCase()` or its `?? ''` goes red here.
 *   - `librarySlotVolumeLetterMatchSql`'s rendered text is pinned against a
 *     literal predicate, so a bare `=`, or a dropped `UPPER`/`COALESCE`, goes
 *     red here.
 *   - `findLibrarySlotOccupant`'s captured WHERE clause is asserted to CARRY
 *     that helper's rendered text -- derived from the helper, not restated as a
 *     third literal -- so re-inlining the predicate at the call site (the exact
 *     regression the comment there used to warn about) goes red here too.
 *
 * Each fold is pinned against its OWN literal, which is what makes a
 * divergence visible in both directions: change either one without the other
 * and one of these cases fails. What no case here can do is execute SQL, so
 * nothing in this file shows that the two folds agree SEMANTICALLY -- that
 * `UPPER(COALESCE(...))` in Postgres and `.toUpperCase()` in V8 answer the same
 * way for a given pair of inputs. The guard for that is the integration case at
 * `tests/integration/library-update.spec.js` ("volume letters differing only by
 * case are still recognized as the same occupied slot", ~line 757), which
 * drives a stored `'a'` against an incoming `'A'` through real Postgres and
 * requires the slot to read as occupied.
 */
import { db, library } from '../../mocks/database.mock';
import { renderSql } from '../../utils/render-sql';
import {
  findLibrarySlotOccupant,
  librarySlotKey,
  librarySlotVolumeLetterMatchSql,
} from '../../../apps/backend/services/library.service';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };

/**
 * The mocked `and(...)`, `eq(...)` and `ne(...)` return plain marker objects
 * (`{ and: [...] }`, `{ eq: [a, b] }`), so a captured WHERE argument is a tree
 * of markers rather than one renderable fragment. Pull out the conditions that
 * ARE `` sql`...` `` fragments -- the only ones whose spelling this suite is
 * about -- and render each. A volume-letter predicate rewritten as `eq(...)`
 * drops out of this list entirely, which fails the assertion below rather than
 * quietly satisfying it.
 */
const sqlPredicatesOf = (where: unknown): string[] => {
  const conditions = (where as { and?: unknown[] }).and ?? [where];
  return conditions
    .filter((condition) => Array.isArray((condition as { sql?: unknown }).sql))
    .map((condition) => renderSql(condition));
};

describe('shelf slot key: the volume-letter fold across the SQL boundary', () => {
  it('librarySlotKey folds the volume letter to upper case', () => {
    expect(librarySlotKey({ artist_id: 1, genre_id: 2, code_number: 3, code_volume_letters: 'd' })).toBe('1/2/3/D');
    expect(librarySlotKey({ artist_id: 1, genre_id: 2, code_number: 3, code_volume_letters: 'D' })).toBe('1/2/3/D');
    expect(librarySlotKey({ artist_id: 1, genre_id: 2, code_number: 3, code_volume_letters: null })).toBe('1/2/3/');
  });

  it('librarySlotVolumeLetterMatchSql compiles to UPPER(COALESCE(...)) on both sides', () => {
    const rendered = renderSql(librarySlotVolumeLetterMatchSql(library.code_volume_letters, 'd'));
    expect(rendered).toBe(`UPPER(COALESCE(library.code_volume_letters, '')) = UPPER(COALESCE(d, ''))`);
  });

  it('findLibrarySlotOccupant carries that predicate rather than restating it', async () => {
    // `.limit()` is the terminal step the service awaits, so the thenable goes
    // in that position -- same arrangement as library.getAlbumByLegacyId.test.ts.
    mockDb._chain.limit.mockReturnValueOnce(Promise.resolve([]));

    await findLibrarySlotOccupant(1, 2, 3, 'd', 99);

    const where = mockDb._chain.where.mock.calls.at(-1)?.[0];
    expect(sqlPredicatesOf(where)).toContain(
      renderSql(librarySlotVolumeLetterMatchSql(library.code_volume_letters, 'd'))
    );
  });
});
