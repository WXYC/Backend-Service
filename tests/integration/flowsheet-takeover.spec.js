const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');
const fls_util = require('../utils/flowsheet_util');
const { isMockApiAvailable, resetMockApi, getMockRequests } = require('../utils/mock_api');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Per-spec sql client. Mirrors the construction in
// flowsheet-join-after-tubafrenzy-signoff.spec.js / flowsheet.spec.js.
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

/**
 * Integration tests for BS#2233 / BS#2308 / BS#2309: `POST /flowsheet/join`'s
 * `intent: "takeover"` branch, run with FLOWSHEET_TAKEOVER_ENABLED=true
 * against real Postgres.
 *
 * The flag ships OFF in production (default dormant, see
 * apps/backend/config/flowsheetTakeover.ts and docs/env-vars.md). Turning it
 * on here — dev_env/docker-compose.yml's `ci` profile and
 * .github/workflows/test.yml's "Start services" step — is a decision about
 * integration TEST COVERAGE, not about the rollout: nothing about this file
 * enables the feature for real users.
 *
 * Mirrors BS#2232's incident shape: a BS-native show (`primary_dj_id` set)
 * with one active co-host, abandoned without a sign-off. Companion unit
 * coverage: tests/unit/controllers/flowsheet.joinIntent.test.ts (the routing
 * table, including the two concurrent-takeover unit cases this file exercises
 * end-to-end against real Postgres).
 */
