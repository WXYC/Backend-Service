const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');
const fls_util = require('../utils/flowsheet_util');

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
 *
 * Extended by BS#2405 with the two cases the narrowed branch (c) separates: an
 * ACTIVE CO-HOST of the open show (who used to get a silent 200 and is now
 * refused with the same 409 a stranger gets) and the show's OWNER (who must
 * still get BS#1861's no-op and must never be prompted). The co-host case
 * belongs here rather than in the unit suite because `joinShow` no longer reads
 * membership at all — only a real `show_djs` row distinguishes a co-host from a
 * stranger, and only this environment has one.
 */
describe('POST /flowsheet/join intent: "takeover" (BS#2233/BS#2308)', () => {
  let sql;

  // A third identity, distinct from both fixture DJs, which are already
  // playing the primary / co-host roles below. The seeded station-manager
  // fixture (dev_env/seed_db.sql) is the pick: a real row with a resolvable
  // dj_name ("Test SM"), and one no other spec mutates — unlike the
  // deletable/reset fixtures the admin specs target.
  //
  // What this deliberately does NOT prove: that takeover is open to any
  // write-capable DJ. PR#2308 decided takeover is not role-gated beyond
  // flowsheet:write ("Authorization — decided, not overlooked"), but under
  // AUTH_BYPASS + NODE_ENV=test `requirePermissions` returns next() before
  // evaluating any permission, so the taker's role is never checked in this
  // environment at all. The station-manager role is incidental here, not the
  // thing under test; the authorization contract is unit-covered.
  const TAKER_DJ_ID = 'test-sm-id-0000000000000000001';
  const TAKER_ACCESS_TOKEN = `Bearer ${TAKER_DJ_ID}`;
  const TAKER_DJ_NAME = 'Test SM';

  beforeAll(async () => {
    sql = makeSql();
  });

  // Best-effort cleanup of every show this file can open, so a failed
  // assertion can't leak an open show into a later spec (--runInBand shares
  // state, and with the flag on a leaked show turns the next spec's join into a
  // hard throw — see tests/utils/flowsheet_util.js). `leave_show` never throws,
  // so calling it unconditionally is safe whether or not the show exists.
  //
  // The secondary is a co-host in the first two tests and the OWNER of the new
  // show in the BS#2405 one, so it needs ending too — and before the primary,
  // since `/flowsheet/end` from a show's own primary ends the show for
  // everyone on it.
  afterEach(async () => {
    await fls_util.leave_show(TAKER_DJ_ID, TAKER_ACCESS_TOKEN);
    await fls_util.leave_show(global.secondary_dj_id, global.secondary_access_token);
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  test(
    'takeover closes the abandoned show (end_time = last logged add_time, show_end marker, ' +
      'all show_djs deactivated, dj_leave for the co-host), opens exactly one new show owned by the ' +
      'caller, and on_air/djs-on-air agree afterward',
    async () => {
      // Seed: primary opens a show, secondary joins as an active co-host —
      // the incident's shape (BS#2232: an open show plus a guest, nobody
      // signs off).
      const startRes = await fls_util.join_show(global.primary_dj_id, global.access_token, {
        show_name: 'BS#2309 takeover fixture',
      });
      const startBody = await startRes.json();
      // Assert the fixture actually STARTED a show rather than no-op-joining
      // a leaked one. `join_show`'s throw only catches non-2xx: an open show
      // leaked by an earlier spec returns the no-op-200 `ShowDJ` body, which
      // carries no `id`, so `oldShowId` would be undefined and the failure
      // would surface four assertions later against the 409 contract instead
      // of here. Same guard, same reason, as mirror-http.spec.js's join A.
      expect(startBody.primary_dj_id).toBe(global.primary_dj_id);
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
      const [trackRow] = await sql.unsafe(`SELECT add_time FROM ${SCHEMA}.flowsheet WHERE id = $1`, [trackRes.body.id]);
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
    }
  );

  /**
   * BS#2405. The spec above proves the 409 + takeover contract for a caller who
   * is NOT a member of the open show. The co-host is the case that was broken,
   * and it can only be proven here: once the narrowing landed, `joinShow` stops
   * reading membership at all, so at the unit boundary an active co-host and a
   * stranger are indistinguishable. Only a real `show_djs` row tells them
   * apart, and only this environment has one.
   *
   * Before the fix, the `.expect(409)` below was a 200 carrying
   * `{ show_id, dj_id, active: true }` and writing nothing — which is how a DJ
   * spent 1h44m on 2026-09-08 unable to end DJ Houndstooth's show or start his
   * own while 31 of his rows were filed under her name.
   */
  test('an ACTIVE CO-HOST of the open show is refused with the 409, and their takeover lands them on their own show', async () => {
    const startRes = await fls_util.join_show(global.primary_dj_id, global.access_token, {
      show_name: 'BS#2405 co-host fixture',
    });
    const startBody = await startRes.json();
    // Same fixture guard as the first test — see the comment there.
    expect(startBody.primary_dj_id).toBe(global.primary_dj_id);
    const oldShowId = startBody.id;

    // The secondary genuinely joins as a co-host: a real `show_djs` row with
    // `active = true`, plus a `dj_join` marker. This is the state the bug
    // keyed on, so assert it rather than assume it.
    await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token, { intent: 'join' });
    const [cohostRow] = await sql.unsafe(`SELECT active FROM ${SCHEMA}.show_djs WHERE show_id = $1 AND dj_id = $2`, [
      oldShowId,
      global.secondary_dj_id,
    ]);
    expect(cohostRow.active).toBe(true);

    // A logged track, so `resolveShowEndInstant` has something truthful to
    // close at — and so the re-attribution half of the incident has a row.
    await request
      .post('/flowsheet')
      .set('Authorization', global.secondary_access_token)
      .send({ artist_name: 'Jessica Pratt', album_title: 'On Your Own Love Again', track_title: 'Back, Baby' })
      .expect(201);

    // The co-host presses "Go Live". This is the assertion the whole issue is
    // about: a refusal naming the show, not a silent 200.
    const conflictRes = await request
      .post('/flowsheet/join')
      .set('Authorization', global.secondary_access_token)
      .send({ dj_id: global.secondary_dj_id })
      .expect(409);
    expect(conflictRes.body.code).toBe('show_already_open');
    expect(conflictRes.body.details.show.id).toBe(oldShowId);

    // Nothing was written by the refusal — still one show, still one dj_join.
    const djJoinRows = await sql.unsafe(
      `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_join'`,
      [oldShowId]
    );
    expect(djJoinRows.length).toBe(1);

    // And the id the 409 handed back is usable verbatim as `expected_show_id`,
    // which is the whole reason no `OnAirDJ` ownership flag is needed for the
    // client half (WXYC/dj-site#1397).
    const takeoverRes = await request
      .post('/flowsheet/join')
      .set('Authorization', global.secondary_access_token)
      .send({
        dj_id: global.secondary_dj_id,
        intent: 'takeover',
        expected_show_id: conflictRes.body.details.show.id,
        show_name: 'BS#2405 co-host takeover',
      })
      .expect(200);

    // A new show owned by the co-host — not a second dj_join into the old one.
    expect(takeoverRes.body.primary_dj_id).toBe(global.secondary_dj_id);
    expect(takeoverRes.body.id).not.toBe(oldShowId);

    // The three writes the incident produced none of.
    const [closedShow] = await sql.unsafe(`SELECT end_time FROM ${SCHEMA}.shows WHERE id = $1`, [oldShowId]);
    expect(closedShow.end_time).not.toBeNull();

    const showEndRows = await sql.unsafe(
      `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'show_end'`,
      [oldShowId]
    );
    expect(showEndRows.length).toBe(1);

    // `endShow` skips the primary (the show_end marker already says they left)
    // and writes a dj_leave for every other active member — here the taker
    // themselves, who was the old show's only co-host.
    const djLeaveRows = await sql.unsafe(
      `SELECT dj_name FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_leave'`,
      [oldShowId]
    );
    expect(djLeaveRows.length).toBe(1);
    expect(djLeaveRows[0].dj_name).toBe('Test dj2');

    const activeMembers = await sql.unsafe(
      `SELECT dj_id FROM ${SCHEMA}.show_djs WHERE show_id = $1 AND active = true`,
      [oldShowId]
    );
    expect(activeMembers.length).toBe(0);

    // The DJ-visible outcome: the air now names the DJ who pressed the button,
    // and a track they log from here lands on their OWN show.
    const djsOnAirRes = await request.get('/flowsheet/djs-on-air').expect(200);
    expect(djsOnAirRes.body.map((dj) => dj.id)).toEqual([global.secondary_dj_id]);

    const newTrackRes = await request
      .post('/flowsheet')
      .set('Authorization', global.secondary_access_token)
      .send({ artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja' })
      .expect(201);
    const [newTrackRow] = await sql.unsafe(`SELECT show_id, dj_name FROM ${SCHEMA}.flowsheet WHERE id = $1`, [
      newTrackRes.body.id,
    ]);
    expect(newTrackRow.show_id).toBe(takeoverRes.body.id);
    // The misattribution half of the incident: 31 of his rows carried the
    // owner's handle because they were filed on her show.
    expect(newTrackRow.dj_name).toBe('Test dj2');
  });

  /**
   * BS#1861's arm (c), still live, asserted here against the same fixture the
   * co-host test above uses. The narrowing must not prompt the show's OWNER:
   * their press is a retried toggle, and a dialog on that path would land on
   * the most common one-click flow in dj-site.
   */
  test('the show OWNER pressing Go Live again is still the BS#1861 no-op, not a 409', async () => {
    const startRes = await fls_util.join_show(global.primary_dj_id, global.access_token, {
      show_name: 'BS#1861 owner retry fixture',
    });
    const startBody = await startRes.json();
    expect(startBody.primary_dj_id).toBe(global.primary_dj_id);
    const showId = startBody.id;

    // No `intent`, exactly as dj-site's toggle sends it.
    const retryRes = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({ dj_id: global.primary_dj_id })
      .expect(200);

    // The `ShowDJ` no-op body, not a `Show` — so this is branch (c) and not a
    // second `startShow`.
    expect(retryRes.body).toEqual({ show_id: showId, dj_id: global.primary_dj_id, active: true });

    const [openShowCount] = await sql.unsafe(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.shows WHERE primary_dj_id = $1 AND end_time IS NULL`,
      [global.primary_dj_id]
    );
    expect(openShowCount.n).toBe(1);

    // The duplicate-marker trace the issue opened on: no show_end, and no
    // dj_join for the owner either.
    const markerRows = await sql.unsafe(
      `SELECT entry_type FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type IN ('dj_join', 'show_end')`,
      [showId]
    );
    expect(markerRows.length).toBe(0);
  });

  test("two concurrent takeovers of the same show produce exactly one new show; the loser gets endShow's CAS 400", async () => {
    const startRes = await fls_util.join_show(global.primary_dj_id, global.access_token, {
      show_name: 'BS#2309 concurrent takeover fixture',
    });
    const startBody = await startRes.json();
    // Same fixture guard as the first test — see the comment there.
    expect(startBody.primary_dj_id).toBe(global.primary_dj_id);
    const oldShowId = startBody.id;

    // Both requests read the same open show before either commits — the
    // double-click shape `endShow`'s own compare-and-set comment describes
    // ("A double-click has both requests reading a live show"). Same taker
    // for both: the race is on the show's `end_time IS NULL` CAS, not on
    // caller identity.
    //
    // This is a timing assumption, not an invariant the route guarantees,
    // so a failure here is worth reading carefully before assuming a
    // regression. `joinShow`'s first await is `getLatestShow()`; B only has
    // to finish that read before A's `endShow` UPDATE commits, and A has
    // two more awaited round trips (`isLatestEntryShowEnd`,
    // `resolveShowEndInstant`) to get through first — roughly a 3x margin,
    // which is why this is stable rather than lucky. (It was 4x until BS#2405
    // narrowed branch (c) to an inline `primary_dj_id` comparison and retired
    // the `isDjAlreadyActiveOnShow` read that used to sit between them.) Two
    // other interleavings are legal but NOT what we want, and
    // each has a distinct signature:
    //   [200, 200] — B read after A's endShow commit but before A's
    //     startShow INSERT, so B saw a closed show and started its own.
    //     Two shows from one race; the length assertion below catches it.
    //   [200, 409] — B read after A's startShow commit, so B's
    //     expected_show_id no longer matched the open show.
    // Neither is a flake to paper over: both mean the window widened.
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

    const statuses = [firstRes.status, secondRes.status].sort((a, b) => a - b);
    // One winner (200, a new show), one loser — endShow's own
    // `WHERE end_time IS NULL` CAS 400, not a second new show.
    expect(statuses).toEqual([200, 400]);

    const [winner, loser] = firstRes.status === 200 ? [firstRes, secondRes] : [secondRes, firstRes];
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

    // The CAS's own symptom, asserted directly rather than inferred from the
    // show count. What `WHERE end_time IS NULL` exists to prevent (BS#1119)
    // is the losing request ALSO running endShow's body — two `show_end`
    // markers on one show. "Exactly one new
    // show" is a downstream consequence of that and would still hold if the
    // loser had failed for some unrelated reason, so pin the marker count too.
    const oldShowEndMarkers = await sql.unsafe(
      `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'show_end'`,
      [oldShowId]
    );
    expect(oldShowEndMarkers.length).toBe(1);
  });
});
