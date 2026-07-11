/**
 * Unit tests for `GET /concerts` (BS#1603, touring-events Phase 2).
 *
 * Service is mocked; these tests pin the controller contract: query-param
 * validation (page/limit/curated/from/to), the 1-indexed page → offset math,
 * the default `starts_on` window ("today forward", America/New_York), and
 * the `ConcertsResponse` wire shape (`concerts` + `PaginationInfo`).
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetConcertsPage = jest.fn<() => Promise<unknown[]>>();
const mockGetConcertsCount = jest.fn<() => Promise<number>>();

jest.mock('../../../apps/backend/services/concerts.service', () => ({
  getConcertsPage: mockGetConcertsPage,
  getConcertsCount: mockGetConcertsCount,
}));

import { nyCalendarDate } from '@wxyc/database';
import { getConcerts, ConcertsQueryParams } from '../../../apps/backend/controllers/concerts.controller';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Same derivation the controller uses for its default `from` — the shared
 * `nyCalendarDate` helper, not a self-referential re-implementation.
 */
const todayEastern = (): string => nyCalendarDate(new Date());

describe('concerts.controller getConcerts', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  const mockNext = jest.fn<NextFunction>();

  const invoke = () => getConcerts(req as Request, res as Response, mockNext);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConcertsPage.mockResolvedValue([]);
    mockGetConcertsCount.mockResolvedValue(0);
    req = { query: {} };
    res = {
      status: jest.fn().mockReturnThis() as unknown as Response['status'],
      json: jest.fn() as unknown as Response['json'],
    };
  });

  const setQuery = (query: ConcertsQueryParams) => {
    req.query = query;
  };

  describe('defaults', () => {
    it('windows from today (America/New_York) forward, uncurated, page 1, limit 50', async () => {
      await invoke();

      expect(mockGetConcertsPage).toHaveBeenCalledWith({ from: todayEastern(), to: undefined, curated: false }, 50, 0);
      expect(mockGetConcertsCount).toHaveBeenCalledWith({
        from: todayEastern(),
        to: undefined,
        curated: false,
      });
      expect(mockGetConcertsPage.mock.calls[0][0]).toEqual(
        expect.objectContaining({ from: expect.stringMatching(ISO_DATE) })
      );
    });

    it('responds with the ConcertsResponse shape', async () => {
      const concerts = [{ id: 1 }, { id: 2 }];
      mockGetConcertsPage.mockResolvedValue(concerts);
      mockGetConcertsCount.mockResolvedValue(2);

      await invoke();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        concerts,
        pagination: { page: 1, limit: 50, total: 2, hasMore: false },
      });
    });
  });

  describe('pagination', () => {
    it('translates 1-indexed page to offset and reports hasMore', async () => {
      const pageRows = Array.from({ length: 10 }, (_, i) => ({ id: i }));
      mockGetConcertsPage.mockResolvedValue(pageRows);
      mockGetConcertsCount.mockResolvedValue(35);
      setQuery({ page: '2', limit: '10' });

      await invoke();

      expect(mockGetConcertsPage).toHaveBeenCalledWith(expect.anything(), 10, 10);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pagination: { page: 2, limit: 10, total: 35, hasMore: true },
        })
      );
    });

    it('reports hasMore=false on the final page', async () => {
      mockGetConcertsPage.mockResolvedValue([{ id: 30 }]);
      mockGetConcertsCount.mockResolvedValue(21);
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
      expect(mockGetConcertsPage).not.toHaveBeenCalled();
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
      expect(mockGetConcertsPage).not.toHaveBeenCalled();
    });

    it('accepts a valid all-digits page/limit', async () => {
      setQuery({ page: '2', limit: '20' });
      await invoke();
      expect(mockGetConcertsPage).toHaveBeenCalledWith(expect.anything(), 20, 20);
    });
  });

  describe('curated filter', () => {
    it('passes curated=true through to the service', async () => {
      setQuery({ curated: 'true' });
      await invoke();
      expect(mockGetConcertsPage).toHaveBeenCalledWith(expect.objectContaining({ curated: true }), 50, 0);
    });

    it('treats curated=false the same as absent', async () => {
      setQuery({ curated: 'false' });
      await invoke();
      expect(mockGetConcertsPage).toHaveBeenCalledWith(expect.objectContaining({ curated: false }), 50, 0);
    });

    it('rejects a non-boolean curated value', async () => {
      setQuery({ curated: 'yes' });
      await expect(invoke()).rejects.toThrow('curated must be "true" or "false"');
    });
  });

  describe('date window', () => {
    it('passes explicit from/to through to the service', async () => {
      setQuery({ from: '2026-08-01', to: '2026-08-31' });
      await invoke();
      expect(mockGetConcertsPage).toHaveBeenCalledWith(
        expect.objectContaining({ from: '2026-08-01', to: '2026-08-31' }),
        50,
        0
      );
    });

    it('accepts a valid explicit from date', async () => {
      setQuery({ from: '2026-06-15' });
      await invoke();
      expect(mockGetConcertsPage).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-06-15' }), 50, 0);
    });

    it.each([
      ['08/01/2026'],
      ['2026-13-99'],
      ['not-a-date'],
      // Rolled-over invalid calendar days: Date.parse rolls these forward,
      // so a shape+parse check would let them through to a Postgres 500.
      ['2026-02-30'],
      ['2026-04-31'],
    ])('rejects from=%s with a 400 WxycError', async (from) => {
      setQuery({ from });
      await expect(invoke()).rejects.toThrow('from must be a valid YYYY-MM-DD date');
    });

    it.each([['08/31/2026'], ['2026-99-01'], ['soon'], ['2026-02-30'], ['2026-04-31']])(
      'rejects to=%s with a 400 WxycError',
      async (to) => {
        setQuery({ to });
        await expect(invoke()).rejects.toThrow('to must be a valid YYYY-MM-DD date');
      }
    );
  });

  it('propagates service failures to the error handler', async () => {
    const failure = new Error('db unavailable');
    mockGetConcertsPage.mockRejectedValue(failure);
    await expect(invoke()).rejects.toThrow(failure);
  });
});
