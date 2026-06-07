const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const postgres = require('postgres');
const fls_util = require('../utils/flowsheet_util');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Per-spec sql client used by the #712 cross-show snapshot test below.
// Mirrors the client construction in tests/integration/migrations.spec.js.
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

/*
 * Start Show (Primary dj hits /flowsheet/join)
 */
describe('Start Show', () => {
  // Clean up by ending show
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const res = await request.post('/flowsheet/join').set('Authorization', global.access_token).send({
      dj_id: global.primary_dj_id,
      show_name: 'test_show',
    });

    expect(res.body.id).toBeDefined();
    expect(res.body.primary_dj_id).toBeDefined();
    expect(res.body.start_time).toBeDefined();
    expect(res.body.show_name).toEqual('test_show');
    expect(res.body.end_time).toBeNull();
  });
});

/*
 * Start Show with dj_name_override (BS#1295 → BS#1321 / epic #1288).
 *
 * Verifies the new per-show override path lands the supplied name in:
 *   - the show_start marker `flowsheet.message` body
 *   - the `flowsheet.dj_name` column on the marker
 *   - the `shows.dj_name_override` column (BS#1321 — was `legacy_dj_name`
 *     in BS#1295; redirected here because `legacy_dj_name` is owned by
 *     the tubafrenzy ETL upsert)
 *   - the `flowsheet.dj_name` column on every TRACK row added after join
 *     (BS#1321 — pre-fix, track rows reverted to `auth_user.dj_name` and
 *     produced within-show inconsistency)
 * regardless of the caller's `auth_user.dj_name`. Also exercises the
 * length-cap rejection and the empty-string / whitespace fallback.
 */
describe('Start Show with dj_name_override', () => {
  let sql;

  beforeAll(() => {
    sql = makeSql();
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('override populates flowsheet marker, flowsheet.dj_name, and shows.dj_name_override', async () => {
    const overrideName = 'Aubrey Hearst';
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
        dj_name_override: overrideName,
      })
      .expect(200);

    expect(res.body.id).toBeDefined();
    const showId = res.body.id;

    // Pull the show row and the show_start flowsheet entry from the DB.
    // BS#1321: override lives in dj_name_override; legacy_dj_name is left
    // alone so the tubafrenzy ETL upsert is not surprised by it.
    const showRows = await sql`
      SELECT dj_name_override, legacy_dj_name FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}
    `;
    expect(showRows.length).toBe(1);
    expect(showRows[0].dj_name_override).toEqual(overrideName);
    expect(showRows[0].legacy_dj_name).toBeNull();

    const markerRows = await sql`
      SELECT dj_name, message
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE show_id = ${showId} AND entry_type = 'show_start'
       LIMIT 1
    `;
    expect(markerRows.length).toBe(1);
    expect(markerRows[0].dj_name).toEqual(overrideName);
    expect(markerRows[0].message).toMatch(new RegExp(`^Start of Show: ${overrideName} joined the set at `));
    expect(markerRows[0].message).not.toMatch(/\bDJ\b/); // locked decision: no "DJ" prefix
  });

  test('override propagates to track rows added after join (BS#1321)', async () => {
    // This is the C1 fix from issue #1321: pre-fix the override only landed
    // on the show_start marker row, and any subsequent /flowsheet POST went
    // through `resolveDjNameForShow` which prefers `auth_user.dj_name` over
    // the override. The result was within-show inconsistency — marker says
    // "Aubrey Hearst", track rows say "DJ Stardust" (or whatever the
    // operator's auth_user.dj_name happens to be — for the seeded test DJ
    // it's "Test dj1").
    //
    // Post-#1321 every track row inserted during a show whose
    // dj_name_override is non-null reflects the override on `flowsheet.dj_name`.
    const overrideName = 'Aubrey Hearst';
    const join = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
        dj_name_override: overrideName,
      })
      .expect(200);

    const showId = join.body.id;

    // Add a from-library track
    const track1 = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, // Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
      })
      .expect(201);

    // Add a free-form track to cover both branches of the addEntry controller
    const track2 = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        record_label: 'Sonamos',
      })
      .expect(201);

    // Add a message entry — the override should reach those too since
    // addEntry plumbs dj_name through every branch.
    const msg = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        message: 'Top of the hour',
      })
      .expect(201);

    const rows = await sql`
      SELECT id, entry_type, dj_name
        FROM ${sql(SCHEMA)}.flowsheet
       WHERE show_id = ${showId} AND id IN (${track1.body.id}, ${track2.body.id}, ${msg.body.id})
       ORDER BY id ASC
    `;

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.dj_name).toEqual(overrideName);
    }
  });

  test('whitespace-only override is ignored — no regression vs baseline', async () => {
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
        dj_name_override: '   ',
      })
      .expect(200);

    const showId = res.body.id;

    const showRows = await sql`
      SELECT dj_name_override, legacy_dj_name FROM ${sql(SCHEMA)}.shows WHERE id = ${showId}
    `;
    expect(showRows.length).toBe(1);
    expect(showRows[0].dj_name_override).toBeNull();
    expect(showRows[0].legacy_dj_name).toBeNull();
  });

  test('override > 255 chars is rejected with 400', async () => {
    const overflow = 'a'.repeat(256);
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
        dj_name_override: overflow,
      })
      .expect(400);

    expect(res.body.message).toBeDefined();
    // No show was created — exit the afterEach cleanly. The afterEach
    // fires leave_show, which is a no-op when there's no active show.
  });
});

