/**
 * Unit tests for `GET /digital-archive/albums/:id/playback` (BS#2320).
 *
 * Service and config are mocked; these tests pin the controller contract:
 * the flag check runs BEFORE any DB read (403, no service call), a missing
 * manifest is 404 (never a 200 with empty tracks), `:id` validation, and the
 * `Cache-Control: private, no-store` header the merged contract promises.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import WxycError from '../../../apps/backend/utils/error';

const mockGetPlaybackManifest = jest.fn<() => Promise<unknown>>();
jest.mock('../../../apps/backend/services/digital-archive.service', () => ({
  getPlaybackManifest: mockGetPlaybackManifest,
}));

const mockGetConfig = jest.fn<() => { enabled: boolean; signTTLSeconds: number }>();
jest.mock('../../../apps/backend/config/digitalArchive', () => ({
  getConfig: mockGetConfig,
}));

import { getPlayback } from '../../../apps/backend/controllers/digital-archive.controller';

describe('digital-archive.controller getPlayback', () => {
  let req: Partial<Request<{ id: string }>>;
  let res: Partial<Response>;
  const mockNext = jest.fn<NextFunction>();

  const invoke = () => getPlayback(req as Request<{ id: string }>, res as Response, mockNext);

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ enabled: true, signTTLSeconds: 14400 });
    req = { params: { id: '42' } };
    res = {
      status: jest.fn().mockReturnThis() as unknown as Response['status'],
      json: jest.fn() as unknown as Response['json'],
      set: jest.fn().mockReturnThis() as unknown as Response['set'],
    };
  });

  it('403s when the flag is off, WITHOUT calling the service (no DB read)', async () => {
    mockGetConfig.mockReturnValue({ enabled: false, signTTLSeconds: 14400 });
    await expect(invoke()).rejects.toThrow(WxycError);
    await expect(invoke()).rejects.toMatchObject({ statusCode: 403 });
    expect(mockGetPlaybackManifest).not.toHaveBeenCalled();
  });

  it('404s when the service returns null (no playable asset) rather than a 200 with empty tracks', async () => {
    mockGetPlaybackManifest.mockResolvedValue(null);
    await expect(invoke()).rejects.toMatchObject({ statusCode: 404 });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric :id with a 400, never reaching the service', async () => {
    req.params = { id: 'abc' };
    await expect(invoke()).rejects.toMatchObject({ statusCode: 400 });
    expect(mockGetPlaybackManifest).not.toHaveBeenCalled();
  });

  it('returns the manifest as-is with Cache-Control: private, no-store', async () => {
    const manifest = {
      library_id: 42,
      expires_at: '2026-01-01T00:00:00.000Z',
      tracks: [{ file_id: 1, provenance: 'rotation_upload', title: 'Track', renditions: [] }],
    };
    mockGetPlaybackManifest.mockResolvedValue(manifest);
    await invoke();
    expect(mockGetPlaybackManifest).toHaveBeenCalledWith(42);
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(manifest);
  });
});
