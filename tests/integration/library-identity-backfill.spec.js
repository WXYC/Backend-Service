const postgres = require('postgres');

/**
 * Integration tests for library-identity-backfill (sub-PR 2.0). Two suites:
 *
 *   1. SQL contract suite — issues the exact UPSERT statements writer.ts
 *      uses against a real Postgres, validating substrate column shapes,
 *      ON CONFLICT semantics, and CHECK-constraint rollback. This catches
 *      schema drift between `shared/database/src/schema.ts` and the writer
 *      independently of the TS module path.
 *   2. TS modules suite — requires `writer.ts` and `orchestrate.ts` directly
 *      via the ts-jest transform (added to `jest.config.json` for the
 *      integration runner) and exercises the actual writer against an
 *      isolated test schema. Covers writer atomicity end-to-end, DRY_RUN
 *      no-write guarantee, and PARTITION_INDEX/COUNT disjointness.
 *
 * Both suites are scoped to isolated `wxyc_test_lib_id_*` schemas, dropped
 * in afterAll regardless of pass/fail.
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

/**
 * Integration tests against the actual TS writer + orchestrator modules.
 *
 * Loaded via ts-jest (added to `jest.config.json` for the integration runner)
 * so the .spec.js can `require()` .ts directly. Each test sets
 * `WXYC_SCHEMA_NAME` and uses `jest.isolateModules()` to ensure the writer's
 * import-time `const SCHEMA = ...` capture lands on the isolated test schema.
 *
 * Covers the §4 acceptance criteria the SQL-only tests above do not:
 *   - writer.ts + recompute.ts atomicity end-to-end (§3.2.2.2).
 *   - DRY_RUN orchestrator path leaves library_identity* untouched (§4).
 *   - Partition disjointness across PARTITION_INDEX=0/1 (§4 acceptance).
 */
