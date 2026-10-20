/**
 * Migration 0201 (BS#3452) — extends `specialty_shows` into a real catalog, backfills legacy rows, seeds the nine
 * programs, and adds the watermark and `last_modified` triggers.
 *
 * Two halves. The first reads the real `wxyc_schema.specialty_shows`, which db-init already migrated from empty
 * (production's table is empty too, BS#3476), so it pins the seeds, the constraints and both triggers. The second
 * runs the real migration file, retargeted at a throwaway schema, over a table pre-seeded with legacy rows, which is
 * the only way to exercise the backfill.
 */

const fs = require('fs');
const path = require('path');
const { getTestDb } = require('../utils/db');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'shared',
  'database',
  'src',
  'migrations',
  '0201_specialty-shows-catalog.sql'
);
const TEST_SCHEMA = 'specialty_catalog_backfill_test';

const SEEDS = [
  ['orange-county-special', 'Orange County Special', 'OCS', true, null, [[6, '12:00', 120, 'weekly']]],
  ['hyperlocal', 'HyperLocal', 'HyperLocal', false, 'guest', [[6, '16:00', 60, 'weekly']]],
  ['backyard-bbq', 'Backyard BBQ', 'BYBBQ', false, 'performer', [[6, '16:00', 60, 'some_weeks']]],
  ['sunset-soundtrack', 'Sunset Soundtrack', 'Sunset Soundtrack', true, null, [[6, '19:00', 120, 'weekly']]],
  ['sunday-punk-radio', 'Sunday Punk Radio', 'Sunday Punk Radio', true, null, [[6, '19:00', 120, 'last_of_month']]],
  ['thursday-night-feature', 'Thursday Night Feature', 'TNF', true, null, [[3, '21:00', 180, 'weekly']]],
  ['inside-track', 'Inside Track', 'Inside Track', true, null, [[4, '21:00', 60, 'weekly']]],
  [
    'friday-night-story-hour',
    'Friday Night Story Hour',
    'Story Hour',
    false,
    'reader',
    [[4, '21:00', 60, 'some_weeks']],
  ],
  ['new-science-experience', 'New Science Experience', 'NSE', false, 'dj', [[4, '22:00', 120, 'weekly']]],
].map(([slug, specialty_name, short_name, logs_playcuts, default_spotlight_role, slots]) => ({
  slug,
  specialty_name,
  short_name,
  logs_playcuts,
  default_spotlight_role,
  slots: slots.map(([day, start_time, duration_minutes, cadence]) => ({ day, start_time, duration_minutes, cadence })),
}));

