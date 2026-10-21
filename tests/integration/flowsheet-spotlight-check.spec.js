/**
 * Integration test: the flowsheet `spotlight` entry type, its `spotlight_role` / `spotlight_name` columns, and the
 * `flowsheet_spotlight_columns_check` CHECK (BS#3458), against real Postgres.
 *
 * The CHECK is added NOT VALID (validated out of band, BS#3478), which still enforces every new INSERT and UPDATE; that
 * is what these cases exercise.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker tier).
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const NAME_PREFIX = 'bs3458:';

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

describe('flowsheet spotlight columns and CHECK (BS#3458)', () => {
  let sql;
  let showId;

  const insertRow = (entryType, role, name) => sql`
    INSERT INTO ${sql(SCHEMA)}.flowsheet
      (show_id, entry_type, artist_name, album_title, track_title, message, spotlight_role, spotlight_name, play_order)
    VALUES (
      ${showId}, ${entryType}, '', '', '', ${'BS3458 probe'},
      ${role}::${sql(SCHEMA)}.spotlight_role, ${name}, ${0}
    )
    RETURNING id`;

  beforeAll(async () => {
    sql = makeSql();
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (show_name, start_time, end_time)
      VALUES (${NAME_PREFIX + 'a'}, ${'2099-04-01 14:00:00+00'}::timestamptz, NULL)
      RETURNING id`;
    showId = row.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ${showId}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}`;
    await sql.end();
  });

  test('the CHECK exists and is deliberately left not validated', async () => {
    const [row] = await sql`
      SELECT c.convalidated
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.conname = 'flowsheet_spotlight_columns_check' AND n.nspname = ${SCHEMA}`;
    expect(row).toBeDefined();
    expect(row.convalidated).toBe(false);
  });

  test('accepts a spotlight row carrying a role and a name', async () => {
    const [row] = await insertRow('spotlight', 'host', 'Test Host');
    expect(row.id).toBeDefined();
  });

  test.each([
    ['a role but no name', 'host', null],
    ['a name but no role', null, 'Test Host'],
    ['neither a role nor a name', null, null],
  ])('rejects a spotlight row with %s', async (_label, role, name) => {
    await expect(insertRow('spotlight', role, name)).rejects.toMatchObject({ code: '23514' });
  });

  // The CHECK as specified ties the pair to the type only when both are set: a track row carrying just one column
  // satisfies `false = false` and is not rejected. Only a track row carrying both is.
  test('rejects a track row carrying both a role and a name', async () => {
    await expect(insertRow('track', 'host', 'Test Host')).rejects.toMatchObject({ code: '23514' });
  });

  test('accepts a track row with neither column', async () => {
    const [row] = await insertRow('track', null, null);
    expect(row.id).toBeDefined();
  });
});
