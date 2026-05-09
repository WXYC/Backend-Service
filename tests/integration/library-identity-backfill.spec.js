const postgres = require('postgres');

/**
 * Integration tests for library-identity-backfill against a real Postgres
 * (sub-PR 2.0).
 *
 * Validates the §3.2.2.2 dual-table-writer contract end-to-end:
 *
 *   - Per-source rows + main rows land atomically (in-transaction).
 *   - DRY_RUN leaves both tables untouched (§4 acceptance).
 *   - Partition disjointness (PARTITION_COUNT=2 with INDEX=0/1 produces
 *     disjoint sets that re-union to the full universe).
 *   - Idempotency: rerunning the writer for the same library_id is a no-op
 *     beyond a refreshed `last_verified_at`.
 *
 * Scoped to an isolated `wxyc_test_lib_id_<random>` schema. The job's
 * orchestrator/writer/resolver modules are exercised against tables created
 * in this schema by setting `WXYC_SCHEMA_NAME` so the schema-qualified SQL
 * lands here rather than `wxyc_schema`.
 */
describe('library-identity-backfill (real DB)', () => {
  let sql;
  let schemaName;
  let originalSchemaEnv;

  beforeAll(async () => {
    schemaName = `wxyc_test_lib_id_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    originalSchemaEnv = process.env.WXYC_SCHEMA_NAME;
    process.env.WXYC_SCHEMA_NAME = schemaName;

    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
    // Minimum subset of substrate columns needed by the orchestrator/writer.
    // Mirrors `shared/database/src/schema.ts`'s library_identity* tables,
    // dropping FK constraints and the audit-only generated column to keep
    // the test lightweight.
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".library (
        id serial PRIMARY KEY,
        canonical_entity_id text,
        canonical_entity_resolved_at timestamptz
      )
    `);
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
    if (originalSchemaEnv === undefined) {
      delete process.env.WXYC_SCHEMA_NAME;
    } else {
      process.env.WXYC_SCHEMA_NAME = originalSchemaEnv;
    }
  });

  beforeEach(async () => {
    await sql.unsafe(
      `TRUNCATE "${schemaName}".library_identity, "${schemaName}".library_identity_source RESTART IDENTITY CASCADE`
    );
    await sql.unsafe(`TRUNCATE "${schemaName}".library RESTART IDENTITY CASCADE`);
  });

  test('writeIdentity inserts the per-source row and main row inside a transaction', async () => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, canonical_entity_id, canonical_entity_resolved_at)
       VALUES (100, 'discogs:987654', '2026-04-15T00:00:00Z')`
    );

    // Module load AFTER WXYC_SCHEMA_NAME is set so the schema-qualified raw
    // SQL ends up pointed at our isolated schema. (The job module captures
    // the env var into a const at import time.)
    jest.resetModules();
    const { writeIdentity } = require('../../jobs/library-identity-backfill/writer');
    await writeIdentity(
      100,
      [
        {
          library_id: 100,
          source: 'discogs_release',
          external_id: '987654',
          method: 'exact_match',
          confidence: 1.0,
          last_verified_at: new Date('2026-04-15T00:00:00Z'),
          boost_sources: null,
          notes: 'backfill:S1',
        },
      ],
      []
    );

    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source WHERE library_id = 100`);
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].source).toBe('discogs_release');
    expect(sourceRows[0].external_id).toBe('987654');
    expect(sourceRows[0].method).toBe('exact_match');
    expect(sourceRows[0].confidence).toBeCloseTo(1.0);
    expect(sourceRows[0].notes).toBe('backfill:S1');

    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 100`);
    expect(mainRows).toHaveLength(1);
    expect(mainRows[0].discogs_release_id).toBe(987654);
    expect(mainRows[0].method).toBe('exact_match');
    expect(mainRows[0].confidence).toBeCloseTo(1.0);
    expect(mainRows[0].agreement_sources).toBeNull();
  });

  test('writeIdentity is idempotent on rerun (UPSERT semantics)', async () => {
    jest.resetModules();
    const { writeIdentity } = require('../../jobs/library-identity-backfill/writer');
    const baseRow = {
      library_id: 200,
      source: 'discogs_release',
      external_id: '111',
      method: 'exact_match',
      confidence: 1.0,
      last_verified_at: new Date('2026-04-15T00:00:00Z'),
      boost_sources: null,
      notes: 'backfill:S1',
    };

    await writeIdentity(200, [baseRow], []);
    await writeIdentity(200, [baseRow], []);

    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source WHERE library_id = 200`);
    expect(sourceRows).toHaveLength(1);
    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 200`);
    expect(mainRows).toHaveLength(1);
    expect(mainRows[0].discogs_release_id).toBe(111);
  });

  test('writeIdentity rolls back atomically when an in-transaction step fails', async () => {
    // Force a violation by passing a confidence value out of [0, 1].
    // The CHECK constraint trips, the transaction rolls back, and neither
    // table holds a partial row for this library_id.
    jest.resetModules();
    const { writeIdentity } = require('../../jobs/library-identity-backfill/writer');
    const bad = {
      library_id: 300,
      source: 'discogs_release',
      external_id: '222',
      method: 'exact_match',
      confidence: 1.7, // out of range — CHECK violation
      last_verified_at: new Date('2026-04-15T00:00:00Z'),
      boost_sources: null,
      notes: 'backfill:S1',
    };

    await expect(writeIdentity(300, [bad], [])).rejects.toThrow();

    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source WHERE library_id = 300`);
    expect(sourceRows).toHaveLength(0);
    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 300`);
    expect(mainRows).toHaveLength(0);
  });

  test('orchestrator DRY_RUN leaves library_identity* untouched', async () => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, canonical_entity_id, canonical_entity_resolved_at) VALUES
       (400, 'discogs:1', now()),
       (401, 'discogs:2', now()),
       (402, 'mb:abc', now()),
       (403, NULL, NULL)`
    );

    jest.resetModules();
    const { runBackfill } = require('../../jobs/library-identity-backfill/orchestrate');
    const writeIdentity = jest.fn(async () => {});
    const result = await runBackfill({ writeIdentity, throttleMs: 0, dryRun: true });

    expect(writeIdentity).not.toHaveBeenCalled();
    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source`);
    expect(sourceRows).toHaveLength(0);
    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity`);
    expect(mainRows).toHaveLength(0);

    expect(result.dryRunReport).toBeDefined();
    if (result.dryRunReport) {
      expect(result.dryRunReport.scanned).toBe(4);
      expect(result.dryRunReport.would_write_sources).toBe(2);
      expect(result.dryRunReport.skipped.no_canonical_entity_id).toBe(1);
      expect(result.dryRunReport.skipped.non_discogs_namespace).toBe(1);
    }
  });

  test('partition runs are disjoint and re-union to the full universe', async () => {
    // Seed 6 rows across both partition buckets. PARTITION_COUNT=2 splits by
    // `id % 2`, so we expect rows at odd ids in one partition and even in the
    // other. Re-union yields the full set with no duplicates.
    const seed = [];
    for (let i = 500; i < 506; i++) {
      seed.push(`(${i}, 'discogs:${i * 11}', now())`);
    }
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, canonical_entity_id, canonical_entity_resolved_at) VALUES ${seed.join(', ')}`
    );

    jest.resetModules();
    const { runBackfill } = require('../../jobs/library-identity-backfill/orchestrate');
    const { writeIdentity } = require('../../jobs/library-identity-backfill/writer');
    const seen0 = [];
    const seen1 = [];

    await runBackfill({
      writeIdentity: async (libraryId, rows, agreement) => {
        seen0.push(libraryId);
        await writeIdentity(libraryId, rows, agreement);
      },
      throttleMs: 0,
      partition: { sqlFragment: require('drizzle-orm').sql`AND ("id" % 2) = 0`, description: 'partition=0/2' },
    });

    await runBackfill({
      writeIdentity: async (libraryId, rows, agreement) => {
        seen1.push(libraryId);
        await writeIdentity(libraryId, rows, agreement);
      },
      throttleMs: 0,
      partition: { sqlFragment: require('drizzle-orm').sql`AND ("id" % 2) = 1`, description: 'partition=1/2' },
    });

    const intersection = seen0.filter((id) => seen1.includes(id));
    expect(intersection).toEqual([]);
    expect([...seen0, ...seen1].sort()).toEqual([500, 501, 502, 503, 504, 505]);

    const mainRows = await sql.unsafe(`SELECT library_id FROM "${schemaName}".library_identity ORDER BY library_id`);
    expect(mainRows.map((r) => r.library_id)).toEqual([500, 501, 502, 503, 504, 505]);
  });
});
