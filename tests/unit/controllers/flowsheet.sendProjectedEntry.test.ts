/**
 * Unit tests for BS#1962: the single-row mutation-echo feeder
 * (`sendProjectedEntry` in `flowsheet.controller.ts`) enriching the
 * client-facing projection with `discogsUnavailable` /
 * `discogsUnavailableNote`, for parity with the SSE feeder
 * (`metadata-broadcast.ts`, tested separately) and the paginated read
 * path's `transformToV2` (#1908).
 *
 * A dedicated file (rather than extending the large existing
 * `flowsheet.controller.test.ts`) per the BS#1962 plan's stated option —
 * keeps the `library.service` mock scoped to exactly the tests that need it.
 *
 * Exercises `addEntry` (the library-hit branch, which is the sole `addEntry`
 * branch that ever carries a non-null `album_id` into `sendProjectedEntry`),
 * `deleteEntry`, and `updateEntry` directly against the real controller
 * exports — `flowsheet.service` and `library.service` are mocked, and
 * `flowsheet-projection`'s allow-list projector runs for real so the
 * assertions observe the actual wire payload (matching the sibling
 * `flowsheet.controller.test.ts` convention).
 */

import { jest } from '@jest/globals';
import type { Request, Response } from 'express';

const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({ captureException: mockCaptureException, captureMessage: mockCaptureMessage }));

const mockGetLatestShow = jest.fn<() => Promise<Record<string, unknown> | null>>();
const mockResolveDjNameForShow = jest.fn<() => Promise<string | null>>();
const mockGetAlbumFromDB = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockAddTrack = jest.fn<() => Promise<Record<string, unknown>>>();
const mockRemoveTrack = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockUpdateEntry = jest.fn<() => Promise<Record<string, unknown> | undefined>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  resolveDjNameForShow: mockResolveDjNameForShow,
  getAlbumFromDB: mockGetAlbumFromDB,
  addTrack: mockAddTrack,
  removeTrack: mockRemoveTrack,
  updateEntry: mockUpdateEntry,
}));

const mockGetDiscogsUnavailableFlagsById = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/library.service', () => ({
  getDiscogsUnavailableFlagsById: mockGetDiscogsUnavailableFlagsById,
}));

// flowsheet-projection is intentionally NOT mocked — these tests observe the
// real client-facing allow-list projection (BS#1513), same convention as
// flowsheet.controller.test.ts.

import { addEntry, deleteEntry, updateEntry } from '../../../apps/backend/controllers/flowsheet.controller';

const createMockRes = (): Response => {
  const res: Partial<Response> = {};
  res.locals = {} as Response['locals'];
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  return res as Response;
};

const FLAGS_SET = {
  discogsUnavailable: true,
  discogsUnavailableNote: 'Embargoed promo pressing',
  lastDiscogsRecheckAt: null,
};
const FLAGS_UNSET = { discogsUnavailable: false, discogsUnavailableNote: null, lastDiscogsRecheckAt: null };

const makeFsEntry = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  show_id: 100,
  album_id: null,
  rotation_id: null,
  entry_type: 'track',
  artist_name: 'Chuquimamani-Condori',
  album_title: 'Edits',
  track_title: 'Call Your Name',
  track_position: null,
  record_label: 'self-released',
  label_id: null,
  play_order: 1,
  request_flag: false,
  segue: false,
  message: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  radio_hour: null,
  dj_name: null,
  metadata_status: 'enriched_match',
  artwork_url: null,
  discogs_url: null,
  release_year: null,
  spotify_url: null,
  apple_music_url: null,
  youtube_music_url: null,
  bandcamp_url: null,
  soundcloud_url: null,
  artist_bio: null,
  artist_wikipedia_url: null,
  ...overrides,
});

