import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

// Mock Sentry
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException }));

// Mock the service module
const mockGetEntriesByPage = jest.fn<() => Promise<unknown[]>>();
const mockGetEntryCount = jest.fn<() => Promise<number>>();
const mockGetEntriesByShow = jest.fn<() => Promise<unknown[]>>();
const mockGetNShows = jest.fn<() => Promise<unknown[]>>();
const mockGetShowMetadata = jest.fn<() => Promise<Record<string, unknown>>>();
const mockTransformToV2 = jest.fn((entry: unknown) => ({ ...(entry as Record<string, unknown>), v2: true }));
const mockAddTrack = jest.fn<() => Promise<Record<string, unknown>>>();
const mockGetLatestShow = jest.fn<() => Promise<Record<string, unknown> | null>>();
const mockGetOnAirDJName = jest.fn<() => Promise<string | null>>();
const mockGetAlbumFromDB = jest.fn<() => Promise<Record<string, unknown>>>();
const mockResolveDjNameForShow = jest.fn<() => Promise<string | null>>();
const mockUpdateEntry = jest.fn<() => Promise<Record<string, unknown>>>();
const mockRemoveTrack = jest.fn<() => Promise<Record<string, unknown>>>();
const mockChangeOrder = jest.fn<() => Promise<Record<string, unknown>>>();
const mockStartShow = jest.fn<() => Promise<Record<string, unknown>>>();
const mockAddDJToShow = jest.fn<() => Promise<Record<string, unknown>>>();
const mockEndShow = jest.fn<() => Promise<Record<string, unknown>>>();
const mockServiceLeaveShow = jest.fn<() => Promise<Record<string, unknown>>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getEntriesByPage: mockGetEntriesByPage,
  getEntryCount: mockGetEntryCount,
  getEntriesByShow: mockGetEntriesByShow,
  getNShows: mockGetNShows,
  getShowMetadata: mockGetShowMetadata,
  transformToV2: mockTransformToV2,
  addTrack: mockAddTrack,
  getLatestShow: mockGetLatestShow,
  getOnAirDJName: mockGetOnAirDJName,
  getAlbumFromDB: mockGetAlbumFromDB,
  resolveDjNameForShow: mockResolveDjNameForShow,
  updateEntry: mockUpdateEntry,
  removeTrack: mockRemoveTrack,
  changeOrder: mockChangeOrder,
  startShow: mockStartShow,
  addDJToShow: mockAddDJToShow,
  endShow: mockEndShow,
  leaveShow: mockServiceLeaveShow,
}));

// flowsheet-projection is intentionally NOT mocked — the controller boundary
// runs the real allow-list projector so these tests observe the actual
// client-facing payload (BS#1513).

import {
  getEntries,
  getLatest,
  getShowInfo,
  addEntry,
  updateEntry,
  deleteEntry,
  changeOrder,
  joinShow,
  leaveShow,
} from '../../../apps/backend/controllers/flowsheet.controller';
import WxycError from '../../../apps/backend/utils/error';
import { INTERNAL_FLOWSHEET_COLUMNS, makeFullFlowsheetRow } from '../../fixtures/flowsheet-row.fixture';