describe('specialty_shows catalog (BS#3452)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  describe('after a fresh migrate', () => {
    test('holds the nine active seed programs', async () => {
      const rows = await sql`
        SELECT slug, specialty_name, short_name, logs_playcuts, default_spotlight_role::text AS default_spotlight_role,
               slots, active, tagline, description, artwork, accent_color
        FROM wxyc_schema.specialty_shows
        WHERE slug = ANY(${SEEDS.map((s) => s.slug)})
        ORDER BY id`;

      expect(rows.map(({ slug }) => slug)).toEqual(SEEDS.map(({ slug }) => slug));
      rows.forEach((row, i) => {
        const { slug, specialty_name, short_name, logs_playcuts, default_spotlight_role, slots } = SEEDS[i];
        expect(row).toMatchObject({ slug, specialty_name, short_name, logs_playcuts, default_spotlight_role, slots });
        expect(row.active).toBe(true);
        expect(row.description).toEqual(expect.any(String));
        expect(row.tagline).toEqual(expect.any(String));
        expect(row.tagline.length).toBeLessThanOrEqual(120);
        expect(row.artwork).toBeNull();
        expect(row.accent_color).toBeNull();
      });
    });

    test('slug and short_name are NOT NULL', async () => {
      const columns = await sql`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'wxyc_schema' AND table_name = 'specialty_shows' AND column_name IN ('slug', 'short_name')`;

      expect(columns.map((c) => c.is_nullable)).toEqual(['NO', 'NO']);
    });

    test('rejects a duplicate slug', async () => {
      await expect(
        sql`INSERT INTO wxyc_schema.specialty_shows (specialty_name, slug, short_name) VALUES ('Dupe', 'hyperlocal', 'Dupe')`
      ).rejects.toMatchObject({ code: '23505' });
    });

    describe('triggers', () => {
      let id;

      beforeAll(async () => {
        [{ id }] = await sql`
          INSERT INTO wxyc_schema.specialty_shows (specialty_name, slug, short_name)
          VALUES ('Trigger Probe', 'trigger-probe', 'Probe') RETURNING id`;
      });

      afterAll(async () => {
        await sql`DELETE FROM wxyc_schema.specialty_shows WHERE id = ${id}`;
      });

      test('an UPDATE moves last_modified', async () => {
        const [{ before }] =
          await sql`SELECT last_modified AS before FROM wxyc_schema.specialty_shows WHERE id = ${id}`;
        await sql`SELECT pg_sleep(0.01)`;
        await sql`UPDATE wxyc_schema.specialty_shows SET tagline = 'moved' WHERE id = ${id}`;
        const [{ after }] = await sql`SELECT last_modified AS after FROM wxyc_schema.specialty_shows WHERE id = ${id}`;

        expect(after.getTime()).toBeGreaterThan(before.getTime());
      });

      test('an UPDATE moves the flowsheet watermark getLastModifiedAt reads', async () => {
        const [{ before }] = await sql`SELECT last_modified_at AS before FROM wxyc_schema.flowsheet_watermark`;
        await sql`UPDATE wxyc_schema.specialty_shows SET tagline = 'moved again' WHERE id = ${id}`;
        const [{ after }] = await sql`SELECT last_modified_at AS after FROM wxyc_schema.flowsheet_watermark`;

        expect(after.getTime()).toBeGreaterThan(before.getTime());
      });
    });
  });

  describe('backfill over a pre-seeded table', () => {
    // The pre-0201 shape of the table, which 0000 created.
    const LEGACY_DDL = `
      CREATE TABLE "${TEST_SCHEMA}".specialty_shows (
        id serial PRIMARY KEY,
        specialty_name varchar(64) NOT NULL,
        description text,
        add_date date DEFAULT now() NOT NULL,
        last_modified timestamptz DEFAULT now() NOT NULL
      )`;

    // The migration reuses 0084's watermark function, so the throwaway schema gets a no-op stand-in.
    const WATERMARK_STUB = `
      CREATE FUNCTION "${TEST_SCHEMA}".touch_flowsheet_watermark() RETURNS trigger AS
      $$ BEGIN RETURN NULL; END; $$ LANGUAGE plpgsql`;

    async function migrate(legacyNames) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
      await sql.unsafe(`CREATE SCHEMA "${TEST_SCHEMA}"`);
      await sql.unsafe(LEGACY_DDL);
      await sql.unsafe(WATERMARK_STUB);
      for (const name of legacyNames) {
        await sql.unsafe(
          `INSERT INTO "${TEST_SCHEMA}".specialty_shows (specialty_name, description) VALUES ($1, 'legacy')`,
          [name]
        );
      }
      const migration = fs.readFileSync(MIGRATION_PATH, 'utf8').replace(/wxyc_schema/g, TEST_SCHEMA);
      await sql.unsafe(migration);
      return sql.unsafe(
        `SELECT id, specialty_name, slug, short_name, description, active FROM "${TEST_SCHEMA}".specialty_shows ORDER BY id`
      );
    }

    afterAll(async () => {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    });

    test('a legacy row matching a seed keeps its id and takes the seed values', async () => {
      const rows = await migrate(['Orange County Special']);

      expect(rows).toHaveLength(9);
      expect(rows[0]).toMatchObject({ id: 1, slug: 'orange-county-special', short_name: 'OCS', active: true });
      expect(rows[0].description).not.toBe('legacy');
    });

    test('a legacy row matching no seed gets a normalized slug and is retired', async () => {
      const rows = await migrate(['  Late Night -- Jazz!! ']);

      expect(rows[0]).toMatchObject({
        id: 1,
        slug: 'late-night-jazz',
        short_name: '  Late Night -- Jazz!! ',
        active: false,
      });
      expect(rows).toHaveLength(10);
    });

    test('legacy rows normalizing to the same slug get the -<id> suffix', async () => {
      const rows = await migrate(['Jazz Hour', 'jazz hour!']);

      expect(rows.slice(0, 2).map((r) => r.slug)).toEqual(['jazz-hour-1', 'jazz-hour-2']);
      expect(rows.slice(0, 2).every((r) => r.active === false)).toBe(true);
    });

    test('of duplicate legacy rows matching a seed, the lowest id takes it and the rest are retired', async () => {
      const rows = await migrate(['Inside Track', 'inside track']);

      expect(rows[0]).toMatchObject({ slug: 'inside-track', active: true });
      expect(rows[1]).toMatchObject({ slug: 'inside-track-2', active: false });
    });
  });
});
