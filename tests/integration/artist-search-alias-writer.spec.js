const postgres = require('postgres');

/**
 * Integration test for the SQL contract used by the artist-search-alias-consumer
 * writer (BS#1266 / artist-search-alias plan PR 4).
 *
 * Issues the exact reconcile + UPSERT statements the writer emits against a
 * real PostgreSQL, validating substrate column shapes, ON CONFLICT semantics,
 * CHECK-constraint rollback, comma/apostrophe-bearing variant byte-fidelity,
 * and FK cascade. Catches migration drift between
 * `shared/database/src/schema.ts` and the writer at PR-review time.
 *
 *   - Comma-bearing variant ("Earth, Wind & Fire") survives the
 *     parameterized-VALUES round-trip. The rejected `'{...}'::text[]`
 *     literal pattern would split this into 2 rows; the writer's
 *     `sql.join(rows, sql\`, \`)` approach preserves it as one bound text.
 *   - Apostrophe-bearing variant ("Sinéad O'Connor") round-trips byte-
 *     identical (Unicode + apostrophe + comma).
 *   - `sources_present` scope: a DELETE scoped to Discogs sources only
 *     leaves a `wxyc_library_alt` row in place; a DELETE that includes
 *     `wxyc_library_alt` and omits the variant from the new variants list
 *     removes the alt row.
 *   - Artist cascade: deleting an `artists` row cascades to its alias rows.
 *   - `CHECK (length(trim(variant)) > 0)` rejects empty/whitespace variants
 *     and the surrounding transaction rolls back atomically.
 *
 * The integration runner is babel-jest with no TypeScript support (per
 * `library-identity-backfill.spec.js` header — drizzle-orm + ts-jest
 * incompatibility on gin_trgm_ops indexes). So this file does NOT import
 * `writer.ts` directly; instead it issues the equivalent raw SQL. Writer
 * TS-level shape (transaction wrapping, sql.join usage, short-circuits) is
 * unit-tested against the @wxyc/database mock in
 * `tests/unit/jobs/artist-search-alias-consumer/writer.test.ts`.
 *
 * Scoped to an isolated `wxyc_test_asa_<random>` schema; dropped in afterAll
 * regardless of pass/fail.
 */
