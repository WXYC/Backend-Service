import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock Sentry
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

// Mock the service module
const mockGetEntriesByPage = jest.fn<() => Promise<unknown[]>>();
const mockGetEntryCount = jest.fn<() => Promise<number>>();
const mockGetEntriesByShow = jest.fn<() => Promise<unknown[]>>();
const mockGetShowMetadata = jest.fn<() => Promise<Record<string, unknown>>>();
const mockTransformToV2 = jest.fn((entry: unknown) => ({ ...(entry as Record<string, unknown>), v2: true }));
const mockAddTrack = jest.fn<() => Promise<Record<string, unknown>>>();
const mockGetLatestShow = jest.fn<() => Promise<Record<string, unknown> | null>>();
const mockGetAlbumFromDB = jest.fn<() => Promise<Record<string, unknown>>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getEntriesByPage: mockGetEntriesByPage,
  getEntryCount: mockGetEntryCount,
  getEntriesByShow: mockGetEntriesByShow,
  getShowMetadata: mockGetShowMetadata,
  transformToV2: mockTransformToV2,
  addTrack: mockAddTrack,
  getLatestShow: mockGetLatestShow,
  getAlbumFromDB: mockGetAlbumFromDB,
}));

const mockFetchAndCacheMetadata = jest.fn<() => Promise<void>>();
jest.mock('../../../apps/backend/services/metadata/index', () => ({
  fetchAndCacheMetadata: mockFetchAndCacheMetadata,
}));

import { getEntries, getLatest, getShowInfo, addEntry } from '../../../apps/backend/controllers/flowsheet.controller';