/*
 * Join Show (Secondary dj(s) hits /flowsheet/join)
 */
describe('Join Show', () => {
  beforeEach(async () => {
    // Start show with primary dj
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    // Clean up and end show
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    // BS#1098: dj_id must match the authenticated caller, so the secondary
    // DJ joins with their own Bearer (raw user-id token, accepted by
    // AUTH_BYPASS — see tests/setup/integration.setup.js).
    const res = await request
      .post('/flowsheet/join')
      .set('Authorization', global.secondary_access_token)
      .send({
        dj_id: global.secondary_dj_id,
      })
      .expect(200);
  });
});

/*
 * End Show (Primary dj hits /flowsheet/end)
 */
describe('End Show', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  // Ensure that primary dj ends the show for all show djs
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Primary DJ Leaves', async () => {
    await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
      })
      .expect(200);
  });

  test('No Active Show Session', async () => {
    // End active show
    await request.post('/flowsheet/end').set('Authorization', global.access_token).send({
      dj_id: global.primary_dj_id,
    });

    // Secondary DJ attempts to /flowsheet/end after the show is over.
    // BS#1102: dj_id must match the authenticated caller, so the secondary
    // DJ has to send their own Bearer to get past the auth check; the
    // 400 then comes from "No active show".
    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.secondary_access_token)
      .send({
        dj_id: global.secondary_dj_id,
      })
      .expect(400);
    expect(res.body.message).toBeDefined();
  });
});

/*
 * Leave Show (Secondary dj hits /flowsheet/end)
 */
describe('Leave Show', () => {
  beforeEach(async () => {
    // Start show
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    // Second DJ joins under their own auth (BS#1098 cross-check).
    await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token);
  });

  // Ensure that primary dj ends the show for all show djs
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly formatted request', async () => {
    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: global.primary_dj_id,
      })
      .expect(200);
  });

  test('Forbidden when dj_id does not match the authenticated user (BS#1102)', async () => {
    // Pre-fix this test passed dj_id=1000 with primary's token and expected
    // a 400 from the downstream "DJ not in show" path. Post-fix the
    // controller rejects the dj_id≠auth.id mismatch with 403 before that
    // path is reached — which is the more secure outcome (the body never
    // reaches the show-membership check).
    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.access_token)
      .send({
        dj_id: 1000,
      })
      .expect(403);
    // WxycError serializes as `{ message }` (see middleware/errorHandler.ts).
    expect(res.body.message).toBeDefined();
  });

  test('No Active Show Session', async () => {
    // End active show
    await request.post('/flowsheet/end').set('Authorization', global.access_token).send({
      dj_id: global.primary_dj_id,
    });

    // Secondary DJ attempts to /flowsheet/end the (now-ended) show. BS#1102
    // requires the secondary's own Bearer for the dj_id=auth.id cross-check.
    const res = await request
      .post('/flowsheet/end')
      .set('Authorization', global.secondary_access_token)
      .send({
        dj_id: global.secondary_dj_id,
      })
      .expect(400);
    expect(res.body.message).toBeDefined();
  });
});

/*
 * Add Flowsheet Entries
 */
