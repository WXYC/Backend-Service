/**
 * Unit tests for the optional genre scope on `getReleasesForArtist` /
 * `countReleasesForArtist` (BS#2637).
 *
 * `artistReleasesQuery` is shared verbatim by the page and its `total` so the
 * two can never disagree about which rows are in scope -- a genre filter
 * applied to only one of them would page a filtered set against an unfiltered
 * count. These assert the predicate on BOTH, from the same helper.
 *
 * What lives here rather than in `tests/integration/library.spec.js`: the
 * predicate shape and the untouched shelf ordering, neither of which needs a
 * database. The integration tier still owns what only Postgres can settle --
 * that artist 431's two memberships really do partition into `Panopticon` and
 * `Rebel Soul`, and that no row duplicates across the genre-matched join.
 */
import { jest } from '@jest/globals';

import { db, createMockQueryChain, library } from '../../mocks/database.mock';
import { asc, eq } from 'drizzle-orm';
import { getReleasesForArtist, countReleasesForArtist } from '../../../apps/backend/services/library.service';

type MockChain = ReturnType<typeof createMockQueryChain>;

/**
 * Queue the release page's rows. The statement terminates at `.offset(...)`,
 * so that is what resolves; the chain is returned so a test can inspect the
 * predicate and the ordering it was called with.
 */
const queuePage = (rows: unknown[] = []): MockChain => {
  const chain = createMockQueryChain();
  chain.offset.mockResolvedValue(rows);
  db.select.mockReturnValueOnce(chain);
  return chain;
};

/**
 * Queue the count read. `db.select({count}).from(sub.as(...))` evaluates the
 * OUTER select before its argument, so the outer chain is queued first; the
 * inner one is the shared `artistReleasesQuery` and is what carries the
 * predicate.
 */
const queueCount = (count: number): MockChain => {
  const outer = createMockQueryChain();
  const inner = createMockQueryChain();
  outer.from.mockResolvedValue([{ count }]);
  db.select.mockReturnValueOnce(outer).mockReturnValueOnce(inner);
  return inner;
};

/** The two reads that must stay in lockstep about which rows are in scope. */
const readers = [
  {
    label: 'the page',
    queue: () => queuePage(),
    read: (genreId?: number) => getReleasesForArtist(431, 0, 50, genreId),
  },
  {
    label: 'the count',
    queue: () => queueCount(0),
    read: (genreId?: number) => countReleasesForArtist(431, genreId),
  },
];

describe('artist release genre scope (BS#2637)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // The unscoped call must issue the predicate it issued before this parameter
  // existed -- not an `and()` of one condition that happens to mean the same
  // thing. Every client on the deployed dj-site omits `genre_id`.
  it.each(readers)('scopes $label to artist_id alone when no genre is named', async ({ queue, read }) => {
    const chain = queue();

    await read();

    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.where.mock.calls[0]?.[0]).toEqual(eq(library.artist_id, 431));
  });

  // The Isis case: artist 431 is filed under Hiphop (6) and Rock (11), and a
  // page scoped to `artist_id` alone lists both bands' releases on whichever
  // card the librarian opened.
  it.each(readers)('scopes $label to (artist_id, genre_id) when a genre is named', async ({ queue, read }) => {
    const chain = queue();

    await read(11);

    expect(chain.where).toHaveBeenCalledTimes(1);
    const predicate = chain.where.mock.calls[0]?.[0] as { and: unknown[] };
    expect(predicate).toEqual({
      and: expect.arrayContaining([eq(library.artist_id, 431), eq(library.genre_id, 11)]),
    });
    expect(predicate.and).toHaveLength(2);
  });

  // The page and the count share `artistReleasesQuery` precisely so they
  // cannot diverge; a genre filter reaching only the page would serve a
  // filtered set under an unfiltered `total` and a wrong `totalPages`.
  it('gives the page and the count the same predicate', async () => {
    const page = queuePage();
    await getReleasesForArtist(431, 0, 50, 11);
    const count = queueCount(0);
    await countReleasesForArtist(431, 11);

    expect(count.where.mock.calls[0]?.[0]).toEqual(page.where.mock.calls[0]?.[0]);
  });

  // Shelf order is the physical filing order and is untouched by the scope.
  // `code_volume_letters` is ASC NULLS FIRST explicitly -- Postgres defaults
  // to NULLS LAST, which would put `R 7A` ahead of its own unlettered `R 7`.
  it.each([
    ['unscoped', undefined],
    ['genre-scoped', 11],
  ])('preserves shelf ordering when %s', async (_label, genreId) => {
    const chain = queuePage();

    await getReleasesForArtist(431, 0, 50, genreId);

    expect(chain.orderBy).toHaveBeenCalledTimes(1);
    const [first, second, third] = chain.orderBy.mock.calls[0];
    expect(first).toEqual(asc(library.code_number));
    expect(second).toMatchObject({ values: [library.code_volume_letters] });
    expect(third).toEqual(asc(library.id));
  });

  it('pages within the genre-scoped set rather than the whole artist', async () => {
    const chain = queuePage();

    await getReleasesForArtist(431, 2, 25, 11);

    expect(chain.limit).toHaveBeenCalledWith(25);
    expect(chain.offset).toHaveBeenCalledWith(50);
  });
});
