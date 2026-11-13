/**
 * BS#3792 (plan BS#3790) -- `library_discogs_release_change` and `library_discogs_release_change_before` against a
 * real Postgres. The unit tier (`tests/unit/database/schema.library-discogs-release-change.test.ts`) pins the declared
 * shape; this spec pins the behaviour the release picker leans on:
 *
 *   - an INSERT into the change table fires `cdc`, the signal every Backend instance clears its lookup caches on,
 *   - the before table fires nothing, so its large jsonb never meets `pg_notify`'s size limit,
 *   - `album_id` and `actor_user_id` carry no foreign key, so a change row can name rows that no longer exist,
 *   - the before row needs its change row and is deleted with it,
 *   - `new_discogs_release_id` must be positive.
 *
 * Every row is removed in `afterEach`, keyed by the probe actor id. Same LISTEN/NOTIFY pattern as
 * `cta-track-artist-link-cdc.spec.js`.
 */

const postgres = require('postgres');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const ACTOR = 'bs3792-schema-probe';
// Far above any id the integration fixture seeds, so no library row has it.
const MISSING_ID = 2_000_000_000;

async function waitForEvent(events, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('library_discogs_release_change (real PG)', () => {
  let sql;
  let listenConn;
  const cdcEvents = [];

  const insertChange = (newReleaseId = 530321) => sql`
    INSERT INTO ${sql(SCHEMA)}.library_discogs_release_change
      (album_id, actor_user_id, old_discogs_release_id, new_discogs_release_id,
       replaced_pin_discogs_release_id, replaced_pin_source)
    VALUES (${MISSING_ID}, ${ACTOR}, 36792451, ${newReleaseId}, 36792451, 'alex-l-2026')
    RETURNING id, changed_at
  `;

  const insertBefore = (changeId) => sql`
    INSERT INTO ${sql(SCHEMA)}.library_discogs_release_change_before (change_id, before_image)
    VALUES (${changeId}, ${sql.json({ label: 'Sonamos', tracklist: [{ position: 'A1', title: 'la paradoja' }] })})
  `;

  beforeAll(async () => {
    sql = getTestDb();
    listenConn = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      username: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });
    await listenConn.listen('cdc', (payload) => {
      try {
        cdcEvents.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });
  });

  afterAll(async () => {
    if (listenConn) await listenConn.end();
  });

  beforeEach(() => {
    cdcEvents.length = 0;
  });

  afterEach(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.library_discogs_release_change WHERE actor_user_id = ${ACTOR}`;
  });

  it('fires cdc on INSERT with the whole row, for an album and actor that exist nowhere', async () => {
    const [row] = await insertChange();
    expect(row.changed_at).toBeInstanceOf(Date);

    const event = await waitForEvent(
      cdcEvents,
      (e) => e.table === 'library_discogs_release_change' && Number(e.data?.id) === Number(row.id)
    );
    expect(event).not.toBeNull();
    expect(event.action).toBe('INSERT');
    expect(event.data).toMatchObject({
      album_id: MISSING_ID,
      actor_user_id: ACTOR,
      old_discogs_release_id: 36792451,
      new_discogs_release_id: 530321,
      replaced_pin_discogs_release_id: 36792451,
      replaced_pin_source: 'alex-l-2026',
    });
  });

  it('fires nothing for the before table', async () => {
    const [row] = await insertChange();
    await waitForEvent(cdcEvents, (e) => e.table === 'library_discogs_release_change');
    await insertBefore(row.id);

    const event = await waitForEvent(cdcEvents, (e) => e.table === 'library_discogs_release_change_before', 500);
    expect(event).toBeNull();
  });

  it('deletes the before row with its change row', async () => {
    const [row] = await insertChange();
    await insertBefore(row.id);
    await sql`DELETE FROM ${sql(SCHEMA)}.library_discogs_release_change WHERE id = ${row.id}`;

    const left = await sql`
      SELECT 1 FROM ${sql(SCHEMA)}.library_discogs_release_change_before WHERE change_id = ${row.id}
    `;
    expect(left).toHaveLength(0);
  });

  it('rejects a before row with no change row', async () => {
    await expect(insertBefore(MISSING_ID)).rejects.toMatchObject({ code: '23503' });
  });

  it.each([0, -1])('rejects new_discogs_release_id = %i with a CHECK violation', async (releaseId) => {
    await expect(insertChange(releaseId)).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'library_discogs_release_change_new_release_id_ck',
    });
  });
});
