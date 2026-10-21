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
const mockAddTrack = jest.fn<() => Promise<Record<string, unknown>>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  updateEntry: mockUpdateEntry,
  addTrack: mockAddTrack,
}));

jest.mock('../../../apps/backend/utils/serverEvents', () => ({
  Topics: { liveFs: 'live-fs-topic' },
  FsEvents: { refetch: 'refetch' },
  serverEventsMgr: { broadcast: jest.fn() },
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

  it.each([
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
