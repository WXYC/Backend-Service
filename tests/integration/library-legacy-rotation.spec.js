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

  describe("a moved record's chain is one record (BS#3007)", () => {
    /** Three rows linked by `moved_from_rotation_id`, oldest first; the older two were killed by their moves. */
    const movedChain = async (suffix) => {
      const first = await typedRow(suffix, 'L');
      const second = await auth.post('/library/rotation').send(moveBody(first, 'M')).expect(201);
      createdRotationIds.push(second.body.id);
      const third = await auth.post('/library/rotation').send(moveBody(second.body, 'H')).expect(201);
      createdRotationIds.push(third.body.id);
      return [first, second.body, third.body];
    };
    const albumIds = async (rows) =>
      (await sql`SELECT album_id FROM ${sql(SCHEMA)}.rotation WHERE id = ANY(${rows.map((r) => r.id)})`).map(
        (r) => r.album_id
      );

    test('imports the newest row, and links every row in the chain to the one release', async () => {
      const chain = await movedChain('chain-import');
      const title = `Imported chain ${runId}`;

      // A play logged while the record sat in the oldest bin.
      const [play] = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet (play_order, entry_type, artist_name, album_title, track_title, rotation_id)
        VALUES (99995, 'track', 'Juana Molina', ${chain[0].album_title}, 'la paradoja', ${chain[0].id})
        RETURNING id`;
      createdFlowsheetIds.push(play.id);

      const res = await auth.post('/library').send(importBody(title, chain[2].id)).expect(201);

      expect(await libraryCount(title)).toBe(1);
      expect(await albumIds(chain)).toEqual([res.body.id, res.body.id, res.body.id]);
      const [linkedPlay] = await sql`SELECT album_id FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${play.id}`;
      expect(linkedPlay.album_id).toBe(res.body.id);
    });

    test('refuses a moved-away row on import with 409 and writes nothing, not even a label', async () => {
      const chain = await movedChain('chain-old-import');
      const label = `Chain Label ${runId}`;

      const res = await auth
        .post('/library')
        .send(importBody(`Imported old row ${runId}`, chain[0].id, label))
        .expect(409);

      expect(res.body.reason).toBe('rotation_not_eligible');
      expect(await libraryCount(`Imported old row ${runId}`)).toBe(0);
      expect(await sql`SELECT id FROM ${sql(SCHEMA)}.labels WHERE label_name = ${label}`).toHaveLength(0);
      expect(await albumIds(chain)).toEqual([null, null, null]);
    });

    test('imports the newest row after an ancestor was linked, leaving that ancestor alone', async () => {
      const chain = await movedChain('chain-linked-ancestor');
      // Old data: a row the chain was moved from, already linked by an import before moves shared a release.
      const earlier = await typedRow('chain-earlier');
      const earlierRelease = await auth
        .post('/library')
        .send(importBody(`Imported earlier ${runId}`, earlier.id))
        .expect(201);
      await sql`UPDATE ${sql(SCHEMA)}.rotation SET moved_from_rotation_id = ${earlier.id} WHERE id = ${chain[0].id}`;

      const res = await auth
        .post('/library')
        .send(importBody(`Imported over linked ${runId}`, chain[2].id))
        .expect(201);

      expect(await albumIds(chain)).toEqual([res.body.id, res.body.id, res.body.id]);
      expect((await rotationRow(earlier.id)).album_id).toBe(earlierRelease.body.id);
    });

    test('an import and a move of one row at once leave one winner: a release or a successor, never both', async () => {
      const row = await typedRow('chain-import-vs-move');
      const title = `Imported against a move ${runId}`;

      const [imported, moved] = await Promise.all([
        auth.post('/library').send(importBody(title, row.id)),
        auth.post('/library/rotation').send(moveBody(row, 'M')),
      ]);
      if (moved.status === 201) createdRotationIds.push(moved.body.id);

      expect([imported.status, moved.status].sort()).toEqual([201, 409]);
      const successors = await sql`SELECT id FROM ${sql(SCHEMA)}.rotation WHERE moved_from_rotation_id = ${row.id}`;
      expect(successors).toHaveLength(moved.status === 201 ? 1 : 0);
      expect(await libraryCount(title)).toBe(imported.status === 201 ? 1 : 0);
    });

    test('PATCH /library/rotation/{id}/link refuses a moved-away row, and the newest row links its ancestors', async () => {
      const chain = await movedChain('chain-link');
      // A release to link to: the one a plain import of an unrelated row makes.
      const target = await typedRow('chain-link-target');
      const made = await auth
        .post('/library')
        .send(importBody(`Link target ${runId}`, target.id))
        .expect(201);

      const movedAway = await auth
        .patch(`/library/rotation/${chain[0].id}/link`)
        .send({ album_id: made.body.id })
        .expect(409);
      expect(movedAway.body.message).toBe(
        'This rotation entry was moved to another bin. Link the entry in its current bin instead.'
      );
      expect(await albumIds(chain)).toEqual([null, null, null]);

      await auth.patch(`/library/rotation/${chain[2].id}/link`).send({ album_id: made.body.id }).expect(200);
      expect(await albumIds(chain)).toEqual([made.body.id, made.body.id, made.body.id]);
    });

    test('imports a chain whose newest row was killed at the end of its run, and links the whole chain', async () => {
      const chain = await movedChain('chain-killed-newest');
      // Killed by its rotation time ending, not by a move: nothing names it in `moved_from_rotation_id`.
      await auth.patch('/library/rotation').send({ rotation_id: chain[2].id, kill_date: '2020-01-01' }).expect(200);
      const title = `Imported killed newest ${runId}`;

      const res = await auth.post('/library').send(importBody(title, chain[2].id)).expect(201);

      expect(await libraryCount(title)).toBe(1);
      expect(await albumIds(chain)).toEqual([res.body.id, res.body.id, res.body.id]);
    });

    test('GET /library/rotation/uncatalogued lists the newest row of a chain and none of the moved-away rows', async () => {
      const chain = await movedChain('chain-queue');
      const queuedIds = async (status) => {
        const res = await auth.get(`/library/rotation/uncatalogued?status=${status}&limit=500`).expect(200);
        return res.body.map((row) => row.id);
      };

      // The older two were killed by their moves, today; the newest is active.
      for (const status of ['all', 'active']) {
        const ids = await queuedIds(status);
        expect(ids).toContain(chain[2].id);
        expect(ids).not.toContain(chain[0].id);
        expect(ids).not.toContain(chain[1].id);
      }

      // Killed at the end of its run (yesterday, so it sorts just behind today's kills in `kill_date DESC` order inside
      // the 500-row window), the newest row joins the killed queue; the moved-away rows, killed today, stay out of it.
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await auth.patch('/library/rotation').send({ rotation_id: chain[2].id, kill_date: yesterday }).expect(200);
      for (const status of ['all', 'killed']) {
        const ids = await queuedIds(status);
        expect(ids).toContain(chain[2].id);
        expect(ids).not.toContain(chain[0].id);
        expect(ids).not.toContain(chain[1].id);
      }
    });
  });
});