describe('Add to Flowsheet', () => {
  // Setup: Start Show
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  // Cleanup: End Show
  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('With Album ID', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        // record_label: 'Warner Bros',
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
  });

  test('With Album ID && Rotation ID', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        rotation_id: 1,
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
  });

  test('With Album ID & Record Label', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        record_label: 'Warner Bros',
      })
      .expect(201);

    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
    expect(res.body.record_label).toEqual('Warner Bros');
  });

  test('With Album ID & Request Flag', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        request_flag: true,
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.request_flag).toBeTruthy();
  });

  test('With Album Title & Artist Name', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Build to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
  });

  test('With Album Title, Artist Name, & Record Label', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Build to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
        record_label: 'Warner Bros',
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
    expect(res.body.record_label).toEqual('Warner Bros');
  });

  test('With Album Title, Artist Name, & Request Flag', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Build to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
        request_flag: true,
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');
  });

  test('With album_id explicitly null + rotation snapshot fields (BS#933)', async () => {
    // BS#689 made the rotation dropdown LEFT JOIN library so unlinked
    // rotation rows (album_id IS NULL) become selectable. dj-site dispatches
    // the chosen row with `album_id: null` and the rotation snapshot fields
    // (artist_name, album_title, record_label). The controller must treat
    // this as a free-form insert — not a library lookup — and return 201,
    // not 500. Without the BS#933 fix the snapshot path crashed with a
    // TypeError because `getAlbumFromDB(null)` returned undefined.
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: null,
        artist_name: 'Coupé Cloué',
        album_title: 'Maintenant ou Jamais',
        track_title: 'Manman',
        record_label: 'Mini Records',
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.artist_name).toEqual('Coupé Cloué');
    expect(res.body.album_title).toEqual('Maintenant ou Jamais');
    expect(res.body.track_title).toEqual('Manman');
    expect(res.body.record_label).toEqual('Mini Records');
  });

  test('With album_id null + rotation_id + snapshot fields (BS#1308)', async () => {
    // Rotation albums that aren't in the WXYC library catalog (LEFT JOIN to
    // library yields id: null on /library/rotation) need to preserve rotation
    // linkage on the wire so the V2 read path can JOIN back to rotation for
    // rotation_bin and the iOS rotation-artwork resolver can find the entry.
    // Pre-fix, dj-site either synthesized a negative album_id (defect class
    // #564/#608/#698/#701) or fell back to FlowsheetCreateSongFreeform and
    // dropped rotation_id on the wire. wxyc-shared#158 added rotation_id to
    // the freeform variant; this pins that BS persists it through the
    // snapshot/else branch alongside album_id IS NULL.
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: null,
        rotation_id: 1, // Built to Spill — Keep it Like a Secret (seed rotation row)
        artist_name: 'Noura Mint Seymali',
        album_title: 'Tzenni',
        track_title: 'Tzenni',
        record_label: 'Glitterbeat',
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.album_id).toBeNull();
    expect(res.body.rotation_id).toEqual(1);
    expect(res.body.artist_name).toEqual('Noura Mint Seymali');
    expect(res.body.album_title).toEqual('Tzenni');
    expect(res.body.track_title).toEqual('Tzenni');
  });

  test('With track_position (BS#943, album_id branch)', async () => {
    // The dj-site flowsheet picker (E6-6) calls /proxy/library/{id}/tracks
    // after a release pick, then submits the chosen track with the library
    // `album_id` plus the Discogs `release_track.position` string (e.g. "A1").
    // BS#835 shipped the column + read projection; this pins the controller
    // forwarding it through to PG and the V2 read shape returning it.
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, // Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        track_position: 'A1',
      })
      .expect(201);

    expect(res.body.track_title).toEqual('Carry the Zero');
    expect(res.body.track_position).toEqual('A1');
  });

  test('With track_position (BS#943, free-form branch)', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        artist_name: 'Juana Molina',
        album_title: 'DOGA',
        track_title: 'la paradoja',
        track_position: 'B2',
        record_label: 'Sonamos',
      })
      .expect(201);

    expect(res.body.track_title).toEqual('la paradoja');
    expect(res.body.track_position).toEqual('B2');
  });

  test('Flowsheet Message', async () => {
    const res = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        message: 'Test Message',
      })
      .expect(201);

    expect(res.body).toBeDefined();
    expect(res.body.message).toEqual('Test Message');
    // These are empty strings as of now, but should be null
    // expect(res.body.artist_name).toBeNull();
    // expect(res.body.album_title).toBeNull();
    // expect(res.body.track_title).toBeNull();
  });
});

