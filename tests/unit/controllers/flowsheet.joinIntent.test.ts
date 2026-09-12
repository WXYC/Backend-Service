/**
 * `POST /flowsheet/join`'s explicit start-vs-join decision (BS#2233).
 *
 * The routing this file pins is the shared fix for both BS#2232 incidents: a
 * DJ pressing "Go Live" while somebody else's show is still open used to be
 * silently attached to that show as a co-host. On 2026-08-20 show 1951164 ran
 * nine hours and absorbed three later DJs; on 2026-08-28 show 1951224 ran ten
 * hours and absorbed four — DJ String Theory at 14:02, Panzón at 16:02, dj
 * eureka! at 18:03 and Dj xD at 21:00 PDT, plus a 3.6-second toggle blip — for
 * 143 entries under one departed DJ's name. In both cases the public on-air
 * name kept reading the departed DJ's handle.
 *
 * Measure 1951224 from that pre-repair shape, not from the show as it stands:
 * `jobs/flowsheet-show-split` has since split it into five shows, so the
 * surviving 1951224 row now runs 11:02–14:02 with one boundary and reads as a
 * far smaller incident than it was.
 *
 * The two shows differ in HOW the banner went wrong, which is why the fix has
 * two halves. 1951164 is BS-native (`primary_dj_id` set), so `on_air` resolved
 * the owner's account handle. 1951224 is tubafrenzy-mirrored (`primary_dj_id`
 * NULL, `legacy_dj_name` "dj sue"), so `on_air` short-circuited to the legacy
 * handle — the case `flowsheet.getOnAirDJName.test.ts` pins. This file covers
 * the routing that stops the co-host attachment in the first place; neither
 * half subsumes the other.
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
const mockCloseShowFromTerminalShowEndMarker = jest.fn<() => Promise<number>>();
const mockResolveShowEndInstant = jest.fn<() => Promise<Date>>();
const mockResolveDjNameForShow = jest.fn<() => Promise<string | null>>();
const mockRecordGoLiveHandoff =
  jest.fn<(intent: 'takeover' | 'join', handoff: { open_show_id: number; dj_id: string }) => void>();

jest.mock('../../../apps/backend/services/flowsheet.service', () => ({
  getLatestShow: mockGetLatestShow,
  startShow: mockStartShow,
  addDJToShow: mockAddDJToShow,
  endShow: mockEndShow,
  isLatestEntryShowEnd: mockIsLatestEntryShowEnd,
  closeShowFromTerminalShowEndMarker: mockCloseShowFromTerminalShowEndMarker,
  resolveShowEndInstant: mockResolveShowEndInstant,
  resolveDjNameForShow: mockResolveDjNameForShow,
}));

jest.mock('../../../apps/backend/services/flowsheet/go-live-handoff-signal', () => ({
  recordGoLiveHandoff: mockRecordGoLiveHandoff,
}));

import { joinShow } from '../../../apps/backend/controllers/flowsheet.controller';
import { resetConfig } from '../../../apps/backend/config/flowsheetTakeover';
import WxycError from '../../../apps/backend/utils/error';

// Production show 1951224 as it actually is: tubafrenzy-mirrored, so
// `primary_dj_id` is NULL and the identity lives in `legacy_dj_name`. That
// shape matters — it is the one where `resolveDjNameForShow` short-circuits to
// the legacy handle, so the 409's name and the on-air banner's name are
// resolved by different rules (see `showAlreadyOpenError`). Giving this
// fixture a `primary_dj_id` would model the easy case under the hard case's id.
const OPEN_SHOW = {
  id: 1951224,
  primary_dj_id: null,
  legacy_dj_name: 'dj sue',
  start_time: new Date('2026-08-28T18:02:34.234Z'),
  end_time: null,
};

// Production show 1951325, the 2026-09-08 BS#2405 incident: BS-native, so
// `primary_dj_id` names a real account and the show HAS an owner. The mirrored
// fixture above cannot express "owner" at all, which is why the owner-versus-
// co-host pair below needs its own show rather than an override.
const NATIVE_SHOW = {
  id: 1951325,
  primary_dj_id: 'dj-houndstooth',
  legacy_dj_name: null,
  start_time: new Date('2026-09-09T01:02:37.000Z'),
  end_time: null,
};

// The show's last logged track, which is what `resolveShowEndInstant` derives.
const LAST_LOGGED = new Date('2026-08-28T20:49:08.792Z');

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

  // Not a hand-joined `user` read: the prompt names the show the same way
  // every other show-scoped surface does. Note this is NOT the same answer as
  // the on-air banner for an abandoned legacy show — `getOnAirDJName` prefers
  // an active `show_djs` member there, and deliberately so. The prompt names
  // the show's OWNER ("whose show am I being asked about"); the banner names
  // whoever is at the controls.
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

  // A JSON `null` is what an unset optional serializes to from several of this
  // epic's clients, and it says the same thing an absent field says. Answering
  // it with a 400 would tell a caller who has not chosen that their choice is
  // invalid — the one response a client cannot turn into a prompt.
  it('409s on an explicit null intent, exactly as it does on an absent one', async () => {
    const res = createMockRes();

    const err = await joinShow(makeReq({ intent: null }), res, next).catch((e: unknown) => e);

    expect((err as WxycError).statusCode).toBe(409);
    expect((err as WxycError).code).toBe('show_already_open');
    expect(mockAddDJToShow).not.toHaveBeenCalled();
    expect(mockEndShow).not.toHaveBeenCalled();
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

  // BS#2403 removed the tubafrenzy sign-off this branch used to schedule for
  // the CLOSED show. What survives it is the ordering the sign-off depended
  // on: `endShow` must be awaited on the OPEN show before `startShow` opens
  // the next one, so the compare-and-set that serializes two racing takeovers
  // still runs first.
  it('ends the OPEN show before starting the new one', async () => {
    const res = createMockRes();
    mockEndShow.mockResolvedValue({ ...OPEN_SHOW, end_time: LAST_LOGGED });

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(expect.objectContaining({ id: OPEN_SHOW.id }), LAST_LOGGED);
    expect(mockEndShow.mock.invocationCallOrder[0]).toBeLessThan(mockStartShow.mock.invocationCallOrder[0]);
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
    mockGetLatestShow.mockResolvedValue({ ...OPEN_SHOW, end_time: new Date('2026-08-28T21:02:58.418Z') });
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

  // BS#1861 arm (c), re-pointed by BS#2405. A DJ re-pressing their OWN toggle
  // is a retry, not a handoff; prompting them would put the dialog on the most
  // common path. This case used to be written as "already active on the show",
  // asserted through `isDjAlreadyActiveOnShow` against the MIRRORED fixture —
  // a show with no owner at all — so it pinned the wider predicate that
  // swallowed the co-host's intent contract rather than BS#1861's actual
  // requirement. BS#1861's trace is the show's own DJ double-pressing, so the
  // case belongs on a BS-native show with the caller as its `primary_dj_id`.
  // The co-host converse is the BS#2405 describe below.
  it('returns the existing membership when the caller OWNS the show', async () => {
    mockGetLatestShow.mockResolvedValue({ ...NATIVE_SHOW, primary_dj_id: 'dj-eureka' });
    const res = createMockRes();

    await joinShow(makeReq({}), res, next);

    expect(res.json).toHaveBeenCalledWith({ show_id: NATIVE_SHOW.id, dj_id: 'dj-eureka', active: true });
    expect(mockEndShow).not.toHaveBeenCalled();
    expect(mockStartShow).not.toHaveBeenCalled();
    expect(mockAddDJToShow).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// BS#2405. Branch (c) used to fire for ANY active member of the open show, so
// a co-host's every press — `intent: "takeover"` included — was answered 200
// with zero writes, and the 409 / prompt / takeover below it were dead code
// for them. On 2026-09-08 a DJ spent 1h44m trapped that way on show 1951325
// while 31 of his rows were filed under the owner's name.
//
// Read the boundary carefully before adding a case here. The narrowing means
// `joinShow` no longer asks whether the caller is a MEMBER of the open show at
// all — the only input the decision now reads is `current_show.primary_dj_id`.
// So at this (mocked-service) boundary an active co-host and a total stranger
// are the same caller: both are "not the owner", and neither can be mocked
// into being distinguishable, because there is nothing left to mock. That
// collapse is the fix. The genuinely-a-co-host case — a real active `show_djs`
// row for the caller — is only expressible where those rows exist, and is
// pinned in tests/integration/flowsheet-takeover.spec.js.
// ---------------------------------------------------------------------------
describe('joinShow — ownership is the only thing branch (c) reads (BS#2405)', () => {
  beforeEach(() => {
    mockGetLatestShow.mockResolvedValue(NATIVE_SHOW);
    mockResolveDjNameForShow.mockResolvedValue('DJ Houndstooth');
    mockAddDJToShow.mockResolvedValue({ show_id: NATIVE_SHOW.id, dj_id: 'dj-eureka', active: true });
  });

  // The details payload is the half that settles the paired client change: the
  // 409 carries the open show's id, so dj-site's existing `readShowAlreadyOpen`
  // parser can lift it straight into the `expected_show_id` a takeover sends.
  // Nothing new is needed on `OnAirDJ` for the trapped co-host to escape.
  it('409s a non-owner with a usable show id rather than answering 200 and writing nothing', async () => {
    const res = createMockRes();

    const err = await joinShow(makeReq({}), res, next).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WxycError);
    expect((err as WxycError).statusCode).toBe(409);
    expect((err as WxycError).code).toBe('show_already_open');
    expect((err as WxycError).details).toEqual({
      show: { id: NATIVE_SHOW.id, dj_name: 'DJ Houndstooth', start_time: NATIVE_SHOW.start_time },
    });
    expect(mockAddDJToShow).not.toHaveBeenCalled();
    expect(mockStartShow).not.toHaveBeenCalled();
    expect(mockEndShow).not.toHaveBeenCalled();
  });

  it('carries that non-owner’s intent="takeover" through to ending the show and starting theirs', async () => {
    const res = createMockRes();
    mockEndShow.mockResolvedValue({ ...NATIVE_SHOW, end_time: LAST_LOGGED });

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: NATIVE_SHOW.id }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(expect.objectContaining({ id: NATIVE_SHOW.id }), LAST_LOGGED);
    expect(mockStartShow).toHaveBeenCalled();
    expect(mockEndShow.mock.invocationCallOrder[0]).toBeLessThan(mockStartShow.mock.invocationCallOrder[0]);
  });

  it('still no-ops for the show OWNER, preserving the BS#1861 retried toggle', async () => {
    const res = createMockRes();

    await joinShow(
      {
        auth: { id: NATIVE_SHOW.primary_dj_id },
        body: { dj_id: NATIVE_SHOW.primary_dj_id },
      } as unknown as Request,
      res,
      next
    );

    expect(res.json).toHaveBeenCalledWith({
      show_id: NATIVE_SHOW.id,
      dj_id: NATIVE_SHOW.primary_dj_id,
      active: true,
    });
    expect(mockEndShow).not.toHaveBeenCalled();
    expect(mockStartShow).not.toHaveBeenCalled();
    expect(mockAddDJToShow).not.toHaveBeenCalled();
  });

  // The behaviour change BS#2405 makes that is NOT the bug fix, stated here
  // rather than discovered in production.
  //
  // `primary_dj_id === req.body.dj_id` is unsatisfiable when the column is
  // NULL, so on a tubafrenzy-mirrored show branch (c) cannot fire for ANY
  // caller — including one who really is an active co-host of it. Every caller
  // reaches the intent contract and is prompted.
  //
  // That is the correct answer, not a casualty. Branch (c) absorbs a retried
  // press by the person who STARTED the show; a mirrored show's identity lives
  // in `legacy_dj_name`, the DJ it names holds no Backend account, and nobody
  // who can press anything is that person. The pre-BS#2405 answer here was the
  // same silent 200 the co-host got, which is what made the two one fix.
  //
  // It is also nearly vacuous going forward: the tubafrenzy flowsheet webhook
  // was disabled 2026-09-07 (WXYC/wiki#88 step E4), so no NEW mirrored show can
  // be created — only a historically-open one can still be the open show.
  it('cannot fire at all on a tubafrenzy-mirrored show, which has no owner', async () => {
    mockGetLatestShow.mockResolvedValue(OPEN_SHOW);
    mockResolveDjNameForShow.mockResolvedValue('dj sue');
    const res = createMockRes();

    const err = await joinShow(makeReq({}), res, next).catch((e: unknown) => e);

    expect(OPEN_SHOW.primary_dj_id).toBeNull();
    expect((err as WxycError).statusCode).toBe(409);
    expect((err as WxycError).code).toBe('show_already_open');
    expect((err as WxycError).details).toEqual({
      show: { id: OPEN_SHOW.id, dj_name: 'dj sue', start_time: OPEN_SHOW.start_time },
    });
    expect(mockAddDJToShow).not.toHaveBeenCalled();
    expect(mockStartShow).not.toHaveBeenCalled();
  });

  // And that prompt is actionable: the mirrored show's id comes back in the
  // 409, so echoing it as `expected_show_id` closes the abandoned legacy show
  // rather than leaving it to collect another DJ's set — the BS#2232 shape.
  it('lets the mirrored show be taken over with the id the 409 handed back', async () => {
    mockGetLatestShow.mockResolvedValue(OPEN_SHOW);
    mockResolveDjNameForShow.mockResolvedValue('dj sue');
    const res = createMockRes();

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next);

    expect(mockEndShow).toHaveBeenCalledWith(expect.objectContaining({ id: OPEN_SHOW.id }), LAST_LOGGED);
    expect(mockStartShow).toHaveBeenCalled();
  });
});

/**
 * A takeover is invisible after the fact -- `endShow` back-dates `end_time` and
 * `shows` has no `updated_at` -- so this signal is the only durable evidence
 * the branch ran. These cases pin that it records resolved handoffs and not
 * prompts: a caller merely shown the 409 has handed nothing off.
 */
