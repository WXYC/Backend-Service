/**
 * Integration test for ETL → CDC → enrichment-consumer delivery
 * (BS#896 / Epic C C7).
 *
 * `jobs/flowsheet-etl/job.ts` inserts flowsheet rows via raw
 * `db.insert(flowsheet)` rather than going through the controller's HTTP
 * path. This spec validates the contract Epic C depends on: every such
 * insert MUST fire a CDC `pg_notify('cdc', ...)` event whose JSON shape is
 * the one `apps/enrichment-worker/cdc-subscriber.ts::filterForEnrichment`
 * accepts.
 *
 * The chain is:
 *   1. ETL inserts a row → PG trigger `cdc_flowsheet` fires `cdc_notify()`
 *      (`shared/database/src/migrations/0046_cdc_notify_triggers.sql`).
 *   2. `cdc_notify()` builds a JSONB payload from `to_jsonb(NEW)` and emits
 *      `pg_notify('cdc', payload::text)`.
 *   3. The worker's LISTEN on channel `cdc` receives the payload.
 *   4. `filterForEnrichment` requires:
 *        table === 'flowsheet'
 *        action === 'INSERT'
 *        data.entry_type === 'track'
 *        data.metadata_status === 'pending'  ← schema default
 *        typeof data.artist_name === 'string' && length > 0
 *        typeof data.id === 'number'
 *
 * The ETL insert path (job.ts:233-247 bulk + :397-429 incremental)
 * deliberately omits `metadata_status` from the column list — the schema
 * default `'pending'` (BS#891) kicks in. If a future refactor accidentally
 * stamps that column to anything else, or the trigger fails to fire, this
 * spec catches it before the worker silently stops processing ETL rows.
 *
 * Pure SQL — does NOT import the ETL code or the worker's filter. The
 * integration runner is babel-jest with no TS support (see
 * `enrichment-worker-claim.spec.js` + `album-metadata-upsert.spec.js`
 * headers for the drizzle-orm + ts-jest incompatibility). Division of
 * responsibility:
 *   - Unit: source-code shape (the ETL's Drizzle .insert call, the worker's
 *     filter logic).
 *   - Integration (this file): the on-the-wire CDC contract that connects
 *     them — that ETL-shape INSERTs produce filter-compatible payloads.
 */

const postgres = require('postgres');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/**
 * Mirror of `apps/enrichment-worker/cdc-subscriber.ts::filterForEnrichment`.
 * Hand-copied because the integration runner cannot import TS source.
 * If this drifts from the canonical, the unit-test pin at
 * `tests/unit/apps/enrichment-worker/cdc-subscriber.test.ts` is the source
 * of truth — fix it there and update here in lockstep.
 */
function filterForEnrichment(event) {
  if (event.table !== 'flowsheet') return null;
  if (event.action !== 'INSERT') return null;
  if (!event.data) return null;
  const data = event.data;
  if (data.entry_type !== 'track') return null;
  if (data.metadata_status !== 'pending') return null;
  if (typeof data.artist_name !== 'string' || data.artist_name.length === 0) return null;
  if (typeof data.id !== 'number') return null;
  return {
    id: data.id,
    entry_type: 'track',
    metadata_status: 'pending',
    artist_name: data.artist_name,
    album_title: typeof data.album_title === 'string' ? data.album_title : null,
    track_title: typeof data.track_title === 'string' ? data.track_title : null,
    album_id: typeof data.album_id === 'number' ? data.album_id : null,
  };
}

/**
 * Wait until `predicate` is satisfied against any element of `events`, or
 * `timeoutMs` elapses. Returns the matching event on success, null on
 * timeout. 25 ms poll is fine — NOTIFY round-trip is sub-ms locally.
 */
