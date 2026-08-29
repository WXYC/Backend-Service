/**
 * `POST /flowsheet/join`'s explicit start-vs-join decision (BS#2233).
 *
 * The routing this file pins is the whole fix for BS#2232: a DJ pressing "Go
 * Live" while somebody else's show is still open used to be silently attached
 * to that show as a co-host. Production show 1951224 collected five DJs that
 * way over ten hours while the public on-air name read the first DJ's handle
 * the entire time.
 *
 * The existing BS#1098 / #1295 / #1861 / #2065 cases live in
 * `flowsheet.controller.test.ts` and are deliberately not restated here — this
 * file mocks the same service module with the extra functions the takeover
 * branch needs, and covers only the new decision.
 */
import { jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';

const mockGetLatestShow = jest.fn<() => Promise<Record<string, unknown> | undefined>>();
const mockStartShow = jest.fn<() => Promise<Record<string, unknown>>>();
const mockAddDJToShow = jest.fn<() => Promise<Record<string, unknown>>>();
const mockEndShow = jest.fn<() => Promise<Record<string, unknown>>>();
const mockIsLatestEntryShowEnd = jest.fn<() => Promise<boolean>>();
const mockIsDjAlreadyActiveOnShow = jest.fn<() => Promise<boolean>>();
const mockCloseShowFromTerminalShowEndMarker = jest.fn<() => Promise<number>>();
const mockResolveShowEndInstant = jest.fn<() => Promise<Date>>();
const mockResolveDjNameForShow = jest.fn<() => Promise<string | null>>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  startShow: mockStartShow,
  addDJToShow: mockAddDJToShow,
  endShow: mockEndShow,
  isLatestEntryShowEnd: mockIsLatestEntryShowEnd,
  isDjAlreadyActiveOnShow: mockIsDjAlreadyActiveOnShow,
  closeShowFromTerminalShowEndMarker: mockCloseShowFromTerminalShowEndMarker,
  resolveShowEndInstant: mockResolveShowEndInstant,
  resolveDjNameForShow: mockResolveDjNameForShow,
}));

const mockScheduleTakeoverSignoff = jest.fn();
jest.mock('../../../apps/backend/middleware/legacy/flowsheet.mirror', () => ({
  flowsheetMirror: { scheduleTakeoverSignoff: mockScheduleTakeoverSignoff },
}));

import { joinShow } from '../../../apps/backend/controllers/flowsheet.controller';
import { resetConfig } from '../../../apps/backend/config/flowsheetTakeover';
import WxycError from '../../../apps/backend/utils/error';

const OPEN_SHOW = {
  id: 1951224,
  primary_dj_id: 'dj-sue',
  start_time: new Date('2026-08-28T15:00:00.000Z'),
  end_time: null,
};

const LAST_LOGGED = new Date('2026-08-28T17:41:00.000Z');

const createMockRes = () => {
  const res: Partial<Response> = {};
  res.locals = {} as Response['locals'];
  res.status = jest.fn().mockReturnValue(res) as unknown as Response['status'];
  res.json = jest.fn().mockReturnValue(res) as unknown as Response['json'];
  res.once = jest.fn().mockReturnValue(res) as unknown as Response['once'];
  return res;
};

const makeReq = (body: Record<string, unknown>): Request =>
  ({ auth: { id: 'dj-eureka' }, body: { dj_id: 'dj-eureka', ...body } }) as unknown as Request;

const next = jest.fn() as unknown as NextFunction;

const enableTakeover = (on: boolean) => {
  if (on) {
    process.env.FLOWSHEET_TAKEOVER_ENABLED = 'true';
  } else {
    delete process.env.FLOWSHEET_TAKEOVER_ENABLED;
  }
  resetConfig();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLatestShow.mockResolvedValue(OPEN_SHOW);
  mockIsLatestEntryShowEnd.mockResolvedValue(false);
  mockIsDjAlreadyActiveOnShow.mockResolvedValue(false);
  mockCloseShowFromTerminalShowEndMarker.mockResolvedValue(0);
  mockResolveShowEndInstant.mockResolvedValue(LAST_LOGGED);
  mockResolveDjNameForShow.mockResolvedValue('dj sue');
  mockStartShow.mockResolvedValue({ id: 1951225, primary_dj_id: 'dj-eureka' });
  mockAddDJToShow.mockResolvedValue({ show_id: OPEN_SHOW.id, dj_id: 'dj-eureka', active: true });
  mockEndShow.mockResolvedValue({ ...OPEN_SHOW, end_time: LAST_LOGGED });
  enableTakeover(true);
});

