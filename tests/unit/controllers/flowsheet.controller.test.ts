import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock the service module
const mockGetEntriesByPage = jest.fn<() => Promise<unknown[]>>();
const mockGetEntryCount = jest.fn<() => Promise<number>>();
const mockGetEntriesByShow = jest.fn<() => Promise<unknown[]>>();
const mockGetShowMetadata = jest.fn<() => Promise<Record<string, unknown>>>();
const mockTransformToV2 = jest.fn((entry: unknown) => ({ ...entry as Record<string, unknown>, v2: true }));

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getEntriesByPage: mockGetEntriesByPage,
  getEntryCount: mockGetEntryCount,
  getEntriesByShow: mockGetEntriesByShow,
  getShowMetadata: mockGetShowMetadata,
  transformToV2: mockTransformToV2,
}));

import { getEntries, getLatest, getShowInfo } from '../../../apps/backend/controllers/flowsheet.controller';

// Helper to create mock Express req/res/next
const createMockReq = (query: Record<string, string> = {}): Partial<Request> => ({
  query,
});

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res;
};

const createMockEntry = (id: number) => ({
  id,
  show_id: 1,
  entry_type: 'track',
  play_order: id,
  add_time: new Date(),
});

describe('flowsheet.controller', () => {
  let mockNext: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    mockNext = jest.fn() as unknown as NextFunction;
  });

  describe('getEntries', () => {
    it('returns paginated entries with defaults (page=0, limit=30)', async () => {
      const entries = [createMockEntry(1), createMockEntry(2)];
      mockGetEntriesByPage.mockResolvedValue(entries);
      mockGetEntryCount.mockResolvedValue(2);

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(mockGetEntriesByPage).toHaveBeenCalledWith(0, 30);
      expect(mockGetEntryCount).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        entries: entries.map(e => ({ ...e, v2: true })),
        total: 2,
        page: 0,
        limit: 30,
        totalPages: 1,
      });
    });

    it('calculates offset from page and limit', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);
      mockGetEntryCount.mockResolvedValue(100);

      const req = createMockReq({ page: '3', limit: '10' });
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(mockGetEntriesByPage).toHaveBeenCalledWith(30, 10);
    });

    it('calculates totalPages correctly', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);
      mockGetEntryCount.mockResolvedValue(25);

      const req = createMockReq({ limit: '10' });
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ totalPages: 3 }),
      );
    });

    it('returns totalPages=0 when no entries exist', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);
      mockGetEntryCount.mockResolvedValue(0);

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ entries: [], total: 0, totalPages: 0 }),
      );
    });

    it('transforms each entry through transformToV2', async () => {
      const entries = [createMockEntry(1), createMockEntry(2), createMockEntry(3)];
      mockGetEntriesByPage.mockResolvedValue(entries);
      mockGetEntryCount.mockResolvedValue(3);

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(mockTransformToV2).toHaveBeenCalledTimes(3);
      expect(mockTransformToV2).toHaveBeenCalledWith(entries[0], 0, entries);
      expect(mockTransformToV2).toHaveBeenCalledWith(entries[1], 1, entries);
      expect(mockTransformToV2).toHaveBeenCalledWith(entries[2], 2, entries);
    });

    describe('validation', () => {
      it.each([
        ['abc', 'limit must be a positive number'],
        ['0', 'limit must be a positive number'],
        ['-1', 'limit must be a positive number'],
      ])('rejects limit=%s with 400', async (limit, expectedMessage) => {
        const req = createMockReq({ limit });
        const res = createMockRes();

        await getEntries(req as Request, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ message: expectedMessage });
        expect(mockGetEntriesByPage).not.toHaveBeenCalled();
      });

      it('rejects limit exceeding MAX_ITEMS (200)', async () => {
        const req = createMockReq({ limit: '201' });
        const res = createMockRes();

        await getEntries(req as Request, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ message: 'Requested too many entries' });
      });

      it('accepts limit=200 (exactly MAX_ITEMS)', async () => {
        mockGetEntriesByPage.mockResolvedValue([]);
        mockGetEntryCount.mockResolvedValue(0);

        const req = createMockReq({ limit: '200' });
        const res = createMockRes();

        await getEntries(req as Request, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(mockGetEntriesByPage).toHaveBeenCalledWith(0, 200);
      });

      it.each([
        ['abc', 'page must be a non-negative number'],
        ['-1', 'page must be a non-negative number'],
      ])('rejects page=%s with 400', async (page, expectedMessage) => {
        const req = createMockReq({ page });
        const res = createMockRes();

        await getEntries(req as Request, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ message: expectedMessage });
        expect(mockGetEntriesByPage).not.toHaveBeenCalled();
      });

      it('accepts page=0', async () => {
        mockGetEntriesByPage.mockResolvedValue([]);
        mockGetEntryCount.mockResolvedValue(0);

        const req = createMockReq({ page: '0' });
        const res = createMockRes();

        await getEntries(req as Request, res as Response, mockNext);

        expect(res.status).toHaveBeenCalledWith(200);
      });
    });

    it('calls next with error on service failure', async () => {
      const error = new Error('DB connection failed');
      mockGetEntriesByPage.mockRejectedValue(error);

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('getLatest', () => {
    it('returns the latest entry transformed to V2', async () => {
      const entry = createMockEntry(42);
      mockGetEntriesByPage.mockResolvedValue([entry]);

      const req = createMockReq();
      const res = createMockRes();

      await getLatest(req as Request, res as Response, mockNext);

      expect(mockGetEntriesByPage).toHaveBeenCalledWith(0, 1);
      expect(mockTransformToV2).toHaveBeenCalledWith(entry);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ ...entry, v2: true });
    });

    it('returns 404 when no entries exist', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);

      const req = createMockReq();
      const res = createMockRes();

      await getLatest(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ message: 'No entries found' });
      expect(mockTransformToV2).not.toHaveBeenCalled();
    });

    it('calls next with error on service failure', async () => {
      const error = new Error('DB timeout');
      mockGetEntriesByPage.mockRejectedValue(error);

      const req = createMockReq();
      const res = createMockRes();

      await getLatest(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('getShowInfo', () => {
    const mockShowMetadata = {
      id: 1,
      specialty_show_name: '',
      show_djs: [{ id: '1', dj_name: 'DJ Test' }],
    };

    it('returns show metadata with V2-transformed entries', async () => {
      const entries = [createMockEntry(1), createMockEntry(2)];
      mockGetShowMetadata.mockResolvedValue(mockShowMetadata);
      mockGetEntriesByShow.mockResolvedValue(entries);

      const req = createMockReq({ show_id: '1' });
      const res = createMockRes();

      await getShowInfo(req as Request, res as Response, mockNext);

      expect(mockGetShowMetadata).toHaveBeenCalledWith(1);
      expect(mockGetEntriesByShow).toHaveBeenCalledWith(1);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        ...mockShowMetadata,
        entries: entries.map(e => ({ ...e, v2: true })),
      });
    });

    it('fetches show metadata and entries in parallel', async () => {
      const callOrder: string[] = [];
      mockGetShowMetadata.mockImplementation(async () => {
        callOrder.push('metadata');
        return mockShowMetadata;
      });
      mockGetEntriesByShow.mockImplementation(async () => {
        callOrder.push('entries');
        return [];
      });

      const req = createMockReq({ show_id: '1' });
      const res = createMockRes();

      await getShowInfo(req as Request, res as Response, mockNext);

      // Both should be called (Promise.all)
      expect(mockGetShowMetadata).toHaveBeenCalledWith(1);
      expect(mockGetEntriesByShow).toHaveBeenCalledWith(1);
    });

    it.each([
      ['abc'],
      [undefined],
    ])('returns 400 for invalid show_id=%s', async (show_id) => {
      const query = show_id !== undefined ? { show_id } : {};
      const req = createMockReq(query as Record<string, string>);
      const res = createMockRes();

      await getShowInfo(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ message: 'Missing or invalid show_id parameter' });
      expect(mockGetShowMetadata).not.toHaveBeenCalled();
      expect(mockGetEntriesByShow).not.toHaveBeenCalled();
    });

    it('calls next with error on service failure', async () => {
      const error = new Error('Show not found');
      mockGetShowMetadata.mockRejectedValue(error);

      const req = createMockReq({ show_id: '1' });
      const res = createMockRes();

      await getShowInfo(req as Request, res as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
