/**
 * Unit tests for getOnAirDJName — the helper backing the `on_air` field on the
 * default paginated GET /flowsheet response (BS on-air-banner fix).
 *
 * It resolves the display name of the DJ currently on air by reading the latest
 * show and running it through resolveDjNameForShow. Crucially it does NOT read
 * the `show_djs` join table (the pre-existing `/djs-on-air` + `/on-air` bug):
 * tubafrenzy-mirrored shows have no `show_djs` rows, so their DJ identity lives
 * only in `shows.legacy_dj_name`. The regression this fixes is the banner
 * showing "AUTO DJ" while DJ MONSTER — a legacy-mirrored show — was live.
 *
 * Mock mechanics: getLatestShow → getNShows(1) terminates in `.limit()`, and
 * resolveDjNameForShow's user lookup also terminates in `.limit()`. Both consume
 * from the same `_chain.limit` once-queue, so queued values are order-sensitive:
 * the show row first, then (only when a primary DJ is present) the user row.
 */
import { jest } from '@jest/globals';

import { db } from '@wxyc/database';
import { resetConfig } from '../../../apps/backend/config/flowsheetSpotlight';
import { ANONYMOUS_ON_AIR_NAME, getOnAir, getOnAirDJName } from '../../../apps/backend/services/flowsheet.service';

const mockDb = db as unknown as { _chain: Record<string, jest.Mock> };
const chain = mockDb._chain;

// Queue the next value the terminal `.limit()` resolves to. Left unqueued, the
// default mock returns the chain itself, so getLatestShow() yields undefined.
const queueLimit = (rows: unknown[]) => chain.limit.mockResolvedValueOnce(rows);
// The latest-show read LEFT JOINs the catalog, so its rows are `{ show, specialty }`
// (specialty null for an untagged show).
const queueShow = (show: Record<string, unknown>, specialty: Record<string, unknown> | null = null) =>
  queueLimit([{ show, specialty }]);
// getDJsInShow's terminal `.where()` reads: the show_djs join, then — only if
// that returned members — the user lookup. Both are consumed on the BS#2233
// branch below; a show carrying an override or a linked primary DJ never
// reaches either.
const queueWhere = (rows: unknown[]) => chain.where.mockResolvedValueOnce(rows);
// An empty show_djs join short-circuits inside getDJsInShow, so the user
// lookup is never issued and only ONE value is needed here.
const queueNoActiveMembers = () => queueWhere([]);

const PROGRAM_ROW = {
  id: 7,
  slug: 'sonic-boom',
  specialty_name: 'Sonic Boom',
  short_name: 'Sonic Boom',
  tagline: null,
  logs_playcuts: true,
  default_spotlight_role: null,
  artwork: null,
  accent_color: null,
};

