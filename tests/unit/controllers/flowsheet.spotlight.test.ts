/**
 * The `FLOWSHEET_SPOTLIGHT_ENABLED` gate and the `PATCH /flowsheet` spotlight-field rules (BS#3459, epic BS#3445).
 *
 * Spotlight rows must not reach the wire until the DJ site and the Android app survive them, so while the flag is off
 * both routes answer 403 `spotlight_disabled` before any service read and nothing is written. With it on, `PATCH`
 * validates `spotlight_role` / `spotlight_name` under the creation rules and never lets a client write `entry_type`.
 */
import { jest } from '@jest/globals';
import type { Request, Response } from 'express';

const mockGetLatestShow = jest.fn<() => Promise<Record<string, unknown> | null>>();
const mockUpdateEntry = jest.fn<(...args: unknown[]) => Promise<Record<string, unknown>>>();
const mockAddTrack = jest.fn<(entry: Record<string, unknown>) => Promise<Record<string, unknown>>>();
const mockFill = jest.fn<() => Promise<number>>();
const mockResolveDjName = jest.fn<() => Promise<string | null>>();
const mockBroadcast = jest.fn();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  updateEntry: mockUpdateEntry,
  addTrack: mockAddTrack,
  fillMissingHourlyBreakpoints: mockFill,
  resolveDjNameForShow: mockResolveDjName,
}));

jest.mock('../../../apps/backend/utils/serverEvents', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { refetch: 'refetch' },
  serverEventsMgr: { broadcast: mockBroadcast },
}));

import { addEntry, updateEntry } from '../../../apps/backend/controllers/flowsheet.controller';
import { getConfig, resetConfig } from '../../../apps/backend/config/flowsheetSpotlight';

const createMockRes = (): Partial<Response> => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.send = jest.fn().mockReturnValue(res) as unknown as Response['send'];
  res.locals = {};
  return res;
};

const patch = (data: Record<string, unknown>) =>
  updateEntry({ body: { entry_id: 7, data } } as unknown as Request, createMockRes() as Response, jest.fn());

const spotlightRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  show_id: 1,
  entry_type: 'spotlight',
  spotlight_role: 'guest',
  spotlight_name: 'Weirs',
  message: 'In the studio: Weirs',
  ...over,
});

afterEach(() => {
  delete process.env.FLOWSHEET_SPOTLIGHT_ENABLED;
  resetConfig();
  jest.clearAllMocks();
});

describe('FLOWSHEET_SPOTLIGHT_ENABLED', () => {
  it.each([
    ['true', true],
    [undefined, false],
    ['false', false],
    ['TRUE', false],
    ['1', false],
    ['', false],
  ])('parses %p as enabled=%p', (raw, enabled) => {
    if (raw !== undefined) {
      process.env.FLOWSHEET_SPOTLIGHT_ENABLED = raw;
    }
    resetConfig();
    expect(getConfig().enabled).toBe(enabled);
  });
});

describe('flag off', () => {
  it('POST /flowsheet with entry_type spotlight answers 403 spotlight_disabled before any service read', async () => {
    const req = {
      body: { entry_type: 'spotlight', spotlight_role: 'guest', spotlight_name: 'Weirs' },
    } as unknown as Request;

    await expect(addEntry(req, createMockRes() as Response, jest.fn())).rejects.toMatchObject({
      statusCode: 403,
      code: 'spotlight_disabled',
    });
    expect(mockGetLatestShow).not.toHaveBeenCalled();
    expect(mockAddTrack).not.toHaveBeenCalled();
  });

  it.each([
    ['spotlight_role', 'guest'],
    ['spotlight_name', 'Weirs'],
  ])('PATCH /flowsheet carrying %s answers 403 spotlight_disabled and calls no service', async (field, value) => {
    await expect(patch({ [field]: value })).rejects.toMatchObject({ statusCode: 403, code: 'spotlight_disabled' });
    expect(mockUpdateEntry).not.toHaveBeenCalled();
  });
});

