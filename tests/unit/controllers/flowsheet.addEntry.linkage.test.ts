/**
 * Unit tests for addEntry enqueueing the LML linkage lookup (B-2.1).
 *
 * The forward path inserts the flowsheet row first (so the HTTP response is
 * never blocked on LML), then fires-and-forgets `runLmlLinkage` only when
 * `album_id` is absent. Bin-picks (album_id provided) skip the lookup —
 * they're already linked.
 */
import { jest } from '@jest/globals';

const mockGetLatestShow = jest.fn<() => Promise<unknown>>();
const mockResolveDjNameForShow = jest.fn<() => Promise<string | null>>();
const mockAddTrack = jest.fn<(entry: unknown) => Promise<unknown>>();
const mockGetAlbumFromDB = jest.fn<(id: number) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  resolveDjNameForShow: mockResolveDjNameForShow,
  addTrack: mockAddTrack,
  getAlbumFromDB: mockGetAlbumFromDB,
}));

const mockFetchMetadata = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/metadata/index', () => ({
  fetchMetadata: mockFetchMetadata,
}));

const mockRunLmlLinkage = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/flowsheet-linkage.service', () => ({
  runLmlLinkage: mockRunLmlLinkage,
}));

import { addEntry } from '../../../apps/backend/controllers/flowsheet.controller';

const makeRes = () => {
  const res: { status: jest.Mock; json: jest.Mock; send: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
    send: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res;
};

describe('addEntry: enqueues LML linkage lookup (B-2.1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLatestShow.mockResolvedValue({ id: 1, primary_dj_id: 'user-1', end_time: null });
    mockResolveDjNameForShow.mockResolvedValue('DJ Stardust');
    mockRunLmlLinkage.mockResolvedValue({ status: 'no_canonical_entity' });
    mockFetchMetadata.mockResolvedValue(undefined);
  });

  it('fires runLmlLinkage when no album_id is provided (free-form track insert)', async () => {
    mockAddTrack.mockResolvedValue({
      id: 999,
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
      album_id: null,
    });

    const req = {
      body: {
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        record_label: 'Sonamos',
      },
    } as unknown as Parameters<typeof addEntry>[0];

    await addEntry(req, makeRes() as unknown as Parameters<typeof addEntry>[1], jest.fn());

    // fire-and-forget — give the microtask a tick to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRunLmlLinkage).toHaveBeenCalledTimes(1);
    expect(mockRunLmlLinkage).toHaveBeenCalledWith({
      flowsheetId: 999,
      artistName: 'Juana Molina',
      albumTitle: 'DOGA',
    });
  });

  it('does NOT fire runLmlLinkage when album_id is already provided (bin pick is already linked)', async () => {
    mockGetAlbumFromDB.mockResolvedValue({
      artist_id: 1,
      artist_name: 'Stereolab',
      album_title: 'Aluminum Tunes',
      record_label: 'Duophonic',
      label_id: null,
    });
    mockAddTrack.mockResolvedValue({
      id: 1000,
      artist_name: 'Stereolab',
      album_title: 'Aluminum Tunes',
      track_title: 'Pop Quiz',
      album_id: 42,
    });

    const req = {
      body: { album_id: 42, track_title: 'Pop Quiz' },
    } as unknown as Parameters<typeof addEntry>[0];

    await addEntry(req, makeRes() as unknown as Parameters<typeof addEntry>[1], jest.fn());
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRunLmlLinkage).not.toHaveBeenCalled();
  });

  it('does NOT fire runLmlLinkage on message-only entries (no artist/album text to look up)', async () => {
    mockAddTrack.mockResolvedValue({ id: 1001, entry_type: 'message', artist_name: '', album_title: '' });

    const req = { body: { message: 'Top of the hour' } } as unknown as Parameters<typeof addEntry>[0];

    await addEntry(req, makeRes() as unknown as Parameters<typeof addEntry>[1], jest.fn());
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRunLmlLinkage).not.toHaveBeenCalled();
  });
});
