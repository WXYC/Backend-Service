/**
 * Unit test for the live insert path writing flowsheet.dj_name (step 5b.2).
 *
 * The controller resolves the DJ name from the active show and passes it to
 * addTrack so the resolved value is denormalized onto the new flowsheet row,
 * removing the need for the search service to join shows -> auth_user.
 */
import { jest } from '@jest/globals';

const mockGetLatestShow = jest.fn<() => Promise<any>>();
const mockResolveDjNameForShow = jest.fn<(show: unknown) => Promise<string | null>>();
const mockAddTrack = jest.fn<(entry: any) => Promise<any>>();
const mockGetAlbumFromDB = jest.fn<(id: number) => Promise<any>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  resolveDjNameForShow: mockResolveDjNameForShow,
  addTrack: mockAddTrack,
  getAlbumFromDB: mockGetAlbumFromDB,
}));

import { addEntry } from '../../../apps/backend/controllers/flowsheet.controller';

const makeRes = () => {
  // `locals` is required: the controller stashes the unprojected row for the
  // legacy mirror via `stashMirrorData(res, ...)` (BS#1513 / PR #1532).
  const res: any = { locals: {} };
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

describe('addEntry: dj_name denormalization (step 5b.2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestShow.mockResolvedValue({
      id: 1,
      primary_dj_id: 'user-1',
      legacy_dj_name: null,
      end_time: null,
    });
    mockAddTrack.mockResolvedValue({ id: 999 });
  });

  it('passes the resolved dj_name to addTrack for free-form track inserts', async () => {
    mockResolveDjNameForShow.mockResolvedValue('DJ Stardust');

    const req: any = {
      body: {
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        record_label: 'Sonamos',
      },
    };

    await addEntry(req, makeRes(), jest.fn());

    expect(mockResolveDjNameForShow).toHaveBeenCalledWith(expect.objectContaining({ id: 1, primary_dj_id: 'user-1' }));
    expect(mockAddTrack).toHaveBeenCalledTimes(1);
    expect(mockAddTrack.mock.calls[0][0]).toEqual(expect.objectContaining({ dj_name: 'DJ Stardust' }));
  });

  it('passes the resolved dj_name when adding a track from the bin (album_id provided)', async () => {
    mockResolveDjNameForShow.mockResolvedValue('DJ Bluejay');
    mockGetAlbumFromDB.mockResolvedValue({
      artist_id: 1,
      artist_name: 'Stereolab',
      album_title: 'Aluminum Tunes',
      record_label: 'Duophonic',
      label_id: null,
    });

    const req: any = {
      body: {
        album_id: 42,
        track_title: 'Pop Quiz',
      },
    };

    await addEntry(req, makeRes(), jest.fn());

    expect(mockAddTrack).toHaveBeenCalledTimes(1);
    expect(mockAddTrack.mock.calls[0][0]).toEqual(expect.objectContaining({ dj_name: 'DJ Bluejay' }));
  });

  it('still inserts when the resolver returns null (e.g. unknown legacy DJ)', async () => {
    mockResolveDjNameForShow.mockResolvedValue(null);

    const req: any = {
      body: {
        artist_name: 'Cat Power',
        album_title: 'Moon Pix',
        track_title: 'Cross Bones Style',
        record_label: 'Matador Records',
      },
    };

    await addEntry(req, makeRes(), jest.fn());

    expect(mockAddTrack).toHaveBeenCalledTimes(1);
    expect(mockAddTrack.mock.calls[0][0]).toEqual(expect.objectContaining({ dj_name: null }));
  });

  it('passes dj_name on message-only inserts as well so it is set consistently', async () => {
    // The migration only backfills track entries, but the live path can cheaply
    // populate dj_name on every entry since it is already resolved per request.
    mockResolveDjNameForShow.mockResolvedValue('DJ Stardust');

    const req: any = {
      body: { message: 'Top of the hour' },
    };

    await addEntry(req, makeRes(), jest.fn());

    expect(mockAddTrack).toHaveBeenCalledTimes(1);
    expect(mockAddTrack.mock.calls[0][0]).toEqual(expect.objectContaining({ dj_name: 'DJ Stardust' }));
  });
});
