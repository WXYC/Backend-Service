/**
 * BS#2235 — operator close, against a real database.
 *
 * `GET /flowsheet/open-shows` + `POST /flowsheet/shows/:id/force-end`, the
 * Backend-Service replacement for tubafrenzy's `EndShowServlet` +
 * "Resume a Show" path, which retires with tubafrenzy on 2026-08-31.
 *
 * What only a live Postgres can prove: the grouped entry counts are right for
 * shows with zero, few, and many entries; the `end_time IS NULL` filter and the
 * window floor actually exclude what they claim to; `force-end` writes the same
 * `show_end` marker and `show_djs` deactivation as `POST /flowsheet/end`,
 * including for a show with a NULL `primary_dj_id` (BS#2093) that the old
 * `endShow` guard refused outright; and the compare-and-set rejects a second
 * force-end without writing a duplicate marker.
 *
 * The role gate is NOT exercised here and cannot be: integration runs under
 * `AUTH_BYPASS=true`, whose branch short-circuits to `next()` before any
 * permission check. That tier lives in
 * `tests/unit/routes/flowsheet-operator-close-permissions.route.test.ts`.
 *
 * Timestamps are relative to `now()` rather than the 1998 window this suite's
 * siblings use, because the endpoint's whole contract is a lookback window off
 * the current instant. Every row written here is torn down in afterAll —
 * load-bearing, not tidiness: an open show left behind would be `max(shows.id)`
 * for whichever spec runs next, and `joinShow` routes a go-live onto the newest
 * open show. Leaving one would reproduce the incident this ticket came from
 * inside the test suite.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

describe('operator close (BS#2235)', () => {
  let sql;
  const showIds = {};

  const insertShow = async (key, { startedDaysAgo, endedDaysAgo = null, legacyDjName = null, entries = 0 }) => {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (start_time, end_time, legacy_dj_name)
      VALUES (
        ${daysAgo(startedDaysAgo)}::timestamptz,
        ${endedDaysAgo === null ? null : daysAgo(endedDaysAgo)}::timestamptz,
        ${legacyDjName}
      )
      RETURNING id`;
    const id = rows[0].id;
    showIds[key] = id;

    for (let i = 1; i <= entries; i += 1) {
      await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet (show_id, entry_type, play_order, message, add_time)
        VALUES (${id}, 'message', ${i}, ${`BS2235 probe ${key} ${i}`}, ${daysAgo(startedDaysAgo)}::timestamptz)`;
    }
    return id;
  };

  beforeAll(async () => {
    sql = makeSql();

    // Insertion order is also id order (serial), and the endpoint resolves
    // `is_current` from `max(shows.id)` — so `current` is inserted LAST and is
    // the newest show in the database for the duration of this spec.
    await insertShow('stale', { startedDaysAgo: 6, legacyDjName: 'DJ Mouseness', entries: 0 });
    await insertShow('busy', { startedDaysAgo: 5, legacyDjName: 'dj meowww', entries: 6 });
    await insertShow('closed', { startedDaysAgo: 4, endedDaysAgo: 4, legacyDjName: 'DJ Flacko', entries: 3 });
    await insertShow('ancient', { startedDaysAgo: 300, legacyDjName: 'DJ Flounder', entries: 1 });
    await insertShow('current', { startedDaysAgo: 0, legacyDjName: 'dj barely there', entries: 2 });
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = Object.values(showIds);
    if (ids.length) {
      // Children first, both of them. `flowsheet.show_id` is ON DELETE SET
      // NULL, so its rows must go before the show or they outlive it as
      // orphans in this shared schema.
      //
      // `show_djs` needs an explicit DELETE too, even though `schema.ts`
      // declares `onDelete: 'cascade'` on that FK: the constraint actually
      // present in the migrated database has no referential action, and a
      // bare `DELETE FROM shows` raises `show_djs_show_id_shows_id_fk`.
      // Observed, not assumed — it is what failed this teardown on first run.
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ANY(${sql.array(ids)}::int[])`;
      await sql`DELETE FROM ${sql(SCHEMA)}.show_djs WHERE show_id = ANY(${sql.array(ids)}::int[])`;
      await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ANY(${sql.array(ids)}::int[])`;
    }
    await sql.end({ timeout: 5 });
  });

  const fetchOpenShows = async (query = '') => {
    const res = await request.get(`/flowsheet/open-shows${query}`).set('Authorization', global.access_token);
    expect(res.status).toBe(200);
    return res.body;
  };

  const findShow = (body, key) => body.shows.find((s) => s.id === showIds[key]);

  describe('GET /flowsheet/open-shows', () => {
    it('returns the in-window open shows with correct grouped entry counts', async () => {
      const body = await fetchOpenShows();

      expect(findShow(body, 'stale')).toMatchObject({ entry_count: 0, dj_name: 'DJ Mouseness' });
      expect(findShow(body, 'busy')).toMatchObject({ entry_count: 6, dj_name: 'dj meowww' });
      expect(findShow(body, 'current')).toMatchObject({ entry_count: 2, dj_name: 'dj barely there' });
    });

    it('omits a closed show', async () => {
      const body = await fetchOpenShows();
      expect(findShow(body, 'closed')).toBeUndefined();
    });

    it('omits an open show older than the window and counts it instead', async () => {
      const body = await fetchOpenShows();

      expect(findShow(body, 'ancient')).toBeUndefined();
      expect(body.older_open_show_count).toBeGreaterThanOrEqual(1);
    });

    // 300 days back: outside the 7-day default, inside the 8760-hour (1 year)
    // ceiling. A probe past the ceiling would be unreachable by any legal
    // request and could not distinguish a working widen from a broken one.
    it('includes the older show once the window is widened to reach it', async () => {
      const body = await fetchOpenShows('?window_hours=8760');
      expect(findShow(body, 'ancient')).toMatchObject({ entry_count: 1, dj_name: 'DJ Flounder' });
    });

    it('orders oldest first', async () => {
      const body = await fetchOpenShows();
      const times = body.shows.map((s) => new Date(s.start_time).getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
    });

    it('flags the abandoned show and spares the busy one', async () => {
      const body = await fetchOpenShows();

      expect(findShow(body, 'stale').likely_abandoned).toBe(true);
      expect(findShow(body, 'busy').likely_abandoned).toBe(false);
    });

    // The exclusion that keeps an operator from ending a live broadcast: the
    // newest show has only two entries but is on the air.
    it('marks the newest show current and never flags it abandoned', async () => {
      const body = await fetchOpenShows();

      expect(findShow(body, 'current')).toMatchObject({ is_current: true, likely_abandoned: false });
      expect(findShow(body, 'stale').is_current).toBe(false);
    });

    it('rejects a malformed window_hours', async () => {
      const res = await request.get('/flowsheet/open-shows?window_hours=24h').set('Authorization', global.access_token);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /flowsheet/shows/:id/force-end', () => {
    it('404s an id that matches no show', async () => {
      const res = await request.post('/flowsheet/shows/2147483646/force-end').set('Authorization', global.access_token);
      expect(res.status).toBe(404);
    });

    it('400s a non-numeric id', async () => {
      const res = await request.post('/flowsheet/shows/abc/force-end').set('Authorization', global.access_token);
      expect(res.status).toBe(400);
    });

    // BS#2093: every one of these probe shows has a NULL primary_dj_id, the
    // shape `endShow` used to refuse with 'Primary DJ not found'. That is also
    // the shape of the entire legacy open-show backlog.
    it('closes an abandoned NULL-primary show, writing exactly one show_end marker', async () => {
      const id = showIds.stale;

      const res = await request.post(`/flowsheet/shows/${id}/force-end`).set('Authorization', global.access_token);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(id);
      expect(res.body.end_time).not.toBeNull();

      const [row] = await sql`SELECT end_time FROM ${sql(SCHEMA)}.shows WHERE id = ${id}`;
      expect(row.end_time).not.toBeNull();

      const markers = await sql`
        SELECT entry_type, message FROM ${sql(SCHEMA)}.flowsheet
        WHERE show_id = ${id} AND entry_type = 'show_end'`;
      expect(markers).toHaveLength(1);
      expect(markers[0].message).toMatch(/^End of show: /);
    });

    it('drops the closed show out of the open-shows list', async () => {
      const body = await fetchOpenShows();
      expect(findShow(body, 'stale')).toBeUndefined();
    });

    // The guarantee is endShow's compare-and-set on `end_time IS NULL`; the
    // controller's own check is only a fast path in front of it. Either way the
    // second call must not append a second marker.
    it('rejects a second force-end and writes no duplicate marker', async () => {
      const id = showIds.stale;

      const res = await request.post(`/flowsheet/shows/${id}/force-end`).set('Authorization', global.access_token);
      expect(res.status).toBe(400);

      const markers = await sql`
        SELECT id FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ${id} AND entry_type = 'show_end'`;
      expect(markers).toHaveLength(1);
    });

    it('deactivates every show_djs membership on the closed show', async () => {
      const id = showIds.busy;

      // A co-host membership, the state a stranded DJ is left in when the
      // primary walks away: `POST /flowsheet/end` can only deactivate them via
      // the primary's own sign-off, which never comes.
      await sql`
        INSERT INTO ${sql(SCHEMA)}.show_djs (show_id, dj_id, active)
        VALUES (${id}, ${global.primary_dj_id}, true)
        ON CONFLICT (show_id, dj_id) DO UPDATE SET active = true`;

      const res = await request.post(`/flowsheet/shows/${id}/force-end`).set('Authorization', global.access_token);
      expect(res.status).toBe(200);

      const memberships = await sql`SELECT active FROM ${sql(SCHEMA)}.show_djs WHERE show_id = ${id}`;
      expect(memberships).toHaveLength(1);
      expect(memberships[0].active).toBe(false);
    });
  });
});
