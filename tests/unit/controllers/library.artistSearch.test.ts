import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/library.service');

import * as libraryService from '../../../apps/backend/services/library.service';
import { searchArtistsInGenre } from '../../../apps/backend/controllers/library.controller';

function mockReqResNext(query: Record<string, unknown> = {}) {
  const req = { params: {}, query, body: {}, auth: { id: 'test-user-id' } } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

const mockedService = libraryService as jest.Mocked<typeof libraryService>;

// One (artist, genre) membership. Jessica Pratt is filed under Rock; the
// library-wide mode returns rows like this one from mixed genres, which is
// why the genre has to travel on the row.
const MATCH: libraryService.ArtistInGenreSearchRow = {
  id: 7,
  artist_name: 'Jessica Pratt',
  code_letters: 'PR',
  code_number: 12,
  genre_id: 11,
  genre_name: 'Rock',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedService.genreExists.mockResolvedValue(true);
  mockedService.searchArtistsInGenre.mockResolvedValue([MATCH]);
});

/**
 * `GET /library/artists/search` — BS#2410 item 1 makes `genre_id` optional.
 *
 * The controller's job is the genre's three-way role: it validates the id when
 * one is given, resolves "unknown genre" to a 404 ONLY then (that check is what
 * distinguishes a stale dropdown id from a genre with no matches, and there is
 * no such thing as a stale id when none was sent), and hands the service a
 * `null` genre otherwise.
 *
 * Permission tier is unchanged at `catalog: ['write']` (see library.route.ts):
 * dropping the filter widens the query, not the audience.
 */
describe('GET /library/artists/search', () => {
  describe('without genre_id (library-wide)', () => {
    it('answers 200 and searches with a null genre', async () => {
      const { req, res, next, statusMock, jsonMock } = mockReqResNext({ q: 'juana' });

      await searchArtistsInGenre(req, res, next);

      expect(mockedService.searchArtistsInGenre).toHaveBeenCalledWith(null, 'juana', 10);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({ artists: [MATCH] });
    });

    it('does not consult genreExists — there is no id to be stale', async () => {
      const { req, res, next } = mockReqResNext({ q: 'juana' });

      await searchArtistsInGenre(req, res, next);

      expect(mockedService.genreExists).not.toHaveBeenCalled();
    });

    it('keeps the 2-character minimum on q', async () => {
      const { req, res, next } = mockReqResNext({ q: 'j' });

      await expect(searchArtistsInGenre(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('q'),
      });
      expect(mockedService.searchArtistsInGenre).not.toHaveBeenCalled();
    });

    it('passes an explicit limit straight through', async () => {
      const { req, res, next } = mockReqResNext({ q: 'juana', limit: '20' });

      await searchArtistsInGenre(req, res, next);

      expect(mockedService.searchArtistsInGenre).toHaveBeenCalledWith(null, 'juana', 20);
    });
  });

  describe('with genre_id (genre-scoped)', () => {
    it('passes the genre through and 200s', async () => {
      const { req, res, next, statusMock, jsonMock } = mockReqResNext({ genre_id: '11', q: 'je' });

      await searchArtistsInGenre(req, res, next);

      expect(mockedService.genreExists).toHaveBeenCalledWith(11);
      expect(mockedService.searchArtistsInGenre).toHaveBeenCalledWith(11, 'je', 10);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({ artists: [MATCH] });
    });

    it('404s an unknown genre rather than answering an empty list', async () => {
      mockedService.genreExists.mockResolvedValue(false);
      const { req, res, next } = mockReqResNext({ genre_id: '99999999', q: 'je' });

      await expect(searchArtistsInGenre(req, res, next)).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('Genre'),
      });
      expect(mockedService.searchArtistsInGenre).not.toHaveBeenCalled();
    });

    it.each([
      ['zero', '0'],
      ['negative', '-1'],
      ['non-numeric', 'rock'],
      // `?genre_id=` is present-but-empty, and `Number('')` is 0 — a blank
      // value is a client bug, not an omission, so it keeps its 400 rather
      // than silently becoming a library-wide search.
      ['blank', ''],
    ])('400s a %s genre_id', async (_label, genre_id) => {
      const { req, res, next } = mockReqResNext({ genre_id, q: 'je' });

      await expect(searchArtistsInGenre(req, res, next)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('genre_id'),
      });
      expect(mockedService.searchArtistsInGenre).not.toHaveBeenCalled();
    });

    it('400s a repeated genre_id key rather than collapsing it to NaN downstream', async () => {
      // Express's `simple` query parser yields string[] for repeated keys.
      const { req, res, next } = mockReqResNext({ genre_id: ['11', '7'], q: 'je' });

      await expect(searchArtistsInGenre(req, res, next)).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
