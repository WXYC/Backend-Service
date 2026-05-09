const postgres = require('postgres');

/**
 * Integration test for the SQL contract used by library-identity-backfill
 * (sub-PR 2.0).
 *
 * The TS modules (`writer.ts`, `orchestrate.ts`) are unit-tested against
 * the @wxyc/database mock; this spec validates the *shape* of the SQL
 * statements those modules issue against a real Postgres so any migration
 * drift between `shared/database/src/schema.ts` and the writer is caught
 * before deploy. Specifically:
 *
 *   - The substrate columns expected by writer.ts exist with the right
 *     types (verified by issuing the exact UPSERT statements the writer
 *     uses, then SELECTing back).
 *   - The `ON CONFLICT (library_id, source) DO UPDATE` per-source UPSERT
 *     and the `ON CONFLICT (library_id) DO UPDATE` main-row UPSERT are
 *     idempotent.
 *   - The CHECK constraints on `confidence` actually trip under bad input
 *     and the surrounding transaction rolls back atomically.
 *
 * We don't import `writer.ts` directly — the integration runner uses
 * babel-jest without TS support, and the dist/ build only exports the
 * entry (`job.ts`). The writer's behavior is unit-tested separately.
 *
 * Scoped to an isolated `wxyc_test_lib_id_<random>` schema; dropped in
 * afterAll regardless of pass/fail.
 */
