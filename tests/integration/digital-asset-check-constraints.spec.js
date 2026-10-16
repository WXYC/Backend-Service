/**
 * BS#2439 -- CHECK constraints `digital_asset_provenance_ck` and
 * `digital_asset_status_ck` reject values outside the closed vocabularies.
 *
 * Against the real database on purpose: a mocked insert cannot fail on a
 * constraint the mock never heard of (the class of gap BS#2334 exists for).
 * Each rejected insert is a separate statement, so a failed one leaves no
 * transaction state behind.
 */

const { getTestDb } = require('../utils/db');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ID = 11; // exists in the integration fixture
const FORMAT_ID = 1;

describe('digital_asset provenance/status CHECK constraints (BS#2439)', () => {
  let sql;
  let artistId;
  let libraryId;

  beforeAll(async () => {
    sql = getTestDb();
    const [a] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES ('BS2439 Fixture Artist', 'BS2439 Fixture Artist', 'ZZ')
      RETURNING id
    `;
    artistId = a.id;
    const [l] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library (artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (${artistId}, ${GENRE_ID}, ${FORMAT_ID}, 'BS2439 Fixture Album', 4390, 'BS2439 Fixture Artist')
      RETURNING id
    `;
    libraryId = l.id;
  });

  afterEach(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.digital_asset WHERE library_id = ${libraryId}`;
  });

  afterAll(async () => {
    await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ${libraryId}`;
    await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
  });

  const insertAsset = (provenance, status) =>
    sql`
      INSERT INTO ${sql(SCHEMA)}.digital_asset (library_id, provenance, disc_number, status)
      VALUES (${libraryId}, ${provenance}, 1, ${status})
    `;

  it.each([
    ['rotation_upload', 'needs_review'],
    ['rotation_upload', 'bound'],
    ['rotation_upload', 'rejected'],
    ['cd_rip', 'needs_review'],
  ])('accepts provenance %s with status %s', async (provenance, status) => {
    await expect(insertAsset(provenance, status)).resolves.toBeDefined();
  });

  it.each(['rotation_uploads', 'Rotation_Upload', ''])('rejects provenance %p', async (provenance) => {
    await expect(insertAsset(provenance, 'needs_review')).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'digital_asset_provenance_ck',
    });
  });

  it.each(['bond', 'Bound', '', 'pulled'])('rejects status %p', async (status) => {
    await expect(insertAsset('rotation_upload', status)).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'digital_asset_status_ck',
    });
  });

  it('rejects an UPDATE that moves a stored row to a status outside the vocabulary', async () => {
    await insertAsset('rotation_upload', 'needs_review');
    await expect(
      sql`UPDATE ${sql(SCHEMA)}.digital_asset SET status = 'boundd' WHERE library_id = ${libraryId}`
    ).rejects.toMatchObject({ code: '23514', constraint_name: 'digital_asset_status_ck' });
  });
});
