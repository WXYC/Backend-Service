import { jest } from '@jest/globals';

jest.mock('../../../apps/backend/services/library.service', () => ({
  artistIdFromName: jest.fn(),
}));

import { Request, Response, NextFunction } from 'express';
import { addAlbum } from '../../../apps/backend/controllers/library.controller';
import * as libraryService from '../../../apps/backend/services/library.service';

function buildReqResNext(body: Record<string, unknown>) {
  const req = { body } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('addAlbum', () => {
  it('should not send a response after calling next(e) when artistIdFromName throws', async () => {
    const error = new Error('db connection lost');
    (libraryService.artistIdFromName as jest.Mock).mockRejectedValue(error);

    const { req, res, next } = buildReqResNext({
      album_title: 'Test Album',
      label: 'Test Label',
      genre_id: 1,
      format_id: 1,
      artist_name: 'Test Artist',
    });

    await addAlbum(req, res, next);

    expect(next).toHaveBeenCalledWith(error);
    expect((res.send as jest.Mock)).not.toHaveBeenCalled();
  });
});
