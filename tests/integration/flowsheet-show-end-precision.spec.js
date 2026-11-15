/**
 * BS#3807 — a derived show end must never land below the show's own last entry.
 *
 * `flowsheet.add_time` and `shows.start_time` are `timestamptz`, which keeps
 * microseconds; a JavaScript `Date` keeps milliseconds. `resolveShowEndInstant`
 * used to read `max(add_time)` straight into a `Date`, dropping the
 * sub-millisecond part, and `endShow` stamped that truncated instant on
 * `shows.end_time`, the `show_end` marker and every co-host `dj_leave` marker.
 * The marker then sat up to 999 µs BELOW the entry it was meant to tie with, and
 * `getEntriesByPage`'s `add_time DESC, id DESC` order rendered a show that
 * signed off and then played one more song (show 1951976, 2026-11-14; 160 of
 * 848 sign-offs in the 90 days before).
 *
 * Every probe here carries a deliberately sub-millisecond timestamp, because a
 * millisecond-exact one cannot tell truncation from rounding up. The order
 * asserted is `getEntriesByPage`'s own `ORDER BY add_time DESC, id DESC`,
 * scoped to the probe show: the probes are days old, so they are nowhere near
 * the first page of the global feed, and the scoped read is the same sort.
 * Comparisons against stored timestamps are made in SQL, at microsecond
 * precision, never on `Date`s the driver has already truncated.
 *
 * The go-live takeover, the other caller of `resolveShowEndInstant`, is pinned
 * in flowsheet-takeover.spec.js.
 *
 * Every row written here is deleted in afterAll: an open show left behind would
 * be `max(shows.id)` for the next spec (see flowsheet-open-shows.spec.js).
 */

const postgres = require('postgres');
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const DAY_MS = 24 * 60 * 60 * 1000;

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

// A millisecond-exact instant five days back; probes add microseconds to it in
// SQL, since a `Date` cannot carry them.
const BASE = new Date(Math.floor((Date.now() - 5 * DAY_MS) / 1000) * 1000);
const BASE_ISO = BASE.toISOString();
// The shape observed on show 1951976: a breakpoint, then a track 18 ms later
// with a 123 µs remainder.
const LAST_ENTRY_US = 722123;
const LAST_ENTRY_ROUNDED_UP = new Date(BASE.getTime() + 723);
const LAST_ENTRY_TRUNCATED = new Date(BASE.getTime() + 722);

