/**
 * BS#2344 — cursor pagination on GET /flowsheet/search has to be startable.
 *
 * `nextCursor` used to be gated on a cursor having been passed *in*, so the
 * first request of a session — which by definition carries none — never handed
 * back the link to the second. dj-site's `getNextPageParam` read `undefined`,
 * set `hasMore` false, and the Previous Sets archive was capped at one page.
 * Every unit-level assertion about page 2 onward passed, because every one of
 * them hand-built the first cursor.
 *
 * Fixing the gate alone would have been wrong, which is the other half of what
 * this spec covers. Page 0 used to compile `ORDER BY add_time <dir>` with no
 * `id` tiebreaker, while cursor pages compiled `ORDER BY add_time <dir>,
 * id <dir>` to match the compound cursor predicate. `add_time` is not a total
 * order here — the legacy ETL backfilled whole batches at one import timestamp
 * — so a cursor taken off the untied page named an ARBITRARY member of its tie
 * group, and the rest of that group was re-served or stepped over on the next
 * page. The fixture below is built so both page boundaries land strictly
 * inside a tie group, which is precisely the case that ordering bug corrupts.
 *
 * The expected sequence is not hardcoded: it is read back from Postgres with
 * the ordering the contract promises, so this spec compares the API's walk
 * against the database's own answer rather than against a transcription of it.
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
// Single token, no spaces, unique to this spec: `artist:<MARKER>` parses to an
// ILIKE contains predicate on artist_name, which scopes every request below to
// this batch alone without depending on tsvector tokenization.
const MARKER = 'BS2344CursorWalkProbe';
const PAGE_SIZE = 3;

/**
 * Nine rows in three `add_time` groups — 4 / 4 / 1, oldest first. Under
 * `add_time DESC, id DESC` the singleton sorts first, so at PAGE_SIZE 3 the
 * page boundaries fall after the 3rd and 6th rows, i.e. strictly inside the
 * two four-row tie groups.
 */
const GROUP_OFFSET_MINUTES = [0, 0, 0, 0, 60, 60, 60, 60, 120];

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

/** Split a cursor token the way parseCursor does, without importing the service. */
function splitCursor(token) {
  const at = token.lastIndexOf('_');
  return { time: token.slice(0, at), id: Number(token.slice(at + 1)) };
}

/** Walk /flowsheet/search from a cold start (no cursor), collecting every page. */
async function walkFromColdStart(query) {
  const pages = [];
  let cursor;
  // Bounded so a regression that hands back the same cursor forever fails as a
  // wrong page count rather than as a hung suite.
  for (let i = 0; i < 10; i++) {
    const params = { ...query, ...(cursor === undefined ? {} : { cursor }) };
    const res = await request.get('/flowsheet/search').query(params).send().expect(200);
    pages.push(res.body);
    cursor = res.body.nextCursor;
    if (cursor === undefined) break;
  }
  return pages;
}

