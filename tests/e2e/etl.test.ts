/**
 * ETL E2E Tests
 *
 * Tests the full ETL pipeline: MySQL source -> transform -> PostgreSQL destination.
 * Requires Docker containers for both MySQL (tubafrenzy schema) and PostgreSQL.
 *
 * Prerequisites:
 *   npm run test:etl:env
 *
 * Run:
 *   npm run test:etl
 *
 * The MySQL container is seeded with dev_env/etl-seed.sql (tubafrenzy schema + test data).
 * The PostgreSQL container gets Drizzle migrations + minimal seed (genres/formats only).
 * The ETL jobs populate PostgreSQL from MySQL.
 */

import { execSync } from 'child_process';
import postgres from 'postgres';

const PG_PORT = process.env.ETL_PG_PORT || '5435';
let pg: ReturnType<typeof postgres>;

const SCHEMA = 'wxyc_schema';

const etlEnv = {
  ...process.env,
  DB_HOST: 'localhost',
  DB_PORT: PG_PORT,
  DB_NAME: 'etldb',
  DB_USERNAME: 'etluser',
  DB_PASSWORD: 'etltest',
  LEGACY_DB_DOCKER_CONTAINER: 'dev_env-etl-mysql-1',
  REMOTE_DB_USER: 'etluser',
  REMOTE_DB_PASSWORD: 'etltest',
  REMOTE_DB_NAME: 'wxycmusic',
};

const runETL = (jobPath: string, jobName: string) => {
  // Clear last_run to force a full import
  execSync(
    `psql "postgres://etluser:etltest@localhost:${PG_PORT}/etldb" -c "DELETE FROM ${SCHEMA}.cronjob_runs WHERE job_name = '${jobName}'"`,
    { stdio: 'pipe' }
  );
  execSync(`npx tsx ${jobPath}`, {
    env: etlEnv,
    cwd: process.cwd(),
    stdio: 'pipe',
    timeout: 60000,
  });
};

beforeAll(async () => {
  pg = postgres(`postgres://etluser:etltest@localhost:${PG_PORT}/etldb`, { max: 1 });
  const result = await pg`SELECT 1 AS ok`;
  expect(result[0].ok).toBe(1);
});

afterAll(async () => {
  await pg.end();
});

// ---- Library ETL ----

describe('Library ETL', () => {
  beforeAll(() => {
    runETL('jobs/library-etl/job.ts', 'library-etl');
  });

  it('imports artists from LIBRARY_CODE', async () => {
    const rows = await pg`SELECT artist_name FROM ${pg(SCHEMA)}.artists`;
    const names = rows.map((r: any) => r.artist_name);
    expect(names).toContain('Autechre');
    expect(names).toContain('Cat Power');
    expect(names).toContain('Various Artists');
    expect(names).toContain('Large Professor');
  });

  it('imports albums with legacy_release_id', async () => {
    const rows = await pg`SELECT album_title, legacy_release_id FROM ${pg(SCHEMA)}.library`;
    expect(rows.length).toBeGreaterThanOrEqual(7);

    const confield = rows.find((r: any) => r.album_title === 'Confield');
    expect(confield).toBeDefined();
    expect(confield.legacy_release_id).toBe(101);
  });

  it('skips releases with db_only genre', async () => {
    const rows = await pg`SELECT album_title FROM ${pg(SCHEMA)}.library WHERE album_title = 'Internal Only'`;
    expect(rows.length).toBe(0);
  });

  it('imports date_lost for missing releases', async () => {
    const rows =
      await pg`SELECT album_title, date_lost, date_found FROM ${pg(SCHEMA)}.library WHERE date_lost IS NOT NULL`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const compilation = rows.find((r: any) => r.album_title === 'Dada Damage: A Night People Compilation');
    expect(compilation).toBeDefined();
    expect(compilation.date_lost).toBeInstanceOf(Date);
    expect(compilation.date_found).toBeNull();
  });

  it('imports date_found for recovered releases', async () => {
    const rows = await pg`SELECT date_lost, date_found FROM ${pg(SCHEMA)}.library WHERE album_title = '1st Class'`;
    expect(rows.length).toBe(1);
    expect(rows[0].date_lost).toBeInstanceOf(Date);
    expect(rows[0].date_found).toBeInstanceOf(Date);
    expect(rows[0].date_found.getTime()).toBeGreaterThan(rows[0].date_lost.getTime());
  });

  it('imports compilation track artists', async () => {
    const rows = await pg`SELECT artist_name, track_title, track_position FROM ${pg(SCHEMA)}.compilation_track_artist`;
    expect(rows.length).toBeGreaterThanOrEqual(3);

    const names = rows.map((r: any) => r.artist_name);
    expect(names).toContain('Sharp Pins');
    expect(names).toContain('Naked on the Vague');

    const sharpPins = rows.find((r: any) => r.artist_name === 'Sharp Pins');
    expect(sharpPins.track_title).toBe('You Turned off the Light');
    expect(sharpPins.track_position).toBe('A1');
  });

  it('imports artist cross-references', async () => {
    const rows = await pg`SELECT COUNT(*)::int AS count FROM ${pg(SCHEMA)}.artist_crossreference`;
    expect(rows[0].count).toBeGreaterThanOrEqual(1);
  });

  it('imports genre-artist cross-references', async () => {
    const rows = await pg`SELECT COUNT(*)::int AS count FROM ${pg(SCHEMA)}.genre_artist_crossreference`;
    expect(rows[0].count).toBeGreaterThanOrEqual(7);
  });

  it('records the last run timestamp', async () => {
    const rows = await pg`SELECT last_run FROM ${pg(SCHEMA)}.cronjob_runs WHERE job_name = 'library-etl'`;
    expect(rows.length).toBe(1);
    expect(rows[0].last_run).toBeInstanceOf(Date);
  });
});

