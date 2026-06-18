/**
 * Integration tests for POST /internal/flowsheet-webhook (BS#909 / H2).
 *
 * The webhook receives tubafrenzy flowsheet events. The acceptance criterion
 * tested here is (c) from issue #909: under a concurrent INSERT race (two
 * webhook deliveries with the same `legacy_entry_id` arriving in flight), PG's
 * INSERT ... ON CONFLICT DO NOTHING serializes the two writes and exactly one
 * delivery sees a fresh INSERT (and would fire enrichment); the other sees an
 * empty RETURNING and falls through to UPDATE without re-firing.
 *
 * This integration test exercises that against real Postgres. The unit-test
 * companion at `tests/unit/routes/internal.route.test.ts` covers fresh-INSERT
 * and ON-CONFLICT branches individually with mocked DB chains; only the
 * concurrent race needs a real engine because the guarantee is the engine's,
 * not the handler's.
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
    max: 4,
  });
}

describe('POST /internal/flowsheet-webhook — concurrent INSERT race (BS#909)', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  // Use a legacy_entry_id deep in a range that's unlikely to collide with any
  // fixture or other spec's writes. The afterEach cleanup deletes by this id.
  const LEGACY_ENTRY_ID = 9_999_991;

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
  });

  const buildEntry = (overrides = {}) => ({
    id: LEGACY_ENTRY_ID,
    radioShowId: 0,
    flowsheetEntryType: 6,
    artistName: 'Chuquimamani-Condori',
    songTitle: 'Call Your Name',
    releaseTitle: 'Edits',
    labelName: 'self-released',
    startTime: 1706799600000,
    requestFlag: false,
    sequenceWithinShow: 1,
    libraryReleaseId: 0,
    rotationReleaseId: 0,
    ...overrides,
  });

  test('two concurrent webhook deliveries produce exactly one row', async () => {
    const entry = buildEntry();
    const responses = await Promise.all([
      request.post('/internal/flowsheet-webhook').set('X-Internal-Key', INTERNAL_KEY).send({ action: 'create', entry }),
      request.post('/internal/flowsheet-webhook').set('X-Internal-Key', INTERNAL_KEY).send({ action: 'create', entry }),
    ]);

    // Both webhook calls succeed (one inserts, one updates); HTTP 200 either way.
    for (const r of responses) expect(r.status).toBe(200);

    // Exactly one row exists for this legacy_entry_id.
    const rows = await sql.unsafe(`SELECT id, artist_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
      LEGACY_ENTRY_ID,
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].artist_name).toBe('Chuquimamani-Condori');
  });

  // BS#1371: marker entry types delivered via the webhook must carry
  // `dj_name` resolved via COALESCE(auth_user.dj_name, shows.legacy_dj_name,
  // auth_user.name). Pre-fix, every webhook-delivered show_start /
  // show_end / dj_join / dj_leave row landed with dj_name=NULL and the v2
  // wire emitted '' (iOS rendered an empty handle for ~119k historical
  // rows). The three cases below cover the three resolution arms.
  //
  // `seedShow` pre-DELETEs (defensive against a prior crashed test leaving
  // a polluted row that would otherwise survive a naive INSERT...ON
  // CONFLICT DO NOTHING and produce a confusing false pass/fail). `clearShow`
  // clears the flowsheet row before the show (FK ordering — shows is not
  // ON DELETE CASCADE).
  const seedShow = async (legacyShowId, { legacyDjName = null, primaryDjId = null } = {}) => {
    await sql.unsafe(
      `DELETE FROM ${SCHEMA}.flowsheet WHERE show_id IN (SELECT id FROM ${SCHEMA}.shows WHERE legacy_show_id = $1)`,
      [legacyShowId]
    );
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [legacyShowId]);
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.shows (legacy_show_id, legacy_dj_name, primary_dj_id, start_time) VALUES ($1, $2, $3, NOW())`,
      [legacyShowId, legacyDjName, primaryDjId]
    );
  };
  const clearShow = async (legacyShowId) => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [LEGACY_ENTRY_ID]);
    await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [legacyShowId]);
  };

  test('show_start webhook resolves dj_name from shows.legacy_dj_name (BS#1371)', async () => {
    const LEGACY_SHOW_ID = 9_999_990;
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: "T'mia Powell" });

    try {
      const entry = buildEntry({ flowsheetEntryType: 9, radioShowId: LEGACY_SHOW_ID });
      const res = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ action: 'create', entry });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        LEGACY_ENTRY_ID,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].entry_type).toBe('show_start');
      expect(rows[0].dj_name).toBe("T'mia Powell");
    } finally {
      await clearShow(LEGACY_SHOW_ID);
    }
  });

  // Highest-priority COALESCE arm. Points shows.primary_dj_id at a seeded
  // auth_user and asserts the resolver picked auth_user.dj_name over
  // legacy_dj_name. Without this case the LEFT JOIN to auth_user is never
  // exercised against real Postgres; a schema rename of auth_user.dj_name
  // would leave the legacy_dj_name case (above) green while production
  // silently regressed on the primary arm.
  //
  // The expected name is fetched at runtime from the seed row rather than
  // hardcoded, so a future rename of the seeded dj_name in dev_env/seed_db.sql
  // doesn't break this test for an unrelated reason. We do hard-code the
  // user id (a stable seed key) — if the row itself is removed from the
  // seed the upfront SELECT throws with a clear "seeded user missing"
  // message instead of a confusing equality failure on the dj_name.
  test('show_start webhook prefers auth_user.dj_name over legacy_dj_name (BS#1371)', async () => {
    const LEGACY_SHOW_ID = 9_999_988;
    const PRIMARY_DJ_ID = 'test-dj1-id-00000000000000000001'; // seeded in dev_env/seed_db.sql
    const [seededUser] = await sql.unsafe(`SELECT dj_name FROM auth_user WHERE id = $1`, [PRIMARY_DJ_ID]);
    if (!seededUser?.dj_name) {
      throw new Error(
        `Seeded auth_user ${PRIMARY_DJ_ID} is missing or has no dj_name; cannot run BS#1371 auth_user-arm test`
      );
    }
    const expectedDjName = seededUser.dj_name;
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: 'Legacy Override Loser', primaryDjId: PRIMARY_DJ_ID });

    try {
      const entry = buildEntry({ flowsheetEntryType: 9, radioShowId: LEGACY_SHOW_ID });
      const res = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ action: 'create', entry });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        LEGACY_ENTRY_ID,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].entry_type).toBe('show_start');
      expect(rows[0].dj_name).toBe(expectedDjName);
      // Negative assertion: the lower-priority legacy_dj_name must NOT win.
      expect(rows[0].dj_name).not.toBe('Legacy Override Loser');
    } finally {
      await clearShow(LEGACY_SHOW_ID);
    }
  });

  test('track webhook leaves dj_name NULL even when the show has a resolved name (BS#1371)', async () => {
    // Track rows have their own dj_name population path (ETL + live insert).
    // The webhook must NOT write dj_name on track rows so we don't double-
    // write and risk drift between the webhook and the ETL writer.
    const LEGACY_SHOW_ID = 9_999_989;
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: 'Some Resolvable Name' });

    try {
      const entry = buildEntry({ flowsheetEntryType: 6, radioShowId: LEGACY_SHOW_ID });
      const res = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({ action: 'create', entry });
      expect(res.status).toBe(200);

      const rows = await sql.unsafe(`SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        LEGACY_ENTRY_ID,
      ]);
      expect(rows.length).toBe(1);
      expect(rows[0].entry_type).toBe('track');
      expect(rows[0].dj_name).toBeNull();
    } finally {
      await clearShow(LEGACY_SHOW_ID);
    }
  });

  test('a second delivery with different mutable fields refreshes those fields', async () => {
    // First delivery: fresh INSERT — the row carries the initial payload.
    const initial = buildEntry({ artistName: 'Juana Molina', songTitle: 'la paradoja', releaseTitle: 'DOGA' });
    const firstRes = await request
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'create', entry: initial });
    expect(firstRes.status).toBe(200);

    // Second delivery: same legacy_entry_id, refreshed mutable fields. The
    // INSERT branch sees a conflict, so the handler falls through to the
    // explicit UPDATE path. We assert the row's mutable subset moved.
    const refreshed = buildEntry({
      artistName: 'Juana Molina',
      songTitle: 'la paradoja',
      releaseTitle: 'DOGA (remastered)',
    });
    const secondRes = await request
      .post('/internal/flowsheet-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', entry: refreshed });
    expect(secondRes.status).toBe(200);

    const rows = await sql.unsafe(`SELECT album_title FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
      LEGACY_ENTRY_ID,
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].album_title).toBe('DOGA (remastered)');
  });

  // BS#1444 (residual of #1371): the show_start is the FIRST entry of a show,
  // so it loses a structural race — when it arrives the stub `shows` row has no
  // `legacy_dj_name` yet, and the marker lands NULL. The ETL fills the name
  // minutes later, but the conflict path only heals the SAME legacy_entry_id
  // (which never re-delivers for a create). The sibling-marker heal backfills
  // the still-NULL marker rows when ANY later entry for the show resolves a
  // name — so the live "signed on" stops rendering nameless mid-show.
  test('a later entry heals a show_start that lost the stub race (BS#1444)', async () => {
    const LEGACY_SHOW_ID = 9_999_987;
    const SHOW_START_ID = 9_999_985;
    const TRACK_ID = 9_999_984;

    // Stub show with no resolvable name yet (mirrors resolveShow's stub insert).
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: null });

    const cleanup = async () => {
      await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id IN ($1, $2)`, [SHOW_START_ID, TRACK_ID]);
      await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [LEGACY_SHOW_ID]);
    };

    try {
      // 1) show_start arrives first → lands NULL (no name source on the stub).
      const startRes = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({
          action: 'create',
          entry: buildEntry({ id: SHOW_START_ID, flowsheetEntryType: 9, radioShowId: LEGACY_SHOW_ID }),
        });
      expect(startRes.status).toBe(200);

      const [startBefore] = await sql.unsafe(
        `SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`,
        [SHOW_START_ID]
      );
      expect(startBefore.entry_type).toBe('show_start');
      expect(startBefore.dj_name).toBeNull();

      // 2) ETL fills shows.legacy_dj_name (simulated).
      await sql.unsafe(`UPDATE ${SCHEMA}.shows SET legacy_dj_name = $1 WHERE legacy_show_id = $2`, [
        'Healed Handle',
        LEGACY_SHOW_ID,
      ]);

      // 3) A later TRACK delivery for the same show triggers the sibling heal.
      const trackRes = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({
          action: 'create',
          entry: buildEntry({ id: TRACK_ID, flowsheetEntryType: 6, radioShowId: LEGACY_SHOW_ID }),
        });
      expect(trackRes.status).toBe(200);

      // show_start is now healed...
      const [startAfter] = await sql.unsafe(`SELECT dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        SHOW_START_ID,
      ]);
      expect(startAfter.dj_name).toBe('Healed Handle');

      // ...but the track row that triggered the heal keeps its own NULL dj_name
      // (track rows have a separate population path; the heal must not touch them).
      const [trackRow] = await sql.unsafe(
        `SELECT entry_type, dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`,
        [TRACK_ID]
      );
      expect(trackRow.entry_type).toBe('track');
      expect(trackRow.dj_name).toBeNull();
    } finally {
      await cleanup();
    }
  });

  // BS#1444 guard: the heal is scoped to `dj_name IS NULL`, so a marker that
  // already resolved to one handle must NOT be clobbered when the show's
  // resolved name later changes (e.g. PII remediation re-points primary_dj_id,
  // or an operator edits the handle). Without this, dropping the isNull
  // predicate would silently overwrite correct stored handles.
  test('heal does not overwrite a marker that already has a dj_name (BS#1444)', async () => {
    const LEGACY_SHOW_ID = 9_999_986;
    const SHOW_START_ID = 9_999_983;
    const TRACK_ID = 9_999_982;

    // Show already has a resolvable name when the show_start arrives.
    await seedShow(LEGACY_SHOW_ID, { legacyDjName: 'First Handle' });

    const cleanup = async () => {
      await sql.unsafe(`DELETE FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id IN ($1, $2)`, [SHOW_START_ID, TRACK_ID]);
      await sql.unsafe(`DELETE FROM ${SCHEMA}.shows WHERE legacy_show_id = $1`, [LEGACY_SHOW_ID]);
    };

    try {
      // show_start lands already-named (resolved at insert).
      const startRes = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({
          action: 'create',
          entry: buildEntry({ id: SHOW_START_ID, flowsheetEntryType: 9, radioShowId: LEGACY_SHOW_ID }),
        });
      expect(startRes.status).toBe(200);

      const [startBefore] = await sql.unsafe(`SELECT dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        SHOW_START_ID,
      ]);
      expect(startBefore.dj_name).toBe('First Handle');

      // The show's resolved name changes...
      await sql.unsafe(`UPDATE ${SCHEMA}.shows SET legacy_dj_name = $1 WHERE legacy_show_id = $2`, [
        'Second Handle',
        LEGACY_SHOW_ID,
      ]);

      // ...and a later entry arrives. The heal must leave the already-named
      // show_start alone (its dj_name IS NOT NULL).
      const trackRes = await request
        .post('/internal/flowsheet-webhook')
        .set('X-Internal-Key', INTERNAL_KEY)
        .send({
          action: 'create',
          entry: buildEntry({ id: TRACK_ID, flowsheetEntryType: 6, radioShowId: LEGACY_SHOW_ID }),
        });
      expect(trackRes.status).toBe(200);

      const [startAfter] = await sql.unsafe(`SELECT dj_name FROM ${SCHEMA}.flowsheet WHERE legacy_entry_id = $1`, [
        SHOW_START_ID,
      ]);
      expect(startAfter.dj_name).toBe('First Handle'); // unchanged, not 'Second Handle'
    } finally {
      await cleanup();
    }
  });
});
