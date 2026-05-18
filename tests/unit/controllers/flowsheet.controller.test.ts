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
const mockResolveDjNameForShow = jest.fn<() => Promise<string | null>>();
const mockUpdateEntry = jest.fn<() => Promise<Record<string, unknown>>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getEntriesByPage: mockGetEntriesByPage,
  getEntryCount: mockGetEntryCount,
  getEntriesByShow: mockGetEntriesByShow,
  getShowMetadata: mockGetShowMetadata,
  transformToV2: mockTransformToV2,
  addTrack: mockAddTrack,
  getLatestShow: mockGetLatestShow,
  getAlbumFromDB: mockGetAlbumFromDB,
  resolveDjNameForShow: mockResolveDjNameForShow,
  updateEntry: mockUpdateEntry,
}));

const mockFetchMetadata = jest.fn<() => Promise<void>>();
const mockFireAndForgetMetadataForRow = jest.fn();
jest.mock('../../../apps/backend/services/metadata/index', () => ({
  fetchMetadata: mockFetchMetadata,
  fireAndForgetMetadataForRow: mockFireAndForgetMetadataForRow,
}));

import {
  getEntries,
  getLatest,
  getShowInfo,
  addEntry,
  updateEntry,
} from '../../../apps/backend/controllers/flowsheet.controller';
import WxycError from '../../../apps/backend/utils/error';