/*
 * Update Flowsheet Entries
 */
describe('Update Flowsheet Entries', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('PATCH updates track_position end-to-end (BS#943)', async () => {
    // The unit test for `updateEntry` mocks the service. This pins the
    // actual UPDATE wire path through Postgres: a row with
    // `track_position: 'A1'` posted, patched to 'B2', then cleared to null.
    // Drizzle's `db.update(flowsheet).set(data).returning()` is the entire
    // wiring on the service side; the PATCH response is the updated row,
    // so we can read `track_position` directly off the response body.
    const created = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, // Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
        track_position: 'A1',
      })
      .expect(201);

    expect(created.body.track_position).toEqual('A1');
    const entry_id = created.body.id;
    expect(entry_id).toBeDefined();

    const patched = await request
      .patch('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id,
        data: { track_position: 'B2' },
      })
      .expect(200);

    expect(patched.body.id).toEqual(entry_id);
    expect(patched.body.track_position).toEqual('B2');

    const cleared = await request
      .patch('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id,
        data: { track_position: null },
      })
      .expect(200);

    expect(cleared.body.id).toEqual(entry_id);
    expect(cleared.body.track_position).toBeNull();
  });
});

/*
 * Retrieve Flowsheet Entries
 */
describe('Retrieve Flowsheet Entries', () => {
  beforeEach(async () => {
    // first show
    const res = await fls_util.join_show(global.primary_dj_id, global.access_token);
    res.body.id;
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 1, //Built to Spill - Keep it Like a Secret
      track_title: 'The Plan',
    });

    // second show
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 2, //Ravyn Lenae - Crush
      track_title: 'Venom',
    });
    await fls_util.leave_show(global.primary_dj_id, global.access_token);

    // third show
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 3, //Jockstrap - I Love You Jennifer B
      track_title: 'Debra',
    });
    await fls_util.leave_show(global.primary_dj_id, global.access_token);

    // fourth show
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 1, //Built to Spill - Keep it Like a Secret
      track_title: 'Carry the Zero',
    });
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request w/o Query Param', async () => {
    const res = await request.get('/flowsheet').send().expect(200);

    expect(res.body.entries.length).toEqual(30);
    expect(res.body.total).toBeDefined();
    expect(res.body.page).toBeDefined();
    expect(res.body.limit).toBeDefined();
    expect(res.body.totalPages).toBeDefined();
  });

  test('Properly Formatted Request w/ 3 entries', async () => {
    const res = await request.get('/flowsheet').query({ limit: 3 }).send().expect(200);

    const entries = res.body.entries;

    expect(entries[0].show_id).not.toBeNull();
    expect(entries[1].show_id).not.toBeNull();
    expect(entries[2].show_id).not.toBeNull();

    // All entries should have entry_type (discriminated union)
    entries.forEach((entry) => {
      expect(entry.entry_type).toBeDefined();
    });

    // First entry is show_end (has dj_name and timestamp, not message)
    expect(entries[0].entry_type).toEqual('show_end');
    expect(entries[0].dj_name).toBeDefined();
    expect(entries[0].timestamp).toBeDefined();

    // Second entry is a track
    expect(entries[1].entry_type).toEqual('track');
    expect(entries[1].artist_name).toEqual('Built to Spill');
    expect(entries[1].album_title).toEqual('Keep it Like a Secret');
    expect(entries[1].track_title).toEqual('Carry the Zero');

    // Third entry is show_start (has dj_name and timestamp)
    expect(entries[2].entry_type).toEqual('show_start');
    expect(entries[2].dj_name).toBeDefined();
    expect(entries[2].timestamp).toBeDefined();

    expect(entries.length).toEqual(3);
  });

  test('Get entries from 3 latest shows', async () => {
    const res = await request.get('/flowsheet').query({ shows_limit: 3 }).send().expect(200);

    // Should include entries from current show and previous 2 shows
    expect(res.body.length).toBeGreaterThan(0);

    // Check that we have entries from all 3 shows
    const showIds = [...new Set(res.body.map((entry) => entry.show_id))];
    expect(showIds.length).toBe(3);

    // Verify the content of track entries
    const trackEntries = res.body.filter((entry) => entry.entry_type === 'track');
    expect(trackEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artist_name: 'Jockstrap',
          album_title: 'I Love You Jennifer B',
          track_title: 'Debra',
        }),
        expect.objectContaining({
          artist_name: 'Ravyn Lenae',
          album_title: 'Crush',
          track_title: 'Venom',
        }),
        expect.objectContaining({
          artist_name: 'Built to Spill',
          album_title: 'Keep it Like a Secret',
          track_title: 'Carry the Zero',
        }),
      ])
    );
  });

  test('Get entries from 2 shows using pagination', async () => {
    const res = await request.get('/flowsheet').query({ shows_limit: 2, page: 1 }).send().expect(200);

    // Should include entries from current show and previous 2 shows
    expect(res.body.length).toBeGreaterThan(0);

    // Check that we have entries from all 3 shows
    const showIds = [...new Set(res.body.map((entry) => entry.show_id))];
    expect(showIds.length).toBe(2);

    // Verify the content of track entries
    const trackEntries = res.body.filter((entry) => entry.entry_type === 'track');
    expect(trackEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artist_name: 'Ravyn Lenae',
          album_title: 'Crush',
          track_title: 'Venom',
        }),
        expect.objectContaining({
          artist_name: 'Built to Spill',
          album_title: 'Keep it Like a Secret',
          track_title: 'The Plan',
        }),
      ])
    );
  });

  test('Invalid shows_limit parameter', async () => {
    await request.get('/flowsheet').query({ shows_limit: 'invalid' }).send().expect(400);

    await request.get('/flowsheet').query({ shows_limit: -1 }).send().expect(400);

    await request.get('/flowsheet').query({ shows_limit: 0 }).send().expect(400);
  });
});

