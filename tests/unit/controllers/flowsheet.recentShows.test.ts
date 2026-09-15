/**
 * Controller-level behaviour for `GET /flowsheet/shows/recent` (BS#2435).
 *
 * The permission tier lives in
 * `tests/unit/routes/flowsheet-recent-shows-permissions.route.test.ts`; the
 * rendered query shape in
 * `tests/unit/services/flowsheet.getRecentShows.sql.test.ts`. This file covers
 * what the handler does with its one input.
 */
import { jest } from '@jest/globals';

jest.mock('../../../apps/backend/services/flowsheet.service', () =>
  jest
    .requireActual<typeof import('../../mocks/flowsheet-service.mock')>('../../mocks/flowsheet-service.mock')
    .createFlowsheetServiceMock()
);

jest.mock('async-mutex', () => ({
  Mutex: jest.fn().mockImplementation(() => ({
    acquire: jest.fn().mockResolvedValue(jest.fn()),
  })),
}));

import { resetFlowsheetServiceMock } from '../../mocks/flowsheet-service.mock';
import * as flowsheetService from '../../../apps/backend/services/flowsheet.service';
import { getRecentShows } from '../../../apps/backend/controllers/flowsheet.controller';
import WxycError from '../../../apps/backend/utils/error';
import type { Request, Response, NextFunction } from 'express';

function createMockRes() {
  const statusMock = jest.fn();
  const jsonMock = jest.fn();
  const res: Partial<Response> = {};
  statusMock.mockReturnValue(res);
  jsonMock.mockReturnValue(res);
  res.status = statusMock as unknown as Response['status'];
  res.json = jsonMock as unknown as Response['json'];
  return { res: res as Response, statusMock, jsonMock };
}

const next = jest.fn() as unknown as NextFunction;

const service = flowsheetService as unknown as ReturnType<
  typeof import('../../mocks/flowsheet-service.mock').createFlowsheetServiceMock
>;
const { getRecentShows: mockGetRecentShows } = service;

const makeReq = (query: Record<string, string> = {}) => ({ query }) as unknown as Request;

beforeEach(() => resetFlowsheetServiceMock(service, new Date('2026-09-15T00:00:00.000Z')));

describe('GET /flowsheet/shows/recent — query parameters', () => {
  it('defaults to the 24-hour window when none is given', async () => {
    const { res, statusMock, jsonMock } = createMockRes();

    await getRecentShows(makeReq(), res, next);

    expect(mockGetRecentShows).toHaveBeenCalledWith(24);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ shows: [] });
  });

  it('passes an explicit window through', async () => {
    const { res } = createMockRes();

    await getRecentShows(makeReq({ window_hours: '6' }), res, next);

    expect(mockGetRecentShows).toHaveBeenCalledWith(6);
  });

  /**
   * Reject rather than clamp, matching `GET /flowsheet/open-shows` (BS#2235):
   * a DJ who mistypes the unit should learn that, not silently get a different
   * window than they asked for.
   */
  it.each(['24h', '', '-1', '1.5', 'all'])('rejects a malformed window_hours (%p)', async (raw) => {
    const { res } = createMockRes();

    await expect(getRecentShows(makeReq({ window_hours: raw }), res, next)).rejects.toThrow(WxycError);
    expect(mockGetRecentShows).not.toHaveBeenCalled();
  });

  it.each(['0', '169'])('rejects a window_hours outside the allowed range (%p)', async (raw) => {
    const { res } = createMockRes();

    await expect(getRecentShows(makeReq({ window_hours: raw }), res, next)).rejects.toThrow(WxycError);
    expect(mockGetRecentShows).not.toHaveBeenCalled();
  });

  /**
   * The ceiling is a week — this is a handoff read, not an archive walk. The
   * archive walk is `GET /flowsheet/playlist` (BS#2399), which is paged and
   * indexed for it; widening this endpoint to reach 2006 would hand a sign-on
   * page a payload it has no way to render.
   */
  it('accepts the widest legal window', async () => {
    const { res, statusMock } = createMockRes();

    await getRecentShows(makeReq({ window_hours: '168' }), res, next);

    expect(mockGetRecentShows).toHaveBeenCalledWith(168);
    expect(statusMock).toHaveBeenCalledWith(200);
  });
});
