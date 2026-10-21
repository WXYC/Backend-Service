/**
 * Unit tests for the public `GET /specialty-shows` catalog (BS#3453).
 *
 * Service is mocked; these tests pin the controller contract: the projected array, the `Cache-Control` and strong
 * `ETag` headers derived from the table's max(last_modified), 304 on a matching `If-None-Match`, and the empty-table
 * case (no ETag to offer).
 */
import { jest } from '@jest/globals';
import type { Request, Response } from 'express';

const mockGetActiveSpecialtyShows = jest.fn<() => Promise<unknown[]>>();
const mockGetCatalogLastModified = jest.fn<() => Promise<Date | null>>();

jest.mock('../../../apps/backend/services/specialty-shows.service', () => ({
  getActiveSpecialtyShows: mockGetActiveSpecialtyShows,
  getCatalogLastModified: mockGetCatalogLastModified,
}));

import { getSpecialtyShows } from '../../../apps/backend/controllers/specialty-shows.controller';

const LAST_MODIFIED = new Date('2026-10-01T12:00:00.000Z');
const ETAG = `"${LAST_MODIFIED.getTime()}"`;
const SHOWS = [{ id: 1, slug: 'orange-county-special', name: 'Orange County Special' }];

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res;
};
const createReq = (ifNoneMatch?: string) =>
  ({ get: (h: string) => (h === 'If-None-Match' ? ifNoneMatch : undefined) }) as unknown as Request;

describe('specialty-shows.controller getSpecialtyShows', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveSpecialtyShows.mockResolvedValue(SHOWS);
    mockGetCatalogLastModified.mockResolvedValue(LAST_MODIFIED);
  });

  it('serves the catalog with a public cache header and a strong ETag from the watermark', async () => {
    const res = createMockRes();
    await getSpecialtyShows(createReq(), res as Response, jest.fn());

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300');
    expect(res.set).toHaveBeenCalledWith('ETag', ETAG);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(SHOWS);
  });

  it.each([ETAG, `W/${ETAG}`, `"other", ${ETAG}`, '*'])(
    'answers 304 with no body for If-None-Match %s',
    async (header) => {
      const res = createMockRes();
      await getSpecialtyShows(createReq(header), res as Response, jest.fn());

      expect(res.status).toHaveBeenCalledWith(304);
      expect(res.end).toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    }
  );

  it('serves 200 when If-None-Match is stale', async () => {
    const res = createMockRes();
    await getSpecialtyShows(createReq('"1"'), res as Response, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('omits the ETag and serves an empty array when the table is empty', async () => {
    mockGetActiveSpecialtyShows.mockResolvedValue([]);
    mockGetCatalogLastModified.mockResolvedValue(null);
    const res = createMockRes();
    await getSpecialtyShows(createReq('*'), res as Response, jest.fn());

    expect(res.set).not.toHaveBeenCalledWith('ETag', expect.anything());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith([]);
  });
});
