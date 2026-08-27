/**
 * DJ real-name PII sentinel wire spec (DJ real-name PII safeguards plan,
 * Track 3b) — the mechanism that would have caught `a0cd1979`.
 *
 * Seeds an `auth_user` row shaped exactly like the pre-Track-2 conflation
 * this whole plan exists to unscrew: `real_name` and `name` both hold the
 * legal-name sentinel. Track 2's databaseHooks (2b), the provision route
 * (2c), and the backfill job (2d) all prevent a row reaching that shape
 * going forward — this spec doesn't exercise any of those; it proves the
 * PUBLIC READ surfaces never surface the legal name regardless of how a row
 * got into that shape, which is the actual PII-leak failure mode (BS#1286/
 * BS#1393/BS#2281 were all downstream of a *read* path, not a write path).
 *
 * Whole-body string match against `JSON.stringify(res.body)` — catches
 * fields that don't exist yet, unlike a keys-only shape assertion. Every
 * `it` also carries a positive control (the seeded HANDLE, a value that is
 * NOT the legal name) so a passing "no sentinel" assertion can't be
 * accidentally vacuous — it only means something if the row was actually in
 * scope for the query.
 *
 * Follows flowsheet-range.spec.js's getTestDb/supertest/cleanup pattern.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// The literal from the plan — never write this constant anywhere outside
// this spec's seed/assert pair.
const SENTINEL_REAL_NAME = 'SENTINEL-REAL-NAME-93aF';
// A resolvable, structurally non-PII handle — distinct from (and not a
// substring of) SENTINEL_REAL_NAME, so a passing "sentinel absent" check
// can't be a false negative from accidental overlap.
const HANDLE = 'SENTINEL-HANDLE-93aF';
const MARKER_ARTIST = 'DJ Real-Name Sentinel Probe Artist';
const MARKER_TRACK = 'DJ Real-Name Sentinel Probe Track';

const USER_ID = 'sentinel-pii-probe-user-000001';
const USER_EMAIL = 'sentinel-pii-probe-93af@test.wxyc.org';
const USER_USERNAME = 'sentinel_pii_probe_93af';

// Fixed past window for /flowsheet/range and /flowsheet/search (time-
// independent, but kept inside the window for tidiness) — 1995, clear of
// flowsheet-range.spec.js's 1998 window and outside anything the shared
// dev/CI schema seeds, so the range query's result set is exactly this
// spec's fixture.
const WINDOW_START = Date.UTC(1995, 0, 15, 0, 0, 0);
const WINDOW_END = Date.UTC(1995, 0, 16, 0, 0, 0);
const at = (offsetMs) => new Date(WINDOW_START + offsetMs).toISOString();

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

describe('DJ real-name PII sentinel (DJ real-name PII safeguards plan, Track 3b)', () => {
  let sql;
  let showId;
  const entryIds = {};

  beforeAll(async () => {
    sql = makeSql();

    // Defensive pre-delete (a prior crashed run could otherwise leave these
    // rows behind and produce a confusing false pass/fail) — same pattern as
    // internal-flowsheet-webhook.spec.js's seedShow.
    await sql.unsafe(
      `DELETE FROM "${SCHEMA}".flowsheet WHERE show_id IN (SELECT id FROM "${SCHEMA}".shows WHERE primary_dj_id = $1)`,
      [USER_ID]
    );
    await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE primary_dj_id = $1`, [USER_ID]);
    await sql.unsafe(`DELETE FROM auth_user WHERE id = $1`, [USER_ID]);

    // Seed the auth_user row shaped exactly like the pre-Track-2 conflation:
    // `name` duplicates `real_name`. `dj_name` is a normal, resolvable
    // handle — the write path this row simulates (dj-site provisioning,
    // pre-2c) always had a real dj_name available; the conflation was never
    // about a missing handle, only about `name` secretly also holding the
    // legal name.
    await sql`
      INSERT INTO auth_user (id, name, email, real_name, dj_name, username, is_anonymous)
      VALUES (${USER_ID}, ${SENTINEL_REAL_NAME}, ${USER_EMAIL}, ${SENTINEL_REAL_NAME}, ${HANDLE}, ${USER_USERNAME}, false)
    `;

    const showRows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (primary_dj_id, start_time, end_time)
      VALUES (${USER_ID}, ${at(60 * 60 * 1000)}::timestamptz, NULL)
      RETURNING id
    `;
    showId = showRows[0].id;

    const insertEntry = async (key, addTimeIso, entryType, extra = {}) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet
          (show_id, add_time, entry_type, dj_name, artist_name, album_title, track_title, message, play_order)
        VALUES (
          ${showId},
          ${addTimeIso}::timestamptz,
          ${entryType},
          ${HANDLE},
          ${extra.artist_name ?? null},
          ${extra.album_title ?? null},
          ${extra.track_title ?? null},
          ${extra.message ?? null},
          ${extra.play_order ?? 1}
        )
        RETURNING id`;
      entryIds[key] = rows[0].id;
    };

    // In-window rows — exercised by GET /flowsheet/range and
    // GET /flowsheet/search, neither of which depends on freshness.
    await insertEntry('marker', at(60 * 60 * 1000), 'show_start', { message: `${MARKER_TRACK} start` });
    await insertEntry('track', at(2 * 60 * 60 * 1000), 'track', {
      artist_name: MARKER_ARTIST,
      album_title: 'Sentinel Probe Album',
      track_title: MARKER_TRACK,
    });

    // Far-future row — GET /flowsheet and GET /flowsheet/latest order by
    // (add_time DESC, id DESC) with no content filter available, so this is
    // the only way to make inclusion deterministic without depending on
    // what else lands in the table during the test run.
    const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();
    await insertEntry('latest', farFuture, 'track', {
      artist_name: MARKER_ARTIST,
      album_title: 'Sentinel Probe Album',
      track_title: MARKER_TRACK,
    });
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = Object.values(entryIds);
    if (ids.length) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [ids]);
    }
    if (showId) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE id = $1`, [showId]);
    }
    await sql.unsafe(`DELETE FROM auth_user WHERE id = $1`, [USER_ID]);
    await sql.end({ timeout: 5 });
  });

  const assertNoSentinel = (res) => {
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL_REAL_NAME);
  };

  describe('GET /flowsheet (default, most-recent page)', () => {
    it('never leaks the sentinel real name', async () => {
      const res = await request.get('/flowsheet');
      assertNoSentinel(res);
    });

    it('positive control: included our probe row', async () => {
      // Track-type V2 entries don't carry a dj_name field at all
      // (transformToV2: "Track entries do not include dj_name in the v2
      // payload" — flowsheet.dj_name on track rows exists solely for the
      // search hot path). artist_name is this endpoint's proof of
      // inclusion instead.
      const res = await request.get('/flowsheet');
      const mine = res.body.entries.find((e) => e.id === entryIds.latest);
      expect(mine).toBeDefined();
      expect(mine.artist_name).toBe(MARKER_ARTIST);
    });
  });

  describe('GET /flowsheet/latest', () => {
    it('never leaks the sentinel real name', async () => {
      const res = await request.get('/flowsheet/latest');
      assertNoSentinel(res);
    });

    it('positive control: returned our probe row', async () => {
      // Same track-type-has-no-dj_name-on-the-wire note as GET /flowsheet above.
      const res = await request.get('/flowsheet/latest');
      expect(res.body.id).toBe(entryIds.latest);
      expect(res.body.artist_name).toBe(MARKER_ARTIST);
    });
  });

  describe('GET /flowsheet/range', () => {
    const fetchWindow = () => request.get(`/flowsheet/range?start=${WINDOW_START}&end=${WINDOW_END}`);

    it('never leaks the sentinel real name', async () => {
      const res = await fetchWindow();
      assertNoSentinel(res);
    });

    it('positive control: resolves the show dj_name through the live auth_user JOIN to the handle, not the real name', async () => {
      const res = await fetchWindow();
      const show = res.body.shows.find((s) => s.id === showId);
      expect(show).toBeDefined();
      expect(show.dj_name).toBe(HANDLE);
      // The projection is a fixed field set with no id/real-name-shaped key
      // — same shape flowsheet-range.spec.js pins for the general case.
      expect(Object.keys(show).sort()).toEqual([
        'dj_name',
        'end_time',
        'id',
        'show_name',
        'specialty_id',
        'start_time',
      ]);
    });

    it('positive control: the marker entry also projects the handle', async () => {
      const res = await fetchWindow();
      const marker = res.body.entries.find((e) => e.id === entryIds.marker);
      expect(marker).toBeDefined();
      expect(marker.dj_name).toBe(HANDLE);
    });
  });

  describe('GET /flowsheet/search', () => {
    it('never leaks the sentinel real name on an unfiltered query', async () => {
      const res = await request.get('/flowsheet/search');
      assertNoSentinel(res);
    });

    it('never leaks the sentinel real name on a dj: operator query matching the handle', async () => {
      const res = await request.get(`/flowsheet/search?q=${encodeURIComponent(`dj:${HANDLE}`)}`);
      assertNoSentinel(res);
    });

    it('positive control: the dj: operator query found our probe row(s), projecting the handle rather than the real name', async () => {
      const res = await request.get(`/flowsheet/search?q=${encodeURIComponent(`dj:${HANDLE}`)}`);
      const mine = res.body.results.filter((r) => r.id === entryIds.track || r.id === entryIds.latest);
      expect(mine.length).toBeGreaterThan(0);
      for (const row of mine) {
        expect(row.dj_name).toBe(HANDLE);
      }
    });
  });
});
