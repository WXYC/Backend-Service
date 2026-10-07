const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * The legacy review-gate bases (BS#2810, slice 16 of #2791): `POST /library` with `from_rotation_id` and the typed-text
 * arm of `POST /library/rotation` with `moved_from_rotation_id`. The shared integration backend never sets
 * `REVIEW_GATE_CUTOVER_DATE`, so every unlinked row is legacy here; the date rule is covered by unit tests. What only
 * Postgres can show is the concurrency: two requests naming one row must leave exactly one new row behind.
 */
describe('legacy rotation rows: import and move (BS#2810)', () => {
  let auth;
  let sql;
  const createdRotationIds = [];
  const createdFlowsheetIds = [];
  const runId = Date.now();

  beforeAll(() => {
    auth = createAuthRequest(request, global.access_token);
    sql = getTestDb();
  });

  afterAll(async () => {
    if (createdFlowsheetIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${createdFlowsheetIds})`;
    }
    if (createdRotationIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${createdRotationIds})`;
    }
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  const typedRow = async (suffix, bin = 'L') => {
    const res = await auth
      .post('/library/rotation')
      .send({ rotation_bin: bin, artist_name: 'Juana Molina', album_title: `Legacy ${runId} ${suffix}` })
      .expect(201);
    createdRotationIds.push(res.body.id);
    return res.body;
  };

  const importBody = (title, rotationId, label = 'Sonamos') => ({
    album_title: title,
    artist_name: 'Built to Spill',
    label,
    genre_id: 11,
    format_id: 1,
    from_rotation_id: rotationId,
  });

  const moveBody = (row, bin) => ({
    rotation_bin: bin,
    artist_name: row.artist_name,
    album_title: row.album_title,
    moved_from_rotation_id: row.id,
  });

  const rotationRow = async (id) => (await sql`SELECT * FROM ${sql(SCHEMA)}.rotation WHERE id = ${id}`)[0];
  const libraryCount = async (title) =>
    (await sql`SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.library WHERE album_title = ${title}`)[0].n;

  describe('POST /library with from_rotation_id', () => {
    test('creates the release, links the row, and re-points the plays logged against it', async () => {
      const row = await typedRow('import');
      const [play] = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet (play_order, entry_type, artist_name, album_title, track_title, rotation_id)
        VALUES (99996, 'track', 'Juana Molina', ${row.album_title}, 'la paradoja', ${row.id})
        RETURNING id`;
      createdFlowsheetIds.push(play.id);

      const res = await auth
        .post('/library')
        .send(importBody(`Imported ${runId}`, row.id))
        .expect(201);

      expect((await rotationRow(row.id)).album_id).toBe(res.body.id);
      const [linkedPlay] = await sql`SELECT album_id FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${play.id}`;
      expect(linkedPlay.album_id).toBe(res.body.id);
    });

    test('imports a killed row: rotation records reach the librarian after their kill date', async () => {
      const row = await typedRow('killed-import');
      await auth.patch('/library/rotation').send({ rotation_id: row.id, kill_date: '2020-01-01' }).expect(200);

      const res = await auth
        .post('/library')
        .send(importBody(`Imported killed ${runId}`, row.id))
        .expect(201);

      expect((await rotationRow(row.id)).album_id).toBe(res.body.id);
    });

    test('refuses a second import of a linked row with 409 and writes nothing, not even a label', async () => {
      const row = await typedRow('second-import');
      await auth
        .post('/library')
        .send(importBody(`Imported twice ${runId}`, row.id))
        .expect(201);
      const label = `Legacy Label ${runId}`;

      const res = await auth
        .post('/library')
        .send(importBody(`Imported twice again ${runId}`, row.id, label))
        .expect(409);

      expect(res.body.reason).toBe('rotation_not_eligible');
      expect(await libraryCount(`Imported twice again ${runId}`)).toBe(0);
      const labels = await sql`SELECT id FROM ${sql(SCHEMA)}.labels WHERE label_name = ${label}`;
      expect(labels).toHaveLength(0);
    });

    test('refuses a row that does not exist', async () => {
      const res = await auth
        .post('/library')
        .send(importBody(`Imported ghost ${runId}`, 987654321))
        .expect(409);

      expect(res.body.reason).toBe('rotation_not_eligible');
      expect(await libraryCount(`Imported ghost ${runId}`)).toBe(0);
    });

    test('two concurrent imports of one row create exactly one library row', async () => {
      const row = await typedRow('concurrent-import');
      const title = `Imported concurrently ${runId}`;

      const results = await Promise.all([
        auth.post('/library').send(importBody(title, row.id)),
        auth.post('/library').send(importBody(title, row.id)),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await libraryCount(title)).toBe(1);
    });
  });

  describe('POST /library/rotation with moved_from_rotation_id', () => {
    test('adds the row in the target bin and kills the source in the same request', async () => {
      const source = await typedRow('move', 'L');

      const res = await auth.post('/library/rotation').send(moveBody(source, 'M')).expect(201);
      createdRotationIds.push(res.body.id);

      expect((await rotationRow(res.body.id)).moved_from_rotation_id).toBe(source.id);
      expect(res.body.rotation_bin).toBe('M');
      const [killed] = await sql`
        SELECT kill_date = CURRENT_DATE AS killed_today FROM ${sql(SCHEMA)}.rotation WHERE id = ${source.id}`;
      expect(killed.killed_today).toBe(true);
    });

    test('refuses a second move from the same source, and a move from a linked row, writing nothing', async () => {
      const source = await typedRow('second-move');
      const first = await auth.post('/library/rotation').send(moveBody(source, 'M')).expect(201);
      createdRotationIds.push(first.body.id);

      const second = await auth.post('/library/rotation').send(moveBody(source, 'H')).expect(409);
      expect(second.body.reason).toBe('rotation_not_eligible');

      const linked = await typedRow('linked-move');
      await auth
        .post('/library')
        .send(importBody(`Linked then moved ${runId}`, linked.id))
        .expect(201);
      const third = await auth.post('/library/rotation').send(moveBody(linked, 'M')).expect(409);
      expect(third.body.reason).toBe('rotation_not_eligible');

      const moved = await sql`
        SELECT id FROM ${sql(SCHEMA)}.rotation WHERE moved_from_rotation_id = ANY(${[source.id, linked.id]})`;
      expect(moved.map((r) => r.id)).toEqual([first.body.id]);
    });

    test('two concurrent moves of one row create exactly one new row', async () => {
      const source = await typedRow('concurrent-move');

      const results = await Promise.all([
        auth.post('/library/rotation').send(moveBody(source, 'M')),
        auth.post('/library/rotation').send(moveBody(source, 'H')),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const created = results.find((r) => r.status === 201);
      createdRotationIds.push(created.body.id);
      const moved = await sql`
        SELECT id FROM ${sql(SCHEMA)}.rotation WHERE moved_from_rotation_id = ${source.id}`;
      expect(moved).toHaveLength(1);
    });
  });
});
