/**
 * Unit tests for `searchArtistsInGenre` — the query behind
 * `GET /library/artists/search` (BS#2410 item 1).
 *
 * The genre filter became optional: a `null` genre means "library-wide", and
 * the row is now one per (artist, genre) membership carrying the genre it
 * belongs to. These tests pin the three things a careless edit loses:
 *
 *   1. The `genres` join and the two added projection keys are present in
 *      BOTH modes — a genre-scoped row without `genre_id`/`genre_name` would
 *      leave the published `ArtistSearchMatch` optional forever.
 *   2. The genre equality predicate appears only when a genre is given, and
 *      the prefix predicate is unconditional.
 *   3. The `ilikeEscaped` prefix escaping (review issue 14 on PR #1154) and
 *      the 1..20 clamp survive the widening.
 *
 * drizzle-orm is automocked project-wide (`tests/__mocks__/drizzle-orm.ts`),
 * so predicates are plain objects rather than rendered SQL — `eq(a, b)` is
 * `{ eq: [a, b] }` and `and(...)` is `{ and: [...] }`. The mock chain
 * conventions follow `library.service.uncataloguedRotation.test.ts`.
 */
import { jest } from '@jest/globals';
import { db, createMockQueryChain, artists, genres, genre_artist_crossreference } from '../../mocks/database.mock';

const mockLookupMetadata = jest.fn<() => Promise<unknown>>();
const mockIsLmlConfigured = jest.fn<() => boolean>();

jest.mock('@wxyc/lml-client', () => ({
  lookupMetadata: mockLookupMetadata,
  isLmlConfigured: mockIsLmlConfigured,
  envInt: (_name: string, fallback: number) => fallback,
}));

import { searchArtistsInGenre } from '../../../apps/backend/services/library.service';

type Chain = ReturnType<typeof createMockQueryChain>;

const stubSelect = (rows: unknown[] = []): Chain => {
  const chain = createMockQueryChain(rows);
  chain.orderBy = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  db.select.mockReturnValue(chain);
  return chain;
};

const projectionKeys = (): string[] => {
  const projection = db.select.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  expect(projection).toBeDefined();
  return Object.keys(projection ?? {}).sort();
};

describe('searchArtistsInGenre (BS#2410)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['genre-scoped', 11],
    ['library-wide', null],
  ])('projects the genre membership columns in %s mode', async (_mode, genreId) => {
    stubSelect();

    await searchArtistsInGenre(genreId, 'ju', 10);

    expect(projectionKeys()).toEqual(['artist_name', 'code_letters', 'code_number', 'genre_id', 'genre_name', 'id']);
  });

  it.each([
    ['genre-scoped', 11],
    ['library-wide', null],
  ])('joins genres for the display name in %s mode', async (_mode, genreId) => {
    const chain = stubSelect();

    await searchArtistsInGenre(genreId, 'ju', 10);

    expect(chain.from).toHaveBeenCalledWith(artists);
    expect(chain.innerJoin).toHaveBeenCalledWith(genre_artist_crossreference, {
      eq: [genre_artist_crossreference.artist_id, artists.id],
    });
    expect(chain.innerJoin).toHaveBeenCalledWith(genres, {
      eq: [genres.id, genre_artist_crossreference.genre_id],
    });
  });

  it('filters on the genre when one is given', async () => {
    const chain = stubSelect();

    await searchArtistsInGenre(11, 'bu', 10);

    const predicate = chain.where.mock.calls[0]?.[0] as { and?: unknown[] };
    expect(predicate.and).toBeDefined();
    expect(predicate.and?.[0]).toEqual({ eq: [genre_artist_crossreference.genre_id, 11] });
  });

  it('drops the genre filter when no genre is given, keeping the name prefix', async () => {
    const chain = stubSelect();

    await searchArtistsInGenre(null, 'bu', 10);

    // The whole predicate is the ILIKE fragment: no `and`, and nothing
    // mentioning genre_id. A library-wide search that still ANDed a genre
    // equality would silently return nothing.
    const predicate = chain.where.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(predicate).not.toHaveProperty('and');
    expect(predicate.values).toEqual([artists.artist_name, 'bu%']);
  });

  it.each([
    ['genre-scoped', 11],
    ['library-wide', null],
  ])('escapes ILIKE metacharacters in %s mode', async (_mode, genreId) => {
    const chain = stubSelect();

    await searchArtistsInGenre(genreId, '%u', 10);

    const predicate = chain.where.mock.calls[0]?.[0] as { and?: unknown[] };
    const ilike = (genreId === null ? predicate : (predicate.and?.[1] as Record<string, unknown>)) as {
      values: unknown[];
    };
    expect(ilike.values).toEqual([artists.artist_name, '\\%u%']);
  });

  it.each([
    [0, 1],
    [-5, 1],
    [10, 10],
    [20, 20],
    [100, 20],
  ])('clamps a limit of %s to %s', async (requested, expected) => {
    const chain = stubSelect();

    await searchArtistsInGenre(null, 'ju', requested);

    expect(chain.limit).toHaveBeenCalledWith(expected);
  });

  it('short-circuits a prefix under two characters without querying', async () => {
    stubSelect();

    await expect(searchArtistsInGenre(null, 'j', 10)).resolves.toEqual([]);

    expect(db.select).not.toHaveBeenCalled();
  });
});
