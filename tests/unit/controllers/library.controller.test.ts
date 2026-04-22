import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetAlbumFromDB = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockMarkAlbumMissing = jest.fn<() => Promise<{ id: number } | undefined>>();
const mockMarkAlbumFound = jest.fn<() => Promise<{ id: number } | undefined>>();

jest.mock('../../../apps/backend/services/library.service', () => ({
  getAlbumFromDB: mockGetAlbumFromDB,
  markAlbumMissing: mockMarkAlbumMissing,
  markAlbumFound: mockMarkAlbumFound,
  // Stub out other exports that may be referenced at import time
  getFormatsFromDB: jest.fn(),
  getRotationFromDB: jest.fn(),
  addToRotation: jest.fn(),
  killRotationInDB: jest.fn(),
  insertAlbum: jest.fn(),
  fuzzySearchLibrary: jest.fn(),
  artistIdFromName: jest.fn(),
  insertArtist: jest.fn(),
  insertArtistGenreCrossreference: jest.fn(),
  getArtistByCode: jest.fn(),
  generateAlbumCodeNumber: jest.fn(),
  generateArtistNumber: jest.fn(),
  getGenresFromDB: jest.fn(),
  insertGenre: jest.fn(),
  insertFormat: jest.fn(),
  isISODate: jest.fn(),
}));

jest.mock('../../../apps/backend/services/labels.service', () => ({
  createLabel: jest.fn(),
}));

import { markMissing, markFound } from '../../../apps/backend/controllers/library.controller';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
}

const fullAlbum = {
  id: 42,
  code_letters: 'AU',
  code_artist_number: 1,
  code_number: 3,
  artist_name: 'Autechre',
  alphabetical_name: 'Autechre',
  album_title: 'Confield',
  record_label: 'Warp',
  label_id: 10,
  plays: 5,
  add_date: new Date('2024-01-15'),
  last_modified: new Date('2024-03-01'),
  format_name: 'CD',
  genre_name: 'Electronic',
  date_lost: new Date('2026-04-22'),
  date_found: null,
  on_streaming: true,
};

describe('library.controller', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = jest.fn() as unknown as NextFunction;
  });

  describe('markMissing', () => {
    it('returns 400 for non-numeric id parameter', async () => {
      const req = { params: { id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 400 for non-positive id parameter', async () => {
      const req = { params: { id: '0' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 400 for negative id parameter', async () => {
      const req = { params: { id: '-5' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 404 when album not found', async () => {
      mockMarkAlbumMissing.mockResolvedValue(undefined);
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(markMissing(req, res, next)).rejects.toThrow('Album not found');
    });

    it('returns 200 with full album on success', async () => {
      mockMarkAlbumMissing.mockResolvedValue({ id: 42 });
      mockGetAlbumFromDB.mockResolvedValue(fullAlbum);
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await markMissing(req, res, next);

      expect(mockMarkAlbumMissing).toHaveBeenCalledWith(42);
      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(fullAlbum);
    });
  });

  describe('markFound', () => {
    it('returns 400 for non-numeric id parameter', async () => {
      const req = { params: { id: 'abc' } } as unknown as Request;
      const res = mockResponse();

      await expect(markFound(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 400 for non-positive id parameter', async () => {
      const req = { params: { id: '0' } } as unknown as Request;
      const res = mockResponse();

      await expect(markFound(req, res, next)).rejects.toThrow('Invalid album ID');
    });

    it('returns 404 when album not found', async () => {
      mockMarkAlbumFound.mockResolvedValue(undefined);
      const req = { params: { id: '999' } } as unknown as Request;
      const res = mockResponse();

      await expect(markFound(req, res, next)).rejects.toThrow('Album not found');
    });

    it('returns 200 with full album on success', async () => {
      mockMarkAlbumFound.mockResolvedValue({ id: 42 });
      mockGetAlbumFromDB.mockResolvedValue({ ...fullAlbum, date_lost: null, date_found: new Date('2026-04-22') });
      const req = { params: { id: '42' } } as unknown as Request;
      const res = mockResponse();

      await markFound(req, res, next);

      expect(mockMarkAlbumFound).toHaveBeenCalledWith(42);
      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(42);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 42, date_found: expect.any(Date) }));
    });
  });
});