// Helper to create mock Express req/res/next
const createMockReq = (query: Record<string, string> = {}): Partial<Request> => ({
  query,
});

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.send = jest.fn().mockReturnValue(res) as unknown as Response['send'];
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
        entries: entries.map((e) => ({ ...e, v2: true })),
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

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ totalPages: 3 }));
    });

    it('returns totalPages=0 when no entries exist', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);
      mockGetEntryCount.mockResolvedValue(0);

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ entries: [], total: 0, totalPages: 0 }));
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

    it('returns 200 with null when no entries exist', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);

      const req = createMockReq();
      const res = createMockRes();

      await getLatest(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(null);
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
        entries: entries.map((e) => ({ ...e, v2: true })),
      });
    });

    it('fetches show metadata and entries in parallel', async () => {
      const callOrder: string[] = [];
      mockGetShowMetadata.mockImplementation(() => {
        callOrder.push('metadata');
        return mockShowMetadata;
      });
      mockGetEntriesByShow.mockImplementation(() => {
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

    it.each([['abc'], [undefined]])('returns 400 for invalid show_id=%s', async (show_id) => {
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

  describe('addEntry', () => {
    const activeShow = { id: 42, end_time: null };

    const createMockBodyReq = (body: Record<string, unknown>): Partial<Request> => ({
      body,
    });

    beforeEach(() => {
      mockGetLatestShow.mockResolvedValue(activeShow);
    });

    it.each([
      ['Talkset', undefined, 'talkset'],
      ['Talkset - DJ Speaking', undefined, 'talkset'],
      ['Breakpoint', undefined, 'breakpoint'],
      ['Breakpoint: Station ID', undefined, 'breakpoint'],
      ['PSA announcement', undefined, 'message'],
      ['Talkset', 'talkset', 'talkset'],
    ])('sets entry_type for message="%s", explicit=%s -> %s', async (message, entryType, expectedType) => {
      const completedEntry = {
        id: 1,
        show_id: activeShow.id,
        entry_type: expectedType,
        message,
        play_order: 1,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);

      const body: Record<string, unknown> = { message };
      if (entryType !== undefined) body.entry_type = entryType;
      const req = createMockBodyReq(body);
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          entry_type: expectedType,
          message,
          show_id: activeShow.id,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(completedEntry);
    });

    it('explicit entry_type takes precedence over message content inference', async () => {
      const message = 'Breakpoint: Station ID';
      const completedEntry = {
        id: 1,
        show_id: activeShow.id,
        entry_type: 'talkset',
        message,
        play_order: 1,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);

      const req = createMockBodyReq({ message, entry_type: 'talkset' });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          entry_type: 'talkset',
          message,
          show_id: activeShow.id,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('reports metadata fetch failure to Sentry when album_id is provided', async () => {
      const albumInfo = { artist_name: 'Autechre', album_title: 'Confield', record_label: 'Warp', artist_id: 5 };
      mockGetAlbumFromDB.mockResolvedValue(albumInfo);
      const completedEntry = {
        id: 1,
        show_id: activeShow.id,
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
        album_id: 10,
        rotation_id: null,
        play_order: 1,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);
      const metadataError = new Error('Discogs timeout');
      mockFetchAndCacheMetadata.mockRejectedValue(metadataError);

      const req = createMockBodyReq({
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
        record_label: 'Warp',
        album_id: 10,
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      // Wait for fire-and-forget .catch() to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockCaptureException).toHaveBeenCalledWith(
        metadataError,
        expect.objectContaining({ tags: { subsystem: 'metadata' } })
      );
    });

    it('reports metadata fetch failure to Sentry when no album_id', async () => {
      const completedEntry = {
        id: 2,
        show_id: activeShow.id,
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        record_label: 'Sonamos',
        album_id: null,
        rotation_id: null,
        play_order: 2,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);
      const metadataError = new Error('Spotify rate limit');
      mockFetchAndCacheMetadata.mockRejectedValue(metadataError);

      const req = createMockBodyReq({
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        record_label: 'Sonamos',
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      await new Promise((r) => setTimeout(r, 10));

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockCaptureException).toHaveBeenCalledWith(
        metadataError,
        expect.objectContaining({ tags: { subsystem: 'metadata' } })
      );
    });

    it('passes segue field through for library-linked tracks (album_id provided)', async () => {
      const albumInfo = {
        artist_name: 'Stereolab',
        album_title: 'Aluminum Tunes',
        record_label: 'Duophonic',
        artist_id: 7,
      };
      mockGetAlbumFromDB.mockResolvedValue(albumInfo);
      const completedEntry = {
        id: 3,
        show_id: activeShow.id,
        artist_name: 'Stereolab',
        album_title: 'Aluminum Tunes',
        track_title: 'Crispy Duck',
        album_id: 20,
        segue: true,
        rotation_id: null,
        play_order: 3,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);
      mockFetchAndCacheMetadata.mockResolvedValue(undefined);

      const req = createMockBodyReq({
        track_title: 'Crispy Duck',
        album_id: 20,
        segue: true,
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          segue: true,
          show_id: activeShow.id,
          album_id: 20,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('defaults segue to false for library-linked tracks when not provided', async () => {
      const albumInfo = {
        artist_name: 'Cat Power',
        album_title: 'Moon Pix',
        record_label: 'Matador Records',
        artist_id: 8,
      };
      mockGetAlbumFromDB.mockResolvedValue(albumInfo);
      const completedEntry = {
        id: 4,
        show_id: activeShow.id,
        artist_name: 'Cat Power',
        album_title: 'Moon Pix',
        track_title: 'Metal Heart',
        album_id: 25,
        segue: false,
        rotation_id: null,
        play_order: 4,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);
      mockFetchAndCacheMetadata.mockResolvedValue(undefined);

      const req = createMockBodyReq({
        track_title: 'Metal Heart',
        album_id: 25,
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          segue: false,
          show_id: activeShow.id,
          album_id: 25,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('does not set entry_type to message for track entries', async () => {
      const trackBody = {
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
        record_label: 'Warp',
      };
      const completedEntry = {
        id: 2,
        show_id: activeShow.id,
        entry_type: 'track',
        ...trackBody,
        play_order: 2,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);
      mockFetchAndCacheMetadata.mockResolvedValue(undefined);

      const req = createMockBodyReq(trackBody);
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.not.objectContaining({
          entry_type: 'message',
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });
});
