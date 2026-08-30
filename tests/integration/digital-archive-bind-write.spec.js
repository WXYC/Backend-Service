/**
 * Integration tests for the REAL shipped functions of
 * `jobs/digital-archive-bind`, against a real Postgres (BS#2319 AC:
 * "a fixture inventory against seeded rotation + library rows produces the
 * expected needs_review set; re-running is a no-op; import flips exactly
 * the listed rows").
 *
 * Exercises the pipeline root-to-write: `candidates.ts` loads the
 * `rotation`/`library` match targets, `match.ts` resolves a hand-built
 * `CandidateAlbum` (standing in for what `group.ts` would produce from a
 * real S3 inventory -- the S3/tag-read legs are unit-tested elsewhere and
 * don't need a database), and `write.ts` plans and executes the DB writes.
 *
 * Needs CI to run: requires the Docker integration DB (the `pg` marker
 * tier). When `write.ts`/`match.ts`/`candidates.ts` change, rebuild
 * (`npm run build --workspace=@wxyc/digital-archive-bind`); CI's Build step
 * produces `dist/*.cjs` before the integration tier runs.
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (written for
// the ts-jest unit tier) is AUTOMATICALLY applied to every `drizzle-orm`
// require. Our compiled `dist/*.cjs` modules require the REAL drizzle-orm,
// so unmock it. Hoisted above the requires below by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const jobDist = (name) => path.join(__dirname, '..', '..', 'jobs', 'digital-archive-bind', 'dist', name);
const candidates = require(jobDist('candidates.cjs'));
const match = require(jobDist('match.cjs'));
const write = require(jobDist('write.cjs'));

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const GENRE_ID = 11; // exists in the integration fixture
const FORMAT_ID = 1;

const emptyTags = {
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  track: null,
  disc: null,
  durationMs: null,
};

const candidateAlbum = ({ contentKind, artist, album, objectKeys, discNumber = 1 }) => ({
  contentKind,
  artistFoldKey: artist.toLowerCase(),
  albumNormKey: album.toLowerCase(),
  discNumber,
  displayArtist: artist,
  displayAlbum: album,
  files: objectKeys.map((objectKey, i) => ({
    objectKey,
    contentKind,
    codec: 'mp3',
    bytes: 1000 + i,
    md5: null,
    tags: { ...emptyTags, artist, album, track: i + 1 },
  })),
});

describe('digital-archive-bind — REAL write functions (real PG)', () => {
  let sql;
  let artistId;
  const libraryIds = [];
  const assetIds = [];

  beforeAll(async () => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    const [a] = await sql`
      INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
      VALUES ('BS2319 Fixture Artist', 'BS2319 Fixture Artist', 'ZZ')
      RETURNING id
    `;
    artistId = a.id;
  });

  afterEach(async () => {
    try {
      if (assetIds.length > 0) {
        await sql`DELETE FROM ${sql(SCHEMA)}.digital_asset_file WHERE asset_id = ANY(${assetIds})`;
        await sql`DELETE FROM ${sql(SCHEMA)}.digital_asset WHERE id = ANY(${assetIds})`;
      }
      if (libraryIds.length > 0) {
        await sql`DELETE FROM ${sql(SCHEMA)}.rotation WHERE album_id = ANY(${libraryIds})`;
        await sql`DELETE FROM ${sql(SCHEMA)}.library WHERE id = ANY(${libraryIds})`;
      }
      if (artistId) await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id = ${artistId}`;
    } finally {
      assetIds.length = 0;
      libraryIds.length = 0;
      artistId = null;
    }
  });

  const seedLibrary = async (albumTitle, extra = {}) => {
    const [row] = await sql`
      INSERT INTO ${sql(SCHEMA)}.library
        (artist_id, genre_id, format_id, album_title, code_number, artist_name)
      VALUES (${artistId}, ${GENRE_ID}, ${FORMAT_ID}, ${albumTitle}, ${Math.floor(Math.random() * 30_000) + 1}, ${extra.artistName ?? 'BS2319 Fixture Artist'})
      RETURNING id
    `;
    libraryIds.push(row.id);
    return row.id;
  };

  it('a freeform candidate matched against a seeded library row inserts a needs_review asset + its files, and re-running is a no-op', async () => {
    const libraryId = await seedLibrary('BS2319 Freeform Album');

    const libraryCandidates = await candidates.loadLibraryCandidates();
    const album = candidateAlbum({
      contentKind: 'freeform',
      artist: 'BS2319 Fixture Artist',
      album: 'BS2319 Freeform Album',
      objectKeys: [
        'library/freeform/BS2319 Fixture Artist/BS2319 Freeform Album/01.mp3',
        'library/freeform/BS2319 Fixture Artist/BS2319 Freeform Album/02.mp3',
      ],
    });
    const result = match.matchLibrary(album, libraryCandidates);
    expect(result.kind).toBe('matched');
    expect(result.libraryId).toBe(libraryId);

    const matched = { candidate: album, libraryId: result.libraryId, tier: result.tier, bindNote: result.note };

    const storeId = await write.ensureStore();
    const existingBefore = await write.loadExistingSlots([libraryId]);
    const plan1 = write.planWrites([matched], existingBefore, new Map(), new Set());
    expect(plan1.toInsert).toHaveLength(1);

    const counts1 = await write.executeWrites(plan1, storeId);
    expect(counts1.inserted).toBe(1);
    expect(counts1.filesWritten).toBe(2);

    const assetRows = await sql`
      SELECT id, status, provenance, disc_number FROM ${sql(SCHEMA)}.digital_asset WHERE library_id = ${libraryId}
    `;
    expect(assetRows).toHaveLength(1);
    expect(assetRows[0].status).toBe('needs_review');
    expect(assetRows[0].provenance).toBe('rotation_upload');
    assetIds.push(assetRows[0].id);

    const fileRows = await sql`
      SELECT object_key FROM ${sql(SCHEMA)}.digital_asset_file WHERE asset_id = ${assetRows[0].id} ORDER BY object_key
    `;
    expect(fileRows.map((r) => r.object_key)).toEqual(album.files.map((f) => f.objectKey).sort());

    // Re-run: the slot now holds a needs_review row, so the plan must insert nothing more.
    const existingAfter = await write.loadExistingSlots([libraryId]);
    const plan2 = write.planWrites([matched], existingAfter, new Map(), new Set());
    expect(plan2.toInsert).toHaveLength(0);
    const counts2 = await write.executeWrites(plan2, storeId);
    expect(counts2.inserted).toBe(0);
    expect(counts2.filesWritten).toBe(0);

    const assetRowsAfter = await sql`SELECT id FROM ${sql(SCHEMA)}.digital_asset WHERE library_id = ${libraryId}`;
    expect(assetRowsAfter).toHaveLength(1); // no duplicate
  });

  it('a rotation-derived candidate matches against a seeded rotation row, not library', async () => {
    const libraryId = await seedLibrary('BS2319 Rotation Album');
    await sql`
      INSERT INTO ${sql(SCHEMA)}.rotation (album_id, rotation_bin, artist_name, album_title)
      VALUES (${libraryId}, 'H', 'BS2319 Fixture Artist', 'BS2319 Rotation Album')
    `;

    const rotationCandidates = await candidates.loadRotationCandidates();
    const album = candidateAlbum({
      contentKind: 'rotation_bin',
      artist: 'BS2319 Fixture Artist',
      album: 'BS2319 Rotation Album',
      objectKeys: ['rotation/Heavy/01.mp3'],
    });
    const result = match.matchRotation(album, rotationCandidates);
    expect(result).toEqual({ kind: 'matched', libraryId, tier: 'exact', note: 'exact' });
  });

  it('the review import flips exactly the rows a reviewer decided, and only from needs_review', async () => {
    const libA = await seedLibrary('BS2319 Import A');
    const libB = await seedLibrary('BS2319 Import B');
    const storeId = await write.ensureStore();

    const albumA = candidateAlbum({
      contentKind: 'freeform',
      artist: 'BS2319 Fixture Artist',
      album: 'BS2319 Import A',
      objectKeys: ['a.mp3'],
    });
    const albumB = candidateAlbum({
      contentKind: 'freeform',
      artist: 'BS2319 Fixture Artist',
      album: 'BS2319 Import B',
      objectKeys: ['b.mp3'],
    });
    const matchedA = { candidate: albumA, libraryId: libA, tier: 'exact', bindNote: 'exact' };
    const matchedB = { candidate: albumB, libraryId: libB, tier: 'exact', bindNote: 'exact' };

    const plan = write.planWrites([matchedA, matchedB], [], new Map(), new Set());
    await write.executeWrites(plan, storeId);

    const rows = await sql`
      SELECT id, library_id FROM ${sql(SCHEMA)}.digital_asset WHERE library_id = ANY(${[libA, libB]}) ORDER BY library_id
    `;
    rows.forEach((r) => assetIds.push(r.id));
    const idA = rows.find((r) => r.library_id === libA).id;
    const idB = rows.find((r) => r.library_id === libB).id;

    const result = await write.applyReviewDecisions([
      { assetId: idA, decision: 'bound' },
      { assetId: idB, decision: 'rejected' },
    ]);
    expect(result.rowsUpdated).toBe(2);

    const after = await sql`SELECT id, status FROM ${sql(SCHEMA)}.digital_asset WHERE id = ANY(${[idA, idB]})`;
    expect(after.find((r) => r.id === idA).status).toBe('bound');
    expect(after.find((r) => r.id === idB).status).toBe('rejected');

    // Re-importing the SAME decisions again is a no-op: both rows are no longer needs_review.
    const second = await write.applyReviewDecisions([
      { assetId: idA, decision: 'rejected' },
      { assetId: idB, decision: 'bound' },
    ]);
    expect(second.rowsUpdated).toBe(0);
    const stillAfter = await sql`SELECT id, status FROM ${sql(SCHEMA)}.digital_asset WHERE id = ANY(${[idA, idB]})`;
    expect(stillAfter.find((r) => r.id === idA).status).toBe('bound');
    expect(stillAfter.find((r) => r.id === idB).status).toBe('rejected');
  });

  it('never writes into a bound slot and reports drift when the candidate keys differ', async () => {
    const libraryId = await seedLibrary('BS2319 Drift Album');
    const storeId = await write.ensureStore();

    const original = candidateAlbum({
      contentKind: 'freeform',
      artist: 'BS2319 Fixture Artist',
      album: 'BS2319 Drift Album',
      objectKeys: ['original.mp3'],
    });
    const matchedOriginal = { candidate: original, libraryId, tier: 'exact', bindNote: 'exact' };
    const plan0 = write.planWrites([matchedOriginal], [], new Map(), new Set());
    await write.executeWrites(plan0, storeId);

    const [assetRow] = await sql`SELECT id FROM ${sql(SCHEMA)}.digital_asset WHERE library_id = ${libraryId}`;
    assetIds.push(assetRow.id);
    await sql`UPDATE ${sql(SCHEMA)}.digital_asset SET status = 'bound' WHERE id = ${assetRow.id}`;

    const drifted = candidateAlbum({
      contentKind: 'freeform',
      artist: 'BS2319 Fixture Artist',
      album: 'BS2319 Drift Album',
      objectKeys: ['replaced.mp3'],
    });
    const matchedDrifted = { candidate: drifted, libraryId, tier: 'exact', bindNote: 'exact' };

    const existing = await write.loadExistingSlots([libraryId]);
    const boundFiles = await write.loadBoundFileKeys([assetRow.id]);
    const plan = write.planWrites([matchedDrifted], existing, boundFiles, new Set());

    expect(plan.toInsert).toHaveLength(0);
    expect(plan.boundDrift).toEqual([
      { assetId: assetRow.id, libraryId, discNumber: 1, candidateKeys: ['replaced.mp3'], boundKeys: ['original.mp3'] },
    ]);

    await write.executeWrites(plan, storeId);
    const stillOriginal =
      await sql`SELECT object_key FROM ${sql(SCHEMA)}.digital_asset_file WHERE asset_id = ${assetRow.id}`;
    expect(stillOriginal.map((r) => r.object_key)).toEqual(['original.mp3']);
  });
});
