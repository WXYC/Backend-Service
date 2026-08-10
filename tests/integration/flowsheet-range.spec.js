/**
 * BS#2062 — `GET /flowsheet/range?start=&end=`, against a real database.
 *
 * The unit specs cover parameter validation and the pure DJ-name chain with
 * the service mocked out. What can only be proven here is the SQL: the
 * half-open `[start, end)` window on `add_time`, the `add_time`/`id` ordering,
 * the show-overlap predicate (including the deliberately asymmetric treatment
 * of a NULL `end_time`), and that an unattributed row survives the read.
 *
 * The window is placed in 1998 — comfortably outside anything the shared
 * dev/CI schema seeds, and outside the fixture flowsheet rows — so the
 * assertions can be exact ("these ids, in this order") rather than
 * "contains". Everything this spec writes is torn down in afterAll.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

// Midnight ET on 1998-04-02 (EDT, UTC-4) and the following midnight.
const WINDOW_START = Date.UTC(1998, 3, 2, 4, 0, 0);
const WINDOW_END = Date.UTC(1998, 3, 3, 4, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER = 'BS2062 Range Probe';

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

describe('GET /flowsheet/range (BS#2062)', () => {
  let sql;
  const showIds = {};
  const entryIds = {};

  beforeAll(async () => {
    sql = makeSql();

    const insertShow = async (key, startOffset, endOffset, legacyDjName) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.shows (start_time, end_time, legacy_dj_name)
        VALUES (
          ${at(startOffset)}::timestamptz,
          ${endOffset === null ? null : at(endOffset)}::timestamptz,
          ${legacyDjName}
        )
        RETURNING id`;
      showIds[key] = rows[0].id;
    };

    // inside:      wholly within the window
    // spansStart:  begins the previous day, ends inside — overlap, not containment
    // endsAtStart: ends exactly at the window's first instant — [a,b) does NOT
    //              contain b, so this must be EXCLUDED
    // openInside:  NULL end_time, starts inside  — included
    // openBefore:  NULL end_time, starts before  — EXCLUDED (a dropped show_end
    //              leaves end_time NULL forever; treating NULL as open-ended
    //              would make every such show intersect every window)
    // after:       starts after the window ends  — excluded
    await insertShow('spansStart', -2 * 60 * 60 * 1000, 2 * 60 * 60 * 1000, `${MARKER} spansStart`);
    await insertShow('inside', 5 * 60 * 60 * 1000, 8 * 60 * 60 * 1000, `${MARKER} inside`);
    await insertShow('endsAtStart', -3 * 60 * 60 * 1000, 0, `${MARKER} endsAtStart`);
    await insertShow('openInside', 10 * 60 * 60 * 1000, null, `${MARKER} openInside`);
    await insertShow('openBefore', -5 * 60 * 60 * 1000, null, `${MARKER} openBefore`);
    await insertShow('after', DAY_MS + 60 * 60 * 1000, DAY_MS + 2 * 60 * 60 * 1000, `${MARKER} after`);

    const insertEntry = async (key, offsetMs, entryType, showKey, extra = {}) => {
      const rows = await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet
          (show_id, add_time, entry_type, artist_name, album_title, track_title, message, play_order)
        VALUES (
          ${showKey === null ? null : showIds[showKey]},
          ${at(offsetMs)}::timestamptz,
          ${entryType},
          ${extra.artist_name ?? null},
          ${extra.album_title ?? null},
          ${extra.track_title ?? null},
          ${extra.message ?? null},
          ${extra.play_order ?? 1}
        )
        RETURNING id`;
      entryIds[key] = rows[0].id;
    };

    // Boundary rows: exactly at start (INCLUDED) and exactly at end (EXCLUDED).
    await insertEntry('atStart', 0, 'track', 'spansStart', {
      artist_name: 'Stereolab',
      album_title: 'Aluminum Tunes',
      track_title: 'Pop Quiz',
    });
    await insertEntry('beforeStart', -1, 'track', 'spansStart', { artist_name: 'Excluded Before' });
    await insertEntry('atEnd', DAY_MS, 'track', 'after', { artist_name: 'Excluded At End' });

    // A show_start marker — the entry types the partial `entry_type='track'`
    // index cannot serve, and the reason this endpoint needed its own index.
    await insertEntry('marker', 60 * 1000, 'show_start', 'spansStart', { message: `${MARKER} start` });

    // Unattributed row: 20 of 2.6M rows have a NULL show_id and Phase 0 decided
    // against a backfill, so the read must return it rather than drop or crash.
    await insertEntry('orphan', 3 * 60 * 60 * 1000, 'track', null, {
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
    });

    // Two rows sharing an add_time, to pin the `id` ASC tie-break.
    await insertEntry('tieA', 6 * 60 * 60 * 1000, 'track', 'inside', { artist_name: 'Tie A' });
    await insertEntry('tieB', 6 * 60 * 60 * 1000, 'track', 'inside', { artist_name: 'Tie B' });
  });

  afterAll(async () => {
    if (!sql) return;
    // `sql.unsafe` with an explicit `$1::int[]`, matching
    // flowsheet-deep-pagination.spec.js. A tagged-template `ANY(${ids})` does
    // NOT reliably bind a JS array here, and a teardown that throws strands
    // fixture rows in the shared CI schema for every later run.
    // Flowsheet first — it FKs to shows.
    const ids = Object.values(entryIds);
    if (ids.length) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [ids]);
    }
    const sIds = Object.values(showIds);
    if (sIds.length) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".shows WHERE id = ANY($1::int[])`, [sIds]);
    }
    await sql.end({ timeout: 5 });
  });

  const fetchWindow = (start = WINDOW_START, end = WINDOW_END) =>
    request.get(`/flowsheet/range?start=${start}&end=${end}`);

  it('is public — no Authorization header required', async () => {
    const res = await fetchWindow();
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('shows');
    expect(res.body).toHaveProperty('entries');
  });

  it('applies a half-open [start, end) window on add_time', async () => {
    const res = await fetchWindow();
    const ids = res.body.entries.map((e) => e.id);

    expect(ids).toContain(entryIds.atStart); // exactly at start: included
    expect(ids).not.toContain(entryIds.atEnd); // exactly at end: excluded
    expect(ids).not.toContain(entryIds.beforeStart);
  });

  it('orders entries by add_time ASC, tie-broken on id ASC', async () => {
    const res = await fetchWindow();
    const mine = res.body.entries.filter((e) => Object.values(entryIds).includes(e.id));

    const times = mine.map((e) => new Date(e.add_time).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));

    const tieA = mine.findIndex((e) => e.id === entryIds.tieA);
    const tieB = mine.findIndex((e) => e.id === entryIds.tieB);
    expect(tieA).toBeGreaterThanOrEqual(0);
    expect(tieB).toBe(tieA + 1); // lower id first, at an identical add_time
  });

  it('returns every entry type, not just tracks', async () => {
    const res = await fetchWindow();
    const marker = res.body.entries.find((e) => e.id === entryIds.marker);
    expect(marker).toBeDefined();
    expect(marker.entry_type).toBe('show_start');
  });

  it('returns an unattributed entry with show_id null', async () => {
    const res = await fetchWindow();
    const orphan = res.body.entries.find((e) => e.id === entryIds.orphan);
    expect(orphan).toBeDefined();
    expect(orphan.show_id).toBeNull();
  });

  it('includes overlapping shows and excludes non-overlapping ones', async () => {
    const res = await fetchWindow();
    const ids = res.body.shows.map((s) => s.id);

    expect(ids).toContain(showIds.spansStart); // starts before, ends inside
    expect(ids).toContain(showIds.inside);
    expect(ids).toContain(showIds.openInside); // NULL end_time, starts inside
    expect(ids).not.toContain(showIds.endsAtStart); // ends exactly at window start
    expect(ids).not.toContain(showIds.openBefore); // NULL end_time, starts before
    expect(ids).not.toContain(showIds.after);
  });

  it('orders shows by start_time ascending', async () => {
    const res = await fetchWindow();
    const mine = res.body.shows.filter((s) => Object.values(showIds).includes(s.id));
    const times = mine.map((s) => new Date(s.start_time).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('projects shows PII-safely — public handle only, no user id or real name', async () => {
    const res = await fetchWindow();
    const show = res.body.shows.find((s) => s.id === showIds.inside);

    expect(Object.keys(show).sort()).toEqual(['dj_name', 'end_time', 'id', 'show_name', 'specialty_id', 'start_time']);
    expect(show.dj_name).toBe(`${MARKER} inside`); // legacy handle, the last chain link
  });

  it('returns a show spanning midnight in BOTH adjacent days', async () => {
    const prevDay = await fetchWindow(WINDOW_START - DAY_MS, WINDOW_START);
    const thisDay = await fetchWindow();

    expect(prevDay.body.shows.map((s) => s.id)).toContain(showIds.spansStart);
    expect(thisDay.body.shows.map((s) => s.id)).toContain(showIds.spansStart);
  });

  it('answers an empty window with 200 and empty arrays, never 404', async () => {
    // 1996, well clear of this spec's fixtures and anything else seeded.
    const start = Date.UTC(1996, 0, 1);
    const res = await fetchWindow(start, start + DAY_MS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ shows: [], entries: [] });
  });

  it('400s on a malformed, inverted, or oversize window', async () => {
    const eightDaysAndOne = 8 * DAY_MS + 1;
    const cases = [
      `/flowsheet/range?end=${WINDOW_END}`,
      `/flowsheet/range?start=${WINDOW_START}`,
      `/flowsheet/range?start=nope&end=${WINDOW_END}`,
      `/flowsheet/range?start=${WINDOW_END}&end=${WINDOW_START}`,
      `/flowsheet/range?start=${WINDOW_START}&end=${WINDOW_START}`,
      `/flowsheet/range?start=${WINDOW_START}&end=${WINDOW_START + eightDaysAndOne}`,
    ];

    for (const path of cases) {
      const res = await request.get(path);
      expect([path, res.status]).toEqual([path, 400]);
      expect(typeof res.body.message).toBe('string');
    }
  });

  it('is not shadowed by the templated routes on this router', async () => {
    // `/range` is registered above `get('/')`; a regression that moved it
    // below would send this to the paginated handler and 200 with the wrong
    // shape rather than fail loudly.
    const res = await fetchWindow();
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body).not.toHaveProperty('totalPages');
  });
});
