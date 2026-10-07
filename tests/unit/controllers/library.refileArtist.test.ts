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
      ...[
        ['empty', ''],
        ['whitespace', '   '],
        ['5 characters', 'ABCDE'],
        ['a non-ASCII letter', 'Ñ'],
        ['Z-Rock', 'Z-Rock'],
        ['a non-string', 7],
      ].map(([name, value]) => [
        `code_letters: ${name}`,
        { id: '431' },
        { genre_id: 6, code_artist_number: 31, code_letters: value },
        'code_letters',
      ]),
      ['a string to_genre_id', { id: '431' }, { genre_id: 6, code_artist_number: 31, to_genre_id: '7' }, 'to_genre_id'],
      ['a zero to_genre_id', { id: '431' }, { genre_id: 6, code_artist_number: 31, to_genre_id: 0 }, 'to_genre_id'],
      [
        'an over-INT4 to_genre_id',
        { id: '431' },
        { genre_id: 6, code_artist_number: 31, to_genre_id: 2147483648 },
        'to_genre_id',
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
      const { statusMock, jsonMock } = await run({
        outcome,
        card: CARD,
        previous: 1,
        previous_letters: 'IS',
        previous_genre_id: 6,
        releases_to_relabel: 2,
      });

      expect(mockedService.refileArtistInGenre).toHaveBeenCalledWith(431, 6, 31, undefined, undefined);
      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith({
        ...CARD,
        changed,
        previous_code_artist_number: 1,
        previous_code_letters: 'IS',
        previous_genre_id: 6,
        releases_to_relabel: 2,
      });
    });

    it('passes the canonical (trimmed, upper-cased) code_letters to the service', async () => {
      mockedService.refileArtistInGenre.mockResolvedValue({ outcome: 'artist_not_found' });
      const { req, res, next } = mockReqRes(
        { id: '431' },
        { genre_id: 6, code_artist_number: 31, code_letters: ' ja ' }
      );

      await refileArtist(req as never, res, next).catch(() => undefined);

      expect(mockedService.refileArtistInGenre).toHaveBeenCalledWith(431, 6, 31, 'JA', undefined);
    });

    it('answers 409 letters_shared_across_genres with the memberships', async () => {
      const memberships = [
        { genre_id: 2, code_artist_number: 7 },
        { genre_id: 6, code_artist_number: 1 },
      ];
      const { statusMock, jsonMock } = await run({ outcome: 'letters_shared', memberships });

      expect(statusMock).toHaveBeenCalledWith(409);
      expect(jsonMock).toHaveBeenCalledWith({
        message: expect.any(String),
        reason: 'letters_shared_across_genres',
        memberships,
      });
    });

    it.each([
      ['artist_not_found', 'artist_not_found', 'Artist not found'],
      ['not_filed', 'artist_not_filed_in_genre', 'Artist not filed under genre 6'],
    ] as const)('throws a 404 for %s carrying code %s', async (outcome, code, message) => {
      mockedService.refileArtistInGenre.mockResolvedValue({ outcome });
      const { req, res, next } = mockReqRes({ id: '431' }, { genre_id: 6, code_artist_number: 31 });

      const error = await refileArtist(req as never, res, next).catch((e: unknown) => e);

      expect(error).toMatchObject({ statusCode: 404 });
      expect((error as { toApiErrorResponse(): unknown }).toApiErrorResponse()).toEqual({ message, code });
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

    describe('genre move', () => {
      const body = { genre_id: 6, code_artist_number: 31, to_genre_id: 7 };

      it('answers 404 genre_not_found for an unknown to_genre_id, before the service', async () => {
        mockedService.genreExists.mockResolvedValue(false);
        const { req, res, next } = mockReqRes({ id: '431' }, body);

        const error = await refileArtist(req as never, res, next).catch((e: unknown) => e);

        expect(error).toMatchObject({ statusCode: 404 });
        expect((error as { toApiErrorResponse(): unknown }).toApiErrorResponse()).toEqual({
          message: 'Genre not found',
          code: 'genre_not_found',
        });
        expect(mockedService.refileArtistInGenre).not.toHaveBeenCalled();
      });

      it('answers 400 (not 404) for a Various Artists destination even when to_genre_id is unknown', async () => {
        const actual = jest.requireActual<typeof libraryService>('../../../apps/backend/services/library.service');
        mockedService.assertRefileLettersAllowed.mockImplementation(actual.assertRefileLettersAllowed);
        mockedService.genreExists.mockResolvedValue(false);
        const { req, res, next } = mockReqRes({ id: '431' }, { ...body, to_genre_id: 9999, code_letters: 'V/A' });

        await expect(refileArtist(req as never, res, next)).rejects.toMatchObject({ statusCode: 400 });
        expect(mockedService.genreExists).not.toHaveBeenCalled();
        expect(mockedService.refileArtistInGenre).not.toHaveBeenCalled();
      });

      it('passes a known to_genre_id through', async () => {
        mockedService.genreExists.mockResolvedValue(true);
        mockedService.refileArtistInGenre.mockResolvedValue({ outcome: 'artist_not_found' });
        const { req, res, next } = mockReqRes({ id: '431' }, body);

        await refileArtist(req as never, res, next).catch(() => undefined);

        expect(mockedService.refileArtistInGenre).toHaveBeenCalledWith(431, 6, 31, undefined, 7);
      });

      it('treats to_genre_id equal to genre_id as absent, without a genre lookup', async () => {
        mockedService.refileArtistInGenre.mockResolvedValue({ outcome: 'artist_not_found' });
        const { req, res, next } = mockReqRes({ id: '431' }, { ...body, to_genre_id: 6 });

        await refileArtist(req as never, res, next).catch(() => undefined);

        expect(mockedService.genreExists).not.toHaveBeenCalled();
        expect(mockedService.refileArtistInGenre).toHaveBeenCalledWith(431, 6, 31, undefined, undefined);
      });

      it('answers 409 already_filed_in_genre', async () => {
        const { statusMock, jsonMock } = await run({ outcome: 'already_filed' });

        expect(statusMock).toHaveBeenCalledWith(409);
        expect(jsonMock).toHaveBeenCalledWith({ message: expect.any(String), reason: 'already_filed_in_genre' });
      });

      it('reports previous_genre_id from the service result', async () => {
        const { jsonMock } = await run({
          outcome: 'refiled',
          card: { ...CARD, genre_id: 7 },
          previous: 1,
          previous_letters: 'IS',
          previous_genre_id: 6,
          releases_to_relabel: 2,
        });

        expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ genre_id: 7, previous_genre_id: 6 }));
      });
    });

    it('answers 503 lock_unavailable', async () => {
      const { statusMock, jsonMock } = await run({ outcome: 'lock_unavailable' });

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lock_unavailable' }));
    });
  });
});
