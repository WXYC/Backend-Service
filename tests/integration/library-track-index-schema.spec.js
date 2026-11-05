/**
 * BS#3740 — catalog search schema: `library_track_index` (the narrow table the
 * matcher reads), its sibling `library_track_data`, and the trigram indexes on
 * `library.label` and `library.alternate_artist_name`.
 *
 * Nothing writes either table yet, so this spec asserts the schema a fresh
 * migrate produces: the indexes exist with the right access method, and
 * deleting a `library` row cascades to both tables.
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

  test.each([
    ['library_label_trgm_idx', 'library', 'label'],
    ['library_alternate_artist_name_trgm_idx', 'library', 'alternate_artist_name'],
    ['library_track_index_search_doc_idx', 'library_track_index', 'search_doc'],
  ])('%s is a valid GIN index on %s.%s', async (indexName, table, column) => {
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
    expect(rows[0].def).toContain(column);
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