describe('derived show end at microsecond precision (BS#3807)', () => {
  let sql;
  const showIds = {};

  const insertShow = async (key, { startOffsetUs = 0, entryOffsetsUs = [] }) => {
    const [{ id }] = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (start_time, legacy_dj_name)
      VALUES (
        ${BASE_ISO}::timestamptz + make_interval(secs => ${startOffsetUs}::float8 / 1000000),
        ${`DJ BS3807 ${key}`}
      )
      RETURNING id`;
    showIds[key] = id;
    let playOrder = 1;
    for (const offsetUs of entryOffsetsUs) {
      await sql`
        INSERT INTO ${sql(SCHEMA)}.flowsheet (show_id, entry_type, play_order, message, add_time)
        VALUES (
          ${id}, 'message', ${playOrder}, ${`BS3807 probe ${key} ${playOrder}`},
          ${BASE_ISO}::timestamptz + make_interval(secs => ${offsetUs}::float8 / 1000000)
        )`;
      playOrder += 1;
    }
    return id;
  };

  const forceEnd = (id, body = {}) =>
    request.post(`/flowsheet/shows/${id}/force-end?force=true`).set('Authorization', global.access_token).send(body);

  // `getEntriesByPage`'s order, scoped to one show.
  const entryTypesInFeedOrder = async (id) => {
    const rows = await sql`
      SELECT entry_type FROM ${sql(SCHEMA)}.flowsheet
      WHERE show_id = ${id}
      ORDER BY add_time DESC, id DESC`;
    return rows.map((r) => r.entry_type);
  };

  // Microsecond-exact comparisons of the closed show against its own rows.
  const closeFacts = async (id) => {
    const [row] = await sql`
      SELECT
        s.end_time >= s.start_time AS end_at_or_after_start,
        s.end_time >= (
          SELECT max(f.add_time) FROM ${sql(SCHEMA)}.flowsheet f
          WHERE f.show_id = s.id AND f.entry_type NOT IN ('show_end', 'dj_leave')
        ) AS end_at_or_after_last_entry,
        (
          SELECT bool_and(f.add_time = s.end_time) FROM ${sql(SCHEMA)}.flowsheet f
          WHERE f.show_id = s.id AND f.entry_type IN ('show_end', 'dj_leave')
        ) AS markers_at_end_time,
        s.end_time
      FROM ${sql(SCHEMA)}.shows s
      WHERE s.id = ${id}`;
    return row;
  };

  beforeAll(async () => {
    sql = makeSql();

    await insertShow('lastEntry', { entryOffsetsUs: [0, 704056, LAST_ENTRY_US] });
    await insertShow('cohost', { entryOffsetsUs: [0, 704056, LAST_ENTRY_US] });
    await insertShow('override', { entryOffsetsUs: [0, LAST_ENTRY_US] });
    // The start_time floor, both ways in: nothing logged, and everything logged
    // before start_time (the legacy shape BS#2143 describes).
    await insertShow('emptyFloor', { startOffsetUs: LAST_ENTRY_US });
    await insertShow('predatesFloor', { startOffsetUs: LAST_ENTRY_US, entryOffsetsUs: [-3_600_000_000] });

    // An active co-host on an ownerless show: `endShow` writes a `dj_leave`
    // for every remaining member except the primary, and this show has none.
    await sql`
      INSERT INTO ${sql(SCHEMA)}.show_djs (show_id, dj_id, active)
      VALUES (${showIds.cohost}, ${global.primary_dj_id}, true)
      ON CONFLICT (show_id, dj_id) DO UPDATE SET active = true`;
  });

  afterAll(async () => {
    if (!sql) return;
    const ids = Object.values(showIds);
    if (ids.length) {
      // Children first; see flowsheet-open-shows.spec.js for why `show_djs`
      // needs its own DELETE despite the schema's declared cascade.
      await sql`DELETE FROM ${sql(SCHEMA)}.flowsheet WHERE show_id = ANY(${sql.array(ids)}::int[])`;
      await sql`DELETE FROM ${sql(SCHEMA)}.show_djs WHERE show_id = ANY(${sql.array(ids)}::int[])`;
      await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ANY(${sql.array(ids)}::int[])`;
    }
    await sql.end({ timeout: 5 });
  });

  describe('POST /flowsheet/shows/:id/force-end without ended_at', () => {
    it('puts the show_end marker above a last entry with a sub-millisecond add_time', async () => {
      const id = showIds.lastEntry;

      const res = await forceEnd(id);
      expect(res.status).toBe(200);

      const order = await entryTypesInFeedOrder(id);
      expect(order[0]).toBe('show_end');

      const facts = await closeFacts(id);
      expect(facts.end_at_or_after_last_entry).toBe(true);
      expect(facts.markers_at_end_time).toBe(true);
      // Rounded up to the next millisecond, not further: the close is still
      // the show's last entry, to the precision a `Date` can carry.
      expect(new Date(facts.end_time).getTime()).toBe(LAST_ENTRY_ROUNDED_UP.getTime());
    });

    it("puts co-host dj_leave markers above the show's last entry too", async () => {
      const id = showIds.cohost;

      const res = await forceEnd(id);
      expect(res.status).toBe(200);

      // The marker and the leave share one instant, so the newer id (the
      // show_end, written last) leads; both sit above the last entry.
      const order = await entryTypesInFeedOrder(id);
      expect(order.slice(0, 2)).toEqual(['show_end', 'dj_leave']);

      const facts = await closeFacts(id);
      expect(facts.end_at_or_after_last_entry).toBe(true);
      expect(facts.markers_at_end_time).toBe(true);
    });

    it('rounds a sub-millisecond start_time up when the show logged nothing', async () => {
      const id = showIds.emptyFloor;

      const res = await forceEnd(id);
      expect(res.status).toBe(200);

      const facts = await closeFacts(id);
      expect(facts.end_at_or_after_start).toBe(true);
      expect(new Date(facts.end_time).getTime()).toBe(LAST_ENTRY_ROUNDED_UP.getTime());
    });

    it('rounds a sub-millisecond start_time up when every entry predates it', async () => {
      const id = showIds.predatesFloor;

      const res = await forceEnd(id);
      expect(res.status).toBe(200);

      expect((await entryTypesInFeedOrder(id))[0]).toBe('show_end');
      const facts = await closeFacts(id);
      expect(facts.end_at_or_after_start).toBe(true);
      expect(facts.end_at_or_after_last_entry).toBe(true);
    });
  });

  // The floor is the derived instant itself (BS#2315), so rounding it up moves
  // the floor with it: the truncated instant, which is below the last entry, is
  // now refused, and the derived instant is still accepted.
  describe('POST /flowsheet/shows/:id/force-end ended_at floor', () => {
    it('refuses the truncated instant, which is below the last entry, naming the rounded floor', async () => {
      const id = showIds.override;

      const res = await forceEnd(id, { ended_at: LAST_ENTRY_TRUNCATED.toISOString() });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain(LAST_ENTRY_ROUNDED_UP.toISOString());
      const [row] = await sql`SELECT end_time FROM ${sql(SCHEMA)}.shows WHERE id = ${id}`;
      expect(row.end_time).toBeNull();
    });

    it('accepts the derived instant itself', async () => {
      const id = showIds.override;

      const res = await forceEnd(id, { ended_at: LAST_ENTRY_ROUNDED_UP.toISOString() });

      expect(res.status).toBe(200);
      expect((await entryTypesInFeedOrder(id))[0]).toBe('show_end');
      const facts = await closeFacts(id);
      expect(facts.end_at_or_after_last_entry).toBe(true);
    });
  });
});