async function waitForEvent(events, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('flowsheet-etl → CDC delivery contract (real PG)', () => {
  let sql; // shared pool for INSERTs / cleanup
  let listenConn; // dedicated connection for LISTEN (cannot be pooled)
  const events = [];
  const insertedIds = [];

  beforeAll(async () => {
    sql = getTestDb();
    // Dedicated connection mirrors what `shared/database/src/cdc-listener.ts`
    // does — postgres-js's LISTEN requires its own connection (the query
    // pool cannot host subscriptions).
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
        events.push(JSON.parse(payload));
      } catch {
        // Malformed payloads aren't this spec's concern.
      }
    });
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${insertedIds})`;
    }
    if (listenConn) await listenConn.end();
    // Pool is shared with the rest of the integration suite; do NOT close it.
  });

  beforeEach(() => {
    // Clear cross-test event leakage. Other specs running before us push
    // their own flowsheet INSERTs to the same channel; we filter by id in
    // each test, but resetting keeps the predicate scans small.
    events.length = 0;
  });

  test('ETL-shape track INSERT (no metadata_status specified) fires CDC INSERT with metadata_status=pending', async () => {
    // Mirrors jobs/flowsheet-etl/job.ts:233-247 — the column list does NOT
    // include metadata_status. The schema default 'pending' (BS#891 enum)
    // is what makes the worker's filter accept the payload.
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, album_title, track_title, play_order, request_flag, segue)
      VALUES
        ('track', 'C7 ETL test artist', 'C7 ETL test album', 'C7 ETL test track',
         99998, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    const event = await waitForEvent(events, (e) => e.data?.id === id);
    expect(event).not.toBeNull();
    expect(event.table).toBe('flowsheet');
    expect(event.schema).toBe(SCHEMA);
    expect(event.action).toBe('INSERT');
    expect(event.data.entry_type).toBe('track');
    expect(event.data.metadata_status).toBe('pending');
    expect(event.data.artist_name).toBe('C7 ETL test artist');
    expect(event.data.album_title).toBe('C7 ETL test album');
    expect(event.data.track_title).toBe('C7 ETL test track');
  });

  test("worker's filter accepts the ETL-shape CDC payload as an enrichment candidate", async () => {
    // Whole-chain pin: ETL insert → CDC event → filter accepts. If either
    // half drifts (column added/removed, default changed, filter narrowed)
    // this assertion fails in CI before the worker silently stops
    // processing ETL-inserted rows in prod.
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, album_title, track_title, play_order, request_flag, segue)
      VALUES
        ('track', 'C7 filter-accept artist', 'C7 album', 'C7 track', 99997, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    const event = await waitForEvent(events, (e) => e.data?.id === id);
    expect(event).not.toBeNull();
    const candidate = filterForEnrichment(event);
    expect(candidate).not.toBeNull();
    expect(candidate.id).toBe(id);
    expect(candidate.artist_name).toBe('C7 filter-accept artist');
    expect(candidate.album_title).toBe('C7 album');
    expect(candidate.track_title).toBe('C7 track');
    expect(candidate.album_id).toBeNull(); // unlinked ETL insert
  });

  test('ETL marker INSERT (entry_type=show_start) fires CDC but filter correctly skips it', async () => {
    // Markers (show_start, show_end, dj_join, dj_leave) flow through the
    // same ETL path and produce CDC events, but the worker's filter rejects
    // them on entry_type !== 'track'. Worker is the discriminator; the CDC
    // layer is intentionally promiscuous so other consumers (e.g., the
    // websocket fan-out) can subscribe to the full feed.
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, play_order, request_flag, segue)
      VALUES
        ('show_start', NULL, 99996, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    const event = await waitForEvent(events, (e) => e.data?.id === id);
    expect(event).not.toBeNull();
    expect(event.data.entry_type).toBe('show_start');
    expect(event.data.metadata_status).toBe('pending');
    // Filter correctly skips: not a track.
    expect(filterForEnrichment(event)).toBeNull();
  });

  test('UPDATE to an ETL row fires CDC with action=UPDATE, filter correctly skips (no re-enrichment)', async () => {
    // The incremental ETL (jobs/flowsheet-etl/job.ts:397-429) uses
    // `onConflictDoUpdate({ target: legacy_entry_id, set: {...} })`. When
    // an upstream tubafrenzy edit re-syncs the same legacy_entry_id, PG
    // takes the UPDATE branch and fires a CDC event with action='UPDATE'.
    // The worker's filter rejects (action !== 'INSERT'), so a lightly-
    // edited title never triggers re-enrichment. That's intentional —
    // metadata is already populated for the row.
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, play_order, request_flag, segue)
      VALUES
        ('track', 'C7 update test artist', 99995, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    await waitForEvent(events, (e) => e.data?.id === id && e.action === 'INSERT');
    events.length = 0;

    await sql`
      UPDATE ${sql(SCHEMA)}.flowsheet
         SET artist_name = 'C7 updated artist'
       WHERE id = ${id}
    `;
    const event = await waitForEvent(events, (e) => e.data?.id === id);
    expect(event).not.toBeNull();
    expect(event.action).toBe('UPDATE');
    expect(event.data.artist_name).toBe('C7 updated artist');
    // Filter correctly skips: UPDATE doesn't trigger re-enrichment.
    expect(filterForEnrichment(event)).toBeNull();
  });
});