describe('rotation_bin read-path fallback (dj-site#750)', () => {
  // When the picker emit path doesn't persist flowsheet.rotation_id (the
  // 2026-06-04 regression cohort), the primary FK join leaves rotation_bin
  // NULL and dj-site's badge disappears. The read path's COALESCE fallback
  // recovers the bin via (a) album_id match, (b) denorm artist/album match,
  // or (c) library+artists JOIN match. Seed has rotation row 1 = album_id 1
  // (Built to Spill — Keep it Like a Secret) in bin 'L'.

  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('rotation_bin populated via primary FK join when rotation_id is set (baseline)', async () => {
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        rotation_id: 1,
        track_title: 'Carry the Zero',
      })
      .expect(201);

    const res = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const track = res.body.entries.find((e) => e.entry_type === 'track' && e.track_title === 'Carry the Zero');
    expect(track).toBeDefined();
    expect(track.rotation_id).toEqual(1);
    expect(track.rotation_bin).toEqual('L');
  });

  test('rotation_bin populated via album_id fallback when rotation_id is NULL', async () => {
    // Simulates the regression cohort: picker preserved album_id but lost rotation_id.
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Carry the Zero',
      })
      .expect(201);

    const res = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const track = res.body.entries.find((e) => e.entry_type === 'track' && e.track_title === 'Carry the Zero');
    expect(track).toBeDefined();
    expect(track.rotation_id).toBeNull();
    expect(track.rotation_bin).toEqual('L');
  });

  test('rotation_bin populated via library+artists denorm fallback when album_id and rotation_id are both NULL', async () => {
    // Simulates the worst case: snapshot branch wrote no album_id and no rotation_id,
    // only the typed/picker-seeded artist+album strings.
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: null,
        artist_name: 'Built to Spill',
        album_title: 'Keep it Like a Secret',
        track_title: 'Carry the Zero',
      })
      .expect(201);

    const res = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const track = res.body.entries.find((e) => e.entry_type === 'track' && e.track_title === 'Carry the Zero');
    expect(track).toBeDefined();
    expect(track.album_id).toBeNull();
    expect(track.rotation_id).toBeNull();
    expect(track.rotation_bin).toEqual('L');
  });

  test('rotation_bin stays NULL when (artist, album) does not match any active rotation row', async () => {
    // Regression pin: fallback must not match on artist alone or album alone, and
    // must not silently classify random tracks as rotation. "Ravyn Lenae — Crush"
    // is in the library (album_id 2) but is NOT in the seeded rotation set.
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2,
        track_title: 'Venom',
      })
      .expect(201);

    const res = await request.get('/flowsheet').query({ limit: 5 }).send().expect(200);
    const track = res.body.entries.find((e) => e.entry_type === 'track' && e.track_title === 'Venom');
    expect(track).toBeDefined();
    expect(track.rotation_id).toBeNull();
    expect(track.rotation_bin).toBeNull();
  });
});