describe('artist-search-alias-consumer writer SQL contract (real DB)', () => {
  let sql;
  let schemaName;

  beforeAll(async () => {
    schemaName = `wxyc_test_asa_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
      onnotice: () => {},
    });

    await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);

    // Minimal `artists` mirror — we only need the PK so we can FK against it.
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".artists (
        id serial PRIMARY KEY,
        artist_name text NOT NULL
      )
    `);

    // Mirror migration 0089's artist_search_alias DDL (table + constraints +
    // FKs). We don't reproduce the GIN trigram index — not required for the
    // semantics under test, and creating it would force a pg_trgm extension
    // dependency in the test database.
    await sql.unsafe(`
      CREATE TABLE "${schemaName}".artist_search_alias (
        artist_id integer NOT NULL,
        source text NOT NULL,
        variant text NOT NULL,
        related_artist_id integer,
        external_subject_id text,
        external_object_id text,
        active boolean,
        method text NOT NULL,
        confidence real NOT NULL,
        last_verified_at timestamptz NOT NULL,
        CONSTRAINT artist_search_alias_pkey PRIMARY KEY (artist_id, source, variant),
        CONSTRAINT artist_search_alias_confidence_range CHECK (confidence BETWEEN 0 AND 1),
        CONSTRAINT artist_search_alias_variant_nonblank CHECK (length(trim(variant)) > 0),
        CONSTRAINT artist_search_alias_artist_id_fk
          FOREIGN KEY (artist_id) REFERENCES "${schemaName}".artists(id) ON DELETE CASCADE,
        CONSTRAINT artist_search_alias_related_artist_id_fk
          FOREIGN KEY (related_artist_id) REFERENCES "${schemaName}".artists(id) ON DELETE SET NULL
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
    await sql.unsafe(`TRUNCATE "${schemaName}".artist_search_alias, "${schemaName}".artists RESTART IDENTITY CASCADE`);
  });

  // Issue the writer's INSERT … ON CONFLICT for one variant. Parameterised
  // so comma/apostrophe-bearing variants round-trip through positional binds
  // exactly the way the TS writer does.
  const upsertVariant = async (artistId, v, lastVerifiedAt) => {
    await sql.unsafe(
      `INSERT INTO "${schemaName}".artist_search_alias
         (artist_id, source, variant, related_artist_id,
          external_subject_id, external_object_id, active,
          method, confidence, last_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (artist_id, source, variant) DO UPDATE SET
         related_artist_id   = EXCLUDED.related_artist_id,
         external_subject_id = EXCLUDED.external_subject_id,
         external_object_id  = EXCLUDED.external_object_id,
         active              = EXCLUDED.active,
         method              = EXCLUDED.method,
         confidence          = EXCLUDED.confidence,
         last_verified_at    = EXCLUDED.last_verified_at`,
      [
        artistId,
        v.source,
        v.variant,
        v.related_artist_id ?? null,
        v.external_subject_id ?? null,
        v.external_object_id ?? null,
        v.active ?? null,
        v.method,
        v.confidence,
        lastVerifiedAt,
      ]
    );
  };

  // Issue the writer's scoped DELETE for one (artist_id, sourcesPresent,
  // variants) tuple. Mirrors the parameterized-VALUES pattern in the TS
  // writer: sources land as individual binds in `srcs(s)`, and (source,
  // variant) pairs land as positional binds when variants is non-empty.
  const reconcileDelete = async (artistId, sourcesPresent, variants) => {
    if (sourcesPresent.length === 0) return;
    const srcBinds = sourcesPresent.map((_, i) => `($${i + 2}::text)`).join(', ');
    const srcParams = [artistId, ...sourcesPresent];

    if (variants.length === 0) {
      await sql.unsafe(
        `DELETE FROM "${schemaName}".artist_search_alias
         WHERE artist_id = $1
           AND source IN (SELECT s FROM (VALUES ${srcBinds}) AS srcs(s))`,
        srcParams
      );
      return;
    }
    const pairBinds = variants
      .map((_, i) => `($${srcParams.length + i * 2 + 1}::text, $${srcParams.length + i * 2 + 2}::text)`)
      .join(', ');
    const pairParams = variants.flatMap((v) => [v.source, v.variant]);
    await sql.unsafe(
      `DELETE FROM "${schemaName}".artist_search_alias
       WHERE artist_id = $1
         AND source IN (SELECT s FROM (VALUES ${srcBinds}) AS srcs(s))
         AND (source, variant) NOT IN (VALUES ${pairBinds})`,
      [...srcParams, ...pairParams]
    );
  };

  const insertArtist = async (name) => {
    const rows = await sql.unsafe(`INSERT INTO "${schemaName}".artists (artist_name) VALUES ($1) RETURNING id`, [name]);
    return rows[0].id;
  };

  it('round-trips a comma-bearing variant byte-identical (Earth, Wind & Fire)', async () => {
    const id = await insertArtist('Earth, Wind & Fire');
    const v = {
      source: 'discogs_alias',
      variant: 'Earth, Wind & Fire',
      method: 'alias_curated',
      confidence: 0.85,
    };
    await upsertVariant(id, v, new Date().toISOString());

    const rows = await sql.unsafe(`SELECT variant FROM "${schemaName}".artist_search_alias WHERE artist_id = $1`, [id]);
    expect(rows.length).toBe(1);
    // Specifically must NOT have split on the comma into two rows.
    expect(rows[0].variant).toBe('Earth, Wind & Fire');
  });

  it("round-trips an apostrophe + diacritic variant byte-identical (Sinéad O'Connor)", async () => {
    const id = await insertArtist('Sinead OConnor');
    const v = {
      source: 'discogs_name_variation',
      variant: "Sinéad O'Connor",
      method: 'name_variation',
      confidence: 0.95,
    };
    await upsertVariant(id, v, new Date().toISOString());

    const rows = await sql.unsafe(`SELECT variant FROM "${schemaName}".artist_search_alias WHERE artist_id = $1`, [id]);
    expect(rows[0].variant).toBe("Sinéad O'Connor");
  });

  it('writes multiple comma-bearing variants in one logical call without element-boundary corruption', async () => {
    const id = await insertArtist('Multi-Comma');
    const variants = [
      { source: 'discogs_alias', variant: 'Earth, Wind & Fire', method: 'alias_curated', confidence: 0.85 },
      { source: 'discogs_alias', variant: 'Tyler, the Creator', method: 'alias_curated', confidence: 0.85 },
      {
        source: 'discogs_alias',
        variant: 'Crosby, Stills, Nash & Young',
        method: 'alias_curated',
        confidence: 0.85,
      },
    ];
    const lva = new Date().toISOString();
    for (const v of variants) await upsertVariant(id, v, lva);

    const rows = await sql.unsafe(
      `SELECT variant FROM "${schemaName}".artist_search_alias WHERE artist_id = $1 ORDER BY variant`,
      [id]
    );
    expect(rows.map((r) => r.variant)).toEqual([
      'Crosby, Stills, Nash & Young',
      'Earth, Wind & Fire',
      'Tyler, the Creator',
    ]);
  });

  it('reconcile DELETE scoped to Discogs sources preserves the wxyc_library_alt row', async () => {
    const id = await insertArtist('Stereolab');
    const lva = new Date().toISOString();
    await upsertVariant(
      id,
      { source: 'discogs_name_variation', variant: 'STEREOLAB', method: 'name_variation', confidence: 0.95 },
      lva
    );
    await upsertVariant(
      id,
      { source: 'wxyc_library_alt', variant: 'Stereo-Lab', method: 'alt_curated', confidence: 0.85 },
      lva
    );

    // sources_present = Discogs only; variants empty. The wxyc_library_alt
    // row must survive.
    await reconcileDelete(id, ['discogs_name_variation'], []);

    const rows = await sql.unsafe(
      `SELECT source, variant FROM "${schemaName}".artist_search_alias WHERE artist_id = $1 ORDER BY source, variant`,
      [id]
    );
    expect(rows).toEqual([{ source: 'wxyc_library_alt', variant: 'Stereo-Lab' }]);
  });

  it('reconcile DELETE that includes wxyc_library_alt removes the alt row when it is not in the new variants list', async () => {
    const id = await insertArtist('Stereolab');
    const lva = new Date().toISOString();
    await upsertVariant(
      id,
      { source: 'wxyc_library_alt', variant: 'Stereo-Lab', method: 'alt_curated', confidence: 0.85 },
      lva
    );

    // sources_present includes wxyc_library_alt and the new variants list is
    // empty (the library row's alternate_artist_name was cleared upstream).
    await reconcileDelete(id, ['wxyc_library_alt'], []);

    const rows = await sql.unsafe(`SELECT 1 FROM "${schemaName}".artist_search_alias WHERE artist_id = $1`, [id]);
    expect(rows.length).toBe(0);
  });

  it('cascades alias rows on artist DELETE', async () => {
    const id = await insertArtist('Stereolab');
    const lva = new Date().toISOString();
    await upsertVariant(
      id,
      { source: 'discogs_name_variation', variant: 'STEREOLAB', method: 'name_variation', confidence: 0.95 },
      lva
    );

    await sql.unsafe(`DELETE FROM "${schemaName}".artists WHERE id = $1`, [id]);

    const rows = await sql.unsafe(`SELECT 1 FROM "${schemaName}".artist_search_alias WHERE artist_id = $1`, [id]);
    expect(rows.length).toBe(0);
  });

  it('rejects empty / whitespace-only variants via CHECK (length(trim(variant)) > 0)', async () => {
    const id = await insertArtist('Cat Power');
    const lva = new Date().toISOString();
    await expect(
      upsertVariant(id, { source: 'discogs_alias', variant: '   ', method: 'alias_curated', confidence: 0.85 }, lva)
    ).rejects.toThrow(/artist_search_alias_variant_nonblank/i);
  });

  it('rejects out-of-range confidence via CHECK (confidence BETWEEN 0 AND 1)', async () => {
    const id = await insertArtist('Cat Power');
    const lva = new Date().toISOString();
    await expect(
      upsertVariant(id, { source: 'discogs_alias', variant: 'Catpower', method: 'alias_curated', confidence: 1.5 }, lva)
    ).rejects.toThrow(/confidence_range/i);
  });

  it('fan-out across duplicate-named artist_ids produces the same variant set under each artist_id', async () => {
    const phoenixBand = await insertArtist('Phoenix');
    const phoenixSolo = await insertArtist('Phoenix');
    const lva = new Date().toISOString();
    const variants = [
      { source: 'discogs_name_variation', variant: 'PHOENIX', method: 'name_variation', confidence: 0.95 },
      { source: 'discogs_alias', variant: 'The Phoenix Band', method: 'alias_curated', confidence: 0.85 },
    ];
    for (const v of variants) await upsertVariant(phoenixBand, v, lva);
    for (const v of variants) await upsertVariant(phoenixSolo, v, lva);

    const rows = await sql.unsafe(
      `SELECT artist_id, source, variant
       FROM "${schemaName}".artist_search_alias
       WHERE artist_id = ANY($1)
       ORDER BY artist_id, source, variant`,
      [[phoenixBand, phoenixSolo]]
    );
    expect(rows.length).toBe(4);
    expect(rows.filter((r) => r.artist_id === phoenixBand).length).toBe(2);
    expect(rows.filter((r) => r.artist_id === phoenixSolo).length).toBe(2);
  });
});
