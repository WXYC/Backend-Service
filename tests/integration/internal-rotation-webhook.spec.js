/**
 * Integration tests for POST /internal/rotation-webhook (BS#1082, BS#1312).
 *
 * The webhook receives tubafrenzy rotation events. The acceptance criterion
 * tested here is from #1082 + #1312: when `sendRotationLinked` posts the
 * partial shape `{id, libraryReleaseId, action: 'update'}`, the receiver
 * must NOT clobber the existing row's `rotation_bin`, `kill_date`,
 * `artist_name`, `album_title`, or `record_label` with the JS-default
 * values computed for missing payload fields. The denorm trio is the
 * surface tubafrenzy + dj-site catalog views render when `album_id IS NULL`
 * — clobbering them turns Heavy rotation rows display-blind until the 30m
 * rotation-etl cron repairs them.
 *
 * The companion unit test at `tests/unit/routes/internal.route.test.ts`
 * verifies the SET-clause shape against a mocked db; this spec verifies the
 * end-to-end behavior at the row level against real Postgres.
 *
 * BS#2109 review round 3 additionally covers: `album_id` no longer un-links
 * a Backend-made link on a `libraryReleaseId: 0` delivery but still accepts
 * a genuinely resolvable one (finding 2's "better form"). An earlier
 * revision also forced the snapshot trio to NULL whenever the row resolved
 * linked; that CASE was itself a bug (it starved `linkRotationToAlbum`'s
 * self-heal path and `jobs/rotation-release-id-backfill`'s candidate query
 * of the columns they need — see `apps/backend/routes/internal.route.ts`)
 * and has been removed. The trio now always writes `excluded.*` when
 * present in the payload, same as every other gated column — a linked row
 * is allowed to keep carrying tubafrenzy's free text, which
 * `PATCH /library/rotation/:id/link` (finding 1) already leaves populated
 * for exactly this reason, and which `getRotationFromDB`'s
 * `COALESCE(artists.artist_name, rotation.artist_name)` read makes
 * display-invisible regardless.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const INTERNAL_KEY = process.env.ETL_NOTIFY_KEY || 'test-secret-key';

function makeSql() {
  return postgres({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
    database: process.env.DB_NAME || 'wxyc_db',
    user: process.env.DB_USERNAME || 'test-user',
    password: process.env.DB_PASSWORD || 'test-pw',
    onnotice: () => {},
    max: 4,
  });
}

describe('POST /internal/rotation-webhook — partial update preserves denorm fields (BS#1082 + BS#1312)', () => {
  let sql;

  // Use a legacy_rotation_id deep in a range that's unlikely to collide.
  const LEGACY_ROTATION_ID = 9_999_982;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`, [LEGACY_ROTATION_ID]);
  });

  afterEach(async () => {
    await sql.unsafe(`DELETE FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`, [LEGACY_ROTATION_ID]);
  });

  async function seedHeavyRotationRow(killDate) {
    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.rotation
         (legacy_rotation_id, rotation_bin, add_date, kill_date, artist_name, album_title, record_label)
       VALUES ($1, 'H', '2026-01-01', $2, 'Jessica Pratt', 'On Your Own Love Again', 'Drag City')`,
      [LEGACY_ROTATION_ID, killDate]
    );
  }

  test('linkage update {id, libraryReleaseId} preserves all five denorm fields (rotation_bin, kill_date, artist_name, album_title, record_label)', async () => {
    await seedHeavyRotationRow('2026-12-31');

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', release: { id: LEGACY_ROTATION_ID, libraryReleaseId: 0 } });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT rotation_bin, kill_date, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.rotation_bin).toBe('H');
    expect(row.kill_date).toEqual(new Date('2026-12-31'));
    expect(row.artist_name).toBe('Jessica Pratt');
    expect(row.album_title).toBe('On Your Own Love Again');
    expect(row.record_label).toBe('Drag City');
  });

  test('full-shape update {rotationType, killDate, artistName, albumTitle, labelName} overwrites all five denorm fields', async () => {
    await seedHeavyRotationRow('2026-12-31');

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({
        action: 'update',
        release: {
          id: LEGACY_ROTATION_ID,
          libraryReleaseId: 0,
          rotationType: 'M',
          killDate: 0,
          artistName: 'Juana Molina',
          albumTitle: 'DOGA',
          labelName: 'Sonamos',
          addDate: 1706799600000,
        },
      });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT rotation_bin, kill_date, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.rotation_bin).toBe('M');
    expect(row.kill_date).toBeNull();
    expect(row.artist_name).toBe('Juana Molina');
    expect(row.album_title).toBe('DOGA');
    expect(row.record_label).toBe('Sonamos');
  });

  // BS#2109: `PATCH /library/rotation/:id/link` creates the first
  // Backend-canonical `album_id` tubafrenzy does not know about. The
  // webhook's `album_id` SET falls back to `COALESCE(excluded.album_id,
  // rotation.album_id)` whenever the payload's own `libraryReleaseId` is
  // falsy, so a `/wxycdb` edit that arrives with `libraryReleaseId: 0` (i.e.
  // `excluded.album_id IS NULL`) cannot revert the link and drop the row
  // back into the cataloging queue.
  //
  // Review round 3 finding 1: `PATCH .../link` deliberately leaves
  // `artist_name`/`album_title`/`record_label` populated on a freshly-linked
  // row (so the tracklist picker can self-heal), which is why this row is
  // seeded WITH a populated snapshot rather than NULLs — that is the real
  // post-link shape now, not an artifact.
  //
  // Also the end-to-end proof that the COALESCE + CASE SQL is valid inside
  // `ON CONFLICT DO UPDATE`, which the mocked-db unit test cannot show.
  test('a Backend-made album_id link survives an update carrying libraryReleaseId: 0', async () => {
    const [libraryRow] = await sql.unsafe(`SELECT id FROM ${SCHEMA}.library ORDER BY id LIMIT 1`);
    expect(libraryRow).toBeDefined();

    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.rotation
         (legacy_rotation_id, album_id, rotation_bin, add_date, artist_name, album_title, record_label)
       VALUES ($1, $2, 'H', '2026-01-01', 'Link Test Artist', 'Link Test Album', 'Link Test Label')`,
      [LEGACY_ROTATION_ID, libraryRow.id]
    );

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', release: { id: LEGACY_ROTATION_ID, libraryReleaseId: 0 } });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT album_id, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    expect(row.album_id).toBe(libraryRow.id);
    // A `sendRotationLinked`-shaped payload carries no artistName key at
    // all, so the presence gate (BS#1082 + BS#1312, untouched by review
    // round 3 finding 2) keeps the snapshot columns out of SET entirely —
    // finding 1's preserved free text survives a linkage-only ping
    // unmodified.
    expect(row.artist_name).toBe('Link Test Artist');
    expect(row.album_title).toBe('Link Test Album');
    expect(row.record_label).toBe('Link Test Label');
  });

  // A linked row is allowed to keep carrying tubafrenzy's free text. An
  // earlier revision nulled the snapshot trio here whenever the row resolved
  // linked, on the theory that tubafrenzy's classic form is unconditionally
  // stale once `album_id` resolves — but that starved `linkRotationToAlbum`'s
  // tracklist-picker self-heal and `jobs/rotation-release-id-backfill`'s
  // candidate query (both need `artist_name`/`album_title` non-NULL) of the
  // columns they depend on, with no path back for a killed row. The trio now
  // writes `excluded.*` unconditionally, same as every other gated column —
  // this is purely a presence-gate question (BS#1082 + BS#1312), independent
  // of whether the row resolves linked.
  test('a full /wxycdb edit on an already-linked row still writes the trio from the payload', async () => {
    const [libraryRow] = await sql.unsafe(`SELECT id FROM ${SCHEMA}.library ORDER BY id LIMIT 1`);
    expect(libraryRow).toBeDefined();

    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.rotation
         (legacy_rotation_id, album_id, rotation_bin, add_date, artist_name, album_title, record_label)
       VALUES ($1, $2, 'H', '2026-01-01', 'Link Test Artist', 'Link Test Album', 'Link Test Label')`,
      [LEGACY_ROTATION_ID, libraryRow.id]
    );

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({
        action: 'update',
        release: {
          id: LEGACY_ROTATION_ID,
          // tubafrenzy does not know about the Backend-made link, so its own
          // classic-form fields are what it currently believes is current —
          // 0 is what it sends when it believes the row is still
          // uncatalogued.
          libraryReleaseId: 0,
          rotationType: 'M',
          killDate: 0,
          artistName: 'Updated Tubafrenzy Artist',
          albumTitle: 'Updated Tubafrenzy Album',
          labelName: 'Updated Tubafrenzy Label',
          addDate: 1706799600000,
        },
      });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT album_id, rotation_bin, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    // The link survives (COALESCE fallback, libraryReleaseId: 0) and every
    // presence-gated column — including the snapshot trio — refreshes from
    // the payload, same as an unlinked row.
    expect(row.album_id).toBe(libraryRow.id);
    expect(row.rotation_bin).toBe('M');
    expect(row.artist_name).toBe('Updated Tubafrenzy Artist');
    expect(row.album_title).toBe('Updated Tubafrenzy Album');
    expect(row.record_label).toBe('Updated Tubafrenzy Label');
  });

  // The COALESCE fallback only applies when the payload's own
  // `libraryReleaseId` is falsy (tubafrenzy doesn't know); a genuinely
  // resolvable `libraryReleaseId` (review round 3 finding 2's "better form")
  // takes the bare `excluded.album_id` branch instead — a real tubafrenzy
  // relink still lands, which the interim blanket-COALESCE shape had
  // silently revoked.
  test('an update carrying a resolvable libraryReleaseId still writes album_id', async () => {
    const [libraryRow] = await sql.unsafe(
      `SELECT id, legacy_release_id FROM ${SCHEMA}.library WHERE legacy_release_id IS NOT NULL ORDER BY id LIMIT 1`
    );
    expect(libraryRow).toBeDefined();

    await sql.unsafe(
      `INSERT INTO ${SCHEMA}.rotation
         (legacy_rotation_id, album_id, rotation_bin, add_date, artist_name, album_title, record_label)
       VALUES ($1, NULL, 'H', '2026-01-01', 'Stale Artist', 'Stale Album', 'Stale Label')`,
      [LEGACY_ROTATION_ID]
    );

    const res = await request
      .post('/internal/rotation-webhook')
      .set('X-Internal-Key', INTERNAL_KEY)
      .send({ action: 'update', release: { id: LEGACY_ROTATION_ID, libraryReleaseId: libraryRow.legacy_release_id } });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(`SELECT album_id FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`, [
      LEGACY_ROTATION_ID,
    ]);
    expect(row.album_id).toBe(libraryRow.id);
  });
});