describe('Delete Flowsheet Entries', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    const res = await request.post('/flowsheet').set('Authorization', global.access_token).send({
      album_id: 1, //Built to Spill - Keep it Like a Secret
      track_title: 'Carry the Zero',
    });

    global.entry_to_delete_id = res.body.id;
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const delete_res = await request
      .delete('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        entry_id: global.entry_to_delete_id,
      })
      .expect(200);

    expect(delete_res.body).toBeDefined();
    expect(delete_res.body.id).toEqual(global.entry_to_delete_id);
    expect(delete_res.body.album_id).toEqual(1);

    const get_res = await request
      .get('/flowsheet')
      .set('Authorization', global.access_token)
      .query({ limit: 1 })
      .send()
      .expect(200);

    expect(get_res.body.entries[0].id).toEqual(Number(global.entry_to_delete_id) - 1);
  });
});

describe('Retrieve Now Playing', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
      })
      .expect(201);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    let res = await request.get('/flowsheet/latest').expect(200);

    expect(res.body).toBeDefined();
    expect(res.body.artist_name).toEqual('Built to Spill');
    expect(res.body.album_title).toEqual('Keep it Like a Secret');
    expect(res.body.track_title).toEqual('Carry the Zero');

    // add a new track
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2, //Ravyn Lenae - Crush
        track_title: 'Venom',
      })
      .expect(201);

    res = await request.get('/flowsheet/latest').expect(200);
    expect(res.body).toBeDefined();
    expect(res.body.artist_name).toEqual('Ravyn Lenae');
    expect(res.body.album_title).toEqual('Crush');
    expect(res.body.track_title).toEqual('Venom');
  });
});

describe('Shift Flowsheet Entries', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);

    // Insert entries to move around
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1, //Built to Spill - Keep it Like a Secret
        track_title: 'Carry the Zero',
      })
      .expect(201);

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 2, //Ravyn Lenae - Crush
        track_title: 'Venom',
      })
      .expect(201);

    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 3, //Jockstrap - I Love You Jennifer B
        track_title: 'Debra',
      })
      .expect(201);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Start > Destination', async () => {
    let get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    const entries = get_entries_res.body.entries;

    const res = await request
      .patch('/flowsheet/play-order')
      .set('Authorization', global.access_token)
      .send({ entry_id: entries[0].id, new_position: entries[2].play_order })
      .expect(200);

    expect(res.body.play_order).toEqual(entries[2].play_order);
  });

  test('Destination > Start', async () => {
    let get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    const entries = get_entries_res.body.entries;
    const res = await request
      .patch('/flowsheet/play-order')
      .set('Authorization', global.access_token)
      .send({ entry_id: entries[2].id, new_position: entries[0].play_order })
      .expect(200);

    // get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
    expect(res.body.play_order).toEqual(entries[0].play_order);
  });

  // Regression guard for #712. The shape fixture (#701) seeds show 7003
  // with flowsheet rows at play_orders 1, 2, 3, 4, 5, 471. Pre-#712 the
  // unscoped bump UPDATEs in `changeOrder` would mutate any row whose
  // play_order fell in the moved range — including rows in *other* shows
  // (the active one created by the surrounding describe + the fixture's
  // ended show 7003). Snapshot show 7003's rows by id+play_order before
  // the reorder and assert byte-equality after.
  test('reordering inside the active show does not touch show 7003 (#712)', async () => {
    const sql = makeSql();
    try {
      const before = await sql.unsafe(
        `SELECT id, play_order FROM "${SCHEMA}".flowsheet WHERE show_id = 7003 ORDER BY id ASC`
      );
      // Sanity-check the fixture preconditions so a future fixture edit
      // can't silently turn this test into a no-op.
      expect(before.length).toBeGreaterThanOrEqual(6);
      const orders = before.map((r) => r.play_order).sort((a, b) => a - b);
      expect(orders).toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 471]));

      // Run a reorder in the active show — the same shape the
      // "Start > Destination" test above exercises.
      const get_entries_res = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
      const entries = get_entries_res.body.entries;
      await request
        .patch('/flowsheet/play-order')
        .set('Authorization', global.access_token)
        .send({ entry_id: entries[0].id, new_position: entries[2].play_order })
        .expect(200);

      // And the reverse direction, to cover both bump branches.
      const get_entries_res2 = await request.get('/flowsheet').query({ limit: 4 }).send().expect(200);
      const entries2 = get_entries_res2.body.entries;
      await request
        .patch('/flowsheet/play-order')
        .set('Authorization', global.access_token)
        .send({ entry_id: entries2[2].id, new_position: entries2[0].play_order })
        .expect(200);

      const after = await sql.unsafe(
        `SELECT id, play_order FROM "${SCHEMA}".flowsheet WHERE show_id = 7003 ORDER BY id ASC`
      );
      // Byte-equal pre/post: no row in show 7003 had its play_order
      // bumped by the reorders above. Pre-#712 some of these rows would
      // have been mutated (the 1..4 range overlaps with the active
      // show's bump range), corrupting the fixture for subsequent tests.
      expect(after).toEqual(before);
    } finally {
      await sql.end();
    }
  });
});