describe('flag on: PATCH /flowsheet spotlight fields', () => {
  beforeEach(() => {
    process.env.FLOWSHEET_SPOTLIGHT_ENABLED = 'true';
    resetConfig();
    mockUpdateEntry.mockResolvedValue(spotlightRow());
  });

  it.each([
    ['a valid role', { spotlight_role: 'performer' }, { spotlight_role: 'performer' }],
    ['a name, trimmed', { spotlight_name: '  Weirs  ' }, { spotlight_name: 'Weirs' }],
    ['the longest name', { spotlight_name: 'a'.repeat(128) }, { spotlight_name: 'a'.repeat(128) }],
    [
      'both fields, ignoring a client entry_type',
      { spotlight_role: 'host', spotlight_name: 'Weirs', entry_type: 'track' },
      { spotlight_role: 'host', spotlight_name: 'Weirs' },
    ],
  ])('accepts %s', async (_label, data, forwarded) => {
    await patch(data);

    expect(mockUpdateEntry).toHaveBeenCalledWith(7, forwarded, expect.anything());
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown role', { spotlight_role: 'emcee' }],
    ['a non-string role', { spotlight_role: 3 }],
    ['an empty name', { spotlight_name: '' }],
    ['a blank name', { spotlight_name: '   ' }],
    ['a 129-character name', { spotlight_name: 'a'.repeat(129) }],
  ])('rejects %s with 400', async (_label, data) => {
    await expect(patch(data)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockUpdateEntry).not.toHaveBeenCalled();
  });
});

describe('flag on: POST /flowsheet with entry_type spotlight', () => {
  const OPEN_SHOW = { id: 31, end_time: null };
  const post = async (body: Record<string, unknown>) => {
    const res = createMockRes();
    await addEntry({ body } as unknown as Request, res as Response, jest.fn());
    return res;
  };
  const valid = { entry_type: 'spotlight', spotlight_role: 'guest', spotlight_name: 'Weirs' };

  beforeEach(() => {
    process.env.FLOWSHEET_SPOTLIGHT_ENABLED = 'true';
    resetConfig();
    mockGetLatestShow.mockResolvedValue(OPEN_SHOW);
    mockResolveDjName.mockResolvedValue('DJ HOUNDSTOOTH');
    mockFill.mockResolvedValue(0);
    mockAddTrack.mockImplementation((entry) => Promise.resolve({ id: 90, play_order: 3, ...entry }));
  });

  it.each([
    ['performer', 'Live in the studio: Weirs'],
    ['dj', 'Now mixing: Weirs'],
    ['reader', 'Reading now: Weirs'],
    ['guest', 'In the studio: Weirs'],
    ['host', 'Live in the studio: Weirs'],
  ])('stores a %s row with the composed message, replacing a client-sent one', async (role, message) => {
    const res = await post({ ...valid, spotlight_role: role, message: 'Talkset' });

    expect(mockAddTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        entry_type: 'spotlight',
        spotlight_role: role,
        spotlight_name: 'Weirs',
        message,
        show_id: 31,
        dj_name: 'DJ HOUNDSTOOTH',
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('trims the name and broadcasts the marker refetch like any non-track row', async () => {
    await post({ ...valid, spotlight_name: '  Weirs  ' });

    expect(mockAddTrack).toHaveBeenCalledWith(expect.objectContaining({ spotlight_name: 'Weirs' }));
    expect(mockBroadcast).toHaveBeenCalledWith('live-fs-topic', { type: 'refetch', payload: { source: 'marker-add' } });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown role', { spotlight_role: 'emcee' }],
    ['no role', { spotlight_role: undefined }],
    ['an empty name', { spotlight_name: '' }],
    ['no name', { spotlight_name: undefined }],
    ['a 129-character name', { spotlight_name: 'a'.repeat(129) }],
    ...[
      'artist_name',
      'album_title',
      'track_title',
      'album_id',
      'rotation_id',
      'record_label',
      'label_id',
      'track_position',
      'request_flag',
      'segue',
    ].map((field): [string, Record<string, unknown>] => [
      `${field} present`,
      { [field]: field === 'request_flag' || field === 'segue' ? false : 1 },
    ]),
  ])('answers 400 for %s and writes nothing', async (_label, over) => {
    await expect(post({ ...valid, ...over })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAddTrack).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('answers 400 when no show is open', async () => {
    mockGetLatestShow.mockResolvedValue({ id: 31, end_time: new Date() });

    await expect(post(valid)).rejects.toMatchObject({ statusCode: 400 });
    expect(mockAddTrack).not.toHaveBeenCalled();
  });
});
