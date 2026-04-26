import { Request, Response } from 'express';

const searchFlowsheet = jest.fn();

jest.mock('../../../apps/backend/services/search.service', () => {
  // Use the real parseCursor implementation so the controller's validation
  // exercises actual codec semantics rather than a hand-mocked allow-list.
  const actual = jest.requireActual('../../../apps/backend/services/search.service');
  return {
    searchFlowsheet: (...args: unknown[]) => searchFlowsheet(...args),
    parseCursor: actual.parseCursor,
    encodeCursor: actual.encodeCursor,
  };
});

import { searchFlowsheetEndpoint } from '../../../apps/backend/controllers/search.controller';

beforeEach(() => {
  searchFlowsheet.mockReset();
  searchFlowsheet.mockResolvedValue({ results: [], total: 0 });
});

const makeRes = () => {
  const res = {} as Response & { _status: number; _body: unknown };
  res.status = jest.fn(function (this: typeof res, code: number) {
    this._status = code;
    return this;
  });
  res.json = jest.fn(function (this: typeof res, body: unknown) {
    this._body = body;
    return this;
  });
  return res;
};

const invoke = (query: Record<string, string | undefined>) => {
  const req = { query } as unknown as Request;
  const res = makeRes();
  const next = jest.fn();
  return { req, res, next, run: () => searchFlowsheetEndpoint(req, res, next) };
};

describe('searchFlowsheetEndpoint', () => {
  describe('empty query', () => {
    it('treats a missing q as an empty filter (returns recent tracks)', async () => {
      const { res, run } = invoke({});

      await run();

      expect(res._status).toBe(200);
      expect(searchFlowsheet).toHaveBeenCalledWith(expect.objectContaining({ q: '' }));
    });

    it('treats an empty q as an empty filter', async () => {
      const { res, run } = invoke({ q: '' });

      await run();

      expect(res._status).toBe(200);
      expect(searchFlowsheet).toHaveBeenCalledWith(expect.objectContaining({ q: '' }));
    });

    it('treats a whitespace-only q as an empty filter', async () => {
      const { res, run } = invoke({ q: '   ' });

      await run();

      expect(res._status).toBe(200);
      expect(searchFlowsheet).toHaveBeenCalledWith(expect.objectContaining({ q: '   ' }));
    });
  });

  describe('parameter forwarding', () => {
    it('passes q, page, limit, sort, and order to the service', async () => {
      const { run } = invoke({ q: 'autechre', page: '2', limit: '25', sort: 'artist', order: 'asc' });

      await run();

      expect(searchFlowsheet).toHaveBeenCalledWith({
        q: 'autechre',
        page: 2,
        limit: 25,
        sort: 'artist',
        order: 'asc',
      });
    });

    it('defaults page to 0, limit to 50, sort to date, order to desc', async () => {
      const { run } = invoke({ q: 'autechre' });

      await run();

      expect(searchFlowsheet).toHaveBeenCalledWith({
        q: 'autechre',
        page: 0,
        limit: 50,
        sort: 'date',
        order: 'desc',
      });
    });

    it('falls back to date sort when sort is invalid', async () => {
      const { run } = invoke({ q: 'autechre', sort: 'bogus' });

      await run();

      expect(searchFlowsheet).toHaveBeenCalledWith(expect.objectContaining({ sort: 'date' }));
    });
  });

  describe('validation errors', () => {
    it('returns 400 when page is negative', async () => {
      const { res, run } = invoke({ q: 'autechre', page: '-1' });

      await run();

      expect(res._status).toBe(400);
      expect(searchFlowsheet).not.toHaveBeenCalled();
    });

    it('returns 400 when limit is zero', async () => {
      const { res, run } = invoke({ q: 'autechre', limit: '0' });

      await run();

      expect(res._status).toBe(400);
      expect(searchFlowsheet).not.toHaveBeenCalled();
    });

    it('returns 400 when limit exceeds the cap', async () => {
      const { res, run } = invoke({ q: 'autechre', limit: '200' });

      await run();

      expect(res._status).toBe(400);
      expect(searchFlowsheet).not.toHaveBeenCalled();
    });
  });

  describe('response shape', () => {
    it('returns results, total, page, and totalPages', async () => {
      searchFlowsheet.mockResolvedValueOnce({ results: ['a', 'b'], total: 100 });
      const { res, run } = invoke({ q: 'autechre', limit: '10' });

      await run();

      expect(res._body).toEqual({ results: ['a', 'b'], total: 100, page: 0, totalPages: 10 });
    });

    it('reports totalPages as 0 when there are no results', async () => {
      searchFlowsheet.mockResolvedValueOnce({ results: [], total: 0 });
      const { res, run } = invoke({});

      await run();

      expect(res._body).toEqual({ results: [], total: 0, page: 0, totalPages: 0 });
    });

    it('includes nextCursor when the service returns one', async () => {
      searchFlowsheet.mockResolvedValueOnce({
        results: ['a'],
        total: 1000,
        nextCursor: '2024-06-15T14:30:00.000Z_42',
      });
      const { res, run } = invoke({ cursor: '2024-06-16T00:00:00.000Z_99' });

      await run();

      expect(res._body).toMatchObject({
        results: ['a'],
        total: 1000,
        nextCursor: '2024-06-15T14:30:00.000Z_42',
      });
    });

    it('omits nextCursor when the service does not return one', async () => {
      searchFlowsheet.mockResolvedValueOnce({ results: ['a'], total: 1 });
      const { res, run } = invoke({});

      await run();

      expect(res._body).not.toHaveProperty('nextCursor');
    });
  });

  describe('cursor parameter', () => {
    it('forwards a valid cursor to the service', async () => {
      const { run } = invoke({ cursor: '2024-06-15T14:30:00.000Z_42' });

      await run();

      expect(searchFlowsheet).toHaveBeenCalledWith(expect.objectContaining({ cursor: '2024-06-15T14:30:00.000Z_42' }));
    });

    it('passes cursor as undefined when not provided', async () => {
      const { run } = invoke({});

      await run();

      expect(searchFlowsheet).toHaveBeenCalledWith(expect.objectContaining({ cursor: undefined }));
    });

    it.each([
      ['no-underscore'],
      ['_42'],
      ['2024-06-15T14:30:00.000Z_'],
      ['2024-06-15T14:30:00.000Z_abc'],
      ['not-a-date_42'],
    ])('returns 400 for malformed cursor %j', async (cursor) => {
      const { res, run } = invoke({ cursor });

      await run();

      expect(res._status).toBe(400);
      expect(searchFlowsheet).not.toHaveBeenCalled();
    });
  });
});
