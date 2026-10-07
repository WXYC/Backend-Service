import { Request, Response, NextFunction } from 'express';

jest.mock('../../../apps/backend/services/library.service');

import * as libraryService from '../../../apps/backend/services/library.service';
import { refileArtist } from '../../../apps/backend/controllers/library.controller';

const mockedService = libraryService as jest.Mocked<typeof libraryService>;

function mockReqRes(params: Record<string, unknown>, body: unknown) {
  const req = { params, body, auth: { id: 'test-user-id' } } as unknown as Request;
  const statusMock = jest.fn().mockReturnThis();
  const jsonMock = jest.fn().mockReturnThis();
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, statusMock, jsonMock };
}

const CARD: libraryService.ArtistCardRow = {
  artist_id: 431,
  artist_name: 'Isis',
  alphabetical_name: 'Isis',
  genre_id: 6,
  code_letters: 'IS',
  code_artist_number: 31,
  code_comp_letter: null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

/**
 * `POST /library/artists/:id/refile` (BS#2643): request validation happens before the service is consulted, and each
 * service outcome maps to exactly one status and body.
 */
describe('POST /library/artists/:id/refile', () => {
  describe('400s, decided before the service runs', () => {
    it.each([
      ['a non-numeric id', { id: 'abc' }, { genre_id: 6, code_artist_number: 31 }, 'Invalid artist ID'],
      ['an array body', { id: '431' }, [], 'body must be a JSON object'],
      ['an unknown key', { id: '431' }, { genre_id: 6, code_artist_number: 31, extra: 1 }, 'extra'],
      [
        'code_letters',
        { id: '431' },
        { genre_id: 6, code_artist_number: 31, code_letters: 'XX' },
        'code_letters is not supported by this endpoint yet',
      ],
      ['a missing genre_id', { id: '431' }, { code_artist_number: 31 }, 'genre_id'],
      ['a string genre_id', { id: '431' }, { genre_id: '6', code_artist_number: 31 }, 'genre_id'],
      ['an over-INT4 genre_id', { id: '431' }, { genre_id: 2147483648, code_artist_number: 31 }, 'genre_id'],
      ['a zero genre_id', { id: '431' }, { genre_id: 0, code_artist_number: 31 }, 'genre_id'],
      ['a missing code_artist_number', { id: '431' }, { genre_id: 6 }, 'code_artist_number'],
      ['a negative code_artist_number', { id: '431' }, { genre_id: 6, code_artist_number: -1 }, 'code_artist_number'],
      [
        'a fractional code_artist_number',
        { id: '431' },
        { genre_id: 6, code_artist_number: 1.5 },
        'code_artist_number',
      ],
      [
        'an over-INT4 code_artist_number',
        { id: '431' },
        { genre_id: 6, code_artist_number: 2147483648 },
        'code_artist_number',
      ],
    ])('rejects %s', async (_name, params, body, fragment) => {
      const { req, res, next } = mockReqRes(params, body);

      await expect(refileArtist(req as never, res, next)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining(fragment),
      });
      expect(mockedService.refileArtistInGenre).not.toHaveBeenCalled();
    });
  });

  describe('outcome mapping', () => {
    const run = async (outcome: libraryService.ArtistRefileOutcome) => {
      mockedService.refileArtistInGenre.mockResolvedValue(outcome);
      const ctx = mockReqRes({ id: '431' }, { genre_id: 6, code_artist_number: 31 });
      await refileArtist(ctx.req as never, ctx.res, ctx.next);
      return ctx;
    };

    it.each([
      ['refiled', true],
      ['unchanged', false],
    ] as const)('answers 200 for %s with changed=%s', async (outcome, changed) => {
      const { statusMock, jsonMock } = await run({ outcome, card: CARD, previous: 1, releases_to_relabel: 2 });

      expect(mockedService.refileArtistInGenre).toHaveBeenCalledWith(431, 6, 31);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        ...CARD,
        changed,
        previous_code_artist_number: 1,
        releases_to_relabel: 2,
      });
    });

    it.each([
      ['artist_not_found', 'Artist not found'],
      ['not_filed', 'Artist not filed under genre 6'],
    ] as const)('throws a 404 for %s', async (outcome, message) => {
      mockedService.refileArtistInGenre.mockResolvedValue({ outcome });
      const { req, res, next } = mockReqRes({ id: '431' }, { genre_id: 6, code_artist_number: 31 });

      await expect(refileArtist(req as never, res, next)).rejects.toMatchObject({ statusCode: 404, message });
    });

    it('answers 409 lettered_compilation_section with no artist', async () => {
      const { statusMock, jsonMock } = await run({ outcome: 'lettered_section' });

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lettered_compilation_section' }));
      expect(jsonMock.mock.calls[0][0]).not.toHaveProperty('artist');
    });

    it('answers 409 various_artists_section with exactly message and reason', async () => {
      const { statusMock, jsonMock } = await run({ outcome: 'various_artists_section' });

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith({
        message: 'Cannot re-file: this membership is a Various Artists bucket shared by every compilation filed in it.',
        reason: 'various_artists_section',
      });
    });

    it('answers 409 artist_code_conflict naming the occupant', async () => {
      const occupant = {
        id: 7,
        artist_name: 'Isis Two',
        code_letters: 'IS',
        code_artist_number: 31,
        code_comp_letter: null,
        genre_id: 6,
      };
      const { statusMock, jsonMock } = await run({ outcome: 'slot_taken', occupant });

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'artist_code_conflict', artist: occupant })
      );
    });

    it('answers 503 lock_unavailable', async () => {
      const { statusMock, jsonMock } = await run({ outcome: 'lock_unavailable' });

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lock_unavailable' }));
    });
  });
});