describe('GET /flowsheet/search cursor pagination from a cold start (BS#2344)', () => {
  let sql;
  let insertedIds = [];
  let expectedDescIds = [];

  beforeAll(async () => {
    sql = makeSql();

    // Explicit add_time values (not the `now()` default) so the tie groups are
    // exact and this spec does not depend on statement timing. Dated well into
    // the past so the batch cannot disturb any other spec's recency assertions.
    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, artist_name, track_title, album_title, play_order, add_time)
       SELECT 'track', $1::text, $1::text || ' #' || n, 'Cursor Walk Probe', n,
              TIMESTAMPTZ '2019-03-01 12:00:00+00' + (offsets[n] * INTERVAL '1 minute')
       FROM generate_series(1, $3::int) AS n, (SELECT $2::int[] AS offsets) AS g
       RETURNING id`,
      [MARKER, GROUP_OFFSET_MINUTES, GROUP_OFFSET_MINUTES.length]
    );
    insertedIds = rows.map((r) => r.id);
    expect(insertedIds).toHaveLength(GROUP_OFFSET_MINUTES.length);

    // Ground truth, computed by Postgres under the ordering the endpoint
    // contract promises — not a transcription of it.
    const ordered = await sql.unsafe(
      `SELECT id FROM "${SCHEMA}".flowsheet
       WHERE artist_name = $1 AND entry_type = 'track'
       ORDER BY add_time DESC, id DESC`,
      [MARKER]
    );
    expectedDescIds = ordered.map((r) => r.id);

    // Two invariants in one: the marker is unique to this batch (nothing
    // foreign leaks into the scoping predicate the requests use), and the
    // contract's ordering resolves to newest-first across the tie groups —
    // ids ascend with add_time here, so the promised order is the ids
    // descending. A drift in either shows up as a diff, not as a confusing
    // off-by-N later.
    expect(expectedDescIds).toEqual([...insertedIds].sort((a, b) => b - a));
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedIds]);
    }
    if (sql) await sql.end();
  });

  test('a full first page carries a nextCursor even though the request had none', async () => {
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `artist:${MARKER}`, page: 0, limit: PAGE_SIZE, sort: 'date', order: 'desc' })
      .send()
      .expect(200);

    expect(res.body.results).toHaveLength(PAGE_SIZE);
    expect(typeof res.body.nextCursor).toBe('string');
    // The cursor names the last row of the page, so the next page resumes
    // exactly where this one stopped. Its timestamp half is Postgres's own
    // full-precision ISO rendering of that row's add_time — a different
    // STRING from `play_date`, the same instant. The suite below is where
    // that distinction is pinned.
    const last = res.body.results[PAGE_SIZE - 1];
    const { time, id } = splitCursor(res.body.nextCursor);
    expect(id).toBe(last.id);
    expect(Date.parse(time)).toBe(Date.parse(last.play_date));
  });

  test('a partial page carries no nextCursor', async () => {
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `artist:${MARKER}`, page: 0, limit: 50, sort: 'date', order: 'desc' })
      .send()
      .expect(200);

    expect(res.body.results).toHaveLength(GROUP_OFFSET_MINUTES.length);
    expect(res.body.nextCursor).toBeUndefined();
  });

  test.each([['desc'], ['asc']])('walks every page in %s order with no duplicate and no skipped id', async (order) => {
    const pages = await walkFromColdStart({
      q: `artist:${MARKER}`,
      page: 0,
      limit: PAGE_SIZE,
      sort: 'date',
      order,
    });

    // Three full pages of 3, then a fourth that returns nothing. That last
    // request is expected: the third page held exactly `limit` rows, and
    // knowing it was the last would require an over-fetch or an exact count.
    expect(pages.map((p) => p.results.length)).toEqual([3, 3, 3, 0]);

    const seen = pages.flatMap((p) => p.results.map((r) => r.id));
    const expected = order === 'desc' ? expectedDescIds : [...expectedDescIds].reverse();
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('non-date sorts still carry no nextCursor, even on a full page', async () => {
    // Cursor mode is date-only: the service consults `parseCursor` only for
    // `sort=date`, so a cursor handed out here would be ignored on the way
    // back in and the client would re-fetch the same page forever.
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `artist:${MARKER}`, page: 0, limit: PAGE_SIZE, sort: 'artist', order: 'asc' })
      .send()
      .expect(200);

    expect(res.body.results).toHaveLength(PAGE_SIZE);
    expect(res.body.nextCursor).toBeUndefined();
  });
});

/**
 * BS#2344 — the emitted cursor has to name the boundary row's ACTUAL
 * `add_time`, not a truncation of it.
 *
 * `flowsheet.add_time` is `timestamptz DEFAULT now()` (migration 0030 widened
 * migration 0019's naive `timestamp`) and every live insert omits the column,
 * so production rows carry Postgres's microsecond resolution. A JS `Date`
 * cannot: it is millisecond-only and FLOORS the remainder. A cursor built from
 * one would name `floor_ms(T)`, strictly less than the boundary row's real
 * `T`, while `parseCursor` binds it back at full `::timestamptz` precision. By
 * SQL row-value semantics that is wrong in both directions:
 *
 *   - `order=asc`:  `(T, id) > (floor_ms(T), cursor_id)` holds for the
 *     boundary row ITSELF, so every page re-serves its predecessor's last row.
 *   - `order=desc`: the boundary row is correctly excluded, but any row whose
 *     `add_time` falls in the open interval `(floor_ms(T), T)` also fails
 *     `< floor_ms(T)` and is silently stepped over.
 *
 * The walks below do NOT reproduce that today, and are not expected to: the
 * service selects the cursor value as a full-precision string, and even before
 * it did, drizzle's postgres-js driver installs a transparent parser over OID
 * 1184 so a raw `db.execute` never saw a `Date` in the first place. They are
 * here because that second fact is a dependency's private decision — nothing
 * in this repo asks for it, the unit tier mocks the opposite shape, and this
 * is the only tier that can tell. The format assertion is the one that fails
 * without the fix.
 *
 * The sibling spec above plants whole-minute timestamps so its tie groups are
 * exact, which is also what keeps it blind to precision. These rows carry
 * sub-millisecond remainders instead, and the `.000200` / `.000500` pair
 * straddling the descending page boundary is where a floored cursor would
 * step over a row.
 */
const US_MARKER = 'BS2344MicrosecondCursorProbe';

/**
 * Microsecond offsets from the base instant, ascending — so `id` ascends with
 * `add_time` and the promised `add_time DESC, id DESC` order is the ids
 * descending, same as the sibling fixture.
 *
 * Every offset has a non-zero sub-millisecond remainder, which is what makes
 * the ascending walk re-serve its boundary row. Offsets 6 and 7 (`3.000200`
 * and `3.000500`) share a millisecond: descending, the cursor is taken off
 * `3.000500` and floors to `3.000000`, so `3.000200` — the very next row —
 * falls outside `< 3.000000` and disappears.
 */
const US_OFFSETS = [1000101, 1500202, 2000303, 2500404, 2900505, 3000200, 3000500, 4000606, 5000707];

describe('GET /flowsheet/search cursors over microsecond add_time (BS#2344)', () => {
  let sql;
  let insertedIds = [];
  let expectedDescIds = [];

  beforeAll(async () => {
    sql = makeSql();

    const rows = await sql.unsafe(
      `INSERT INTO "${SCHEMA}".flowsheet (entry_type, artist_name, track_title, album_title, play_order, add_time)
       SELECT 'track', $1::text, $1::text || ' #' || n, 'Microsecond Cursor Probe', n,
              TIMESTAMPTZ '2019-03-02 12:00:00+00' + (offsets[n] * INTERVAL '1 microsecond')
       FROM generate_series(1, $3::int) AS n, (SELECT $2::int[] AS offsets) AS g
       RETURNING id`,
      [US_MARKER, US_OFFSETS, US_OFFSETS.length]
    );
    insertedIds = rows.map((r) => r.id);
    expect(insertedIds).toHaveLength(US_OFFSETS.length);

    const ordered = await sql.unsafe(
      `SELECT id, to_char(add_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
       FROM "${SCHEMA}".flowsheet
       WHERE artist_name = $1 AND entry_type = 'track'
       ORDER BY add_time DESC, id DESC`,
      [US_MARKER]
    );
    expectedDescIds = ordered.map((r) => r.id);

    // The premise, asserted rather than assumed: the column kept every row's
    // sub-millisecond remainder. `.SSSSSSZ` — the last three digits before the
    // Z are the microseconds a JS `Date` cannot represent.
    expect(ordered.map((r) => Number(r.exact.slice(-4, -1)))).toEqual([707, 606, 500, 200, 505, 404, 303, 202, 101]);
    expect(expectedDescIds).toEqual([...insertedIds].sort((a, b) => b - a));
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await sql.unsafe(`DELETE FROM "${SCHEMA}".flowsheet WHERE id = ANY($1::int[])`, [insertedIds]);
    }
    if (sql) await sql.end();
  });

  test('the cursor names the boundary row at full precision, not its floored play_date', async () => {
    const res = await request
      .get('/flowsheet/search')
      .query({ q: `artist:${US_MARKER}`, page: 0, limit: PAGE_SIZE, sort: 'date', order: 'desc' })
      .send()
      .expect(200);

    const last = res.body.results[PAGE_SIZE - 1];
    const { time, id } = splitCursor(res.body.nextCursor);

    expect(id).toBe(last.id);
    // Same instant, more resolution: `play_date` stays the millisecond ISO
    // string the SearchResult contract promises, and the cursor carries the
    // microseconds that string had to drop.
    expect(Date.parse(time)).toBe(Date.parse(last.play_date));
    expect(time).toMatch(/\.\d{6}Z$/);
  });

  test.each([['desc'], ['asc']])(
    'walks microsecond-precision rows in %s order with no duplicate and no skipped id',
    async (order) => {
      const pages = await walkFromColdStart({
        q: `artist:${US_MARKER}`,
        page: 0,
        limit: PAGE_SIZE,
        sort: 'date',
        order,
      });

      const seen = pages.flatMap((p) => p.results.map((r) => r.id));
      const expected = order === 'desc' ? expectedDescIds : [...expectedDescIds].reverse();
      expect(seen).toEqual(expected);
      expect(pages.map((p) => p.results.length)).toEqual([3, 3, 3, 0]);
    }
  );
});