afterAll(() => enableTakeover(false));

describe('joinShow — the flag is the rollout, and OFF means byte-identical', () => {
  // The contract PR 4 of the epic's chain depends on: auto-dj-orchestrator
  // ships `intent: "takeover"` BEFORE the flag is flipped, and a 400 on the
  // unrecognized field would crash that daemon on start. Flag OFF must ignore
  // `intent` entirely — never a 400, never a 409.
  it.each([undefined, 'join', 'takeover', 'nonsense'])(
    'flag OFF + intent=%p co-hosts exactly as it does today',
    async (intent) => {
      enableTakeover(false);
      const res = createMockRes();

      await joinShow(makeReq(intent === undefined ? {} : { intent, expected_show_id: OPEN_SHOW.id }), res, next);

      expect(mockAddDJToShow).toHaveBeenCalledWith('dj-eureka', expect.objectContaining({ id: OPEN_SHOW.id }));
      expect(mockEndShow).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    }
  );
});

describe('joinShow — an open show the caller does not belong to', () => {
  it('409s with the show details when no intent was sent', async () => {
    const res = createMockRes();

    const err = await joinShow(makeReq({}), res, next).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WxycError);
    expect((err as WxycError).statusCode).toBe(409);
    expect((err as WxycError).code).toBe('show_already_open');
    expect((err as WxycError).details).toEqual({
      show: { id: OPEN_SHOW.id, dj_name: 'dj sue', start_time: OPEN_SHOW.start_time },
    });
    expect(mockAddDJToShow).not.toHaveBeenCalled();
    expect(mockEndShow).not.toHaveBeenCalled();
    expect(mockStartShow).not.toHaveBeenCalled();
  });

  // Not a hand-joined `user` read: the modal renders beside a banner fed by
  // the same chain, and two different resolutions of one show's name is the
  // class of divergence this work exists to remove.
  it('resolves the 409 dj_name through the shared show-name chain', async () => {
    const res = createMockRes();

    await joinShow(makeReq({}), res, next).catch(() => undefined);

    expect(mockResolveDjNameForShow).toHaveBeenCalledWith(expect.objectContaining({ id: OPEN_SHOW.id }));
  });

  it('co-hosts on intent="join", writing one dj_join through the unchanged path', async () => {
    const res = createMockRes();

    await joinShow(makeReq({ intent: 'join' }), res, next);

    expect(mockAddDJToShow).toHaveBeenCalledWith('dj-eureka', expect.objectContaining({ id: OPEN_SHOW.id }));
    expect(mockEndShow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('400s an unrecognized intent', async () => {
    const res = createMockRes();

    const err = await joinShow(makeReq({ intent: 'end_it_all' }), res, next).catch((e: unknown) => e);

    expect((err as WxycError).statusCode).toBe(400);
    expect(mockAddDJToShow).not.toHaveBeenCalled();
    expect(mockEndShow).not.toHaveBeenCalled();
  });
});

describe('joinShow — takeover', () => {
  it('closes the open show and starts a new one for the caller, in that order', async () => {
    const res = createMockRes();
    const order: string[] = [];
    mockEndShow.mockImplementation(() => {
      order.push('endShow');
      return Promise.resolve({ ...OPEN_SHOW, end_time: LAST_LOGGED });
    });
    mockStartShow.mockImplementation(() => {
      order.push('startShow');
      return Promise.resolve({ id: 1951225, primary_dj_id: 'dj-eureka' });
    });

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next);

    expect(order).toEqual(['endShow', 'startShow']);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ id: 1951225, primary_dj_id: 'dj-eureka' });
  });

  /**
   * `now()` is right for a prompt handoff and a lie for an abandoned one — it
   * would credit a departed DJ with however many hours of dead air elapsed
   * before the next DJ arrived, and (per `endShow`'s own EndShowOptions note)
   * put a `show_end` marker at the top of the public flowsheet.
   * `resolveShowEndInstant` is truthful in both cases, because a prompt
   * handoff's last logged track IS recent. One rule, correct twice.
   */
  it('closes at the show’s last logged entry, never at now()', async () => {
    const res = createMockRes();

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next);

    expect(mockResolveShowEndInstant).toHaveBeenCalledWith(expect.objectContaining({ id: OPEN_SHOW.id }));
    expect(mockEndShow).toHaveBeenCalledWith(expect.objectContaining({ id: OPEN_SHOW.id }), LAST_LOGGED);
  });

  it('carries the caller’s show_name, specialty_id and dj_name_override onto the new show', async () => {
    const res = createMockRes();

    await joinShow(
      makeReq({
        intent: 'takeover',
        expected_show_id: OPEN_SHOW.id,
        show_name: 'Night Shift',
        specialty_id: 7,
        dj_name_override: 'eureka!',
      }),
      res,
      next
    );

    expect(mockStartShow).toHaveBeenCalledWith('dj-eureka', 'Night Shift', 7, 'eureka!');
  });

  // The sign-off has to name the show that CLOSED. Handing the mirror the new
  // show would sign off the broadcast that just started — the failure the
  // response-tap middleware cannot avoid, which is why the takeover branch
  // calls the mirror directly instead of chaining `flowsheetMirror.endShow`.
  it('mirrors the sign-off for the CLOSED show, never the new one', async () => {
    const res = createMockRes();
    const finalized = { ...OPEN_SHOW, end_time: LAST_LOGGED, legacy_show_id: 172773 };
    mockEndShow.mockResolvedValue(finalized);

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next);

    expect(mockScheduleTakeoverSignoff).toHaveBeenCalledWith(expect.anything(), res, finalized);
  });

  it('400s a takeover with no expected_show_id', async () => {
    const res = createMockRes();

    const err = await joinShow(makeReq({ intent: 'takeover' }), res, next).catch((e: unknown) => e);

    expect((err as WxycError).statusCode).toBe(400);
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  /**
   * Clients poll, so the DJ reads a snapshot. If the show moved on between the
   * prompt and the click, ending "whatever is open now" would close a show the
   * DJ was never shown — the informed consent the prompt exists to provide,
   * silently voided.
   */
  it('re-409s and closes nothing when expected_show_id no longer names the open show', async () => {
    const res = createMockRes();

    const err = await joinShow(makeReq({ intent: 'takeover', expected_show_id: 1951220 }), res, next).catch(
      (e: unknown) => e
    );

    expect((err as WxycError).statusCode).toBe(409);
    expect((err as WxycError).details).toEqual({
      show: { id: OPEN_SHOW.id, dj_name: 'dj sue', start_time: OPEN_SHOW.start_time },
    });
    expect(mockEndShow).not.toHaveBeenCalled();
    expect(mockStartShow).not.toHaveBeenCalled();
  });

  // The stale-snapshot case that is NOT an error: the DJ asked for "my own
  // show", the outgoing DJ signed off while the dialog was on screen, and the
  // outcome they asked for is already true. Re-prompting here would be the
  // dialog firing on the common one-click path.
  it('starts the new show silently when the expected show closed while the dialog was open', async () => {
    mockGetLatestShow.mockResolvedValue({ ...OPEN_SHOW, end_time: new Date('2026-08-28T17:45:00.000Z') });
    const res = createMockRes();

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next);

    expect(mockEndShow).not.toHaveBeenCalled();
    expect(mockStartShow).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('joinShow — the cases that must never prompt', () => {
  it('starts a show with no prompt when nothing is open', async () => {
    mockGetLatestShow.mockResolvedValue(undefined);
    const res = createMockRes();

    await joinShow(makeReq({}), res, next);

    expect(mockStartShow).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  // BS#1861 arm (c). A DJ re-pressing their own toggle is a retry, not a
  // handoff; prompting them would put the dialog on the most common path.
  it('returns the existing membership when the caller is already active on the show', async () => {
    mockIsDjAlreadyActiveOnShow.mockResolvedValue(true);
    const res = createMockRes();

    await joinShow(makeReq({}), res, next);

    expect(res.json).toHaveBeenCalledWith({ show_id: OPEN_SHOW.id, dj_id: 'dj-eureka', active: true });
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  // BS#1861 arm (b): a show whose terminal entry is a `show_end` marker is
  // demonstrably over even while `end_time` reads NULL. The intent branch runs
  // strictly after that guard, so it can neither observe nor weaken it.
  it('starts a show with no prompt when the open show’s terminal entry is a show_end marker', async () => {
    mockIsLatestEntryShowEnd.mockResolvedValue(true);
    const res = createMockRes();

    await joinShow(makeReq({}), res, next);

    expect(mockCloseShowFromTerminalShowEndMarker).toHaveBeenCalledWith(OPEN_SHOW.id);
    expect(mockStartShow).toHaveBeenCalled();
    expect(mockAddDJToShow).not.toHaveBeenCalled();
  });
});
