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

const mockGetOpenShows = jest.fn<(hours?: number, limit?: number) => Promise<unknown>>();
const mockGetShowById = jest.fn<(id: number) => Promise<unknown>>();
const mockEndShow = jest.fn<(show: unknown, options?: unknown) => Promise<unknown>>();
const mockGetLatestShow = jest.fn<() => Promise<unknown>>();
const mockResolveShowEndInstant = jest.fn<(show: unknown) => Promise<Date>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getOpenShows: mockGetOpenShows,
  getShowById: mockGetShowById,
  endShow: mockEndShow,
  getLatestShow: mockGetLatestShow,
  resolveShowEndInstant: mockResolveShowEndInstant,
  OPEN_SHOWS_DEFAULT_WINDOW_HOURS: 168,
  OPEN_SHOWS_MAX_WINDOW_HOURS: 262_800,
  OPEN_SHOWS_DEFAULT_LIMIT: 100,
  OPEN_SHOWS_MAX_LIMIT: 500,
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

const makeReq = (query: Record<string, string> = {}, params: Record<string, string> = {}) =>
  ({ query, params }) as unknown as Request;

describe('GET /flowsheet/open-shows — query parameters', () => {
  beforeEach(() => {
    mockGetOpenShows.mockReset().mockResolvedValue({ shows: [], total_in_window: 0, older_open_show_count: 0 });
  });

  it('defaults to the 7-day window and the default limit when neither is given', async () => {
    const { res, statusMock, jsonMock } = createMockRes();

    await getOpenShows(makeReq(), res, next);

    expect(mockGetOpenShows).toHaveBeenCalledWith(168, 100);
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith({ shows: [], total_in_window: 0, older_open_show_count: 0 });
  });

  it('passes a valid window_hours through', async () => {
    const { res } = createMockRes();
    await getOpenShows(makeReq({ window_hours: '24' }), res, next);
    expect(mockGetOpenShows).toHaveBeenCalledWith(24, 100);
  });

  it('passes a valid limit through', async () => {
    const { res } = createMockRes();
    await getOpenShows(makeReq({ limit: '25' }), res, next);
    expect(mockGetOpenShows).toHaveBeenCalledWith(168, 25);
  });

  // parseInt('24h') is 24. An operator who types a unit should be told, not
  // silently handed a window they did not ask for.
  it.each(['24h', '', ' ', '-1', '2.5', 'all', '0x10', '0'])('rejects window_hours=%p with 400', async (raw) => {
    const { res } = createMockRes();

    await expect(getOpenShows(makeReq({ window_hours: raw }), res, next)).rejects.toThrow(WxycError);
    expect(mockGetOpenShows).not.toHaveBeenCalled();
  });

  it.each(['0', '501', 'all', '1.5'])('rejects limit=%p with 400', async (raw) => {
    const { res } = createMockRes();

    await expect(getOpenShows(makeReq({ limit: raw }), res, next)).rejects.toThrow(WxycError);
    expect(mockGetOpenShows).not.toHaveBeenCalled();
  });

  it('rejects a window past the ceiling', async () => {
    const { res } = createMockRes();

    await expect(getOpenShows(makeReq({ window_hours: '262801' }), res, next)).rejects.toThrow(
      'window_hours must be between 1 and 262800'
    );
    expect(mockGetOpenShows).not.toHaveBeenCalled();
  });

  /**
   * The ceiling has to REACH the backlog. The first cut was 8,760 (one year),
   * which made `older_open_show_count` a number describing rows no legal
   * request could ever list — production's open shows start in 2006.
   */
  it('accepts a window wide enough to reach a 2006 show', async () => {
    const hoursBackTo2006 = 20 * 365 * 24;
    const { res } = createMockRes();

    await getOpenShows(makeReq({ window_hours: String(hoursBackTo2006) }), res, next);

    expect(mockGetOpenShows).toHaveBeenCalledWith(hoursBackTo2006, 100);
  });
});