describe('POST /flowsheet/join intent: "takeover" (BS#2233/BS#2308)', () => {
  let sql;
  let mockApiAvailable = false;

  // A third identity, distinct from both fixture DJs. Takeover authorization
  // is deliberately NOT role-gated beyond flowsheet:write (PR#2308's
  // "Authorization — decided, not overlooked") — any write-capable DJ can
  // take over an abandoned show, matching the physical reality that whoever
  // is in the studio is on air. The seeded fixture pool only carries the two
  // plain-DJ accounts (test_dj1/test_dj2), already playing the primary/
  // co-host roles below, so the taker needs someone else. The seeded
  // station-manager fixture (dev_env/seed_db.sql) fits: a real row with a
  // resolvable dj_name ("Test SM"), and AUTH_BYPASS's raw-Bearer path
  // (tests/setup/integration.setup.js, mirrored here) doesn't care about
  // role — `/flowsheet/join` never checks one beyond flowsheet:write.
  const TAKER_DJ_ID = 'test-sm-id-0000000000000000001';
  const TAKER_ACCESS_TOKEN = `Bearer ${TAKER_DJ_ID}`;
  const TAKER_DJ_NAME = 'Test SM';

  beforeAll(async () => {
    sql = makeSql();
    mockApiAvailable = await isMockApiAvailable();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  test(
    'takeover closes the abandoned show (end_time = last logged add_time, show_end marker, ' +
      'all show_djs deactivated, dj_leave for the co-host), opens exactly one new show owned by the ' +
      'caller, signs off tubafrenzy, and on_air/djs-on-air agree afterward',
    async () => {
      if (mockApiAvailable) await resetMockApi();

      try {
        // Seed: primary opens a show, secondary joins as an active co-host —
        // the incident's shape (BS#2232: an open show plus a guest, nobody
        // signs off).
        const startRes = await fls_util.join_show(global.primary_dj_id, global.access_token, {
          show_name: 'BS#2309 takeover fixture',
        });
        const startBody = await startRes.json();
        const oldShowId = startBody.id;

        await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token, { intent: 'join' });

        // A logged track. `resolveShowEndInstant` must report ITS add_time as
        // the close instant, never now() — proven below not by hand-setting
        // a timestamp, but by a real wait: the assertion is that end_time
        // equals this row's OWN (database-assigned) add_time and measurably
        // predates the takeover call by the wait interval.
        const trackRes = await request
          .post('/flowsheet')
          .set('Authorization', global.access_token)
          .send({ artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja' })
          .expect(201);
        const [trackRow] = await sql.unsafe(`SELECT add_time FROM ${SCHEMA}.flowsheet WHERE id = $1`, [
          trackRes.body.id,
        ]);
        const lastLoggedAddTime = new Date(trackRow.add_time);

        // The gap that makes "end_time = now()" and "end_time = last logged
        // add_time" observably different outcomes.
        await new Promise((r) => setTimeout(r, 1200));

        // The taker sees the show is genuinely open and gets the 409 — the
        // same prompt the dj-site "Go Live" flow would show — then echoes
        // its show id back as `expected_show_id`, the compare-and-set
        // BS#2233 specifies.
        const conflictRes = await request
          .post('/flowsheet/join')
          .set('Authorization', TAKER_ACCESS_TOKEN)
          .send({ dj_id: TAKER_DJ_ID })
          .expect(409);
        expect(conflictRes.body.code).toBe('show_already_open');
        expect(conflictRes.body.details.show.id).toBe(oldShowId);

        const beforeTakeover = Date.now();
        const takeoverRes = await request
          .post('/flowsheet/join')
          .set('Authorization', TAKER_ACCESS_TOKEN)
          .send({
            dj_id: TAKER_DJ_ID,
            intent: 'takeover',
            expected_show_id: conflictRes.body.details.show.id,
            show_name: 'BS#2309 taker show',
          })
          .expect(200);

        // Opens exactly one new show, owned by the caller — not a co-host
        // join into the old one.
        expect(takeoverRes.body.primary_dj_id).toBe(TAKER_DJ_ID);
        expect(takeoverRes.body.id).not.toBe(oldShowId);
        const newShowId = takeoverRes.body.id;

        const [closedShow] = await sql.unsafe(`SELECT end_time FROM ${SCHEMA}.shows WHERE id = $1`, [oldShowId]);
        expect(closedShow.end_time).not.toBeNull();
        // The derived instant, byte-equal to the track's own add_time — not
        // an approximation of it.
        expect(new Date(closedShow.end_time).getTime()).toBe(lastLoggedAddTime.getTime());
        // And it demonstrably predates the takeover call by (most of) the
        // artificial gap above. Byte-equality with a stale timestamp alone
        // wouldn't rule out a coincidental now()-at-a-different-moment
        // match; this rules it out.
        expect(beforeTakeover - new Date(closedShow.end_time).getTime()).toBeGreaterThan(1000);

        // A show_end marker was written, at the same derived instant.
        const showEndRows = await sql.unsafe(
          `SELECT add_time FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'show_end'`,
          [oldShowId]
        );
        expect(showEndRows.length).toBe(1);
        expect(new Date(showEndRows[0].add_time).getTime()).toBe(lastLoggedAddTime.getTime());

        // All show_djs deactivated — the primary AND the co-host.
        const activeMembers = await sql.unsafe(
          `SELECT dj_id FROM ${SCHEMA}.show_djs WHERE show_id = $1 AND active = true`,
          [oldShowId]
        );
        expect(activeMembers.length).toBe(0);

        // A dj_leave for the co-host — and ONLY the co-host: `endShow` skips
        // the primary (whose departure is what the show_end marker already
        // says), so this must be exactly one row, naming the secondary.
        const djLeaveRows = await sql.unsafe(
          `SELECT dj_name FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_leave'`,
          [oldShowId]
        );
        expect(djLeaveRows.length).toBe(1);
        expect(djLeaveRows[0].dj_name).toBe('Test dj2');

        // The most important assertion in this file — BS#2232's actual
        // user-visible symptom. Before the routing fix, a silent co-host join
        // onto an abandoned show left `on_air` naming the departed owner
        // while `djs-on-air` named whoever had actually shown up. After a
        // takeover, both endpoints are reading the SAME (new) show and must
        // agree.
        const flowsheetRes = await request.get('/flowsheet').query({ limit: 1 }).expect(200);
        expect(flowsheetRes.body.on_air).toEqual({ dj_name: TAKER_DJ_NAME });

        const djsOnAirRes = await request.get('/flowsheet/djs-on-air').expect(200);
        expect(djsOnAirRes.body).toEqual([{ id: TAKER_DJ_ID, dj_name: TAKER_DJ_NAME }]);

        // Spelled out explicitly: the two endpoints name the same DJ.
        expect(flowsheetRes.body.on_air.dj_name).toBe(djsOnAirRes.body[0].dj_name);
        // And neither still names the departed primary or the co-host —
        // confirms this is the fix closing the divergence, not a
        // coincidental match on an unrelated field.
        expect(flowsheetRes.body.on_air.dj_name).not.toBe('Test dj1');
        expect(djsOnAirRes.body.map((dj) => dj.id)).not.toContain(global.primary_dj_id);
        expect(djsOnAirRes.body.map((dj) => dj.id)).not.toContain(global.secondary_dj_id);

        // The old show's tubafrenzy sign-off. This belongs here, against the
        // real mirror helper, rather than the dj-site E2E, where tubafrenzy
        // is a mock. `scheduleTakeoverSignoff` defers to `res.once('finish')`
        // (fire-and-forget, per BS#2233's "do not await it on the request
        // path"), so poll briefly rather than asserting immediately.
        if (mockApiAvailable) {
          const [oldShowRow] = await sql.unsafe(`SELECT legacy_show_id FROM ${SCHEMA}.shows WHERE id = $1`, [
            oldShowId,
          ]);

          const deadline = Date.now() + 4000;
          let signoffRequests = [];
          while (Date.now() < deadline) {
            const tubafrenzyRequests = await getMockRequests('tubafrenzy');
            signoffRequests = tubafrenzyRequests.filter(
              (r) => r.method === 'POST' && r.path.includes('/api/radioShow/signoff')
            );
            if (signoffRequests.length > 0) break;
            await new Promise((r) => setTimeout(r, 100));
          }

          expect(signoffRequests.length).toBeGreaterThanOrEqual(1);
          // Correlate to the OLD show's tubafrenzy id when the create-show
          // mirror tap has already persisted it — signs off the CLOSED show,
          // never the one that just started (the subtle case PR#2308 calls
          // out: both taps read the same res.locals.mirrorData key, so a
          // mis-wired end tap would sign off the wrong show).
          if (oldShowRow?.legacy_show_id != null) {
            const oldShowSignoffs = signoffRequests.filter(
              (r) => r.body && r.body.radioShowId === oldShowRow.legacy_show_id
            );
            expect(oldShowSignoffs.length).toBeGreaterThanOrEqual(1);
          }
        }

        await fls_util.leave_show(TAKER_DJ_ID, TAKER_ACCESS_TOKEN);
        void newShowId;
      } finally {
        // Best-effort cleanup of both shows so a failed assertion above can't
        // leak an open show into a later spec (--runInBand shares state).
        await fls_util.leave_show(TAKER_DJ_ID, TAKER_ACCESS_TOKEN);
        await fls_util.leave_show(global.primary_dj_id, global.access_token);
      }
    }
  );

  test("two concurrent takeovers of the same show produce exactly one new show; the loser gets endShow's CAS 400", async () => {
    try {
      const startRes = await fls_util.join_show(global.primary_dj_id, global.access_token, {
        show_name: 'BS#2309 concurrent takeover fixture',
      });
      const startBody = await startRes.json();
      const oldShowId = startBody.id;

      // Both requests read the same open show before either commits — the
      // double-click shape `endShow`'s own compare-and-set comment describes
      // ("A double-click has both requests reading a live show"), reproduced
      // here with two genuinely concurrent requests rather than a timing
      // guess. Same taker for both: the race is on the show's `end_time IS
      // NULL` CAS, not on caller identity.
      const [firstRes, secondRes] = await Promise.all([
        request
          .post('/flowsheet/join')
          .set('Authorization', TAKER_ACCESS_TOKEN)
          .send({ dj_id: TAKER_DJ_ID, intent: 'takeover', expected_show_id: oldShowId, show_name: 'Racer A' }),
        request
          .post('/flowsheet/join')
          .set('Authorization', TAKER_ACCESS_TOKEN)
          .send({ dj_id: TAKER_DJ_ID, intent: 'takeover', expected_show_id: oldShowId, show_name: 'Racer B' }),
      ]);

      const statuses = [firstRes.status, secondRes.status].sort();
      // One winner (200, a new show), one loser — endShow's own
      // `WHERE end_time IS NULL` CAS 400, not a second new show.
      expect(statuses).toEqual([200, 400]);

      const winner = firstRes.status === 200 ? firstRes : secondRes;
      const loser = firstRes.status === 200 ? secondRes : firstRes;
      expect(loser.body.message).toBe('Bad Request: No active show session found.');

      // Exactly one show opened by the taker as a result of this race —
      // `id > oldShowId` scopes to shows created after (and because of) it,
      // immune to any other fixture the taker owns from an earlier test.
      const newShowsFromThisRace = await sql.unsafe(
        `SELECT id FROM ${SCHEMA}.shows WHERE primary_dj_id = $1 AND id > $2`,
        [TAKER_DJ_ID, oldShowId]
      );
      expect(newShowsFromThisRace.length).toBe(1);
      expect(newShowsFromThisRace[0].id).toBe(winner.body.id);

      await fls_util.leave_show(TAKER_DJ_ID, TAKER_ACCESS_TOKEN);
    } finally {
      await fls_util.leave_show(TAKER_DJ_ID, TAKER_ACCESS_TOKEN);
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    }
  });
});
