/**
 * Integration test for the CDC oversized-payload + error-branch fallback
 * paths (WXYC/Backend-Service#1120).
 *
 * Background: migration 0046 wrapped `pg_notify('cdc', payload::text)` in a
 * broad `EXCEPTION WHEN OTHERS ... RAISE WARNING ... RETURN NULL` block.
 * Since cdc_notify is an AFTER trigger, the returned NULL is ignored — the
 * mutation commits, but the CDC event is silently dropped when the payload
 * exceeds Postgres's 8000-byte pg_notify cap. The 2026-06-13 migration 0094
 * detects oversized payloads up-front and emits a minimal-payload
 * `cdc_oversized` notification carrying (table, schema, action, primary_key)
 * instead, and routes unexpected exceptions through a dedicated `cdc_error`
 * channel.
 *
 * This spec exercises both new channels against real Postgres:
 *
 *   1. Normal-size INSERT → cdc fires, cdc_oversized is silent.
 *   2. INSERT whose to_jsonb(NEW) crosses the 7800-byte threshold →
 *      cdc_oversized fires with reason='payload_too_large' and a primary_key
 *      string; cdc is silent for that row.
 *   3. The originating mutation commits regardless (visibility, not data
 *      safety, is the contract).
 *
 * Pure SQL (babel-jest runner, no TS import) — same pattern as
 * flowsheet-etl-cdc-delivery.spec.js.
 */

const postgres = require('postgres');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

async function waitForEvent(events, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = events.find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('CDC oversized + error fallback channels (real PG)', () => {
  let sql;
  let listenConn;
  const cdcEvents = [];
  const oversizedEvents = [];
  const errorEvents = [];
  const insertedIds = [];

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
    await listenConn.listen('cdc_oversized', (payload) => {
      try {
        oversizedEvents.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });
    await listenConn.listen('cdc_error', (payload) => {
      try {
        errorEvents.push(JSON.parse(payload));
      } catch {
        /* ignore */
      }
    });
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE id = ANY(${insertedIds})`;
    }
    if (listenConn) await listenConn.end();
  });

  beforeEach(() => {
    cdcEvents.length = 0;
    oversizedEvents.length = 0;
    errorEvents.length = 0;
  });

  test('normal-size flowsheet INSERT fires `cdc`, not `cdc_oversized`', async () => {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, album_title, track_title, play_order, request_flag, segue)
      VALUES
        ('track', '#1120 normal artist', '#1120 album', '#1120 track', 89901, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    const event = await waitForEvent(cdcEvents, (e) => e.data?.id === id);
    expect(event).not.toBeNull();
    expect(event.action).toBe('INSERT');

    // No oversized fallback should have fired for this row.
    const oversized = await waitForEvent(oversizedEvents, (e) => Number(e.primary_key) === id, 150);
    expect(oversized).toBeNull();
  });

  test('oversized flowsheet INSERT fires `cdc_oversized` fallback, not `cdc`', async () => {
    // Build a ~10 KB artist_bio. With the rest of the row, to_jsonb(NEW) is
    // guaranteed to cross the 7800-byte safety threshold.
    const bigBio = 'x'.repeat(10000);
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, album_title, track_title, artist_bio,
         play_order, request_flag, segue)
      VALUES
        ('track', '#1120 oversized', '#1120 big album', '#1120 big track', ${bigBio},
         89902, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    const fallback = await waitForEvent(oversizedEvents, (e) => Number(e.primary_key) === id);
    expect(fallback).not.toBeNull();
    expect(fallback.table).toBe('flowsheet');
    expect(fallback.schema).toBe(SCHEMA);
    expect(fallback.action).toBe('INSERT');
    expect(fallback.reason).toBe('payload_too_large');
    expect(typeof fallback.payload_bytes).toBe('number');
    expect(fallback.payload_bytes).toBeGreaterThan(7800);
    expect(typeof fallback.timestamp).toBe('number');

    // The full `cdc` channel must NOT have received this row.
    const fullEvent = await waitForEvent(cdcEvents, (e) => e.data?.id === id, 200);
    expect(fullEvent).toBeNull();
  });

  test('oversized INSERT still commits the row (visibility-only failure mode)', async () => {
    const bigBio = 'y'.repeat(10000);
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.flowsheet
        (entry_type, artist_name, album_title, track_title, artist_bio,
         play_order, request_flag, segue)
      VALUES
        ('track', '#1120 commit-check', '#1120 album', '#1120 track', ${bigBio},
         89903, false, false)
      RETURNING id
    `;
    const id = rows[0].id;
    insertedIds.push(id);

    const persisted = await sql`
      SELECT id, artist_name FROM ${sql(SCHEMA)}.flowsheet WHERE id = ${id}
    `;
    expect(persisted.length).toBe(1);
    expect(persisted[0].artist_name).toBe('#1120 commit-check');

    // And the oversized fallback fired (sanity).
    const fallback = await waitForEvent(oversizedEvents, (e) => Number(e.primary_key) === id);
    expect(fallback).not.toBeNull();
  });

  test('cdc_notify() function is the post-0094 shape (declares cdc_oversized + cdc_error)', async () => {
    // Pin: the deployed function body references both new channels by name.
    // Catches accidental rollbacks of the migration without exercising the
    // full overflow path. Cheap last-line-of-defense.
    const result = await sql`
      SELECT pg_get_functiondef(p.oid) AS body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'cdc_notify' AND n.nspname IN ('public', ${SCHEMA})
      LIMIT 1
    `;
    expect(result.length).toBe(1);
    const body = result[0].body;
    expect(body).toMatch(/cdc_oversized/);
    expect(body).toMatch(/cdc_error/);
    expect(body).toMatch(/payload_too_large/);
  });
});
