/**
 * `GET`/`PATCH`/`DELETE /labels/{id}` (BS#3289), against real migrations: the per-source reference counts, a rename that
 * rewrites the name copies beside every `label_id` in one transaction, re-parenting with cycle refusal, and a delete the
 * server refuses (409 with the counts) while any foreign key or child label points at the row. The route gating and the
 * input validation are pinned by `tests/unit/routes/labels.route.test.ts`.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  managerAccessToken,
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-LABELS';
const NO_REFS = { library: 0, rotation: 0, flowsheet: 0, intake_items: 0 };

describe('/labels/{id} (BS#3289)', () => {
  let auth;
  let sql;
  let counter = 0;

  const cleanup = async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE artist_name LIKE ${`${PREFIX}%`}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE artist_name LIKE ${`${PREFIX}%`}`;
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
    await sql`DELETE FROM ${sql(SCHEMA)}.labels WHERE label_name LIKE ${`${PREFIX}%`}`;
  };

  /** A label named for this run, optionally under a parent. */
  const newLabel = async (parentId = null, name = `${PREFIX} ${Date.now()}-${counter++}`) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.labels (label_name, parent_label_id) VALUES (${name}, ${parentId}) RETURNING *`;
    return row;
  };

  const newRotation = async (labelId, recordLabel) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (rotation_bin, artist_name, album_title, record_label, label_id)
      VALUES ('H', ${`${PREFIX} artist`}, ${`${PREFIX} album`}, ${recordLabel}, ${labelId}) RETURNING id`;
    return row.id;
  };

  /** One row of each source pointing at `label`, each carrying the old name as its text copy except `bareRotationId`. */
  const referenceEverywhere = async (label) => {
    const library = await seedLibraryRelease({ label: label.label_name, label_id: label.id });
    const copiedRotationId = await newRotation(label.id, label.label_name);
    const bareRotationId = await newRotation(label.id, null);
    const [flowsheet] = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, artist_name, record_label, label_id)
      VALUES ('track', 1,${`${PREFIX} artist`}, ${label.label_name}, ${label.id}) RETURNING id`;
    const intake = await seedIntakeItem({ record_label: label.label_name, label_id: label.id });
    return { library, copiedRotationId, bareRotationId, flowsheet, intake };
  };

  const textCopies = async (ids) => {
    const [[lib], [rot], [bare], [fs], [intake]] = await Promise.all([
      sql`SELECT label FROM ${sql(SCHEMA)}.library WHERE id = ${ids.library.id}`,
      sql`SELECT record_label FROM ${sql(SCHEMA)}.rotation WHERE id = ${ids.copiedRotationId}`,
      sql`SELECT record_label FROM ${sql(SCHEMA)}.rotation WHERE id = ${ids.bareRotationId}`,
      sql`SELECT record_label FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${ids.flowsheet.id}`,
      sql`SELECT record_label FROM ${sql(SCHEMA)}.intake_items WHERE id = ${ids.intake.id}`,
    ]);
    return [lib.label, rot.record_label, bare.record_label, fs.record_label, intake.record_label];
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  describe('GET /labels/{id}', () => {
    test('returns the label with zero counts when nothing references it', async () => {
      const label = await newLabel();
      const res = await auth.get(`/labels/${label.id}`).expect(200);
      expect(res.body).toEqual({ ...label, references: NO_REFS, child_labels: 0 });
    });

    test('counts each source separately, and child labels', async () => {
      const label = await newLabel();
      await referenceEverywhere(label);
      await newLabel(label.id);
      const res = await auth.get(`/labels/${label.id}`).expect(200);
      expect(res.body.references).toEqual({ library: 1, rotation: 2, flowsheet: 1, intake_items: 1 });
      expect(res.body.child_labels).toBe(1);
    });

    test('is a 404 for an absent label and a 400 for a malformed id', async () => {
      await auth.get('/labels/2147483000').expect(404);
      await auth.get('/labels/not-a-number').expect(400);
    });
  });

  describe('PATCH /labels/{id}: rename', () => {
    test('rewrites the non-null name copies beside every label_id and reports the counts', async () => {
      const label = await newLabel();
      const ids = await referenceEverywhere(label);
      const newName = `${label.label_name} renamed`;

      const res = await auth.patch(`/labels/${label.id}`).send({ label_name: newName }).expect(200);

      expect(res.body.label).toEqual({ ...label, label_name: newName });
      expect(res.body.rewritten).toEqual({ library: 1, rotation: 1, flowsheet: 1, intake_items: 1 });
      expect(await textCopies(ids)).toEqual([newName, newName, null, newName, newName]);
    });

    test('rewrites nothing and reports zeros when the name is unchanged', async () => {
      const label = await newLabel();
      await referenceEverywhere(label);
      const res = await auth.patch(`/labels/${label.id}`).send({ label_name: label.label_name }).expect(200);
      expect(res.body.rewritten).toEqual(NO_REFS);
    });

    test('is one transaction: a failing text rewrite rolls the rename and the earlier rewrites back', async () => {
      const label = await newLabel();
      const ids = await referenceEverywhere(label);
      const poison = `${PREFIX} poison ${Date.now()}`;
      // rotation is rewritten after library, so library.label has been updated when this raises.
      await sql.unsafe(`
        CREATE FUNCTION "${SCHEMA}".itest_labels_poison() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'itest poison'; END $$;
        CREATE TRIGGER itest_labels_poison BEFORE UPDATE ON "${SCHEMA}".rotation
          FOR EACH ROW WHEN (NEW.record_label = '${poison}') EXECUTE FUNCTION "${SCHEMA}".itest_labels_poison();`);
      try {
        await auth.patch(`/labels/${label.id}`).send({ label_name: poison }).expect(500);
      } finally {
        await sql.unsafe(`DROP TRIGGER itest_labels_poison ON "${SCHEMA}".rotation;
                          DROP FUNCTION "${SCHEMA}".itest_labels_poison();`);
      }
      const [current] = await sql`SELECT label_name FROM ${sql(SCHEMA)}.labels WHERE id = ${label.id}`;
      expect(current.label_name).toBe(label.label_name);
      expect(await textCopies(ids)).toEqual([
        label.label_name,
        label.label_name,
        null,
        label.label_name,
        label.label_name,
      ]);
    });

    test('is a 409 label_name_taken, pointing at merge, when another label has the name', async () => {
      const label = await newLabel();
      const other = await newLabel();
      const res = await auth.patch(`/labels/${label.id}`).send({ label_name: other.label_name }).expect(409);
      expect(res.body.code).toBe('label_name_taken');
      expect(res.body.message).toMatch(/merge/);
      const [current] = await sql`SELECT label_name FROM ${sql(SCHEMA)}.labels WHERE id = ${label.id}`;
      expect(current.label_name).toBe(label.label_name);
    });

    test('is a 404 for an absent label', async () => {
      await auth
        .patch('/labels/2147483000')
        .send({ label_name: `${PREFIX} nobody` })
        .expect(404);
    });
  });

  describe('PATCH /labels/{id}: re-parent', () => {
    test('sets and clears the parent', async () => {
      const parent = await newLabel();
      const child = await newLabel();
      const set = await auth.patch(`/labels/${child.id}`).send({ parent_label_id: parent.id }).expect(200);
      expect(set.body.label.parent_label_id).toBe(parent.id);
      expect(set.body.rewritten).toEqual(NO_REFS);
      const cleared = await auth.patch(`/labels/${child.id}`).send({ parent_label_id: null }).expect(200);
      expect(cleared.body.label.parent_label_id).toBeNull();
    });

    test('refuses a label as its own parent and as a descendant’s child, and changes nothing', async () => {
      const grandparent = await newLabel();
      const parent = await newLabel(grandparent.id);
      const child = await newLabel(parent.id);

      const self = await auth.patch(`/labels/${grandparent.id}`).send({ parent_label_id: grandparent.id }).expect(400);
      expect(self.body.code).toBe('label_parent_cycle');
      const loop = await auth.patch(`/labels/${grandparent.id}`).send({ parent_label_id: child.id }).expect(400);
      expect(loop.body.code).toBe('label_parent_cycle');

      const [row] = await sql`SELECT parent_label_id FROM ${sql(SCHEMA)}.labels WHERE id = ${grandparent.id}`;
      expect(row.parent_label_id).toBeNull();
    });

    test('refuses a parent that is no label', async () => {
      const label = await newLabel();
      const res = await auth.patch(`/labels/${label.id}`).send({ parent_label_id: 2147483000 }).expect(400);
      expect(res.body.code).toBe('unknown_reference');
    });
  });

  describe('DELETE /labels/{id}', () => {
    test('deletes an unreferenced label with a 204', async () => {
      const label = await newLabel();
      await auth.delete(`/labels/${label.id}`).expect(204);
      const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.labels WHERE id = ${label.id}`;
      expect(rows).toHaveLength(0);
    });

    test('is a 404 for an absent label', async () => {
      await auth.delete('/labels/2147483000').expect(404);
    });

    test.each([
      ['library', (label) => seedLibraryRelease({ label_id: label.id }), { library: 1 }],
      ['rotation', (label) => newRotation(label.id, null), { rotation: 1 }],
      [
        'flowsheet',
        (label) =>
          sql`INSERT INTO ${sql(SCHEMA)}.flowsheet (entry_type, play_order, artist_name, label_id) VALUES ('track', 1,${`${PREFIX} artist`}, ${label.id})`,
        { flowsheet: 1 },
      ],
      ['intake_items', (label) => seedIntakeItem({ label_id: label.id }), { intake_items: 1 }],
    ])('is a 409 label_in_use with the counts while a %s row references it', async (_source, reference, expected) => {
      const label = await newLabel();
      await reference(label);
      const res = await auth.delete(`/labels/${label.id}`).expect(409);
      expect(res.body.code).toBe('label_in_use');
      expect(res.body.details).toEqual({ references: { ...NO_REFS, ...expected }, child_labels: 0 });
      const rows = await sql`SELECT id FROM ${sql(SCHEMA)}.labels WHERE id = ${label.id}`;
      expect(rows).toHaveLength(1);
    });

    test('is a 409 label_in_use while a child label names it as parent', async () => {
      const label = await newLabel();
      await newLabel(label.id);
      const res = await auth.delete(`/labels/${label.id}`).expect(409);
      expect(res.body.details).toEqual({ references: NO_REFS, child_labels: 1 });
    });

    test('does not text-match rotation.record_label: a row whose label never resolved does not block', async () => {
      const label = await newLabel();
      await newRotation(null, label.label_name);
      await auth.delete(`/labels/${label.id}`).expect(204);
    });
  });
});