describe('On Air Status', () => {
  describe('GET /flowsheet/on-air', () => {
    test('returns false when DJ is not on air', async () => {
      // Ensure no active show
      await fls_util.leave_show(global.primary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/on-air')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.id).toBe(global.primary_dj_id);
      expect(res.body.is_live).toBe(false);
    });

    test('returns true when DJ is on air', async () => {
      // Start a show
      await fls_util.join_show(global.primary_dj_id, global.access_token);

      const res = await request
        .get('/flowsheet/on-air')
        .query({ dj_id: global.primary_dj_id })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.id).toBe(global.primary_dj_id);
      expect(res.body.is_live).toBe(true);

      // Clean up
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    });

    test('returns false for non-existent DJ', async () => {
      const res = await request
        .get('/flowsheet/on-air')
        .query({ dj_id: 'non-existent-dj-id' })
        .set('Authorization', global.access_token)
        .expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.is_live).toBe(false);
    });
  });

  describe('GET /flowsheet/djs-on-air', () => {
    test('returns empty array when no show is active', async () => {
      // Ensure no active show
      await fls_util.leave_show(global.primary_dj_id, global.access_token);

      const res = await request.get('/flowsheet/djs-on-air').set('Authorization', global.access_token).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    test('returns DJ list when show is active', async () => {
      // Start a show
      await fls_util.join_show(global.primary_dj_id, global.access_token);

      const res = await request.get('/flowsheet/djs-on-air').set('Authorization', global.access_token).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('dj_name');

      // Clean up
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    });

    test('returns multiple DJs when multiple are on air', async () => {
      // Start a show with primary DJ
      await fls_util.join_show(global.primary_dj_id, global.access_token);
      // Secondary DJ joins under their own auth (BS#1098 cross-check).
      await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token);

      const res = await request.get('/flowsheet/djs-on-air').set('Authorization', global.access_token).expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(2);

      const djIds = res.body.map((dj) => dj.id);
      expect(djIds).toContain(global.primary_dj_id);
      expect(djIds).toContain(global.secondary_dj_id);

      // Clean up
      await fls_util.leave_show(global.primary_dj_id, global.access_token);
    });
  });
});