describe('POST /flowsheet/shows/:id/force-end', () => {
  const endInstant = new Date('2026-08-20T18:46:20.000Z');

  beforeEach(() => {
    mockGetShowById.mockReset();
    mockEndShow.mockReset();
    // Default: the target is not the on-air show, so the guard stays quiet.
    mockGetLatestShow.mockReset().mockResolvedValue({ id: -1 });
    mockResolveShowEndInstant.mockReset().mockResolvedValue(endInstant);
  });

  it('reuses endShow with the show’s own end instant and responds with the finalized show', async () => {
    const openShow = { id: 1951164, primary_dj_id: 'dj-1', end_time: null };
    const finalized = { ...openShow, end_time: endInstant };
    mockGetShowById.mockResolvedValue(openShow);
    mockEndShow.mockResolvedValue(finalized);

    const { res, statusMock, jsonMock } = createMockRes();
    await forceEndShow(makeReq({}, { id: '1951164' }), res, next);

    // Not a reimplementation: the same call the 2026-08-20 remediation made,
    // so markers, show_djs deactivation and the tubafrenzy sign-off follow one
    // implementation shared with POST /flowsheet/end.
    //
    // `endedAt` is what makes that reuse safe for an OLD show. Stamping now()
    // would give a 2006 show an interval overlapping every archive day since,
    // and put its show_end marker at the top of the live flowsheet — see
    // EndShowOptions in flowsheet.service.
    expect(mockResolveShowEndInstant).toHaveBeenCalledWith(openShow);
    expect(mockEndShow).toHaveBeenCalledWith(openShow, { endedAt: endInstant });
    expect(statusMock).toHaveBeenCalledWith(200);
    expect(jsonMock).toHaveBeenCalledWith(finalized);
  });

  // The endpoint's reason to exist: closing a show the caller has no
  // relationship to, including one whose primary DJ is NULL (BS#2093 — the
  // entire legacy cohort).
  it('closes a show with a NULL primary_dj_id', async () => {
    const orphan = { id: 74840, primary_dj_id: null, end_time: null };
    mockGetShowById.mockResolvedValue(orphan);
    mockEndShow.mockResolvedValue({ ...orphan, end_time: endInstant });

    const { res, statusMock } = createMockRes();
    await forceEndShow(makeReq({}, { id: '74840' }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(orphan, { endedAt: endInstant });
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  /**
   * The server-side half of `is_current`. Deliberately NOT unconditional: the
   * 2026-08-20 stuck show WAS `max(shows.id)` for the whole nine hours it hung,
   * so a blanket refusal would veto the exact case this endpoint was built for.
   * What it stops is a mistyped id, or an operator acting on a list fetched
   * before a new show signed on.
   */
  it('409s when the target is the current on-air show', async () => {
    const live = { id: 1951168, primary_dj_id: 'dj-1', end_time: null };
    mockGetShowById.mockResolvedValue(live);
    mockGetLatestShow.mockResolvedValue(live);

    const { res } = createMockRes();

    await expect(forceEndShow(makeReq({}, { id: '1951168' }), res, next)).rejects.toThrow('current on-air show');
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it('ends the current on-air show when force=true is passed explicitly', async () => {
    const live = { id: 1951164, primary_dj_id: 'dj-1', end_time: null };
    mockGetShowById.mockResolvedValue(live);
    mockGetLatestShow.mockResolvedValue(live);
    mockEndShow.mockResolvedValue({ ...live, end_time: endInstant });

    const { res, statusMock } = createMockRes();
    await forceEndShow(makeReq({ force: 'true' }, { id: '1951164' }), res, next);

    expect(mockEndShow).toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(200);
    // force=true waives the confirmation and nothing else — the end instant is
    // still derived, never replaced by now().
    expect(mockResolveShowEndInstant).toHaveBeenCalledWith(live);
  });

  it('does not treat force=1 or force=yes as confirmation', async () => {
    const live = { id: 7, primary_dj_id: 'dj-1', end_time: null };
    mockGetShowById.mockResolvedValue(live);
    mockGetLatestShow.mockResolvedValue(live);

    for (const force of ['1', 'yes', 'TRUE', '']) {
      const { res } = createMockRes();
      await expect(forceEndShow(makeReq({ force }, { id: '7' }), res, next)).rejects.toThrow('current on-air show');
    }
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it('404s an id that matches no show', async () => {
    mockGetShowById.mockResolvedValue(undefined);

    const { res } = createMockRes();

    await expect(forceEndShow(makeReq({}, { id: '999999999' }), res, next)).rejects.toThrow(
      'Not Found: no show with that id'
    );
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  // The fast path. The real guarantee against a duplicate show_end marker is
  // endShow's compare-and-set on `end_time IS NULL`, exercised in
  // tests/unit/services/flowsheet.endShow.test.ts.
  it('400s an already-ended show without calling endShow', async () => {
    mockGetShowById.mockResolvedValue({ id: 5, primary_dj_id: 'dj-1', end_time: new Date() });

    const { res } = createMockRes();

    await expect(forceEndShow(makeReq({}, { id: '5' }), res, next)).rejects.toThrow(
      'Bad Request: show is already ended'
    );
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it.each(['abc', '1.5', '-3', '', ' 5'])('400s a non-integer id %p without touching the database', async (id) => {
    const { res } = createMockRes();

    await expect(forceEndShow(makeReq({}, { id }), res, next)).rejects.toThrow('show id must be a positive integer');
    expect(mockGetShowById).not.toHaveBeenCalled();
  });
});
