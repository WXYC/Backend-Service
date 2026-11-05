/**
 * BS#3740 — catalog search schema: `library_track_index` (the narrow table the
 * matcher reads), its sibling `library_track_data`, and the trigram indexes on
 * `library.label` and `library.alternate_artist_name`.
 *
 * Nothing writes either table yet, so this spec asserts the schema a fresh
 * migrate produces: the indexes exist with the exact definitions the 0209
 * header builds by hand on prod, deleting a `library` row cascades to both
 * tables, and `source` is limited to its three values.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 2,
  });
}

describe('catalog search schema (BS#3740)', () => {
  let sql;
  const libraryIds = [];

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) {
      if (libraryIds.length > 0) {
        await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = ANY($1)`, [libraryIds]);
      }
      await sql.end();
    }
  });

  // The full definition, not a substring: the two trigram indexes are built
  // CONCURRENTLY by hand on prod from the statements in the 0209 header, and
  // `IF NOT EXISTS` keeps whatever is already there. A drifted opclass or
  // expression in the migration would pass a "contains the column" check while
  // fresh databases and prod disagreed.
  test.each([
    ['library_label_trgm_idx', 'library', 'USING gin (label gin_trgm_ops)'],
    ['library_alternate_artist_name_trgm_idx', 'library', 'USING gin (alternate_artist_name gin_trgm_ops)'],
    ['library_track_index_search_doc_idx', 'library_track_index', 'USING gin (search_doc)'],
  ])('%s is a valid index defined exactly as %s %s', async (indexName, table, usingClause) => {
    const rows = await sql.unsafe(
      `SELECT am.amname, i.indisvalid, pg_get_indexdef(c.oid) AS def
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_am am ON am.oid = c.relam
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE n.nspname = $1 AND c.relname = $2 AND t.relname = $3`,
      [SCHEMA, indexName, table]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amname).toBe('gin');
    expect(rows[0].indisvalid).toBe(true);
    expect(rows[0].def).toBe(`CREATE INDEX ${indexName} ON ${SCHEMA}.${table} ${usingClause}`);
  });

  describe('library_track_data_source_check', () => {
    test('exists on library_track_data and names the three sources', async () => {
      const rows = await sql.unsafe(
        `SELECT pg_get_constraintdef(con.oid) AS def
           FROM pg_constraint con
           JOIN pg_class t ON t.oid = con.conrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'library_track_data'
            AND con.conname = 'library_track_data_source_check' AND con.contype = 'c'`,
        [SCHEMA]
      );
      expect(rows).toHaveLength(1);
      for (const source of ['compilation', 'override', 'album_metadata']) {
        expect(rows[0].def).toContain(`'${source}'`);
      }
    });

    test.each([
      ['compilation', true],
      ['override', true],
      ['album_metadata', true],
      ['overrides', false],
      ['Album_metadata', false],
      ['', false],
    ])('source %j is accepted: %s', async (source, accepted) => {
      const [{ id }] = await sql.unsafe(
        `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
         VALUES (1, 11, 1, 'bs3740-check-probe', 9998, 'Jessica Pratt')
         RETURNING id`
      );
      libraryIds.push(id);
      const insert = sql.unsafe(
        `INSERT INTO "${SCHEMA}".library_track_data (library_id, source, tracks, fingerprint)
         VALUES ($1, $2, '[]'::jsonb, 'abc')`,
        [id, source]
      );
      if (accepted) {
        await expect(insert).resolves.toBeDefined();
      } else {
        await expect(insert).rejects.toMatchObject({ code: '23514' });
      }
    });
  });

  test('deleting a library row cascades to library_track_index and library_track_data', async () => {
    const [{ id }] = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
       VALUES (1, 11, 1, 'bs3740-cascade-probe', 9999, 'Juana Molina')
       RETURNING id`
    );
    libraryIds.push(id);

    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_track_index (library_id, search_doc)
       VALUES ($1, to_tsvector('simple', 'la paradoja'))`,
      [id]
    );
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}".library_track_data
         (library_id, source, source_batch, discogs_release_id, tracks, fingerprint, refreshed_at)
       VALUES ($1, 'override', NULL, NULL, '[{"title":"la paradoja","position":"A1","artist_credits":[]}]'::jsonb, 'abc', now())`,
      [id]
    );

    await sql.unsafe(`DELETE FROM "${SCHEMA}".library WHERE id = $1`, [id]);

    const [{ n }] = await sql.unsafe(
      `SELECT (SELECT count(*) FROM "${SCHEMA}".library_track_index WHERE library_id = $1)::int
            + (SELECT count(*) FROM "${SCHEMA}".library_track_data WHERE library_id = $1)::int AS n`,
      [id]
    );
    expect(n).toBe(0);
  });

  test.each([
    ['library_track_index', `(library_id, search_doc) VALUES (2147483000, ''::tsvector)`],
    [
      'library_track_data',
      `(library_id, source, tracks, fingerprint) VALUES (2147483000, 'override', '[]'::jsonb, 'abc')`,
    ],
  ])('%s rejects a library_id with no library row', async (table, insertTail) => {
    await expect(sql.unsafe(`INSERT INTO "${SCHEMA}".${table} ${insertTail}`)).rejects.toMatchObject({
      code: '23503',
    });
  });
});
