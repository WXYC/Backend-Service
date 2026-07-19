/**
 * Unit tests for `GET /concerts` (BS#1603, on-tour Phase 2) and the public
 * `GET /concerts/:id` (BS#1694, On Tour sharing).
 *
 * Service is mocked; these tests pin the controller contract: query-param
 * validation (page/limit/curated/from/to), the 1-indexed page → offset math,
 * the default `starts_on` window ("today forward", America/New_York), the
 * `ConcertsResponse` wire shape (`concerts` + `PaginationInfo`), and the
 * by-id contract (id validation, null → 404, `Cache-Control: public` on the
 * 200 path only).
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetConcertsPage = jest.fn<() => Promise<unknown[]>>();
const mockGetConcertsCount = jest.fn<() => Promise<number>>();
const mockGetConcertById = jest.fn<() => Promise<unknown>>();

jest.mock('../../../apps/backend/services/concerts.service', () => ({
  getConcertsPage: mockGetConcertsPage,
  getConcertsCount: mockGetConcertsCount,
  getConcertById: mockGetConcertById,
}));

import { nyCalendarDate } from '@wxyc/database';
import {
  getConcertById,
  getConcerts,
  ConcertsQueryParams,
} from '../../../apps/backend/controllers/concerts.controller';

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

/**
 * `GET /concerts/:id` (BS#1694) — public, windowless single-concert read per
 * `wxyc-shared/api.yaml` v1.18.0 (`/concerts/{id}`, wxyc-shared#236). The
 * service is mocked, so these pin the controller half of the contract: the
 * all-digits id guard (same strictness as the list's page/limit — a bare
 * parseInt would coerce '12abc'), null → 404 WxycError, and public
 * cacheability on the 200 path only (an error response must never pick up the
 * public Cache-Control, or a shared cache could pin a 404/400 for 5 minutes).
 * Auth-tier wiring (no middleware) is pinned in the route + integration tests;
 * windowless/tombstone semantics are pinned against real SQL in
 * tests/integration/concerts-by-id.spec.js.
 */
describe('concerts.controller getConcertById', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  const mockNext = jest.fn<NextFunction>();

  const invoke = () => getConcertById(req as Request, res as Response, mockNext);

  const concert = {
    id: 4821,
    venue: { id: 3, slug: 'cats-cradle', name: "Cat's Cradle", city: 'Carrboro', state: 'NC', address: null },
    starts_on: '2026-08-14',
    status: 'on_sale',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConcertById.mockResolvedValue(concert);
    req = { params: { id: '4821' } };
    res = {
      status: jest.fn().mockReturnThis() as unknown as Response['status'],
      json: jest.fn() as unknown as Response['json'],
      set: jest.fn().mockReturnThis() as unknown as Response['set'],
    };
  });

  const setId = (id: string) => {
    req.params = { id };
  };

  it('serves the concert the service resolves, verbatim', async () => {
    await invoke();

    expect(mockGetConcertById).toHaveBeenCalledWith(4821);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(concert);
  });

  it('marks the 200 publicly cacheable with the ~5-minute TTL the spec calls for', async () => {
    await invoke();
    // The public directive must be the FINAL Cache-Control written — it
    // overrides the no-store default the handler pins first.
    expect(res.set).toHaveBeenLastCalledWith('Cache-Control', 'public, max-age=300');
  });

  // Omitting Cache-Control does NOT keep a 404 out of shared caches: 404 is
  // heuristically cacheable by default (RFC 9110 §15.5.5), and the CDN tier
  // this route is built for caches header-less 404s for minutes — long
  // enough to pin a freshly-shared id as dead at the edge. Every response
  // therefore starts explicitly `no-store`; only the 200 path upgrades to
  // the public directive.
  it('pins the no-store default before anything can throw', async () => {
    await invoke();
    expect(res.set).toHaveBeenNthCalledWith(1, 'Cache-Control', 'no-store');
  });

  it('maps a service null to a 404 WxycError with Cache-Control pinned no-store', async () => {
    mockGetConcertById.mockResolvedValue(null);
    setId('999999');

    await expect(invoke()).rejects.toMatchObject({ statusCode: 404 });
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.set).not.toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
    expect(res.json).not.toHaveBeenCalled();
  });

  it.each([
    ['abc'],
    // trailing-garbage / radix inputs a bare parseInt would coerce
    ['12abc'],
    ['0x10'],
    ['-1'],
    ['1.5'],
    [''],
    // 0 is all-digits but not a valid serial id — reject before the query
    ['0'],
  ])('rejects id=%s with a 400 WxycError without querying', async (id) => {
    setId(id);

    await expect(invoke()).rejects.toMatchObject({
      statusCode: 400,
      message: 'id must be a positive integer',
    });
    expect(mockGetConcertById).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.set).not.toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
  });

  // Out-of-int4-range ids (e.g. '2147483648') are well-formed integers that
  // can never exist; the SERVICE owns that persistence fact and resolves
  // them to null (see concerts.service.test.ts), which the null → 404
  // mapping above already covers at this tier. The full wire behavior is
  // pinned end-to-end in tests/integration/concerts-by-id.spec.js.

  it('propagates service failures to the error handler', async () => {
    const failure = new Error('db unavailable');
    mockGetConcertById.mockRejectedValue(failure);
    await expect(invoke()).rejects.toThrow(failure);
  });
});