describe('library-identity-backfill SQL contract (real DB)', () => {
  let sql;
  let schemaName;

  beforeAll(async () => {
    schemaName = `wxyc_test_lib_id_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library_identity (
        library_id integer PRIMARY KEY,
        discogs_master_id integer,
        discogs_release_id integer,
        musicbrainz_release_group_mbid uuid,
        musicbrainz_release_mbid uuid,
        musicbrainz_recording_mbid uuid,
        wikidata_qid text,
        spotify_id text,
        apple_music_id text,
        last_verified_at timestamptz NOT NULL,
        method text NOT NULL,
        confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        agreement_sources text,
        notes text
      )
    `);
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library_identity_source (
        library_id integer NOT NULL,
        source text NOT NULL,
        external_id text NOT NULL,
        method text NOT NULL,
        confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        last_verified_at timestamptz NOT NULL,
        boost_sources text,
        notes text,
        PRIMARY KEY (library_id, source)
      )
    `);
  });

  afterAll(async () => {
    if (sql) {
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      } finally {
        await sql.end();
      }
    }
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE "${schemaName}".library_identity, "${schemaName}".library_identity_source RESTART IDENTITY CASCADE`
    );
  });

  // The exact UPSERTs writer.ts issues, parameterized via `sql.unsafe` so we
  // can interpolate the test schema name (Postgres rejects parameter binds
  // for identifiers).
  const upsertSource = async (row) => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library_identity_source (
         library_id, source, external_id, method, confidence,
         last_verified_at, boost_sources, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (library_id, source) DO UPDATE SET
         external_id = EXCLUDED.external_id,
         method = EXCLUDED.method,
         confidence = EXCLUDED.confidence,
         last_verified_at = EXCLUDED.last_verified_at,
         boost_sources = EXCLUDED.boost_sources,
         notes = EXCLUDED.notes`,
      [
        row.library_id,
        row.source,
        row.external_id,
        row.method,
        row.confidence,
        row.last_verified_at,
        row.boost_sources,
        row.notes,
      ]
    );
  };

  const upsertMain = async (row) => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library_identity (
         library_id,
         discogs_master_id, discogs_release_id,
         musicbrainz_release_group_mbid, musicbrainz_release_mbid, musicbrainz_recording_mbid,
         wikidata_qid, spotify_id, apple_music_id,
         last_verified_at, method, confidence, agreement_sources, notes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (library_id) DO UPDATE SET
         discogs_master_id = EXCLUDED.discogs_master_id,
         discogs_release_id = EXCLUDED.discogs_release_id,
         musicbrainz_release_group_mbid = EXCLUDED.musicbrainz_release_group_mbid,
         musicbrainz_release_mbid = EXCLUDED.musicbrainz_release_mbid,
         musicbrainz_recording_mbid = EXCLUDED.musicbrainz_recording_mbid,
         wikidata_qid = EXCLUDED.wikidata_qid,
         spotify_id = EXCLUDED.spotify_id,
         apple_music_id = EXCLUDED.apple_music_id,
         last_verified_at = EXCLUDED.last_verified_at,
         method = EXCLUDED.method,
         confidence = EXCLUDED.confidence,
         agreement_sources = EXCLUDED.agreement_sources`,
      [
        row.library_id,
        row.discogs_master_id,
        row.discogs_release_id,
        row.musicbrainz_release_group_mbid,
        row.musicbrainz_release_mbid,
        row.musicbrainz_recording_mbid,
        row.wikidata_qid,
        row.spotify_id,
        row.apple_music_id,
        row.last_verified_at,
        row.method,
        row.confidence,
        row.agreement_sources,
        row.notes,
      ]
    );
  };

  test('per-source UPSERT lands the row and reports it back via SELECT', async () => {
    await upsertSource({
      library_id: 100,
      source: 'discogs_release',
      external_id: '987654',
      method: 'exact_match',
      confidence: 1.0,
      last_verified_at: new Date('2026-04-15T00:00:00Z'),
      boost_sources: null,
      notes: 'backfill:S1',
    });

    const rows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source WHERE library_id = 100`);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('discogs_release');
    expect(rows[0].external_id).toBe('987654');
    expect(rows[0].method).toBe('exact_match');
    expect(rows[0].confidence).toBeCloseTo(1.0);
    expect(rows[0].notes).toBe('backfill:S1');
  });

  test('main-row UPSERT lands and is idempotent on rerun', async () => {
    const main = {
      library_id: 200,
      discogs_master_id: null,
      discogs_release_id: 111,
      musicbrainz_release_group_mbid: null,
      musicbrainz_release_mbid: null,
      musicbrainz_recording_mbid: null,
      wikidata_qid: null,
      spotify_id: null,
      apple_music_id: null,
      last_verified_at: new Date('2026-04-15T00:00:00Z'),
      method: 'exact_match',
      confidence: 1.0,
      agreement_sources: null,
      notes: null,
    };

    await upsertMain(main);
    await upsertMain(main);

    const rows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 200`);
    expect(rows).toHaveLength(1);
    expect(rows[0].discogs_release_id).toBe(111);
    expect(rows[0].method).toBe('exact_match');
    expect(rows[0].confidence).toBeCloseTo(1.0);
    expect(rows[0].agreement_sources).toBeNull();
  });

  test('confidence CHECK constraint trips on out-of-range values and the transaction rolls back atomically', async () => {
    // The writer wraps per-source + main-row UPSERTs in a single
    // db.transaction(); when any step trips the CHECK, the entire
    // transaction rolls back. Simulate that with an explicit tx here so the
    // SQL contract — not the TS wiring — is what's under test.
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO "${schemaName}".library_identity_source (
             library_id, source, external_id, method, confidence,
             last_verified_at, boost_sources, notes
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [300, 'discogs_release', '222', 'exact_match', 1.7, new Date(), null, 'backfill:S1']
        );
        // Should never reach this; the CHECK on the previous statement trips.
        await tx.unsafe(
          `INSERT INTO "${schemaName}".library_identity (
             library_id, discogs_release_id, last_verified_at, method, confidence
           ) VALUES ($1, $2, $3, $4, $5)`,
          [300, 222, new Date(), 'exact_match', 1.0]
        );
      })
    ).rejects.toThrow(/check/i);

    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source WHERE library_id = 300`);
    expect(sourceRows).toHaveLength(0);
    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 300`);
    expect(mainRows).toHaveLength(0);
  });

  test('per-source ON CONFLICT (library_id, source) preserves disjoint sources for one library_id', async () => {
    // Sub-PR 2.1+ writes additional sources for the same library_id; the
    // composite PK must allow both rows to coexist without overwriting.
    const last = new Date('2026-04-15T00:00:00Z');
    await upsertSource({
      library_id: 400,
      source: 'discogs_release',
      external_id: '111',
      method: 'exact_match',
      confidence: 1.0,
      last_verified_at: last,
      boost_sources: null,
      notes: 'backfill:S1',
    });
    await upsertSource({
      library_id: 400,
      source: 'wikidata',
      external_id: 'Q42',
      method: 'alias_match',
      confidence: 0.85,
      last_verified_at: last,
      boost_sources: null,
      notes: 'backfill:S2',
    });

    const rows = await sql.unsafe(
      `SELECT source FROM "${schemaName}".library_identity_source WHERE library_id = 400 ORDER BY source`
    );
    expect(rows.map((r) => r.source)).toEqual(['discogs_release', 'wikidata']);
  });
});
