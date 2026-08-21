/**
 * Controller-level behaviour for the operator-close pair (BS#2235).
 *
 * The permission tier lives in
 * `tests/unit/routes/flowsheet-operator-close-permissions.route.test.ts`; the
 * rendered query shape in
 * `tests/unit/services/flowsheet.getOpenShows.sql.test.ts`. This file covers
 * what the handlers do with their inputs.
 */
import { jest } from '@jest/globals';

const mockGetOpenShows = jest.fn<(hours?: number) => Promise<unknown>>();
const mockGetShowById = jest.fn<(id: number) => Promise<unknown>>();
const mockEndShow = jest.fn<(show: unknown) => Promise<unknown>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getOpenShows: mockGetOpenShows,
  getShowById: mockGetShowById,
  endShow: mockEndShow,
  OPEN_SHOWS_DEFAULT_WINDOW_HOURS: 168,
  OPEN_SHOWS_MAX_WINDOW_HOURS: 8760,
}));

jest.mock('async-mutex', () => ({
  Mutex: jest.fn().mockImplementation(() => ({
    acquire: jest.fn().mockResolvedValue(jest.fn()),
  })),
}));

import { getOpenShows, forceEndShow } from '../../../apps/backend/controllers/flowsheet.controller';
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

describe('GET /flowsheet/open-shows — window_hours handling', () => {
  beforeEach(() => {
    mockGetOpenShows.mockReset().mockResolvedValue({ shows: [], older_open_show_count: 0 });
  });

  it('defaults to the 7-day window when window_hours is absent', async () => {
    const req = { query: {} } as unknown as Request;
    const { res, statusMock, jsonMock } = createMockRes();

    await getOpenShows(req, res, next);

    expect(mockGetOpenShows).toHaveBeenCalledWith(168);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ shows: [], older_open_show_count: 0 });
  });

  it('passes a valid window_hours through', async () => {
    const req = { query: { window_hours: '24' } } as unknown as Request;
    const { res } = createMockRes();

    await getOpenShows(req, res, next);

    expect(mockGetOpenShows).toHaveBeenCalledWith(24);
  });

  // parseInt('24h') is 24. An operator who types a unit should be told, not
  // silently handed a window they did not ask for.
  it.each(['24h', '', ' ', '-1', '2.5', 'all', '0x10'])('rejects window_hours=%p with 400', async (raw) => {
    const req = { query: { window_hours: raw } } as unknown as Request;
    const { res } = createMockRes();

    await expect(getOpenShows(req, res, next)).rejects.toThrow(WxycError);
    expect(mockGetOpenShows).not.toHaveBeenCalled();
  });

  it('rejects a window past the one-year ceiling', async () => {
    const req = { query: { window_hours: '8761' } } as unknown as Request;
    const { res } = createMockRes();

    await expect(getOpenShows(req, res, next)).rejects.toThrow('window_hours must be between 1 and 8760');
    expect(mockGetOpenShows).not.toHaveBeenCalled();
  });

  it('accepts the ceiling itself', async () => {
    const req = { query: { window_hours: '8760' } } as unknown as Request;
    const { res } = createMockRes();

    await getOpenShows(req, res, next);

    expect(mockGetOpenShows).toHaveBeenCalledWith(8760);
  });
});

describe('POST /flowsheet/shows/:id/force-end', () => {
  beforeEach(() => {
    mockGetShowById.mockReset();
    mockEndShow.mockReset();
  });

  it('reuses endShow and responds with the finalized show', async () => {
    const openShow = { id: 1951164, primary_dj_id: 'dj-1', end_time: null };
    const finalized = { ...openShow, end_time: new Date('2026-08-21T03:03:36.000Z') };
    mockGetShowById.mockResolvedValue(openShow);
    mockEndShow.mockResolvedValue(finalized);

    const req = { params: { id: '1951164' } } as unknown as Request;
    const { res, statusMock, jsonMock } = createMockRes();

    await forceEndShow(req, res, next);

    // Not a reimplementation: the same call the 2026-08-20 remediation made,
    // so markers, show_djs deactivation and the tubafrenzy sign-off follow one
    // implementation shared with POST /flowsheet/end.
    expect(mockEndShow).toHaveBeenCalledWith(openShow);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(finalized);
  });

  // The endpoint's reason to exist: closing a show the caller has no
  // relationship to, including one whose primary DJ is NULL (BS#2093 — the
  // entire legacy cohort).
  it('closes a show with a NULL primary_dj_id', async () => {
    const orphan = { id: 74840, primary_dj_id: null, end_time: null };
    mockGetShowById.mockResolvedValue(orphan);
    mockEndShow.mockResolvedValue({ ...orphan, end_time: new Date() });

    const req = { params: { id: '74840' } } as unknown as Request;
    const { res, statusMock } = createMockRes();

    await forceEndShow(req, res, next);

    expect(mockEndShow).toHaveBeenCalledWith(orphan);
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('404s an id that matches no show', async () => {
    mockGetShowById.mockResolvedValue(undefined);

    const req = { params: { id: '999999999' } } as unknown as Request;
    const { res } = createMockRes();

    await expect(forceEndShow(req, res, next)).rejects.toThrow('Not Found: no show with that id');
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  // The fast path. The real guarantee against a duplicate show_end marker is
  // endShow's compare-and-set on `end_time IS NULL`, exercised in
  // tests/unit/services/flowsheet.endShow.test.ts.
  it('400s an already-ended show without calling endShow', async () => {
    mockGetShowById.mockResolvedValue({ id: 5, primary_dj_id: 'dj-1', end_time: new Date() });

    const req = { params: { id: '5' } } as unknown as Request;
    const { res } = createMockRes();

    await expect(forceEndShow(req, res, next)).rejects.toThrow('Bad Request: show is already ended');
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it.each(['abc', '1.5', '-3', '', ' 5'])('400s a non-integer id %p without touching the database', async (id) => {
    const req = { params: { id } } as unknown as Request;
    const { res } = createMockRes();

    await expect(forceEndShow(req, res, next)).rejects.toThrow('show id must be a positive integer');
    expect(mockGetShowById).not.toHaveBeenCalled();
  });
});
