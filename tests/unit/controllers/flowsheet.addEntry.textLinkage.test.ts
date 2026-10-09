/**
 * Unit test for the insert-path text linkage (BS#3066, part of BS#3057).
 *
 * A typed track row (no album_id, or a library-miss album_id) is linked to the
 * one catalog release its text names, stamped `direct_text_match`. A picked row
 * is stamped `dj_bin_pick`. The lookup is enrichment: any failure leaves the
 * row unlinked and the play recorded.
 */
import { jest } from '@jest/globals';

const mockGetLatestShow = jest.fn<() => Promise<any>>();
const mockResolveDjNameForShow = jest.fn<(show: unknown) => Promise<string | null>>();
const mockAddTrack = jest.fn<(entry: any) => Promise<any>>();
const mockGetAlbumFromDB = jest.fn<(id: number) => Promise<any>>();
const mockFindLibraryReleasesByText = jest.fn<(artist: string, album: string) => Promise<number[]>>();
const mockFillMissingHourlyBreakpoints = jest.fn<() => Promise<number>>().mockResolvedValue(0);
const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@sentry/node', () => ({ captureException: mockCaptureException, captureMessage: mockCaptureMessage }));

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  resolveDjNameForShow: mockResolveDjNameForShow,
  addTrack: mockAddTrack,
  getAlbumFromDB: mockGetAlbumFromDB,
  fillMissingHourlyBreakpoints: mockFillMissingHourlyBreakpoints,
  findLibraryReleasesByText: mockFindLibraryReleasesByText,
}));

jest.mock('../../../apps/backend/utils/serverEvents', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { refetch: 'refetch' },
  serverEventsMgr: { broadcast: jest.fn() },
}));

import { addEntry } from '../../../apps/backend/controllers/flowsheet.controller';

const makeRes = () => {
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

const typed = {
  artist_name: 'juana molina',
  album_title: 'doga',
  track_title: 'la paradoja',
  record_label: 'sonamos',
};

const post = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await addEntry({ body } as any, res, jest.fn());
  return res;
};

const addedEntry = () => mockAddTrack.mock.calls[0][0];

describe('addEntry: insert-path text linkage (BS#3066)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestShow.mockResolvedValue({ id: 7, primary_dj_id: 'user-1', legacy_dj_name: null, end_time: null });
    mockResolveDjNameForShow.mockResolvedValue('DJ Stardust');
    mockAddTrack.mockResolvedValue({ id: 999 });
    mockFindLibraryReleasesByText.mockResolvedValue([]);
  });

  describe('typed path (album_id omitted or null)', () => {
    it.each([
      ['omitted', {}],
      ['explicit null', { album_id: null }],
    ])('links the single candidate and keeps the typed text byte-equal (%s)', async (_label, extra) => {
      mockFindLibraryReleasesByText.mockResolvedValue([54108]);

      const res = await post({ ...typed, ...extra });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(mockFindLibraryReleasesByText).toHaveBeenCalledWith('juana molina', 'doga');
      expect(addedEntry()).toEqual(
        expect.objectContaining({
          ...typed,
          album_id: 54108,
          linkage_source: 'direct_text_match',
          linkage_confidence: 1,
          linked_at: expect.any(Date),
        })
      );
    });

    it.each([
      ['no candidate', []],
      ['several candidates', [1, 2]],
    ])('leaves the row unlinked on %s', async (_label, ids) => {
      mockFindLibraryReleasesByText.mockResolvedValue(ids);

      await post({ ...typed });

      expect(addedEntry().album_id).toBeNull();
      expect(addedEntry()).not.toHaveProperty('linkage_source');
      expect(addedEntry()).not.toHaveProperty('linkage_confidence');
      expect(addedEntry()).not.toHaveProperty('linked_at');
    });

    it('records the play unlinked and reports to Sentry when the lookup rejects', async () => {
      const err = new Error('pool exhausted');
      mockFindLibraryReleasesByText.mockRejectedValue(err);

      const res = await post({ ...typed });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(addedEntry().album_id).toBeNull();
      expect(addedEntry()).not.toHaveProperty('linkage_source');
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(mockCaptureException).toHaveBeenCalledWith(err, {
        tags: { tool: 'flowsheet', subsystem: 'text-linkage' },
        extra: { show_id: 7 },
      });
    });

    it('links a rotation play that arrives with an explicit null album_id', async () => {
      mockFindLibraryReleasesByText.mockResolvedValue([54108]);

      await post({ ...typed, album_id: null, rotation_id: 12 });

      expect(addedEntry()).toEqual(expect.objectContaining({ rotation_id: 12, album_id: 54108 }));
    });

    it.each([
      ['a track-shaped body with entry_type talkset', { ...typed, entry_type: 'talkset' }],
      ['a message entry', { message: 'Top of the hour' }],
    ])('never calls the matcher for %s', async (_label, body) => {
      await post(body);

      expect(mockFindLibraryReleasesByText).not.toHaveBeenCalled();
      expect(mockAddTrack).toHaveBeenCalledTimes(1);
      expect(addedEntry()).not.toHaveProperty('linkage_source');
    });
  });

  describe('picked path (album_id present)', () => {
    const albumInfo = {
      artist_id: 1,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      record_label: 'Sonamos',
      label_id: null,
    };

    it('stamps dj_bin_pick without consulting the matcher', async () => {
      mockGetAlbumFromDB.mockResolvedValue(albumInfo);

      await post({ album_id: 54108, track_title: 'la paradoja' });

      expect(mockFindLibraryReleasesByText).not.toHaveBeenCalled();
      expect(addedEntry()).toEqual(
        expect.objectContaining({
          album_id: 54108,
          linkage_source: 'dj_bin_pick',
          linkage_confidence: null,
          linked_at: expect.any(Date),
        })
      );
    });

    it('runs the matcher when the picked id misses in the library', async () => {
      mockGetAlbumFromDB.mockResolvedValue(undefined);
      mockFindLibraryReleasesByText.mockResolvedValue([54108]);

      await post({ ...typed, album_id: 99999 });

      expect(mockFindLibraryReleasesByText).toHaveBeenCalledTimes(1);
      expect(addedEntry()).toEqual(expect.objectContaining({ album_id: 54108, linkage_source: 'direct_text_match' }));
    });
  });
});
