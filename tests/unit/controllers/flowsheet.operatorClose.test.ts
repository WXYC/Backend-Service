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

const END_INSTANT = new Date('2026-08-20T18:46:20.000Z');
const service = flowsheetService as unknown as ReturnType<
  typeof import('../../mocks/flowsheet-service.mock').createFlowsheetServiceMock
>;
const {
  getOpenShows: mockGetOpenShows,
  getShowById: mockGetShowById,
  endShow: mockEndShow,
  getLatestShow: mockGetLatestShow,
  isLatestEntryShowEnd: mockIsLatestEntryShowEnd,
  resolveShowEndInstant: mockResolveShowEndInstant,
} = service;

const makeReq = (query: Record<string, string> = {}, params: Record<string, string> = {}, body?: unknown) =>
  ({ query, params, body }) as unknown as Request;

beforeEach(() => resetFlowsheetServiceMock(service, END_INSTANT));

describe('GET /flowsheet/open-shows — query parameters', () => {
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

  // Only `limit`'s own bounds — both parameters share one parser, and its
  // malformed-input handling is covered by the window_hours battery above.
  it.each(['0', '501'])('rejects limit=%p with 400', async (raw) => {
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
  const endInstant = END_INSTANT;

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
    expect(mockEndShow).toHaveBeenCalledWith(openShow, endInstant);
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

    expect(mockEndShow).toHaveBeenCalledWith(orphan, endInstant);
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

  /**
   * The carve-out that keeps the guard from blocking its own cohort. A show
   * whose `show_end` marker landed but whose `end_time` was never stamped (the
   * lost-webhook residue `jobs/legacy-mirror-reconcile` detects, BS#2065) holds
   * `max(shows.id)` while being demonstrably over. `jobs/legacy-mirror-reconcile`
   * already paid for this correction once (BS#2068); a bare `id === max(id)`
   * test would 409 exactly the show the nightly detector flagged for closing.
   */
  it('does not 409 a max(id) show whose terminal entry is already a show_end marker', async () => {
    const orphaned = { id: 1951168, primary_dj_id: null, end_time: null };
    mockGetShowById.mockResolvedValue(orphaned);
    mockGetLatestShow.mockResolvedValue(orphaned);
    mockIsLatestEntryShowEnd.mockResolvedValue(true);
    mockEndShow.mockResolvedValue({ ...orphaned, end_time: endInstant });

    const { res, statusMock } = createMockRes();
    await forceEndShow(makeReq({}, { id: '1951168' }), res, next);

    expect(statusMock).toHaveBeenCalledWith(200);
    expect(mockEndShow).toHaveBeenCalledWith(orphaned, endInstant);
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

/**
 * The derived instant is the right default and the wrong answer often enough
 * to need an override: a DJ who stopped logging at 9pm and stayed on the air
 * until 11pm leaves a show whose flowsheet cannot say so. The operator can.
 *
 * Bounded on both ends, because both bounds protect a public read. The floor
 * is the DERIVED instant itself — `resolveShowEndInstant`, i.e. the show's last
 * logged entry floored at `start_time` — so the override can only ever move the
 * close later than the flowsheet's own answer, never earlier (BS#2315). Below
 * it, a show closes at an instant that precedes entries it still owns:
 * `getShowsInTimeWindow` then drops it from windows `GET /flowsheet` serves its
 * entries in, and any "which show does this entry belong to" derivation from
 * the interval contradicts the `show_id` FK. Above `now` produces a show that
 * claims to have ended in the future.
 *
 * `resolveShowEndInstant` is mocked here, so the floor these tests exercise is
 * whatever the mock returns — END_INSTANT by default, which is 46 minutes after
 * `openShow.start_time`. That gap is the point: it separates the two floors the
 * endpoint used to conflate.
 */
describe('POST /flowsheet/shows/:id/force-end — operator-supplied ended_at', () => {
  const openShow = {
    id: 1951164,
    primary_dj_id: 'dj-1',
    start_time: new Date('2026-08-20T18:00:00.000Z'),
    end_time: null,
  };

  beforeEach(() => {
    mockGetShowById.mockResolvedValue(openShow);
    mockEndShow.mockResolvedValue({ ...openShow, end_time: END_INSTANT });
  });

  it('uses a supplied instant above the floor instead of the derived one', async () => {
    const operatorInstant = new Date('2026-08-20T23:30:00.000Z');
    const { res, statusMock } = createMockRes();

    await forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: operatorInstant.toISOString() }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(openShow, operatorInstant);
    expect(statusMock).toHaveBeenCalledWith(200);
  });

  it('falls back to the derived instant when ended_at is absent', async () => {
    const { res } = createMockRes();

    await forceEndShow(makeReq({}, { id: '1951164' }, {}), res, next);

    expect(mockResolveShowEndInstant).toHaveBeenCalledWith(openShow);
    expect(mockEndShow).toHaveBeenCalledWith(openShow, END_INSTANT);
  });

  it('accepts an instant exactly at the floor', async () => {
    const { res } = createMockRes();

    await forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: END_INSTANT.toISOString() }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(openShow, END_INSTANT);
  });

  /**
   * The defect BS#2315 fixes. 18:30 is inside `[start_time, now]` and was
   * accepted, closing a show at an instant 16 minutes before the last entry it
   * still owns.
   */
  it('400s an instant below the floor without closing the show', async () => {
    const { res } = createMockRes();

    await expect(
      forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: '2026-08-20T18:30:00.000Z' }), res, next)
    ).rejects.toThrow(WxycError);
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  // An operator who is told "too early" and not told how early has to bisect.
  it('names the floor in the rejection', async () => {
    const { res } = createMockRes();

    await expect(
      forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: '2026-08-20T18:30:00.000Z' }), res, next)
    ).rejects.toThrow(END_INSTANT.toISOString());
  });

  /**
   * A show with nothing logged has no last-entry instant, so
   * `resolveShowEndInstant` returns `start_time` and the floor degrades to the
   * old bound. That is the one case where closing at `start_time` is honest.
   */
  it('accepts start_time on a show with no logged entries', async () => {
    mockResolveShowEndInstant.mockResolvedValue(openShow.start_time);
    const { res } = createMockRes();

    await forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: openShow.start_time.toISOString() }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(openShow, openShow.start_time);
  });

  it('400s an instant before start_time on a show with no logged entries', async () => {
    mockResolveShowEndInstant.mockResolvedValue(openShow.start_time);
    const { res } = createMockRes();

    await expect(
      forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: '2026-08-20T17:59:59.000Z' }), res, next)
    ).rejects.toThrow(WxycError);
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it('400s an instant in the future without closing the show', async () => {
    const { res } = createMockRes();
    const future = new Date(Date.now() + 60_000).toISOString();

    await expect(forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: future }), res, next)).rejects.toThrow(
      WxycError
    );
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it.each(['yesterday', '', '2026-13-45T00:00:00Z', 1_755_000_000_000])(
    '400s an unparseable ended_at %p',
    async (raw) => {
      const { res } = createMockRes();

      await expect(forceEndShow(makeReq({}, { id: '1951164' }, { ended_at: raw }), res, next)).rejects.toThrow(
        WxycError
      );
      expect(mockEndShow).not.toHaveBeenCalled();
    }
  );
});