describe('sendProjectedEntry discogs-unavailable enrichment (BS#1962)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestShow.mockResolvedValue({ id: 100, end_time: null });
    mockResolveDjNameForShow.mockResolvedValue(null);
  });

  describe('addEntry (library-hit branch)', () => {
    it('flagged library-linked track: response carries discogsUnavailable + note', async () => {
      mockGetAlbumFromDB.mockResolvedValue({
        artist_name: 'Duke Ellington',
        album_title: 'Duke Ellington & John Coltrane',
        record_label: 'Impulse Records',
      });
      mockAddTrack.mockResolvedValue(makeFsEntry({ album_id: 501 }));
      mockGetDiscogsUnavailableFlagsById.mockResolvedValue(FLAGS_SET);

      const req = { body: { album_id: 501, track_title: 'In a Sentimental Mood' } } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res, jest.fn());

      expect(mockGetDiscogsUnavailableFlagsById).toHaveBeenCalledWith(501);
      expect(res.status).toHaveBeenCalledWith(201);
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body.discogsUnavailable).toBe(true);
      expect(body.discogsUnavailableNote).toBe('Embargoed promo pressing');
    });

    it('linked-unflagged track: response carries discogsUnavailable: false (present, not omitted)', async () => {
      mockGetAlbumFromDB.mockResolvedValue({
        artist_name: 'Duke Ellington',
        album_title: 'Duke Ellington & John Coltrane',
        record_label: 'Impulse Records',
      });
      mockAddTrack.mockResolvedValue(makeFsEntry({ album_id: 501 }));
      mockGetDiscogsUnavailableFlagsById.mockResolvedValue(FLAGS_UNSET);

      const req = { body: { album_id: 501, track_title: 'In a Sentimental Mood' } } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res, jest.fn());

      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body).toHaveProperty('discogsUnavailable', false);
      expect(body).not.toHaveProperty('discogsUnavailableNote');
    });

    it('album_id null (free-text entry): response omits the field, no lookup performed', async () => {
      mockAddTrack.mockResolvedValue(makeFsEntry({ album_id: null }));

      const req = {
        body: {
          artist_name: 'Jessica Pratt',
          album_title: 'On Your Own Love Again',
          track_title: 'Back, Baby',
          record_label: 'Drag City',
        },
      } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res, jest.fn());

      expect(mockGetDiscogsUnavailableFlagsById).not.toHaveBeenCalled();
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('discogsUnavailable');
      expect(body).not.toHaveProperty('discogsUnavailableNote');
    });

    it('a lookup failure degrades to omitting the field — response still 201 with the projected row', async () => {
      mockGetAlbumFromDB.mockResolvedValue({
        artist_name: 'Duke Ellington',
        album_title: 'Duke Ellington & John Coltrane',
        record_label: 'Impulse Records',
      });
      mockAddTrack.mockResolvedValue(makeFsEntry({ album_id: 501 }));
      mockGetDiscogsUnavailableFlagsById.mockRejectedValue(new Error('db blip'));

      const req = { body: { album_id: 501, track_title: 'In a Sentimental Mood' } } as unknown as Request;
      const res = createMockRes();

      await addEntry(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(201);
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('discogsUnavailable');
      expect(body).not.toHaveProperty('discogsUnavailableNote');
      expect(body.id).toBe(1);
    });
  });

  describe('deleteEntry', () => {
    it('flagged library-linked track: echo carries the flag', async () => {
      mockRemoveTrack.mockResolvedValue(makeFsEntry({ album_id: 501 }));
      mockGetDiscogsUnavailableFlagsById.mockResolvedValue(FLAGS_SET);

      const req = { body: { entry_id: 1 } } as unknown as Request;
      const res = createMockRes();

      await deleteEntry(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body.discogsUnavailable).toBe(true);
    });
  });

  describe('updateEntry', () => {
    it('flagged library-linked track: echo carries the flag', async () => {
      mockUpdateEntry.mockResolvedValue(makeFsEntry({ album_id: 501 }));
      mockGetDiscogsUnavailableFlagsById.mockResolvedValue(FLAGS_SET);

      const req = { body: { entry_id: 1, data: { track_title: 'Renamed' } } } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body.discogsUnavailable).toBe(true);
      expect(body.discogsUnavailableNote).toBe('Embargoed promo pressing');
    });

    it('unlinked entry: echo omits the field, no lookup performed', async () => {
      mockUpdateEntry.mockResolvedValue(makeFsEntry({ album_id: null }));

      const req = { body: { entry_id: 1, data: { track_title: 'Renamed' } } } as unknown as Request;
      const res = createMockRes();

      await updateEntry(req, res, jest.fn());

      expect(mockGetDiscogsUnavailableFlagsById).not.toHaveBeenCalled();
      const body = (res.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
      expect(body).not.toHaveProperty('discogsUnavailable');
    });
  });
});