// ---- Flowsheet ETL ----

describe('Flowsheet ETL', () => {
  beforeAll(() => {
    runETL('jobs/flowsheet-etl/job.ts', 'flowsheet-etl');
  });

  it('imports shows with show_name', async () => {
    const rows = await pg`SELECT legacy_show_id, show_name, start_time, end_time FROM ${pg(SCHEMA)}.shows`;
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const bluejayShow = rows.find((r: any) => r.legacy_show_id === 1001);
    expect(bluejayShow).toBeDefined();
    expect(bluejayShow.show_name).toBe('The Nest');
    expect(bluejayShow.start_time).toBeInstanceOf(Date);
    expect(bluejayShow.end_time).toBeInstanceOf(Date);
  });

  it('imports show with null end_time (active show)', async () => {
    const rows = await pg`SELECT end_time FROM ${pg(SCHEMA)}.shows WHERE legacy_show_id = 1002`;
    expect(rows.length).toBe(1);
    expect(rows[0].end_time).toBeNull();
  });

  it('imports all flowsheet entries', async () => {
    const rows = await pg`SELECT COUNT(*)::int AS count FROM ${pg(SCHEMA)}.flowsheet`;
    expect(rows[0].count).toBeGreaterThanOrEqual(10);
  });

  it('maps entry types correctly', async () => {
    const entries = await pg`SELECT legacy_entry_id, entry_type FROM ${pg(SCHEMA)}.flowsheet ORDER BY legacy_entry_id`;

    const byId = (id: number) => entries.find((e: any) => e.legacy_entry_id === id);
    expect(byId(2001).entry_type).toBe('show_start');
    expect(byId(2002).entry_type).toBe('track'); // LIBRARY (6)
    expect(byId(2004).entry_type).toBe('talkset'); // TALKSET (7)
    expect(byId(2006).entry_type).toBe('breakpoint'); // HOURLY_BREAK (8)
    expect(byId(2007).entry_type).toBe('track'); // HEAVY (1) -> track
    expect(byId(2008).entry_type).toBe('show_end'); // END_OF_SHOW (10)
    expect(byId(2010).entry_type).toBe('track'); // OTHER (0) -> track
  });

  it('parses DJ name from show_start/show_end entries', async () => {
    const entries =
      await pg`SELECT legacy_entry_id, artist_name FROM ${pg(SCHEMA)}.flowsheet WHERE entry_type IN ('show_start', 'show_end')`;

    const byId = (id: number) => entries.find((e: any) => e.legacy_entry_id === id);
    expect(byId(2001).artist_name).toBe('DJ Bluejay');
    expect(byId(2008).artist_name).toBe('DJ Bluejay');
    expect(byId(2009).artist_name).toBe('dj wilde');
  });

  it('imports segue flag', async () => {
    const entries =
      await pg`SELECT legacy_entry_id, segue FROM ${pg(SCHEMA)}.flowsheet WHERE legacy_entry_id IN (2002, 2003)`;
    const byId = (id: number) => entries.find((e: any) => e.legacy_entry_id === id);
    expect(byId(2003).segue).toBe(true);
    expect(byId(2002).segue).toBe(false);
  });

  it('imports request flag', async () => {
    const entries =
      await pg`SELECT legacy_entry_id, request_flag FROM ${pg(SCHEMA)}.flowsheet WHERE legacy_entry_id IN (2002, 2005)`;
    const byId = (id: number) => entries.find((e: any) => e.legacy_entry_id === id);
    expect(byId(2005).request_flag).toBe(true);
    expect(byId(2002).request_flag).toBe(false);
  });

  it('maps show_id via legacy_show_id', async () => {
    const showRows = await pg`SELECT id, legacy_show_id FROM ${pg(SCHEMA)}.shows`;
    const entries =
      await pg`SELECT legacy_entry_id, show_id FROM ${pg(SCHEMA)}.flowsheet WHERE legacy_entry_id IN (2002, 2010)`;

    const bluejayShow = showRows.find((s: any) => s.legacy_show_id === 1001);
    const wildeShow = showRows.find((s: any) => s.legacy_show_id === 1002);

    const byId = (id: number) => entries.find((e: any) => e.legacy_entry_id === id);
    expect(byId(2002).show_id).toBe(bluejayShow.id);
    expect(byId(2010).show_id).toBe(wildeShow.id);
  });

  it('imports track metadata', async () => {
    const rows =
      await pg`SELECT artist_name, album_title, track_title, record_label FROM ${pg(SCHEMA)}.flowsheet WHERE legacy_entry_id = 2002`;
    expect(rows[0].artist_name).toBe('Autechre');
    expect(rows[0].album_title).toBe('Confield');
    expect(rows[0].track_title).toBe('VI Scose Poise');
    expect(rows[0].record_label).toBe('Warp');
  });

  it('records the last run timestamp', async () => {
    const rows = await pg`SELECT last_run FROM ${pg(SCHEMA)}.cronjob_runs WHERE job_name = 'flowsheet-etl'`;
    expect(rows.length).toBe(1);
    expect(rows[0].last_run).toBeInstanceOf(Date);
  });
});
