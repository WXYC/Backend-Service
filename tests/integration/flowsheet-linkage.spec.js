/**
 * Forward-path flowsheet linkage E2E (B-2.1, B-3.3).
 *
 * Exercises the full async link path that Epic B's forward path is built on:
 *
 *   POST /flowsheet (free-form, no album_id)
 *     → controller fires `runLmlLinkage` after responding
 *       → LML lookup (mock-api fixture)
 *         → mapLookupToCanonicalEntity → `discogs:release:<id>`
 *           → seeded library row matches by canonical_entity_id
 *             → flowsheet.album_id + linkage_source + linkage_confidence persisted
 *
 * The unit suite (B-2.1) already covers each layer with mocks. This spec is
 * the cross-layer integration: real Express server, real PostgreSQL, real
 * Drizzle queries, mock LML over HTTP. Hits the seeded `Autechre / Confield`
 * fixture (mock release_id 4080) which the seed pre-populates with
 * `canonical_entity_id = 'discogs:release:4080'` so the resolver finds a
 * single matching library row.
 *
 * Uses `secondary_dj_id` to avoid conflicts with concurrent flowsheet specs
 * and queries the database directly because `linkage_source` /
 * `linkage_confidence` are intentionally not exposed on the V2 read path.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const fls_util = require('../utils/flowsheet_util');
const { isMockApiAvailable, resetMockApi } = require('../utils/mock_api');
const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const AUTECHRE_CANONICAL_ENTITY_ID = 'discogs:release:4080';
const AUTO_ACCEPT_CONFIDENCE = 0.9; // SEARCH_TYPE_CONFIDENCE.direct in library.service.ts

let mockApiAvailable = false;
const getTestDjId = () => global.secondary_dj_id;

/** Poll the flowsheet row until linkage_source is set, or time out. */
async function waitForLinkage(entryId, ms = 3000) {
  const sql = getTestDb();
  const start = Date.now();
  while (Date.now() - start < ms) {
    const rows = await sql`
      SELECT album_id, linkage_source, linkage_confidence, linked_at
      FROM ${sql(SCHEMA)}.flowsheet
      WHERE id = ${entryId}
    `;
    if (rows[0]?.linkage_source) return rows[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** Read a flowsheet row's linkage columns once (no polling). */
async function readLinkage(entryId) {
  const sql = getTestDb();
  const rows = await sql`
    SELECT album_id, linkage_source, linkage_confidence, linked_at
    FROM ${sql(SCHEMA)}.flowsheet
    WHERE id = ${entryId}
  `;
  return rows[0] ?? null;
}

beforeAll(async () => {
  mockApiAvailable = await isMockApiAvailable();
  if (!mockApiAvailable) {
    console.warn('Skipping flowsheet-linkage tests: mock API server not available');
  }
});

describe('Forward-path flowsheet linkage (B-2.1 E2E)', () => {
  beforeEach(async () => {
    if (!mockApiAvailable) return;
    await resetMockApi();
    await fls_util.join_show(getTestDjId(), global.secondary_access_token);
  });

  afterEach(async () => {
    if (!mockApiAvailable) return;
    await fls_util.leave_show(getTestDjId(), global.secondary_access_token);
  });

  test('free-form Autechre/Confield insert auto-links to seeded library row via LML', async () => {
    if (!mockApiAvailable) return;

    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Autechre',
        album_title: 'Confield',
        track_title: 'VI Scose Poise',
      })
      .expect(201);

    // Insert returns immediately; album_id is null until the fire-and-forget link lands.
    expect(addRes.body.album_id).toBeNull();

    const linked = await waitForLinkage(addRes.body.id);
    expect(linked).not.toBeNull();
    expect(linked.linkage_source).toBe('lml_high_confidence');
    expect(Number(linked.linkage_confidence)).toBeCloseTo(AUTO_ACCEPT_CONFIDENCE, 2);
    expect(linked.linked_at).not.toBeNull();
    expect(linked.album_id).not.toBeNull();

    // album_id resolves to the seeded Autechre library row carrying the canonical entity id.
    const sql = getTestDb();
    const libRows = await sql`
      SELECT canonical_entity_id, album_title
      FROM ${sql(SCHEMA)}.library
      WHERE id = ${linked.album_id}
    `;
    expect(libRows[0]?.canonical_entity_id).toBe(AUTECHRE_CANONICAL_ENTITY_ID);
    expect(libRows[0]?.album_title).toBe('Confield');
  });

  test('bin-pick (album_id provided) is already linked and skips LML linkage', async () => {
    if (!mockApiAvailable) return;

    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, // Built to Spill - Keep it Like a Secret (seeded)
        track_title: 'The Plan',
      })
      .expect(201);

    expect(addRes.body.album_id).toBe(1);

    // Give fire-and-forget a chance to (incorrectly) fire — assert it stays inert.
    await new Promise((r) => setTimeout(r, 250));
    const row = await readLinkage(addRes.body.id);
    expect(row).not.toBeNull();
    expect(row.linkage_source).toBeNull();
    expect(row.linkage_confidence).toBeNull();
    expect(row.linked_at).toBeNull();
    expect(row.album_id).toBe(1);
  });
});
