/**
 * Unit tests for `peekArtistShelf` (BS#2588) -- the ONE genre-scoped shelf
 * read backing `GET /library/artists/:id/next-release-number`, answering both
 * `next_code_number` and `slots_in_use`.
 *
 * What lives here rather than in `tests/integration/library.spec.js`: the
 * shape rules that need no database -- the volume-letter fold, `""` as a
 * member of the set, de-duplication, the sort, the `(artist_id, genre_id)`
 * predicate, and the single-statement claim. The integration tier still owns
 * what only Postgres can settle: that this agrees with the number
 * `generateAlbumCodeNumber` hands the create path, and that the fold means
 * the same thing in SQL as in V8.
 */
import { jest } from '@jest/globals';

import { db, createMockQueryChain, library } from '../../mocks/database.mock';
import { peekArtistShelf } from '../../../apps/backend/services/library.service';

type ShelfRow = { code_number: number; code_volume_letters: string | null };

/**
 * Queue the shelf read's rows. The statement terminates at `.where(...)`, so
 * that is what resolves; the chain is returned so a test can inspect the
 * predicate it was called with.
 */
const queueShelf = (rows: ShelfRow[]) => {
  const chain = createMockQueryChain();
  chain.where.mockResolvedValue(rows);
  db.select.mockReturnValueOnce(chain);
  return chain;
};

describe('peekArtistShelf (BS#2588)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Finding 2 of the BS#2626 review: the peek used to issue
  // `generateAlbumCodeNumber`'s `MAX(code_number)` query alongside this one
  // under a `Promise.all`, over the identical predicate. Both halves now come
  // out of these rows, so a re-added second statement goes red here.
  it('answers both halves from a single statement', async () => {
    queueShelf([{ code_number: 3, code_volume_letters: null }]);

    const result = await peekArtistShelf(42, 11);

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ next_code_number: 4, slots_in_use: { 3: [''] } });
  });

  // The genre predicate is the acceptance criterion BS#2588 names: an artist
  // filed under two genres has two independently-lettered shelves, and
  // dropping `genre_id` here would union them.
  it('scopes the read to (artist_id, genre_id), not to artist_id alone', async () => {
    const chain = queueShelf([]);

    await peekArtistShelf(42, 11);

    expect(chain.where).toHaveBeenCalledTimes(1);
    const predicate = chain.where.mock.calls[0]?.[0] as { and: unknown[] };
    expect(predicate).toEqual({
      and: expect.arrayContaining([{ eq: [library.artist_id, 42] }, { eq: [library.genre_id, 11] }]),
    });
    expect(predicate.and).toHaveLength(2);
  });

  it('previews 1 with an empty slots_in_use for a shelf with no rows', async () => {
    queueShelf([]);

    expect(await peekArtistShelf(42, 11)).toEqual({ next_code_number: 1, slots_in_use: {} });
  });

  // `""` is a MEMBER of the set, not an absence: a shelf holding 7, 7A and 7B
  // reports all three, so the client can offer C. Reducing the siblings to a
  // max instead -- WXYC/dj-site#1581's removed client-side helper -- would
  // report `['B']` and lose the fact that the unlettered volume is taken.
  it('reports the unlettered volume as "" beside its lettered siblings', async () => {
    queueShelf([
      { code_number: 7, code_volume_letters: null },
      { code_number: 7, code_volume_letters: 'A' },
      { code_number: 7, code_volume_letters: 'B' },
      { code_number: 12, code_volume_letters: null },
    ]);

    expect(await peekArtistShelf(42, 11)).toEqual({
      next_code_number: 13,
      slots_in_use: { 7: ['', 'A', 'B'], 12: [''] },
    });
  });

  // The fold is `foldVolumeLetters`, the same expression `librarySlotKey`
  // applies -- `'d'` and `'D'` are ONE slot, and `POST /library` stores
  // whatever case the librarian typed (`validateCodeVolumeLetters` trims but
  // never upper-cases). Dropping the fold reports `['D', 'd']` as two free
  // neighbours of one occupied slot.
  it('folds mixed-case letters to one upper-cased member', async () => {
    queueShelf([
      { code_number: 4, code_volume_letters: 'd' },
      { code_number: 4, code_volume_letters: 'D' },
    ]);

    expect((await peekArtistShelf(42, 11)).slots_in_use).toEqual({ 4: ['D'] });
  });

  // `''` and NULL address the same slot -- `validateCodeVolumeLetters`
  // resolves a blank box to NULL, but legacy rows may hold `''` -- so the two
  // must not appear as two members.
  it('treats a stored empty string and NULL as the same unlettered slot', async () => {
    queueShelf([
      { code_number: 9, code_volume_letters: '' },
      { code_number: 9, code_volume_letters: null },
    ]);

    expect((await peekArtistShelf(42, 11)).slots_in_use).toEqual({ 9: [''] });
  });

  // Postgres returns an unordered heap scan, so the response must not depend
  // on which row arrives first -- neither the letters (sorted, not
  // first-wins) nor the number (a true max, not "the last row seen").
  it.each([
    ['ascending', [1, 2, 50]],
    ['descending', [50, 2, 1]],
    ['shuffled', [2, 50, 1]],
  ])('is independent of row order (%s)', async (_label, numbers) => {
    queueShelf(numbers.map((code_number, i) => ({ code_number, code_volume_letters: ['b', null, 'A'][i] })));

    const result = await peekArtistShelf(42, 11);

    expect(result.next_code_number).toBe(51);
    expect(Object.keys(result.slots_in_use).sort()).toEqual(['1', '2', '50']);
  });

  it('sorts the letters at a number rather than preserving arrival order', async () => {
    queueShelf([
      { code_number: 1, code_volume_letters: 'C' },
      { code_number: 1, code_volume_letters: 'A' },
      { code_number: 1, code_volume_letters: 'b' },
    ]);

    expect((await peekArtistShelf(42, 11)).slots_in_use).toEqual({ 1: ['A', 'B', 'C'] });
  });
});