describe('getOnAir', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('spotlight (BS#3460)', () => {
    const OPEN_SHOW = { id: 41, end_time: null, primary_dj_id: null, dj_name_override: 'DJ HOUNDSTOOTH' };
    const SPOTLIGHT_ROW = {
      id: 90,
      show_id: 41,
      play_order: 3,
      add_time: new Date('2026-10-21T20:00:00Z'),
      entry_type: 'spotlight',
      spotlight_role: 'performer',
      spotlight_name: 'Weirs',
      message: 'Live in the studio: Weirs',
    };

    const setFlag = (value: string | undefined) => {
      if (value === undefined) {
        delete process.env.FLOWSHEET_SPOTLIGHT_ENABLED;
      } else {
        process.env.FLOWSHEET_SPOTLIGHT_ENABLED = value;
      }
      resetConfig();
    };

    afterEach(() => setFlag(undefined));

    it("carries the open show's newest spotlight as a V2 spotlight entry", async () => {
      setFlag('true');
      queueShow(OPEN_SHOW);
      queueLimit([SPOTLIGHT_ROW]);

      expect((await getOnAir())?.spotlight).toEqual({
        id: 90,
        show_id: 41,
        play_order: 3,
        add_time: SPOTLIGHT_ROW.add_time,
        entry_type: 'spotlight',
        spotlight_role: 'performer',
        spotlight_name: 'Weirs',
        message: 'Live in the studio: Weirs',
      });
    });

    it('is null when the open show has no spotlight', async () => {
      setFlag('true');
      queueShow(OPEN_SHOW);
      queueLimit([]);

      expect(await getOnAir()).toHaveProperty('spotlight', null);
    });

    it('leaves the key out while the flag is off, without reading', async () => {
      setFlag(undefined);
      queueShow(OPEN_SHOW);

      expect(await getOnAir()).not.toHaveProperty('spotlight');
      expect(chain.limit).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a band', 'performer', { mode: 'closed', source: 'spotlight' }],
      ['a reader', 'reader', { mode: 'closed', source: 'spotlight' }],
      ['a guest', 'guest', { mode: 'requests', source: 'default' }],
    ])('request_line follows the spotlight read: %s', async (_name, spotlight_role, request_line) => {
      setFlag('true');
      queueShow(OPEN_SHOW);
      queueLimit([{ ...SPOTLIGHT_ROW, spotlight_role }]);

      expect((await getOnAir())?.request_line).toEqual(request_line);
    });

    it('request_line ignores an empty spotlight read', async () => {
      setFlag('true');
      queueShow(OPEN_SHOW);
      queueLimit([]);

      expect((await getOnAir())?.request_line).toEqual({ mode: 'requests', source: 'default' });
    });

    it('request_line ignores the spotlight while the flag is off', async () => {
      setFlag(undefined);
      queueShow(OPEN_SHOW);

      expect((await getOnAir())?.request_line).toEqual({ mode: 'requests', source: 'default' });
    });

    it('request_line still answers when the spotlight lookup fails', async () => {
      setFlag('true');
      queueShow(OPEN_SHOW);
      chain.limit.mockRejectedValueOnce(new Error('pool exhausted') as never);

      expect((await getOnAir())?.request_line).toEqual({ mode: 'requests', source: 'default' });
    });

    it('drops the key, never the banner, when the lookup fails', async () => {
      setFlag('true');
      queueShow(OPEN_SHOW);
      chain.limit.mockRejectedValueOnce(new Error('pool exhausted') as never);

      const onAir = await getOnAir();

      expect(onAir).toMatchObject({ dj_name: 'DJ HOUNDSTOOTH', show_id: 41 });
      expect(onAir).not.toHaveProperty('spotlight');
    });
  });

  it('carries the open show id, title and specialty ref for a tagged show', async () => {
    queueShow(
      { id: 41, end_time: null, primary_dj_id: null, dj_name_override: 'DJ HOUNDSTOOTH', show_name: 'Boom Hour' },
      PROGRAM_ROW
    );

    expect(await getOnAir()).toEqual({
      dj_name: 'DJ HOUNDSTOOTH',
      show_id: 41,
      show_name: 'Boom Hour',
      specialty: expect.objectContaining({ id: 7, slug: 'sonic-boom', name: 'Sonic Boom' }),
      request_line: { mode: 'requests', source: 'default' },
    });
  });

  it.each([
    ['the DJs chose a mode', 'closed', 'feedback', { mode: 'closed', source: 'dj' }],
    ['the program defaults to messages', null, 'feedback', { mode: 'feedback', source: 'program' }],
    ['neither chose', null, null, { mode: 'requests', source: 'default' }],
  ])('carries request_line when %s', async (_name, request_mode, default_request_mode, request_line) => {
    queueShow(
      { id: 41, end_time: null, primary_dj_id: null, dj_name_override: 'DJ HOUNDSTOOTH', request_mode },
      { ...PROGRAM_ROW, default_request_mode }
    );

    expect((await getOnAir())?.request_line).toEqual(request_line);
  });

  it('answers null specialty and null show_name for a freeform show', async () => {
    queueShow({ id: 42, end_time: null, primary_dj_id: null, dj_name_override: 'DJ HOUNDSTOOTH', show_name: null });

    expect(await getOnAir()).toEqual({
      dj_name: 'DJ HOUNDSTOOTH',
      show_id: 42,
      show_name: null,
      specialty: null,
      request_line: { mode: 'requests', source: 'default' },
    });
  });

  it('is null on automation (latest show ended)', async () => {
    queueShow({ id: 43, end_time: new Date('2026-07-07T18:00:00Z'), show_name: 'Boom Hour' }, PROGRAM_ROW);

    expect(await getOnAir()).toBeNull();
  });
});

