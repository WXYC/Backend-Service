/**
 * Integration tests for BS#1861: a legacy tubafrenzy sign-off (webhook
 * `show_end`) followed immediately by a dj-site go-live (`POST /flowsheet/join`)
 * must start a NEW show — not silently guest-join the show that just ended.
 *
 * Exercises the full stack across all three fixes from the issue:
 *   (a) the webhook's `shows.end_time` fast-path on a `show_end` delivery
 *   (b) `joinShow`'s belt-and-braces "newest entry is show_end" check,
 *       pinned in isolation by forcing `end_time` back to NULL so the test
 *       can't pass on (a) alone
 *   (c) no duplicate `dj_join` marker for a DJ already active on the show
 *
 * Companion unit coverage: tests/unit/routes/internal.route.test.ts (the
 * end_time fast-path in isolation), tests/unit/controllers/flowsheet.controller.test.ts
 * and tests/unit/services/flowsheet.joinShowGuards.test.ts (the two joinShow
 * guards in isolation).
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const INTERNAL_KEY = process.env.ETL_NOTIFY_KEY || 'test-secret-key';

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

describe('POST /flowsheet/join after a tubafrenzy sign-off (BS#1861)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  const buildEntry = (overrides = {}) => ({
    radioShowId: 0,
    flowsheetEntryType: 6,
    artistName: 'Jessica Pratt',
    songTitle: 'Back, Baby',
    releaseTitle: 'On Your Own Love Again',
    labelName: 'Drag City',
    startTime: Date.now(),
    requestFlag: false,
    sequenceWithinShow: 1,
    libraryReleaseId: 0,
    rotationReleaseId: 0,
    ...overrides,
  });

  const postWebhook = (entry) =>
    request.post('/internal/flowsheet-webhook').set('X-Internal-Key', INTERNAL_KEY).send({ action: 'create', entry });

  const cleanupLegacyShow = async (legacyShowId, entryIds) => {
    if (entryIds.length > 0) {
      await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = ANY($1)`, [entryIds]);
    }
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [legacyShowId]);
  };

  const endCurrentShow = () =>
    request.post('/flowsheet/end').set('Authorization', global.access_token).send({ dj_id: global.primary_dj_id });

  test('acceptance criterion 1: go-live right after a sign-off starts a NEW show, not a guest dj_join into the ended one', async () => {
    const LEGACY_SHOW_ID = 7_777_001;
    const START_ID = 7_777_101;
    const END_ID = 7_777_102;

    try {
      await postWebhook(
        buildEntry({ id: START_ID, radioShowId: LEGACY_SHOW_ID, flowsheetEntryType: 9, djHandle: 'DJ MONSTER' })
      );
      const endRes = await postWebhook(buildEntry({ id: END_ID, radioShowId: LEGACY_SHOW_ID, flowsheetEntryType: 10 }));
      expect(endRes.status).toBe(200);

      // Fast-path (option (a)): the webhook should have closed the legacy
      // show at write time, not left it for the next ETL tick.
      const [legacyShow] = await sql.unsafe(`SELECT id, end_time FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [
        LEGACY_SHOW_ID,
      ]);
      expect(legacyShow.end_time).not.toBeNull();

      // Go live immediately, as the real dj-site flow would.
      const joinRes = await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id, show_name: 'BS#1861 regression 1' });
      expect(joinRes.status).toBe(200);
      // A startShow response is a Show (start_time/show_name); an
      // addDJToShow response is a ShowDJ (show_id/dj_id/active) with neither
      // field. Their presence proves the startShow branch ran.
      expect(joinRes.body.start_time).toBeDefined();
      expect(joinRes.body.show_name).toEqual('BS#1861 regression 1');
      expect(joinRes.body.id).not.toEqual(legacyShow.id);

      const newShowId = joinRes.body.id;

      const [newShowFirstEntry] = await sql.unsafe(
        `SELECT entry_type FROM ${SCHEMA}.flowsheet WHERE show_id = $1 ORDER BY id ASC LIMIT 1`,
        [newShowId]
      );
      expect(newShowFirstEntry.entry_type).toBe('show_start');

      const legacyDjJoinRows = await sql.unsafe(
        `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_join'`,
        [legacyShow.id]
      );
      expect(legacyDjJoinRows.length).toBe(0);

      await endCurrentShow();
    } finally {
      await cleanupLegacyShow(LEGACY_SHOW_ID, [START_ID, END_ID]);
    }
  });

  test('option (b): joinShow still starts a new show when end_time is NULL but the newest entry is show_end', async () => {
    const LEGACY_SHOW_ID = 7_777_002;
    const START_ID = 7_777_201;
    const END_ID = 7_777_202;

    try {
      await postWebhook(
        buildEntry({ id: START_ID, radioShowId: LEGACY_SHOW_ID, flowsheetEntryType: 9, djHandle: 'DJ GHOST' })
      );
      await postWebhook(buildEntry({ id: END_ID, radioShowId: LEGACY_SHOW_ID, flowsheetEntryType: 10 }));

      const [legacyShow] = await sql.unsafe(`SELECT id FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [
        LEGACY_SHOW_ID,
      ]);

      // Simulate the fast-path (a) having been skipped or lost a race — the
      // pre-#1861 window. The show's newest flowsheet entry is still
      // show_end, so (b) is the only thing standing between this and a
      // mis-join.
      await sql.unsafe(`UPDATE ${SCHEMA}.shows SET end_time = NULL WHERE id = $1`, [legacyShow.id]);

      const joinRes = await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id, show_name: 'BS#1861 regression 2' });
      expect(joinRes.status).toBe(200);
      expect(joinRes.body.start_time).toBeDefined();
      expect(joinRes.body.id).not.toEqual(legacyShow.id);

      const legacyDjJoinRows = await sql.unsafe(
        `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_join'`,
        [legacyShow.id]
      );
      expect(legacyDjJoinRows.length).toBe(0);

      await endCurrentShow();
    } finally {
      await cleanupLegacyShow(LEGACY_SHOW_ID, [START_ID, END_ID]);
    }
  });

  test('option (c): an already-active DJ re-join does not write a duplicate dj_join marker', async () => {
    const startRes = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({ dj_id: global.primary_dj_id, show_name: 'BS#1861 regression 3' });
    expect(startRes.status).toBe(200);
    const showId = startRes.body.id;

    try {
      // Secondary DJ joins as a co-host — first join, genuine dj_join marker.
      const firstJoin = await request
        .post('/flowsheet/join')
        .set('Authorization', global.secondary_access_token)
        .send({ dj_id: global.secondary_dj_id });
      expect(firstJoin.status).toBe(200);

      const afterFirstJoin = await sql.unsafe(
        `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_join'`,
        [showId]
      );
      expect(afterFirstJoin.length).toBe(1);

      // Secondary DJ retries the same join (the dj-site "Go Live" retry flap
      // from the issue's 16:32-16:35 trace).
      const secondJoin = await request
        .post('/flowsheet/join')
        .set('Authorization', global.secondary_access_token)
        .send({ dj_id: global.secondary_dj_id });
      expect(secondJoin.status).toBe(200);

      const afterSecondJoin = await sql.unsafe(
        `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_join'`,
        [showId]
      );
      // Still exactly one — the retry did not write a second marker.
      expect(afterSecondJoin.length).toBe(1);

      // The primary DJ re-joining their own already-active show (the
      // issue's 16:37:59 duplicate) must not write a dj_join either.
      const primaryRejoin = await request
        .post('/flowsheet/join')
        .set('Authorization', global.access_token)
        .send({ dj_id: global.primary_dj_id });
      expect(primaryRejoin.status).toBe(200);

      const afterPrimaryRejoin = await sql.unsafe(
        `SELECT id FROM ${SCHEMA}.flowsheet WHERE show_id = $1 AND entry_type = 'dj_join'`,
        [showId]
      );
      expect(afterPrimaryRejoin.length).toBe(1);
    } finally {
      await endCurrentShow();
    }
  });
});
