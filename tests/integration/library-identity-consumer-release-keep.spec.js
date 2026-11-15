/**
 * BS#3809 — the library-identity-consumer writes the main-row Discogs release
 * that an MD pin decided, and keeps it when LML later sends null.
 *
 * Runs the REAL compiled `writeSingleArtist`
 * (`jobs/library-identity-consumer/dist/writer.cjs`) through `@wxyc/database`'s
 * postgres-js driver against the live `library_identity` table. LML is not
 * involved: each test hands the writer the bulk-resolve result LML would send.
 *
 * Rebuild after editing the job (`npm run build --workspace=@wxyc/library-identity-consumer`).
 *
 * @see WXYC/Backend-Service#3809
 * @see WXYC/Backend-Service#3790
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock is auto-applied
// to every `drizzle-orm` require. The compiled bundle needs the real one.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'library-identity-consumer', 'dist');
const { writeSingleArtist } = require(path.join(distDir, 'writer.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

const answer = (library_id, release = {}) => ({
  kind: 'single_artist',
  library_id,
  main: { discogs_artist_id: 82730, wikidata_qid: 'Q3809' },
  method: release.discogs_release_id ? 'manual' : 'exact_match',
  confidence: release.discogs_release_id ? 1.0 : 0.9,
  provenance: [{ source: 'discogs', method: 'exact_match', confidence: 1.0, external_id: '82730' }],
  discogs_release_id: null,
  discogs_master_id: null,
  ...release,
});

describe('BS#3809 library-identity-consumer keeps the pinned release (REAL upsert, real PG)', () => {
  let sql;
  const libraryIds = [];

  const seed = async (suffix) => {
    const [{ id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number)
      VALUES (1, 11, 1, ${'bs3809-release-keep-' + suffix}, 9999)
      RETURNING id
    `;
    libraryIds.push(id);
    return id;
  };

  const read = async (id) => {
    const [row] = await sql`
      SELECT discogs_release_id, discogs_master_id, method, wikidata_qid, notes
        FROM ${sql(SCHEMA)}.library_identity WHERE library_id = ${id}
    `;
    return row;
  };

  beforeAll(() => {
    sql = getTestDb();
  });

  afterAll(async () => {
    if (libraryIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.library_identity_source WHERE library_id = ANY(${libraryIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_identity WHERE library_id = ANY(${libraryIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
    }
    // The pool is shared with the rest of the integration suite; do NOT close it.
  });

  test('an answer with a release writes it, a later null keeps it, a later different release replaces it', async () => {
    const id = await seed('sequence');

    await writeSingleArtist(answer(id, { discogs_release_id: 5559001, discogs_master_id: 77 }));
    expect(await read(id)).toMatchObject({ discogs_release_id: 5559001, discogs_master_id: 77, method: 'manual' });

    await writeSingleArtist(answer(id));
    expect(await read(id)).toMatchObject({
      discogs_release_id: 5559001,
      discogs_master_id: 77,
      // The rest of the row still follows LML.
      method: 'exact_match',
      wikidata_qid: 'Q3809',
      notes: 'consumer:lml-bulk',
    });

    await writeSingleArtist(answer(id, { discogs_release_id: 530321, discogs_master_id: 88 }));
    expect(await read(id)).toMatchObject({ discogs_release_id: 530321, discogs_master_id: 88 });
  });

  test('a new release without a master clears the old release’s master', async () => {
    const id = await seed('no-master');

    await writeSingleArtist(answer(id, { discogs_release_id: 5559001, discogs_master_id: 77 }));
    await writeSingleArtist(answer(id, { discogs_release_id: 530321, discogs_master_id: null }));

    expect(await read(id)).toMatchObject({ discogs_release_id: 530321, discogs_master_id: null });
  });

  test('a row LML never pinned stays without a release', async () => {
    const id = await seed('never-pinned');

    await writeSingleArtist(answer(id));
    await writeSingleArtist(answer(id));

    expect(await read(id)).toMatchObject({ discogs_release_id: null, discogs_master_id: null });
  });
});
