/**
 * Unit tests for `GET /album-reviews` (album-reviews-sheet-sync plan /
 * ADR 0011).
 *
 * Service is mocked; these tests pin the controller contract: query-param
 * validation (album_id/artist/page/limit), the 1-indexed page → offset
 * math, defaults (page 1, limit 50) and the limit cap (100), and the
 * `AlbumReviewsResponse` wire shape (`album_reviews` + `PaginationInfo`).
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetAlbumReviewsPage = jest.fn<() => Promise<unknown[]>>();
const mockGetAlbumReviewsCount = jest.fn<() => Promise<number>>();

jest.mock('../../../apps/backend/services/album-reviews.service', () => ({
  getAlbumReviewsPage: mockGetAlbumReviewsPage,
  getAlbumReviewsCount: mockGetAlbumReviewsCount,
}));

import { getAlbumReviews, AlbumReviewsQueryParams } from '../../../apps/backend/controllers/album-reviews.controller';

describe('album-reviews.controller getAlbumReviews', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  const mockNext = jest.fn<NextFunction>();

  const invoke = () => getAlbumReviews(req as Request, res as Response, mockNext);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAlbumReviewsPage.mockResolvedValue([]);
    mockGetAlbumReviewsCount.mockResolvedValue(0);
    req = { query: {} };
    res = {
      status: jest.fn().mockReturnThis() as unknown as Response['status'],
      json: jest.fn() as unknown as Response['json'],
    };
  });

  const setQuery = (query: AlbumReviewsQueryParams) => {
    req.query = query;
  };

  describe('defaults', () => {
    it('serves page 1, limit 50, with no filters', async () => {
      await invoke();

      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith({ album_id: undefined, artist: undefined }, 50, 0);
      expect(mockGetAlbumReviewsCount).toHaveBeenCalledWith({ album_id: undefined, artist: undefined });
    });

    it('responds with the AlbumReviewsResponse shape', async () => {
      const album_reviews = [{ id: 1 }, { id: 2 }];
      mockGetAlbumReviewsPage.mockResolvedValue(album_reviews);
      mockGetAlbumReviewsCount.mockResolvedValue(2);

      await invoke();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        album_reviews,
        pagination: { page: 1, limit: 50, total: 2, hasMore: false },
      });
    });
  });

  describe('pagination', () => {
    it('translates 1-indexed page to offset and reports hasMore', async () => {
      const pageRows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      mockGetAlbumReviewsPage.mockResolvedValue(pageRows);
      mockGetAlbumReviewsCount.mockResolvedValue(35);
      setQuery({ page: '2', limit: '10' });

      await invoke();

      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith(expect.anything(), 10, 10);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pagination: { page: 2, limit: 10, total: 35, hasMore: true },
        })
      );
    });

    it('reports hasMore=false on the final page', async () => {
      mockGetAlbumReviewsPage.mockResolvedValue([{ id: 30 }]);
      mockGetAlbumReviewsCount.mockResolvedValue(21);
      setQuery({ page: '3', limit: '10' });

      await invoke();

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pagination: expect.objectContaining({ hasMore: false }),
        })
      );
    });

    it.each([
      ['0', 'page must be a positive integer'],
      ['-1', 'page must be a positive integer'],
      ['abc', 'page must be a positive integer'],
      // radix-less / trailing-garbage inputs a bare parseInt would coerce
      ['1abc', 'page must be a positive integer'],
      ['0x10', 'page must be a positive integer'],
    ])('rejects page=%s with a 400 WxycError', async (page, message) => {
      setQuery({ page });
      await expect(invoke()).rejects.toThrow(message);
      expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
    });

    it.each([
      ['0', 'limit must be a positive integer'],
      ['-5', 'limit must be a positive integer'],
      ['abc', 'limit must be a positive integer'],
      ['20xyz', 'limit must be a positive integer'],
      ['0x10', 'limit must be a positive integer'],
      ['101', 'limit must be at most 100'],
    ])('rejects limit=%s with a 400 WxycError', async (limit, message) => {
      setQuery({ limit });
      await expect(invoke()).rejects.toThrow(message);
      expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
    });

    it('accepts the maximum limit of 100', async () => {
      setQuery({ limit: '100' });
      await invoke();
      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith(expect.anything(), 100, 0);
    });

    it('accepts a valid all-digits page/limit', async () => {
      setQuery({ page: '2', limit: '20' });
      await invoke();
      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith(expect.anything(), 20, 20);
    });
  });

  describe('album_id filter', () => {
    it('passes a parsed album_id through to the service', async () => {
      setQuery({ album_id: '42' });
      await invoke();
      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith({ album_id: 42, artist: undefined }, 50, 0);
      expect(mockGetAlbumReviewsCount).toHaveBeenCalledWith({ album_id: 42, artist: undefined });
    });

    it.each([
      ['0', 'album_id must be a positive integer'],
      ['-7', 'album_id must be a positive integer'],
      ['abc', 'album_id must be a positive integer'],
      ['3.5', 'album_id must be a positive integer'],
      ['7abc', 'album_id must be a positive integer'],
      ['0x10', 'album_id must be a positive integer'],
    ])('rejects album_id=%s with a 400 WxycError', async (album_id, message) => {
      setQuery({ album_id });
      await expect(invoke()).rejects.toThrow(message);
      expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
    });
  });

  describe('artist filter', () => {
    it('passes the raw artist string through to the service (service owns normalization)', async () => {
      setQuery({ artist: 'Juana Molina' });
      await invoke();
      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith({ album_id: undefined, artist: 'Juana Molina' }, 50, 0);
      expect(mockGetAlbumReviewsCount).toHaveBeenCalledWith({ album_id: undefined, artist: 'Juana Molina' });
    });

    it.each([
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
    ])('rejects %s with a 400 WxycError', async (_label, artist) => {
      setQuery({ artist });
      await expect(invoke()).rejects.toThrow('artist must be a non-empty string');
      expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
    });

    it('rejects an artist longer than 256 characters', async () => {
      setQuery({ artist: 'a'.repeat(257) });
      await expect(invoke()).rejects.toThrow('artist must be at most 256 characters');
      expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
    });

    it('accepts an artist of exactly 256 characters', async () => {
      const artist = 'a'.repeat(256);
      setQuery({ artist });
      await invoke();
      expect(mockGetAlbumReviewsPage).toHaveBeenCalledWith(expect.objectContaining({ artist }), 50, 0);
    });

    it('rejects a repeated artist param (array) instead of coercing it', async () => {
      // Express's query parser turns ?artist=a&artist=b into an array; the
      // typed param says string, so the runtime guard must 400 rather than
      // pass an array into the service's normalize call.
      setQuery({ artist: ['Stereolab', 'Cat Power'] as unknown as string });
      await expect(invoke()).rejects.toThrow('artist must be a non-empty string');
      expect(mockGetAlbumReviewsPage).not.toHaveBeenCalled();
    });
  });

  it('propagates service failures to the error handler', async () => {
    const failure = new Error('db unavailable');
    mockGetAlbumReviewsPage.mockRejectedValue(failure);
    await expect(invoke()).rejects.toThrow(failure);
  });
});