describe('joinShow — go-live handoff signal', () => {
  it.each([
    ['a completed takeover', { intent: 'takeover', expected_show_id: OPEN_SHOW.id }, 'takeover'],
    ['a completed co-host join', { intent: 'join' }, 'join'],
  ] as const)('records %s', async (_name, body, intent) => {
    const res = createMockRes();

    await joinShow(makeReq({ ...body }), res, next);

    expect(mockRecordGoLiveHandoff).toHaveBeenCalledWith(intent, {
      open_show_id: OPEN_SHOW.id,
      dj_id: 'dj-eureka',
    });
  });

  it.each([
    ['the caller is only prompted', {}],
    ['a stale takeover is refused', { intent: 'takeover', expected_show_id: OPEN_SHOW.id + 1 }],
  ] as const)('records nothing when %s', async (_name, body) => {
    const res = createMockRes();

    await joinShow(makeReq({ ...body }), res, next).catch(() => undefined);

    expect(mockRecordGoLiveHandoff).not.toHaveBeenCalled();
  });

  // `endShow` is the destructive half. If `startShow` then fails, a DJ's show
  // has been terminated with nobody on air — the case most worth alerting on,
  // and the one a happy-path-only record would drop.
  it('records a takeover whose new show fails to start', async () => {
    mockStartShow.mockRejectedValueOnce(new Error('insert failed'));
    const res = createMockRes();

    await joinShow(makeReq({ intent: 'takeover', expected_show_id: OPEN_SHOW.id }), res, next).catch(() => undefined);

    expect(mockEndShow).toHaveBeenCalled();
    expect(mockRecordGoLiveHandoff).toHaveBeenCalledWith('takeover', {
      open_show_id: OPEN_SHOW.id,
      dj_id: 'dj-eureka',
    });
  });
});