// Helper to create mock Express req/res/next
const createMockReq = (query: Record<string, string> = {}): Partial<Request> => ({
  query,
});

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.send = jest.fn().mockReturnValue(res) as unknown as Response['send'];
  res.end = jest.fn().mockReturnValue(res) as unknown as Response['end'];
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
    mockNext = jest.fn();
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
      ])('rejects limit=%s with WxycError', async (limit, expectedMessage) => {
        const req = createMockReq({ limit });
        const res = createMockRes();

        await expect(getEntries(req as Request, res as Response, mockNext)).rejects.toThrow(expectedMessage);
        expect(mockGetEntriesByPage).not.toHaveBeenCalled();
      });

      it('rejects limit exceeding MAX_ITEMS (200)', async () => {
        const req = createMockReq({ limit: '201' });
        const res = createMockRes();

        await expect(getEntries(req as Request, res as Response, mockNext)).rejects.toThrow(
          'Requested too many entries'
        );
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
      ])('rejects page=%s with WxycError', async (page, expectedMessage) => {
        const req = createMockReq({ page });
        const res = createMockRes();

        await expect(getEntries(req as Request, res as Response, mockNext)).rejects.toThrow(expectedMessage);
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

    it('rejects with error on service failure', async () => {
      const error = new Error('DB connection failed');
      mockGetEntriesByPage.mockRejectedValue(error);

      const req = createMockReq();
      const res = createMockRes();

      await expect(getEntries(req as Request, res as Response, mockNext)).rejects.toThrow(error);
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

    it('returns 204 with no body when no entries exist', async () => {
      mockGetEntriesByPage.mockResolvedValue([]);

      const req = createMockReq();
      const res = createMockRes();

      await getLatest(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
      expect(mockTransformToV2).not.toHaveBeenCalled();
    });

    it('rejects with error on service failure', async () => {
      const error = new Error('DB timeout');
      mockGetEntriesByPage.mockRejectedValue(error);

      const req = createMockReq();
      const res = createMockRes();

      await expect(getLatest(req as Request, res as Response, mockNext)).rejects.toThrow(error);
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

    it.each([['abc'], [undefined]])('throws WxycError for invalid show_id=%s', async (show_id) => {
      const query = show_id !== undefined ? { show_id } : {};
      const req = createMockReq(query);
      const res = createMockRes();

      await expect(getShowInfo(req as Request, res as Response, mockNext)).rejects.toThrow(
        'Missing or invalid show_id parameter'
      );
      expect(mockGetShowMetadata).not.toHaveBeenCalled();
      expect(mockGetEntriesByShow).not.toHaveBeenCalled();
    });

    it('rejects with error on service failure', async () => {
      const error = new Error('Show not found');
      mockGetShowMetadata.mockRejectedValue(error);

      const req = createMockReq({ show_id: '1' });
      const res = createMockRes();

      await expect(getShowInfo(req as Request, res as Response, mockNext)).rejects.toThrow(error);
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

    // The Sentry/error path is owned by enrichment.service.ts and is
    // covered in tests/unit/services/metadata.enrichment.test.ts. Here we
    // verify only that the controller delegates to it with the right args.

    it('delegates metadata enrichment with artistId from album lookup when album_id is provided', async () => {
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

      const req = createMockBodyReq({
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
        record_label: 'Warp',
        album_id: 10,
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledWith({
        flowsheetId: 1,
        artistName: 'Autechre',
        albumId: 10,
        artistId: 5,
        albumTitle: 'Confield',
        trackTitle: 'VI Scose Poise',
      });
    });

    it('falls through to free-form path when album_id is explicitly null (BS#933)', async () => {
      // BS#689 made the rotation dropdown LEFT JOIN library so unlinked
      // rotation rows (album_id IS NULL) become selectable; their dropdown
      // entries carry a NULL id. dj-site dispatches `album_id: null` along
      // with the rotation snapshot fields (artist_name / album_title /
      // record_label). Before the fix, the controller branched on
      // `body.album_id !== undefined` — `null !== undefined` was true, so
      // it called getAlbumFromDB(null), which returned undefined, and the
      // next line TypeErrored when it tried to set record_label on it.
      // The fix flips the predicate to `!= null` so null falls through to
      // the snapshot-fields branch.
      const completedEntry = {
        id: 3,
        show_id: activeShow.id,
        artist_name: 'Coupé Cloué',
        album_title: 'Maintenant ou Jamais',
        track_title: 'Manman',
        record_label: 'Mini Records',
        album_id: null,
        rotation_id: 99,
        play_order: 3,
        add_time: new Date(),
      };
      mockAddTrack.mockResolvedValue(completedEntry);

      const req = createMockBodyReq({
        artist_name: 'Coupé Cloué',
        album_title: 'Maintenant ou Jamais',
        track_title: 'Manman',
        record_label: 'Mini Records',
        album_id: null,
        rotation_id: 99,
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      // getAlbumFromDB must not be invoked — null album_id is not a library lookup.
      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          artist_name: 'Coupé Cloué',
          album_title: 'Maintenant ou Jamais',
          track_title: 'Manman',
          record_label: 'Mini Records',
          album_id: null,
          rotation_id: 99,
          show_id: activeShow.id,
        })
      );
    });

    it('delegates metadata enrichment without artistId for free-form inserts (no album_id)', async () => {
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

      const req = createMockBodyReq({
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        record_label: 'Sonamos',
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockFireAndForgetMetadataForRow).toHaveBeenCalledWith({
        flowsheetId: 2,
        artistName: 'Juana Molina',
        albumId: undefined,
        artistId: undefined,
        albumTitle: 'DOGA',
        trackTitle: 'la paradoja',
      });
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
      mockFetchMetadata.mockResolvedValue(undefined);

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
      mockFetchMetadata.mockResolvedValue(undefined);

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

    it('forwards track_position into NewFSEntry for the album_id branch (BS#943)', async () => {
      // The dj-site flowsheet picker (E6-6) calls /proxy/library/{id}/tracks
      // after a release is selected, then submits the chosen track with the
      // library `album_id` plus the Discogs `release_track.position` string
      // (e.g. "A1"). Schema/projection landed in BS#835; this pins the
      // controller wiring that lets the value reach the DB.
      const albumInfo = {
        artist_name: 'Autechre',
        album_title: 'Confield',
        record_label: 'Warp',
        artist_id: 5,
      };
      mockGetAlbumFromDB.mockResolvedValue(albumInfo);
      mockAddTrack.mockResolvedValue({
        id: 1,
        show_id: activeShow.id,
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
        track_position: 'A1',
        album_id: 10,
        play_order: 1,
        add_time: new Date(),
      });

      const req = createMockBodyReq({
        track_title: 'VI Scose Poise',
        track_position: 'A1',
        album_id: 10,
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          album_id: 10,
          track_title: 'VI Scose Poise',
          track_position: 'A1',
          show_id: activeShow.id,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('forwards track_position into NewFSEntry for the free-form branch (BS#943)', async () => {
      // Free-form fallback: dj-site sends snapshot fields without album_id but
      // still carries a position the DJ entered or that survived from a
      // rotation-snapshot pick.
      mockAddTrack.mockResolvedValue({
        id: 2,
        show_id: activeShow.id,
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        track_position: 'B2',
        record_label: 'Sonamos',
        album_id: null,
        play_order: 2,
        add_time: new Date(),
      });

      const req = createMockBodyReq({
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        track_position: 'B2',
        record_label: 'Sonamos',
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockGetAlbumFromDB).not.toHaveBeenCalled();
      expect(mockAddTrack).toHaveBeenCalledWith(
        expect.objectContaining({
          artist_name: 'Juana Molina',
          track_title: 'la paradoja',
          track_position: 'B2',
          show_id: activeShow.id,
        })
      );
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('does not forward track_position on the message-only branch (BS#943)', async () => {
      // Talkset/breakpoint/PSA rows are entry_type != 'track'; the column is
      // semantically track-only. Even if a malformed payload includes
      // track_position on a message entry, the controller should not pass it
      // through.
      mockAddTrack.mockResolvedValue({
        id: 3,
        show_id: activeShow.id,
        entry_type: 'talkset',
        message: 'Talkset',
        play_order: 3,
        add_time: new Date(),
      });

      const req = createMockBodyReq({
        message: 'Talkset',
        track_position: 'A1',
      });
      const res = createMockRes();

      await addEntry(req as Request, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledWith(expect.not.objectContaining({ track_position: expect.anything() }));
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
      mockFetchMetadata.mockResolvedValue(undefined);

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

  describe('updateEntry', () => {
    it('forwards track_position from data into the service update payload (BS#943)', async () => {
      // Picker edit flow: user changes the track on an existing entry; the
      // PATCH body carries the new position. The service `updateEntry` does a
      // straight `db.update(flowsheet).set(data)`, so the controller only
      // needs the type widening — but we pin the contract here so a future
      // regression that strips fields shows up loudly.
      mockUpdateEntry.mockResolvedValue({
        id: 99,
        track_title: 'la paradoja',
        track_position: 'A2',
      });

      const req = {
        body: {
          entry_id: 99,
          data: {
            track_title: 'la paradoja',
            track_position: 'A2',
          },
        },
      } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res as Response, mockNext);

      expect(mockUpdateEntry).toHaveBeenCalledWith(
        99,
        expect.objectContaining({ track_position: 'A2', track_title: 'la paradoja' })
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
