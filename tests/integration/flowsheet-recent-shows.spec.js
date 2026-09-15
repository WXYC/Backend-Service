/**
 * BS#2435 — the handoff read, against a real database.
 *
 * `GET /flowsheet/shows/recent`: recent shows and who was on them, for a DJ
 * arriving for a shift. What only a live Postgres can prove — the window floor
 * actually excludes what it claims to; the `show_djs` grouping attaches the
 * right DJs to the right shows across a page; the `active` filter really drops
 * a departed co-host; a legacy show with NO `show_djs` rows still surfaces,
 * named from `shows.legacy_dj_name`; and this endpoint and
 * `GET /flowsheet/djs-on-air` return the same people for the show they both
 * report on.
 *
 * The role gate is NOT exercised here and cannot be: integration runs under
 * `AUTH_BYPASS=true`, whose branch short-circuits to `next()` before any
 * permission check. That tier lives in
 * `tests/unit/routes/flowsheet-recent-shows-permissions.route.test.ts`.
 *
 * Timestamps are relative to `now()` rather than the 1998 window this suite's
 * siblings use, because the endpoint's whole contract is a lookback off the
 * current instant. Every row written here is torn down in afterAll —
 * load-bearing, not tidiness: the one deliberately-open show below would
 * otherwise be `max(shows.id)` for whichever spec runs next, and `joinShow`
 * routes a go-live onto the newest open show.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const HOUR_MS = 60 * 60 * 1000;

const PREFIX = 'bs2435';
const USERS = {
  // The two active co-hosts on the account show.
  meow: { id: `${PREFIX}-user-meow`, djName: 'dj meowww' },
  vaquero: { id: `${PREFIX}-user-vaquero`, djName: 'El Vaquero' },
  // A handle `resolveDjDisplayName` filters away (BS#1286): a real account with
  // an unusable name, which must surface as `dj_name: null`, never blank.
  anon: { id: `${PREFIX}-user-anon`, djName: 'Anonymous' },
  // Signed off mid-show: an inactive `show_djs` row.
  departed: { id: `${PREFIX}-user-departed`, djName: 'DJ Flacko' },
};

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

const hoursAgo = (n) => new Date(Date.now() - n * HOUR_MS).toISOString();

describe('recent shows (BS#2435)', () => {
  let sql;
  const showIds = {};

  const insertShow = async (
    key,
    { startedHoursAgo, endedHoursAgo = null, legacyDjName = null, primaryDjId = null }
  ) => {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (start_time, end_time, legacy_dj_name, primary_dj_id)
      VALUES (
        ${hoursAgo(startedHoursAgo)}::timestamptz,
        ${endedHoursAgo === null ? null : hoursAgo(endedHoursAgo)}::timestamptz,
        ${legacyDjName},
        ${primaryDjId}
      )
      RETURNING id`;
    showIds[key] = rows[0].id;
    return rows[0].id;
  };

  const addShowDJ = async (showKey, user, active = true) => {
    await sql`
      INSERT INTO ${sql(SCHEMA)}.show_djs (show_id, dj_id, active)
      VALUES (${showIds[showKey]}, ${user.id}, ${active})`;
  };

  beforeAll(async () => {
    sql = makeSql();

    // Defensive pre-delete: a prior crashed run would otherwise collide on the
    // fixed user ids. Same pattern as dj-real-name-sentinel.spec.js.
    const userIds = Object.values(USERS).map((u) => u.id);
    // `= ANY(${list})`, NOT `= ANY(${sql.array(list)}::varchar[])`. The cast
    // form reaches Postgres as the single string "a,b,c" and fails with
    // `malformed array literal` — postgres-js cannot infer a string array's
    // element OID, and the explicit `::varchar[]` is applied to an already-
    // flattened value rather than fixing it. A bare interpolated JS array
    // serializes correctly and is what station-signup{,-admin,-review}.spec.js
    // already do. The `::int[]` casts in afterAll are fine — numbers infer.
    //
    // Shows first, and by owner rather than by id: a crashed run leaves the
    // deliberately-open `live` show behind, and `shows.primary_dj_id` is
    // ON DELETE SET NULL — so deleting only the users would orphan it as an
    // un-ownable open show that `joinShow` then routes the next go-live onto.
    await sql`
      DELETE FROM ${sql(SCHEMA)}.show_djs
      WHERE dj_id = ANY(${userIds})
         OR show_id IN (
           SELECT id FROM ${sql(SCHEMA)}.shows WHERE primary_dj_id = ANY(${userIds})
         )`;
    await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE primary_dj_id = ANY(${userIds})`;
    await sql`DELETE FROM auth_user WHERE id = ANY(${userIds})`;

    for (const user of Object.values(USERS)) {
      await sql`
        INSERT INTO auth_user (id, name, email, dj_name, username, is_anonymous)
        VALUES (${user.id}, ${user.djName}, ${`${user.id}@wxyc.org`}, ${user.djName}, ${user.id}, false)`;
    }

    // Insertion order is id order (serial). The deliberately-open `live` show is
    // last, so it is `max(shows.id)` — which is the pivot `djs-on-air` resolves
    // against, and therefore the show both endpoints report on.
    await insertShow('outside', { startedHoursAgo: 48, endedHoursAgo: 47, legacyDjName: 'DJ Flounder' });
    await insertShow('legacy', { startedHoursAgo: 10, endedHoursAgo: 8, legacyDjName: 'DJ Mouseness' });
    await insertShow('nameless', { startedHoursAgo: 6, endedHoursAgo: 5 });
    // `legacyDjName` set alongside real account rows: account rows must win, the
    // same precedence `djs-on-air` applies.
    await insertShow('account', { startedHoursAgo: 4, endedHoursAgo: 2, legacyDjName: 'DJ Stale Handle' });
    await insertShow('live', { startedHoursAgo: 1, primaryDjId: USERS.meow.id });

    await addShowDJ('account', USERS.meow);
    await addShowDJ('account', USERS.vaquero);
    await addShowDJ('account', USERS.anon);
    await addShowDJ('account', USERS.departed, false);
    await addShowDJ('live', USERS.meow);
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = Object.values(showIds);
    if (ids.length) {
      // `flowsheet.show_id` is ON DELETE SET NULL and the deployed `show_djs`
      // FK carries no referential action, so both children go first — see the
      // teardown note in flowsheet-open-shows.spec.js.
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ANY(${sql.array(ids)}::int[])`;
      await sql`DELETE FROM ${sql(SCHEMA)}.show_djs WHERE show_id = ANY(${sql.array(ids)}::int[])`;
      await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ANY(${sql.array(ids)}::int[])`;
    }
    await sql`DELETE FROM auth_user WHERE id = ANY(${Object.values(USERS).map((u) => u.id)})`;
    await sql.end({ timeout: 5 });
  });

  const fetchRecent = async (query = '') => {
    const res = await request.get(`/flowsheet/shows/recent${query}`).set('Authorization', global.access_token);
    expect(res.status).toBe(200);
    return res.body;
  };

  const findShow = (body, key) => body.shows.find((s) => s.id === showIds[key]);
  const handles = (show) => show.djs.map((dj) => dj.dj_name);

  it('returns the in-window shows newest first', async () => {
    const body = await fetchRecent();

    const ours = body.shows.filter((s) => Object.values(showIds).includes(s.id)).map((s) => s.id);
    expect(ours).toEqual([showIds.live, showIds.account, showIds.nameless, showIds.legacy]);

    const times = body.shows.map((s) => new Date(s.start_time).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('carries each show its start and end times, and leaves an open show null', async () => {
    const body = await fetchRecent();

    expect(findShow(body, 'legacy').start_time).toBeTruthy();
    expect(findShow(body, 'legacy').end_time).toBeTruthy();
    expect(findShow(body, 'live').end_time).toBeNull();
  });

  it('excludes a show older than the window, and includes it once widened', async () => {
    expect(findShow(await fetchRecent(), 'outside')).toBeUndefined();

    const widened = await fetchRecent('?window_hours=72');
    expect(handles(findShow(widened, 'outside'))).toEqual(['DJ Flounder']);
  });

  /**
   * The cohort the ticket calls out: a tubafrenzy-mirrored show has no
   * `show_djs` rows at all. Dropping it would leave the handoff list silently
   * missing most of the station's recent history.
   */
  it('names a legacy show from legacy_dj_name, with a null id', async () => {
    const body = await fetchRecent();

    expect(findShow(body, 'legacy').djs).toEqual([{ id: null, dj_name: 'DJ Mouseness' }]);
  });

  it('lists every active account DJ, ignoring the departed co-host and the stale legacy handle', async () => {
    const show = findShow(await fetchRecent(), 'account');

    expect(handles(show).sort()).toEqual(['El Vaquero', 'dj meowww', null].sort());
    expect(handles(show)).not.toContain('DJ Flacko');
    expect(handles(show)).not.toContain('DJ Stale Handle');
    expect(show.djs.every((dj) => dj.id !== null)).toBe(true);
  });

  /**
   * Degrade visibly, not blank — twice over. A show with no resolvable handle
   * at all keeps its row and its times against an empty list, and an account
   * whose handle filters away keeps its id against an explicit null. Neither
   * ever emits an empty string, and neither drops the row.
   */
  it('keeps an unnamed show, with an empty DJ list', async () => {
    const show = findShow(await fetchRecent(), 'nameless');

    expect(show).toBeDefined();
    expect(show.djs).toEqual([]);
    expect(show.start_time).toBeTruthy();
  });

  it('reports a null dj_name for an account whose handle filters away', async () => {
    const show = findShow(await fetchRecent(), 'account');

    expect(show.djs).toContainEqual({ id: USERS.anon.id, dj_name: null });
  });

  /**
   * The acceptance criterion that keeps the two reads from drifting: both
   * resolve the open show through `composeShowDJList`, so they name the same
   * people. Order is not compared — this endpoint sorts deterministically by
   * `auth_user.id` while `djs-on-air` does not sort at all.
   */
  it('agrees with djs-on-air about the show they both report on', async () => {
    const onAirRes = await request.get('/flowsheet/djs-on-air').set('Authorization', global.access_token);
    expect(onAirRes.status).toBe(200);

    const live = findShow(await fetchRecent(), 'live');
    const key = (dj) => `${dj.id}::${dj.dj_name}`;

    expect(live.djs.map(key).sort()).toEqual(onAirRes.body.map(key).sort());
  });

  it('never emits a legal name', async () => {
    // Structural, not a spot check: `real_name` is not an input to any chain
    // this endpoint reaches (docs/pii.md). Asserted on the serialized body so a
    // future column addition that carried one would fail here.
    const res = await request.get('/flowsheet/shows/recent').set('Authorization', global.access_token);

    expect(JSON.stringify(res.body)).not.toContain('real_name');
  });

  it('rejects a malformed window_hours rather than clamping it', async () => {
    const res = await request.get('/flowsheet/shows/recent?window_hours=24h').set('Authorization', global.access_token);
    expect(res.status).toBe(400);
  });

  it('rejects a window_hours past the one-week ceiling', async () => {
    const res = await request.get('/flowsheet/shows/recent?window_hours=169').set('Authorization', global.access_token);
    expect(res.status).toBe(400);
  });
});
