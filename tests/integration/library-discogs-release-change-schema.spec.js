/**
 * BS#3792 (plan BS#3790) -- `library_discogs_release_change` and `library_discogs_release_change_before` against a
 * real Postgres. The unit tier (`tests/unit/database/schema.library-discogs-release-change.test.ts`) pins the declared
 * shape; this spec pins the behaviour the release picker leans on:
 *
 *   - an INSERT into the change table fires `cdc`, the signal every Backend instance clears its lookup caches on, and
 *     an UPDATE or DELETE fires nothing (the rows are append-only),
 *   - the before table fires nothing, so its large jsonb never meets `pg_notify`'s size limit,
 *   - `album_id` and `actor_user_id` carry no foreign key, so a change row can name rows that no longer exist,
 *   - the before row needs its change row and is deleted with it,
 *   - `new_discogs_release_id` must be positive, and the other two release ids NULL or positive.
 *
 * Every row is removed in `afterEach`, keyed by the probe actor id. The LISTEN goes through the test pool's own
 * `sql.listen`, so it is always on the same server and database as the INSERTs.
 */

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
  let unlisten;
  const cdcEvents = [];

  const insertChange = ({
    newReleaseId = 530321,
    oldReleaseId = 36792451,
    replacedPinReleaseId = 36792451,
  } = {}) => sql`
    INSERT INTO ${sql(SCHEMA)}.library_discogs_release_change
      (album_id, actor_user_id, old_discogs_release_id, new_discogs_release_id,
       replaced_pin_discogs_release_id, replaced_pin_source)
    VALUES (${MISSING_ID}, ${ACTOR}, ${oldReleaseId}, ${newReleaseId}, ${replacedPinReleaseId}, 'alex-l-2026')
    RETURNING id, changed_at
  `;

  const isChangeEvent = (id) => (e) =>
    e.table === 'library_discogs_release_change' && Number(e.data?.id) === Number(id);

  const insertBefore = (changeId) => sql`
    INSERT INTO ${sql(SCHEMA)}.library_discogs_release_change_before (change_id, before_image)
    VALUES (${changeId}, ${sql.json({ label: 'Sonamos', tracklist: [{ position: 'A1', title: 'la paradoja' }] })})
  `;

  beforeAll(async () => {
    sql = getTestDb();
    ({ unlisten } = await sql.listen('cdc', (payload) => {
      try {
        cdcEvents.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    }));
  });

  afterAll(async () => {
    if (unlisten) await unlisten();
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

    const event = await waitForEvent(cdcEvents, isChangeEvent(row.id));
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

  it('fires nothing on UPDATE or DELETE of a change row', async () => {
    const [row] = await insertChange();
    // The INSERT's event proves the listener is live, so the silence below is real.
    expect(await waitForEvent(cdcEvents, isChangeEvent(row.id))).not.toBeNull();
    cdcEvents.length = 0;

    await sql`UPDATE ${sql(SCHEMA)}.library_discogs_release_change SET replaced_pin_source = 'edited' WHERE id = ${row.id}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.library_discogs_release_change WHERE id = ${row.id}`;

    expect(await waitForEvent(cdcEvents, isChangeEvent(row.id), 500)).toBeNull();
  });

  it('fires nothing for the before table', async () => {
    const [row] = await insertChange();
    // The INSERT's event proves the listener is live, so the silence below is real.
    expect(await waitForEvent(cdcEvents, isChangeEvent(row.id))).not.toBeNull();
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

  it.each([
    ['newReleaseId', 0, 'library_discogs_release_change_new_release_id_ck'],
    ['newReleaseId', -1, 'library_discogs_release_change_new_release_id_ck'],
    ['oldReleaseId', 0, 'library_discogs_release_change_old_release_id_ck'],
    ['replacedPinReleaseId', 0, 'library_discogs_release_change_replaced_pin_release_id_ck'],
  ])('rejects %s = %i with %s', async (field, value, constraint) => {
    await expect(insertChange({ [field]: value })).rejects.toMatchObject({
      code: '23514',
      constraint_name: constraint,
    });
  });

  it('accepts NULL for the old release and the replaced pin', async () => {
    const [row] = await insertChange({ oldReleaseId: null, replacedPinReleaseId: null });
    expect(row.id).toBeDefined();
  });
});