describe('Retrieve Playlist Object', () => {
  beforeEach(async () => {
    // setup show
    const res = await fls_util.join_show(global.primary_dj_id, global.access_token);
    const body = await res.json();
    global.CurrentShowID = body.id;

    // Secondary joins as themselves (BS#1098 cross-check).
    await fls_util.join_show(global.secondary_dj_id, global.secondary_access_token);

    // Insert entry to for show
    await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 3, //Jockstrap - I Love You Jennifer B
        track_title: 'Debra',
      })
      .expect(201);

    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('Properly Formatted Request', async () => {
    const playlist = await request
      .get('/flowsheet/playlist')
      .query({ show_id: global.CurrentShowID })
      .send()
      .expect(200);

    expect(playlist.body.show_djs).toEqual([
      { id: global.primary_dj_id, dj_name: 'Test dj1' },
      { id: global.secondary_dj_id, dj_name: 'Test dj2' },
    ]);

    // All entries should have entry_type (discriminated union)
    playlist.body.entries.forEach((entry) => {
      expect(entry.entry_type).toBeDefined();
      expect(['track', 'show_start', 'show_end', 'dj_join', 'dj_leave', 'talkset', 'breakpoint', 'message']).toContain(
        entry.entry_type
      );
    });

    // Verify expected entry types are present
    expect(playlist.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entry_type: 'show_start', dj_name: expect.any(String) }),
        expect.objectContaining({ entry_type: 'dj_join', dj_name: expect.any(String) }),
        expect.objectContaining({ entry_type: 'track', artist_name: 'Jockstrap' }),
        expect.objectContaining({ entry_type: 'dj_leave', dj_name: expect.any(String) }),
        expect.objectContaining({ entry_type: 'show_end', dj_name: expect.any(String) }),
      ])
    );

    // Track entries should not have message field
    const trackEntry = playlist.body.entries.find((e) => e.entry_type === 'track');
    expect(trackEntry).toBeDefined();
    expect(trackEntry.artist_name).toBeDefined();
    expect(trackEntry.message).toBeUndefined();

    // Show start/end entries should have dj_name and timestamp, not track fields
    const showStartEntry = playlist.body.entries.find((e) => e.entry_type === 'show_start');
    expect(showStartEntry).toBeDefined();
    expect(showStartEntry.dj_name).toBeDefined();
    expect(showStartEntry.timestamp).toBeDefined();
    expect(showStartEntry.artist_name).toBeUndefined();

    expect(new Date(playlist.body.date)).toBeInstanceOf(Date);
  });
});

describe('Paginated ordering with ETL-imported entries', () => {
  const postgres = require('postgres');
  let sql;
  let staleEntryId;

  beforeAll(() => {
    sql = postgres({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || process.env.CI_DB_PORT || '5433', 10),
      database: process.env.DB_NAME || 'wxyc_db',
      user: process.env.DB_USERNAME || 'test-user',
      password: process.env.DB_PASSWORD || 'test-pw',
    });
  });

  afterAll(async () => {
    if (staleEntryId) {
      const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
      await sql.unsafe(`DELETE FROM ${schema}.flowsheet WHERE id = ${staleEntryId}`);
    }
    await sql.end();
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('newest entry appears first even when older entry has higher play_order', async () => {
    // Insert a stale ETL-imported entry first — it gets a lower id, simulating
    // old data imported by the ETL before the current show exists. It has a very
    // high play_order (from a long old show), which under the old ORDER BY
    // play_order DESC would sort above all recent entries.
    const schema = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
    const result = await sql.unsafe(`
      INSERT INTO ${schema}.flowsheet
        (play_order, entry_type, artist_name, album_title, track_title, record_label, add_time, request_flag, segue)
      VALUES
        (99999, 'track', 'Stale Artist', 'Stale Album', 'Stale Track', 'Stale Label', '2020-01-01T00:00:00Z', false, false)
      RETURNING id
    `);
    staleEntryId = result[0].id;

    // Now create a fresh entry via the API — this gets a higher id but lower
    // play_order, matching the production scenario
    await fls_util.join_show(global.primary_dj_id, global.access_token);
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Carry the Zero',
      })
      .expect(201);

    // The paginated endpoint should return the fresh entry first, not the stale one
    const res = await request.get('/flowsheet').query({ limit: 1 }).expect(200);

    expect(res.body.entries[0].artist_name).not.toBe('Stale Artist');
    expect(res.body.entries[0].id).toBe(addRes.body.id);
  });
});

describe('V1 API - entry_type field', () => {
  beforeEach(async () => {
    await fls_util.join_show(global.primary_dj_id, global.access_token);
  });

  afterEach(async () => {
    await fls_util.leave_show(global.primary_dj_id, global.access_token);
  });

  test('entry_type field present in responses', async () => {
    // Add a track
    const addRes = await request
      .post('/flowsheet')
      .set('Authorization', global.access_token)
      .send({
        album_id: 1,
        track_title: 'Carry the Zero',
      })
      .expect(201);

    // POST response includes entry_type
    expect(addRes.body.entry_type).toBe('track');

    // GET returns paginated entries with entry_type
    const getRes = await request.get('/flowsheet').query({ limit: 1 }).expect(200);
    expect(getRes.body.entries[0].entry_type).toBeDefined();
  });
});