// Helper to create mock Express req/res/next
const createMockReq = (query: Record<string, string> = {}): Partial<Request> => ({
  query,
});

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.locals = {} as Response['locals'];
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
      mockGetOnAirDJName.mockResolvedValue(null);

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
        on_air: null,
      });
    });

    // on_air (BS on-air-banner fix): the default paginated branch carries the
    // current on-air DJ so clients render the banner without scanning the
    // fetched entry window for a show_start marker. An OnAirInfo object means a
    // named DJ is live; JSON null means confirmed automation ("Auto DJ").
    it('includes on_air with the DJ name when a DJ is live', async () => {
      mockGetEntriesByPage.mockResolvedValue([createMockEntry(1)]);
      mockGetEntryCount.mockResolvedValue(1);
      mockGetOnAirDJName.mockResolvedValue('DJ MONSTER');

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(mockGetOnAirDJName).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ on_air: { dj_name: 'DJ MONSTER' } }));
    });

    it('sets on_air to null when the station is on automation', async () => {
      mockGetEntriesByPage.mockResolvedValue([createMockEntry(1)]);
      mockGetEntryCount.mockResolvedValue(1);
      mockGetOnAirDJName.mockResolvedValue(null);

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ on_air: null }));
    });

    // The banner is auxiliary: if getOnAirDJName rejects, the field is omitted
    // (clients decode absent → unknown → hide banner) and the playlist read still
    // succeeds — a banner-query failure must not 500 the whole endpoint.
    it('omits on_air and still returns the playlist when getOnAirDJName throws', async () => {
      const entries = [createMockEntry(1), createMockEntry(2)];
      mockGetEntriesByPage.mockResolvedValue(entries);
      mockGetEntryCount.mockResolvedValue(2);
      mockGetOnAirDJName.mockRejectedValue(new Error('shows lookup failed'));

      const req = createMockReq();
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('on_air');
      expect(body).toMatchObject({ total: 2, page: 0, limit: 30, totalPages: 1 });
      expect(mockNext).not.toHaveBeenCalled();
      // the failure is reported, not silently swallowed
      expect(mockCaptureException).toHaveBeenCalled();
    });

    // on_air rides only on the default paginated branch (the branch the iOS app
    // polls). The shows_limit branch returns a bare array, so it must neither
    // compute nor emit on_air — locking in that "default branch only" decision.
    it('does not compute on_air on the shows_limit branch', async () => {
      mockGetNShows.mockResolvedValue([{ id: 1 }]);
      mockGetEntriesByShow.mockResolvedValue([createMockEntry(1)]);

      const req = createMockReq({ shows_limit: '1' });
      const res = createMockRes();

      await getEntries(req as Request, res as Response, mockNext);

      expect(mockGetOnAirDJName).not.toHaveBeenCalled();
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(Array.isArray(body)).toBe(true);
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

    it('throws WxycError 404 when a positive album_id is not found in library (BS#1271)', async () => {
      // BS#933 narrowed the lookup-branch predicate from `!== undefined` to
      // `!= null`, fixing the explicit-null case. A positive `album_id` that
      // doesn't match any `library.id` (deleted between dj-site picker fetch
      // and POST, or rotation→library FK desync) still slipped through and
      // produced a bare TypeError on the next line — captured as a 500 with
      // no Sentry exception, the signal at the root of BS#1271's POST
      // /flowsheet internal_error bursts. The guard now turns the not-found
      // case into a clean 404 WxycError.
      // Mock the not-found case explicitly: real `getAlbumFromDB` returns
      // `undefined` on no match (see library.service.test.ts:1759).
      mockGetAlbumFromDB.mockResolvedValue(undefined);

      const req = createMockBodyReq({
        album_id: 9999,
        track_title: 'Crispy Duck',
        record_label: 'Duophonic',
      });
      const res = createMockRes();

      await expect(addEntry(req as Request, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
      await expect(addEntry(req as Request, res as Response, mockNext)).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('9999'),
      });
      expect(mockGetAlbumFromDB).toHaveBeenCalledWith(9999);
      // INSERT must not run when the album lookup misses.
      expect(mockAddTrack).not.toHaveBeenCalled();
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

    it('strips internal columns from data before passing to the service (BS#1099)', async () => {
      // Mass-assignment guard: any `flowsheet:write` caller can send arbitrary
      // body keys today. Setting `metadata_status='enriched_match'` skips the
      // enrichment worker forever; `legacy_entry_id` reintroduces the BS#908
      // mirror loop; `show_id` reattaches the row to another show; `play_order`
      // collides with the per-show sequence (#693). The controller must drop
      // these fields before they reach `db.update().set()`.
      //
      // `album_id` and `rotation_id` are explicitly NOT on this list — they
      // are first-class FKs the picker writes (BS#1270). They're covered by
      // the dedicated positive test below.
      mockUpdateEntry.mockResolvedValue({ id: 99, track_title: 'ok' });

      const req = {
        body: {
          entry_id: 99,
          data: {
            track_title: 'ok',
            // The following keys are server-internal and must be stripped.
            metadata_status: 'enriched_match',
            legacy_entry_id: 9999999,
            legacy_release_id: 8888,
            show_id: 1,
            play_order: 0,
            linkage_source: 'manual',
            linkage_confidence: 0.99,
            linked_at: new Date(),
            metadata_attempt_at: new Date(),
            enriching_since: new Date(),
            dj_name: 'evil-dj',
            artwork_url: 'https://example.com/x.jpg',
            discogs_url: 'https://discogs.com/x',
            release_year: 1999,
          },
        },
      } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res as Response, mockNext);

      expect(mockUpdateEntry).toHaveBeenCalledTimes(1);
      const passedData = (mockUpdateEntry as unknown as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      // Allowed field is forwarded.
      expect(passedData).toEqual(expect.objectContaining({ track_title: 'ok' }));
      // Each internal key is absent from the service argument.
      for (const internalKey of [
        'metadata_status',
        'legacy_entry_id',
        'legacy_release_id',
        'show_id',
        'play_order',
        'linkage_source',
        'linkage_confidence',
        'linked_at',
        'metadata_attempt_at',
        'enriching_since',
        'dj_name',
        'artwork_url',
        'discogs_url',
        'release_year',
      ]) {
        expect(passedData).not.toHaveProperty(internalKey);
      }
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('forwards album_id and rotation_id from data to the service (BS#1270)', async () => {
      // BS#1099 originally omitted `album_id` and `rotation_id` from the
      // controller allowlist, which silently stripped them from every
      // PATCH the dj-site rotation/library picker issued. This caused
      // rotation-listed but library-unlinked albums (Yenbett class) to
      // render without artwork on iOS / dj-site. Both are first-class FKs
      // the picker legitimately writes; restore them to the allowlist and
      // pin the contract here.
      mockUpdateEntry.mockResolvedValue({ id: 99, album_id: 42, rotation_id: 7 });

      const req = {
        body: {
          entry_id: 99,
          data: {
            album_id: 42,
            rotation_id: 7,
          },
        },
      } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res as Response, mockNext);

      expect(mockUpdateEntry).toHaveBeenCalledTimes(1);
      expect(mockUpdateEntry).toHaveBeenCalledWith(99, expect.objectContaining({ album_id: 42, rotation_id: 7 }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('forwards every UpdateRequestBody field that the client legitimately sets', async () => {
      // Anti-drift guard: the controller's pick list and the service-layer
      // pick list both have to stay in sync with `UpdateRequestBody`. If
      // either drops a documented field, this test catches it.
      mockUpdateEntry.mockResolvedValue({ id: 7 });

      const data = {
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        track_position: 'A1',
        record_label: 'Sonamos',
        label_id: 99,
        album_id: 100,
        rotation_id: 5,
        request_flag: true,
        segue: false,
        message: 'corrected DJ note',
      };

      const req = {
        body: { entry_id: 7, data },
      } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res as Response, mockNext);

      expect(mockUpdateEntry).toHaveBeenCalledTimes(1);
      const passedData = (mockUpdateEntry as unknown as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      // Every field in `data` (= every field in UpdateRequestBody) reaches
      // the service. A drop here would silently break legitimate edits.
      for (const [key, value] of Object.entries(data)) {
        expect(passedData[key]).toEqual(value);
      }
    });
  });

  describe('addEntry free-form branch (BS#1099)', () => {
    const activeShow = { id: 42, end_time: null };

    beforeEach(() => {
      mockGetLatestShow.mockResolvedValue(activeShow);
      mockResolveDjNameForShow.mockResolvedValue('dj-real-name');
    });

    it('strips internal columns from body before constructing the insert payload', async () => {
      // The free-form POST branch (no album_id, no message) used to spread
      // `req.body` directly into the insert. A client with `flowsheet:write`
      // could set `metadata_status`, `legacy_entry_id`, etc. The controller
      // must construct the insert payload from named fields only.
      // No album_id in the body — that's the discriminator that picks this
      // branch over the (safe) album_id branch above.
      mockAddTrack.mockResolvedValue({ id: 1, show_id: activeShow.id });

      const req = {
        body: {
          // Required free-form fields:
          artist_name: 'Juana Molina',
          album_title: 'DOGA',
          track_title: 'la paradoja',
          record_label: 'Sonamos',
          // Server-internal columns the client must not be able to set:
          metadata_status: 'enriched_match',
          legacy_entry_id: 9999999,
          legacy_release_id: 8888,
          show_id: 999,
          play_order: 0,
          linkage_source: 'manual',
          linkage_confidence: 0.99,
          linked_at: new Date(),
          metadata_attempt_at: new Date(),
          enriching_since: new Date(),
          dj_name: 'evil-dj',
          artwork_url: 'https://example.com/x.jpg',
          discogs_url: 'https://discogs.com/x',
          release_year: 1999,
        },
      } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res as Response, mockNext);

      expect(mockAddTrack).toHaveBeenCalledTimes(1);
      const passedEntry = (mockAddTrack as unknown as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      // The server-controlled fields are overridden by the controller.
      expect(passedEntry.show_id).toBe(activeShow.id);
      expect(passedEntry.dj_name).toBe('dj-real-name');
      // Allowed fields pass through.
      expect(passedEntry.artist_name).toBe('Juana Molina');
      expect(passedEntry.album_title).toBe('DOGA');
      expect(passedEntry.track_title).toBe('la paradoja');
      expect(passedEntry.record_label).toBe('Sonamos');
      // Internal keys are absent from the service argument. `album_id` is
      // deliberately not in this list — in the free-form branch the
      // discriminator `body.album_id != null` already constrains it to
      // null/undefined, and the BS#933 snapshot path still passes
      // `album_id: null` through to preserve that semantic.
      for (const internalKey of [
        'metadata_status',
        'legacy_entry_id',
        'legacy_release_id',
        'play_order',
        'linkage_source',
        'linkage_confidence',
        'linked_at',
        'metadata_attempt_at',
        'enriching_since',
        'artwork_url',
        'discogs_url',
        'release_year',
      ]) {
        expect(passedEntry).not.toHaveProperty(internalKey);
      }
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('joinShow (BS#1098)', () => {
    it('rejects when body.dj_id does not match the authenticated user', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'victim-dj', show_name: 'taking over your show' },
      } as unknown as Request;
      const res = createMockRes();

      await expect(joinShow(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
      expect(mockStartShow).not.toHaveBeenCalled();
      expect(mockAddDJToShow).not.toHaveBeenCalled();
    });

    it('starts a new show when body.dj_id matches the caller and there is no active show', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });
      mockStartShow.mockResolvedValue({ id: 42, primary_dj_id: 'caller-dj' });

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', show_name: 'My Show', specialty_id: 7 },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      // 4th arg is dj_name_override (BS#1295) — undefined when absent on the body.
      expect(mockStartShow).toHaveBeenCalledWith('caller-dj', 'My Show', 7, undefined);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('adds the caller to the active show as a co-host', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null });
      mockAddDJToShow.mockResolvedValue({ id: 99, dj_id: 'caller-dj' });

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj' },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      expect(mockAddDJToShow).toHaveBeenCalledWith('caller-dj', expect.objectContaining({ id: 1 }));
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('rejects when req.auth.id is missing entirely', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });

      const req = {
        body: { dj_id: 'some-dj' },
      } as unknown as Request;
      const res = createMockRes();

      await expect(joinShow(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
      expect(mockStartShow).not.toHaveBeenCalled();
    });
  });

  describe('joinShow dj_name_override (BS#1295)', () => {
    it('forwards a trimmed dj_name_override to startShow when starting a new show', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });
      mockStartShow.mockResolvedValue({ id: 42, primary_dj_id: 'caller-dj' });

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', show_name: 'My Show', specialty_id: 7, dj_name_override: 'Aubrey Hearst' },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      expect(mockStartShow).toHaveBeenCalledWith('caller-dj', 'My Show', 7, 'Aubrey Hearst');
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('passes undefined to startShow when dj_name_override is an empty string', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });
      mockStartShow.mockResolvedValue({ id: 42, primary_dj_id: 'caller-dj' });

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', dj_name_override: '' },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      expect(mockStartShow).toHaveBeenCalledWith('caller-dj', undefined, undefined, undefined);
    });

    it('passes undefined to startShow when dj_name_override is whitespace-only', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });
      mockStartShow.mockResolvedValue({ id: 42, primary_dj_id: 'caller-dj' });

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', dj_name_override: '   ' },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      expect(mockStartShow).toHaveBeenCalledWith('caller-dj', undefined, undefined, undefined);
    });

    it('rejects with 400 when the trimmed dj_name_override exceeds 255 chars', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });
      const overflow = 'a'.repeat(256);

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', dj_name_override: overflow },
      } as unknown as Request;
      const res = createMockRes();

      await expect(joinShow(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
      expect(mockStartShow).not.toHaveBeenCalled();
    });

    it('accepts exactly 255 chars at the boundary', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: new Date() });
      mockStartShow.mockResolvedValue({ id: 42, primary_dj_id: 'caller-dj' });
      const exactly255 = 'a'.repeat(255);

      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', dj_name_override: exactly255 },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      expect(mockStartShow).toHaveBeenCalledWith('caller-dj', undefined, undefined, exactly255);
    });

    it('does not forward dj_name_override when joining an existing show (co-host path)', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null });
      mockAddDJToShow.mockResolvedValue({ id: 99, dj_id: 'caller-dj' });

      // Even if a client sends dj_name_override on a co-host /join, the
      // service contract treats it as ignored — there's no per-co-host
      // override path. Caller wired startShow only.
      const req = {
        auth: { id: 'caller-dj' },
        body: { dj_id: 'caller-dj', dj_name_override: 'Aubrey Hearst' },
      } as unknown as Request;
      const res = createMockRes();

      await joinShow(req, res as Response, mockNext);

      expect(mockStartShow).not.toHaveBeenCalled();
      expect(mockAddDJToShow).toHaveBeenCalled();
    });
  });

  describe('leaveShow (BS#1102)', () => {
    it('rejects when body.dj_id does not match the authenticated user', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null, primary_dj_id: 'victim-primary' });

      const req = {
        auth: { id: 'guest-dj' },
        body: { dj_id: 'victim-primary' },
      } as unknown as Request;
      const res = createMockRes();

      await expect(leaveShow(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
      expect(mockEndShow).not.toHaveBeenCalled();
      expect(mockServiceLeaveShow).not.toHaveBeenCalled();
    });

    it('rejects when a guest tries to kick a co-host (body.dj_id = other co-host)', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null, primary_dj_id: 'primary-dj' });

      const req = {
        auth: { id: 'guest-dj' },
        body: { dj_id: 'other-cohost' },
      } as unknown as Request;
      const res = createMockRes();

      await expect(leaveShow(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
      expect(mockServiceLeaveShow).not.toHaveBeenCalled();
    });

    it('ends the show when the caller is the primary DJ leaving', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null, primary_dj_id: 'primary-dj' });
      mockEndShow.mockResolvedValue({ id: 1, end_time: new Date() });

      const req = {
        auth: { id: 'primary-dj' },
        body: { dj_id: 'primary-dj' },
      } as unknown as Request;
      const res = createMockRes();

      await leaveShow(req, res as Response, mockNext);

      expect(mockEndShow).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
      expect(mockServiceLeaveShow).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('removes a guest DJ when the caller is the guest leaving themselves', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 1, end_time: null, primary_dj_id: 'primary-dj' });
      mockServiceLeaveShow.mockResolvedValue({ id: 99, dj_id: 'guest-dj' });

      const req = {
        auth: { id: 'guest-dj' },
        body: { dj_id: 'guest-dj' },
      } as unknown as Request;
      const res = createMockRes();

      await leaveShow(req, res as Response, mockNext);

      expect(mockServiceLeaveShow).toHaveBeenCalledWith('guest-dj', expect.objectContaining({ id: 1 }));
      expect(mockEndShow).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('does not leak internal flowsheet columns (BS#1513)', () => {
    // Fully-populated raw row + internal-column deny-list shared with the
    // projector and DJ-peek leak suites (tests/fixtures/flowsheet-row.fixture.ts)
    // so a new internal column is covered everywhere from one update site.
    const makeRawRow = () => makeFullFlowsheetRow() as unknown as Record<string, unknown>;

    const lastJsonPayload = (res: Partial<Response>) => {
      const calls = (res.json as unknown as jest.Mock).mock.calls;
      return calls[calls.length - 1][0] as Record<string, unknown>;
    };

    const expectProjected = (payload: Record<string, unknown>) => {
      for (const key of INTERNAL_FLOWSHEET_COLUMNS) {
        expect(payload).not.toHaveProperty(key);
      }
      // Client-facing fields survive.
      expect(payload).toMatchObject({
        id: 42,
        entry_type: 'track',
        artist_name: 'Juana Molina',
        track_title: 'la paradoja',
        artwork_url: 'https://example.com/art.jpg',
        // Client-facing per the FlowsheetEntryResponse SSOT (rationale in the
        // flowsheet-projection.ts module docstring).
        metadata_status: 'enriched_match',
      });
    };

    it('addEntry projects the raw insert row (message branch)', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 42, end_time: null });
      mockAddTrack.mockResolvedValue(makeRawRow());

      const req = { body: { message: 'Talkset' } } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(201);
      expectProjected(lastJsonPayload(res));
    });

    it('addEntry projects the raw insert row (free-form track branch)', async () => {
      mockGetLatestShow.mockResolvedValue({ id: 42, end_time: null });
      mockResolveDjNameForShow.mockResolvedValue('DJ Test');
      mockAddTrack.mockResolvedValue(makeRawRow());

      const req = {
        body: {
          artist_name: 'Juana Molina',
          album_title: 'DOGA',
          track_title: 'la paradoja',
          record_label: 'Sonamos',
        },
      } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(201);
      expectProjected(lastJsonPayload(res));
    });

    it('deleteEntry projects the raw deleted row', async () => {
      mockRemoveTrack.mockResolvedValue(makeRawRow());

      const req = { body: { entry_id: 42 } } as unknown as Request;
      const res = createMockRes();

      await deleteEntry(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expectProjected(lastJsonPayload(res));
    });

    it('updateEntry projects the raw updated row', async () => {
      mockUpdateEntry.mockResolvedValue(makeRawRow());

      const req = { body: { entry_id: 42, data: { track_title: 'la paradoja' } } } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expectProjected(lastJsonPayload(res));
    });

    it('changeOrder projects the raw reordered row', async () => {
      mockChangeOrder.mockResolvedValue(makeRawRow());

      const req = { body: { entry_id: 42, new_position: 3 } } as unknown as Request;
      const res = createMockRes();

      await changeOrder(req, res as Response, mockNext);

      expect(res.status).toHaveBeenCalledWith(200);
      expectProjected(lastJsonPayload(res));
    });

    describe('feeds the legacy mirror the unprojected row (PR #1532 review follow-up)', () => {
      // The mirror middleware taps the HTTP response body into
      // res.locals.mirrorData (tapJsonResponse), and its BS#908 loop guards +
      // restart fallback read `legacy_entry_id` off that data — a column the
      // projection strips. Controllers therefore pre-stash the raw row via
      // stashMirrorData before res.json; these tests pin that the stash
      // happens on every mirrored mutation and carries the internal columns
      // in the parsed-JSON shape the mirror handlers were built against.
      const stashedOf = (res: Partial<Response>) =>
        (res.locals as Record<string, unknown>).mirrorData as Record<string, unknown>;

      it('addEntry stashes the full row for the mirror', async () => {
        mockGetLatestShow.mockResolvedValue({ id: 42, end_time: null });
        mockResolveDjNameForShow.mockResolvedValue('DJ Test');
        mockAddTrack.mockResolvedValue(makeRawRow());

        const req = {
          body: {
            artist_name: 'Juana Molina',
            album_title: 'DOGA',
            track_title: 'la paradoja',
            record_label: 'Sonamos',
          },
        } as unknown as Request;
        const res = createMockRes();

        await addEntry(req, res as Response, mockNext);

        const stashed = stashedOf(res);
        expect(stashed).toMatchObject({ id: 42, legacy_entry_id: 9999 });
        expect(stashed).toHaveProperty('search_doc');
        // JSON-parity with the pre-projection tapped body: dates as ISO strings.
        expect(typeof stashed.add_time).toBe('string');
      });

      it('deleteEntry stashes the full row for the mirror', async () => {
        mockRemoveTrack.mockResolvedValue(makeRawRow());

        const req = { body: { entry_id: 42 } } as unknown as Request;
        const res = createMockRes();

        await deleteEntry(req, res as Response, mockNext);

        const stashed = stashedOf(res);
        expect(stashed).toMatchObject({ id: 42, legacy_entry_id: 9999, play_order: 5 });
      });

      it('updateEntry stashes the full row for the mirror', async () => {
        mockUpdateEntry.mockResolvedValue(makeRawRow());

        const req = { body: { entry_id: 42, data: { track_title: 'la paradoja' } } } as unknown as Request;
        const res = createMockRes();

        await updateEntry(req, res as Response, mockNext);

        const stashed = stashedOf(res);
        expect(stashed).toMatchObject({ id: 42, legacy_entry_id: 9999 });
      });

      it('changeOrder stashes the full row too (inert today — its mirror is commented out in the route — but correct-by-default if re-enabled)', async () => {
        mockChangeOrder.mockResolvedValue(makeRawRow());

        const req = { body: { entry_id: 42, new_position: 3 } } as unknown as Request;
        const res = createMockRes();

        await changeOrder(req, res as Response, mockNext);

        const stashed = stashedOf(res);
        expect(stashed).toMatchObject({ id: 42, legacy_entry_id: 9999 });
      });
    });

    describe('updateEntry rejects empty patches (PR #1532 review follow-up)', () => {
      // An empty (or fully-filtered) patch would reach drizzle's `.set({})`,
      // which throws `No values to set` — surfacing as a 500 for what is a
      // malformed request. The controller rejects it with a 400 before the
      // service runs.
      it.each([
        ['an empty data object', {}],
        ['data omitted entirely', undefined],
        ['data containing only non-updatable keys', { metadata_status: 'enriched_match', legacy_entry_id: 1 }],
      ])('400s on %s instead of letting drizzle 500', async (_name, data) => {
        const req = { body: { entry_id: 42, data } } as unknown as Request;
        const res = createMockRes();

        await expect(updateEntry(req, res as Response, mockNext)).rejects.toMatchObject({ statusCode: 400 });
        expect(mockUpdateEntry).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
      });
    });

    describe('404s cleanly when the target row is missing (PR #1532 review follow-up)', () => {
      // removeTrack / updateEntry / changeOrder return `.returning()[0]` /
      // a post-commit re-read — `undefined` when no row matches (double
      // delete, PATCH racing a delete, delete landing between changeOrder's
      // commit and its confirmation read). Pre-#1532 that serialized as a
      // misleading 200-with-empty-body; with the projection it would be a
      // bare TypeError -> 500 internal_error (the BS#1271 class). Pin the
      // clean 404 instead.
      it('deleteEntry throws 404 when removeTrack matches no row', async () => {
        mockRemoveTrack.mockResolvedValue(undefined);

        const req = { body: { entry_id: 424242 } } as unknown as Request;
        const res = createMockRes();

        await expect(deleteEntry(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
        await expect(deleteEntry(req, res as Response, mockNext)).rejects.toMatchObject({ statusCode: 404 });
        expect(res.json).not.toHaveBeenCalled();
      });

      it('updateEntry throws 404 when the UPDATE matches no row', async () => {
        mockUpdateEntry.mockResolvedValue(undefined);

        const req = { body: { entry_id: 424242, data: { track_title: 'x' } } } as unknown as Request;
        const res = createMockRes();

        await expect(updateEntry(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
        await expect(updateEntry(req, res as Response, mockNext)).rejects.toMatchObject({ statusCode: 404 });
        expect(res.json).not.toHaveBeenCalled();
      });

      it('changeOrder throws 404 when the confirmation read finds the row deleted mid-flight', async () => {
        mockChangeOrder.mockResolvedValue(undefined);

        const req = { body: { entry_id: 424242, new_position: 2 } } as unknown as Request;
        const res = createMockRes();

        await expect(changeOrder(req, res as Response, mockNext)).rejects.toBeInstanceOf(WxycError);
        await expect(changeOrder(req, res as Response, mockNext)).rejects.toMatchObject({ statusCode: 404 });
        expect(res.json).not.toHaveBeenCalled();
      });
    });
  });
});