describe('library-identity-backfill TS modules (real DB)', () => {
  let sql;
  let schemaName;
  let originalSchemaEnv;

  beforeAll(async () => {
    schemaName = `wxyc_test_lib_id_ts_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
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

  /**
   * Load writer + orchestrator from a fresh module-graph so their import-time
   * `process.env.WXYC_SCHEMA_NAME` capture honors the schema we just set.
   */
  const loadModules = () => {
    let writer;
    let orchestrator;
    jest.isolateModules(() => {
      writer = require('../../jobs/library-identity-backfill/writer');
      orchestrator = require('../../jobs/library-identity-backfill/orchestrate');
    });
    return { writer, orchestrator };
  };

  test('writeIdentity inserts the per-source row and main row inside a single transaction', async () => {
    const { writer } = loadModules();

    await writer.writeIdentity(
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
    expect(sourceRows[0].external_id).toBe('987654');
    expect(sourceRows[0].method).toBe('exact_match');
    expect(sourceRows[0].notes).toBe('backfill:S1');

    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 100`);
    expect(mainRows).toHaveLength(1);
    expect(mainRows[0].discogs_release_id).toBe(987654);
    expect(mainRows[0].method).toBe('exact_match');
    expect(mainRows[0].confidence).toBeCloseTo(1.0);
    expect(mainRows[0].agreement_sources).toBeNull();
  });

  test('writeIdentity rolls back atomically when the per-source CHECK constraint trips', async () => {
    const { writer } = loadModules();

    await expect(
      writer.writeIdentity(
        300,
        [
          {
            library_id: 300,
            source: 'discogs_release',
            external_id: '222',
            method: 'exact_match',
            confidence: 1.7, // out of [0,1] — CHECK trips
            last_verified_at: new Date(),
            boost_sources: null,
            notes: 'backfill:S1',
          },
        ],
        []
      )
    ).rejects.toThrow();

    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source WHERE library_id = 300`);
    expect(sourceRows).toHaveLength(0);
    const mainRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity WHERE library_id = 300`);
    expect(mainRows).toHaveLength(0);
  });

  test('runBackfill DRY_RUN leaves library_identity* untouched and reports honestly on rerun', async () => {
    // Seed: 4 library rows. 2 are in library_identity already (rerun overlap),
    // 1 has a fresh discogs match, 1 has a non-discogs namespace.
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, canonical_entity_id, canonical_entity_resolved_at) VALUES
       (500, 'discogs:1', now()),
       (501, 'discogs:2', now()),
       (502, 'discogs:3', now()),
       (503, 'mb:abc', now())`
    );
    // Pre-populate library_identity for 500 and 501 so the rerun-overlap
    // bucket actually has rows to count.
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library_identity
       (library_id, discogs_release_id, last_verified_at, method, confidence)
       VALUES
       (500, 1, now(), 'exact_match', 1.0),
       (501, 2, now(), 'exact_match', 1.0)`
    );

    const { orchestrator } = loadModules();
    const writeIdentity = jest.fn(async () => {});
    let capturedReport;
    const result = await orchestrator.runBackfill({
      writeIdentity,
      throttleMs: 0,
      batchSize: 500,
      dryRun: true,
      onDryRunReport: (r) => {
        capturedReport = r;
      },
    });

    expect(writeIdentity).not.toHaveBeenCalled();
    expect(result.totals.wrote).toBe(0);
    expect(capturedReport).toBeDefined();
    expect(capturedReport.scanned).toBe(4);
    expect(capturedReport.skipped.already_in_library_identity).toBe(2);
    expect(capturedReport.skipped.non_discogs_namespace).toBe(1);
    expect(capturedReport.skipped.no_canonical_entity_id).toBe(0);
    expect(capturedReport.would_write_sources).toBe(1);

    // Still only the 2 pre-seeded main rows; no per-source rows written.
    const mainRows = await sql.unsafe(`SELECT library_id FROM "${schemaName}".library_identity ORDER BY library_id`);
    expect(mainRows.map((r) => r.library_id)).toEqual([500, 501]);
    const sourceRows = await sql.unsafe(`SELECT * FROM "${schemaName}".library_identity_source`);
    expect(sourceRows).toHaveLength(0);
  });

  test('runBackfill partitions are disjoint and their union covers the full universe', async () => {
    // Seed 6 rows. PARTITION_COUNT=2 splits by `id % 2`, so PARTITION_INDEX=0
    // sees the even ids and INDEX=1 the odds. Neither sees both.
    const tuples = [];
    for (let i = 600; i < 606; i++) {
      tuples.push(`(${i}, 'discogs:${i * 11}', now())`);
    }
    await sql.unsafe(
      `INSERT INTO "${schemaName}".library (id, canonical_entity_id, canonical_entity_resolved_at) VALUES ${tuples.join(', ')}`
    );

    const { writer, orchestrator } = loadModules();
    const seen0 = [];
    const seen1 = [];

    await orchestrator.runBackfill({
      writeIdentity: async (libraryId, rows, agreement) => {
        seen0.push(libraryId);
        await writer.writeIdentity(libraryId, rows, agreement);
      },
      throttleMs: 0,
      partition: orchestrator.resolvePartitionFilter('0', '2'),
    });

    await orchestrator.runBackfill({
      writeIdentity: async (libraryId, rows, agreement) => {
        seen1.push(libraryId);
        await writer.writeIdentity(libraryId, rows, agreement);
      },
      throttleMs: 0,
      partition: orchestrator.resolvePartitionFilter('1', '2'),
    });

    const intersection = seen0.filter((id) => seen1.includes(id));
    expect(intersection).toEqual([]);
    expect([...seen0, ...seen1].sort()).toEqual([600, 601, 602, 603, 604, 605]);

    const mainRows = await sql.unsafe(`SELECT library_id FROM "${schemaName}".library_identity ORDER BY library_id`);
    expect(mainRows.map((r) => r.library_id)).toEqual([600, 601, 602, 603, 604, 605]);
  });
});