describe('getOnAirDJName', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns shows.legacy_dj_name for an open tubafrenzy-mirrored show — the DJ MONSTER production bug', async () => {
    queueShow({
      id: 1950003,
      end_time: null,
      primary_dj_id: null,
      dj_name_override: null,
      legacy_dj_name: 'DJ MONSTER',
    });
    queueNoActiveMembers();

    expect(await getOnAirDJName()).toBe('DJ MONSTER');
  });

  it('resolves the primary DJ user.djName for an open show with a Backend-Service account', async () => {
    queueShow({ id: 2, end_time: null, primary_dj_id: 'user-1', dj_name_override: null, legacy_dj_name: null });
    queueLimit([{ djName: 'DJ HOUNDSTOOTH' }]); // resolveDjNameForShow user lookup

    expect(await getOnAirDJName()).toBe('DJ HOUNDSTOOTH');
  });

  it('returns the WXYC station brand for an open show with no resolvable DJ name — an anonymous human at the controls', async () => {
    // A tubafrenzy sign-on with a blank djHandle leaves legacy_dj_name null. A
    // human is still live, so the banner must read "WXYC", not falsely claim
    // automation (which is what a null return renders as "AUTO DJ" downstream).
    queueShow({ id: 3, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: null });
    queueNoActiveMembers();

    expect(await getOnAirDJName()).toBe(ANONYMOUS_ON_AIR_NAME);
  });

  it('returns the WXYC station brand for an open show whose legacy_dj_name is blank/whitespace', async () => {
    // resolveDjNameForShow can return an empty or whitespace legacy_dj_name
    // verbatim; that is still an anonymous human, not automation.
    queueShow({ id: 6, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: '   ' });
    queueNoActiveMembers();

    expect(await getOnAirDJName()).toBe(ANONYMOUS_ON_AIR_NAME);
  });

  it('returns null when the latest show has already ended (end_time set) — automation', async () => {
    queueShow({
      id: 4,
      end_time: new Date('2026-07-07T18:00:00Z'),
      primary_dj_id: null,
      dj_name_override: null,
      legacy_dj_name: 'DJ MONSTER',
    });

    expect(await getOnAirDJName()).toBeNull();
  });

  it('honours dj_name_override precedence for an open show', async () => {
    // The override short-circuits resolveDjNameForShow ahead of the user lookup,
    // so only getLatestShow's terminal .limit() is consumed.
    queueShow({
      id: 5,
      end_time: null,
      primary_dj_id: 'user-1',
      dj_name_override: 'DJ HOUNDSTOOTH',
      legacy_dj_name: 'DJ MONSTER',
    });

    expect(await getOnAirDJName()).toBe('DJ HOUNDSTOOTH');
  });

  it('returns null when there is no latest show at all', async () => {
    // No queued value → getLatestShow() resolves undefined.
    expect(await getOnAirDJName()).toBeNull();
  });

  /**
   * BS#2233. `resolveDjNameForShow` short-circuits to `legacy_dj_name` the
   * moment `primary_dj_id` is NULL, so a legacy show that a real DJ has since
   * joined kept naming whoever tubafrenzy recorded when it opened — while
   * `GET /flowsheet/djs-on-air`, which prefers account rows, named the DJ
   * actually at the controls. Two on-air endpoints, two answers, disagreeing
   * on exactly the shows where it matters.
   */
  describe('an ownerless show with an active account member', () => {
    it('names the active member, not the legacy handle the departed DJ left behind', async () => {
      queueShow({ id: 1951224, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: 'dj sue' });
      queueWhere([{ dj_id: 'user-9', active: true }]);
      queueWhere([{ id: 'user-9', djName: 'eureka!' }]);

      expect(await getOnAirDJName()).toBe('eureka!');
    });

    it('falls back to legacy_dj_name when the only active member has no resolvable handle', async () => {
      // "Anonymous" is filtered by resolveDjDisplayName, so the member
      // contributes no name and the legacy identity is still the best answer.
      queueShow({ id: 1951224, end_time: null, primary_dj_id: null, dj_name_override: null, legacy_dj_name: 'dj sue' });
      queueWhere([{ dj_id: 'user-9', active: true }]);
      queueWhere([{ id: 'user-9', djName: 'Anonymous' }]);

      expect(await getOnAirDJName()).toBe('dj sue');
    });

    it('still lets an operator-supplied override win, without a join-table read', async () => {
      queueShow({
        id: 1951224,
        end_time: null,
        primary_dj_id: null,
        dj_name_override: 'Guest Host',
        legacy_dj_name: 'dj sue',
      });

      expect(await getOnAirDJName()).toBe('Guest Host');
      expect(chain.where).not.toHaveBeenCalled();
    });
  });
});
