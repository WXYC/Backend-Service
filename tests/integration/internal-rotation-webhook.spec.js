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
 * a genuinely resolvable one (finding 2's "better form"), and the snapshot
 * trio is forced to NULL rather than written whenever the row resolves
 * linked — regardless of whether the link came from
 * `PATCH /library/rotation/:id/link` or from this same webhook call
 * (finding 2), reconciled against `PATCH .../link`'s decision to leave a
 * fresh link's own snapshot populated for the tracklist picker's self-heal
 * (finding 1).
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

  // Review round 3 finding 3: the prior version of this test sent the
  // `sendRotationLinked` shape (`{id, libraryReleaseId: 0}`), which carries
  // no `artistName` — so the presence gate excludes the snapshot columns
  // from SET entirely and the assertion below never exercised finding 2's
  // CASE branch at all, regardless of what it asserted. The scenario this
  // test's name describes — "the next /wxycdb edit" — is the
  // `sendRotationUpdated` shape, which DOES carry the trio. Sent against
  // that shape, a linked row must end up with the trio NULLed (finding 2),
  // not carrying whatever free text tubafrenzy's classic form still has for
  // it — tubafrenzy has no idea the row is linked, so its own free-text
  // fields are unconditionally treated as stale once `album_id` resolves.
  test('a full /wxycdb edit on an already-linked row nulls the free-text snapshot instead of writing it back', async () => {
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
          // classic-form fields are the stale free text — 0 is what it
          // sends when it believes the row is still uncatalogued.
          libraryReleaseId: 0,
          rotationType: 'M',
          killDate: 0,
          artistName: 'Stale Tubafrenzy Artist',
          albumTitle: 'Stale Tubafrenzy Album',
          labelName: 'Stale Tubafrenzy Label',
          addDate: 1706799600000,
        },
      });
    expect(res.status).toBe(200);

    const [row] = await sql.unsafe(
      `SELECT album_id, rotation_bin, artist_name, album_title, record_label
         FROM ${SCHEMA}.rotation WHERE legacy_rotation_id = $1`,
      [LEGACY_ROTATION_ID]
    );
    // The link survives (COALESCE fallback, libraryReleaseId: 0) and the
    // presence-gated, non-linkage column (rotation_bin) still refreshes...
    expect(row.album_id).toBe(libraryRow.id);
    expect(row.rotation_bin).toBe('M');
    // ...but the snapshot trio is forced to NULL rather than overwritten
    // with tubafrenzy's stale free text, since the row resolves linked.
    expect(row.artist_name).toBeNull();
    expect(row.album_title).toBeNull();
    expect(row.record_label).toBeNull();
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
