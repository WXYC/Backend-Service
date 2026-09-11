const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');

/**
 * BS#2436 — `PATCH /library/:id/missing` and `/found` are gated to
 * `catalog: ['read']` (routes/library.route.ts), so any DJ pulling records
 * fires them. They are the only `library` writers that are not a catalogue
 * edit, and `last_modified` is what a librarian sorts "recently changed" by —
 * so a found-toggle that bumped it pushed a release catalogued in 2011 to the
 * top of that list and buried whatever genuinely changed.
 *
 * The probe row is backdated to a fixed past instant rather than compared
 * against its own creation time: a create-then-toggle comparison separates the
 * two timestamps by milliseconds and would pass by accident if the write were
 * ever dropped to second resolution. A 2011 baseline is the reported case and
 * fails unmistakably.
 *
 * The watermark case is a tripwire, not a regression test — it passed before
 * this fix too. `library_watermark`'s trigger is narrowed to the columns the
 * catalog export projects (migration 0142), a list excluding `last_modified`,
 * `date_lost`, and `date_found` alike, so a shelf toggle has never advanced it.
 * The case fails only when those columns join the trigger list, which is the
 * moment the service docblock's "costs no freshness signal" claim stops
 * holding.
 */

const postgres = require('postgres');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// The user-reported case: a release catalogued long ago that a DJ flags
// missing and un-flags the next week.
const CATALOGUED_AT = '2011-03-14T09:00:00.000Z';

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

describe('PATCH /library/:id/missing and /found leave last_modified alone (BS#2436)', () => {
  let auth;
  let sql;
  let albumId;
  const uniq = Date.now();

  const readLastModified = async () => {
    const rows = await sql.unsafe(`SELECT last_modified FROM "${SCHEMA}".library WHERE id = $1`, [albumId]);
    return rows[0].last_modified.toISOString();
  };

  const readWatermark = async () => {
    const rows = await sql.unsafe(`SELECT last_modified_at FROM "${SCHEMA}".library_watermark WHERE id = true`);
    return rows[0].last_modified_at.getTime();
  };

  beforeAll(async () => {
    auth = createAuthRequest(request, global.access_token);
    sql = makeSql();

    // POST /library only accepts an artist already catalogued in the genre, so
    // the probe brings its own rather than leaning on a seed row other
    // --runInBand specs also mutate.
    const artist = await auth
      .post('/library/artists')
      .send({
        artist_name: `Juana Molina ${uniq}`,
        code_letters: 'MO',
        genre_id: 11,
        code_number: 9500 + (uniq % 400),
      })
      .expect(201);

    const res = await auth
      .post('/library')
      .send({
        album_title: `DOGA ${uniq}`,
        artist_id: artist.body.id,
        label: `Sonamos ${uniq}`,
        genre_id: 11,
        format_id: 1,
      })
      .expect(201);
    albumId = res.body.id;

    // Age the row the way the catalogue actually looks: the toggle handlers are
    // the thing under test, so the baseline has to predate them.
    await sql.unsafe(`UPDATE "${SCHEMA}".library SET last_modified = $1 WHERE id = $2`, [CATALOGUED_AT, albumId]);
    expect(await readLastModified()).toBe(CATALOGUED_AT);
  });

  afterAll(async () => {
    if (sql) await sql.end();
  });

  test('marking missing sets date_lost, clears date_found, and does not touch last_modified', async () => {
    const res = await auth.patch(`/library/${albumId}/missing`).expect(200);

    expect(res.body.date_lost).not.toBeNull();
    expect(res.body.date_found).toBeNull();
    expect(new Date(res.body.last_modified).toISOString()).toBe(CATALOGUED_AT);
    expect(await readLastModified()).toBe(CATALOGUED_AT);
  });

  test('marking found sets date_found and does not touch last_modified', async () => {
    const res = await auth.patch(`/library/${albumId}/found`).expect(200);

    expect(res.body.date_found).not.toBeNull();
    expect(new Date(res.body.last_modified).toISOString()).toBe(CATALOGUED_AT);
    expect(await readLastModified()).toBe(CATALOGUED_AT);
  });

  test('the toggle carries no catalog-freshness signal to lose with the column write gone', async () => {
    // Push the watermark back far enough that any movement is unambiguous. This
    // write is on `library_watermark` itself, which carries no trigger.
    await sql.unsafe(
      `UPDATE "${SCHEMA}".library_watermark SET last_modified_at = now() - interval '1 hour' WHERE id = true`
    );
    const before = await readWatermark();

    await auth.patch(`/library/${albumId}/missing`).expect(200);

    expect(await readWatermark()).toBe(before);
  });
});
