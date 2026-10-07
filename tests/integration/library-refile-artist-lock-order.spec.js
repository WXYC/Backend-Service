/**
 * `POST /library/artists/:id/refile` bucket lock (BS#2643), with the interleavings forced rather than raced.
 *
 * The re-file locks the whole `(code_letters, genre_id)` bucket in one statement over `genre_artist_crossreference`
 * alone, `ORDER BY artist_id`, plain `FOR UPDATE`, on its transaction. Three properties, each pinned here:
 *
 *  (a) Two re-files into one bucket SERIALIZE. A raw session S holds `FOR UPDATE` on the bucket's lowest
 *      `artist_id` row (a third artist below both movers), so both requests queue on that first row before holding
 *      anything else. Both are fired, the spec waits until two request backends are provably waiting, then releases S.
 *      Exactly one answers 200; the loser re-reads the occupied slot and answers 409 naming the winner. If the bucket
 *      lock ran on the pool instead of the transaction, both blocked statements would complete on S's commit and
 *      release at once, and both requests would pass the occupancy check against a still-free 31: two 200s.
 *      TIME BUDGET: both requests must be seen waiting, and S released, inside the 750 ms `lock_timeout`, measured
 *      from when the first starts waiting. After the release the winner takes the first row and locks the rest; the
 *      loser starts a NEW lock wait on that row behind the winner, with its own 750 ms covering the winner's UPDATE,
 *      count and commit. On a slow runner that wait can legitimately time out with a 503: the spec logs it and
 *      re-sends the loser once, which must then answer 409 naming the winner. Two 200s, a 500, or a 409 naming the
 *      wrong artist are failures.
 *  (b) The lock does not reach `artists`. S holds a bucket row ABOVE mover X, so the re-file locks X's crossreference
 *      row and blocks on S's. While it is blocked, `SELECT ... FROM artists WHERE id = X FOR KEY SHARE NOWAIT`
 *      succeeds. A joined `.for('update')` would have locked X's `artists` row too and the probe would be refused
 *      with 55P03.
 *  (c) A live writer holding a bucket row past the timeout makes the request stand down with 503
 *      `LockUnavailableRefusal`.
 */
const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { managerAccessToken } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-REFILE-LOCK';
const GENRE = 6;
const BLOCKED_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 15;
const TARGET = 31;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('POST /library/artists/:id/refile bucket lock (BS#2643)', () => {
  let manager;
  let sql;
  let letters = 0;

  // A fresh code-letters bucket per test so no test sees another's rows.
  const newBucket = async (count) => {
    const code = `ZL${String.fromCharCode(65 + letters++)}`;
    const ids = [];
    for (let i = 0; i < count; i++) {
      const [artist] = await sql`
        INSERT INTO ${sql(SCHEMA)}.artists (artist_name, alphabetical_name, code_letters)
        VALUES (${`${PREFIX} ${code} ${i}`}, ${`${PREFIX} ${code} ${i}`}, ${code}) RETURNING id`;
      await sql`
        INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
        VALUES (${artist.id}, ${GENRE}, ${i + 1})`;
      ids.push(artist.id);
    }
    return ids;
  };

  const cleanup = async () => {
    const ids = (await sql`SELECT id FROM ${sql(SCHEMA)}.artists WHERE artist_name LIKE ${`${PREFIX}%`}`).map(
      (a) => a.id
    );
    if (ids.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.genre_artist_crossreference WHERE artist_id IN ${sql(ids)}`;
      await sql`DELETE FROM ${sql(SCHEMA)}.artists WHERE id IN ${sql(ids)}`;
    }
  };

  /** Opens a raw transaction holding `FOR UPDATE` on `artistId`'s crossreference row until `release()` is called. */
  const holdRow = async (artistId) => {
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    let resolvePid;
    const held = new Promise((resolve) => {
      resolvePid = resolve;
    });
    const done = sql.begin(async (tx) => {
      const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
      await tx.unsafe(
        `SELECT 1 FROM "${SCHEMA}".genre_artist_crossreference WHERE artist_id = $1 AND genre_id = $2 FOR UPDATE`,
        [artistId, GENRE]
      );
      resolvePid(pid);
      await released;
    });
    const pid = await held;
    return {
      pid,
      release: async () => {
        release();
        await done;
      },
    };
  };

  /** Polls until `count` request backends (not S, not this probe) are waiting on a lock in a crossreference statement. */
  const waitForWaiters = async (sPid, count) => {
    const deadline = Date.now() + BLOCKED_WAIT_MS;
    while (Date.now() < deadline) {
      const waiting = await sql`
        SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND pid <> ${sPid}::int AND pid <> pg_backend_pid()
          AND query ILIKE '%genre_artist_crossreference%'`;
      if (waiting.length >= count) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`${count} request backend(s) were not seen waiting within ${BLOCKED_WAIT_MS} ms`);
  };

  const refile = (artistId) =>
    manager.post(`/library/artists/${artistId}/refile`).send({ genre_id: GENRE, code_artist_number: TARGET });

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it('(a) serializes two re-files into one bucket: exactly one 200, the loser names the winner', async () => {
    const [lowest, x, y] = await newBucket(3);
    const s = await holdRow(lowest);
    let released = false;
    let results;
    try {
      const pending = [refile(x).then((r) => r), refile(y).then((r) => r)];
      await waitForWaiters(s.pid, 2);
      await s.release();
      released = true;
      results = await Promise.all(pending);
    } finally {
      if (!released) await s.release();
    }

    const winners = results.map((r, i) => ({ r, id: [x, y][i] })).filter(({ r }) => r.status === 200);
    expect(winners).toHaveLength(1);
    const winnerId = winners[0].id;
    const loserIndex = results.findIndex((r) => r.status !== 200);
    const loserId = [x, y][loserIndex];
    let loser = results[loserIndex];
    if (loser.status === 503) {
      console.warn('refile lock-order (a): loser answered 503 (timing); re-sending once');
      loser = await refile(loserId);
    }
    expect(loser.status).toBe(409);
    expect(loser.body.reason).toBe('artist_code_conflict');
    expect(loser.body.artist).toMatchObject({ id: winnerId, code_artist_number: TARGET });
  }, 30000);

  it('(b) does not lock the artists rows: KEY SHARE on the mover succeeds while the re-file is blocked', async () => {
    const [x, above] = await newBucket(2);
    const s = await holdRow(above);
    let released = false;
    let result;
    let probe;
    try {
      const pending = refile(x).then((r) => r);
      await waitForWaiters(s.pid, 1);
      probe = await sql
        .begin(async (tx) => {
          await tx.unsafe(`SELECT id FROM "${SCHEMA}".artists WHERE id = $1 FOR KEY SHARE NOWAIT`, [x]);
          return 'granted';
        })
        .catch((error) => error.code);
      await s.release();
      released = true;
      result = await pending;
    } finally {
      if (!released) await s.release();
    }

    expect(probe).toBe('granted');
    // The probe is the property under test; on a slow runner the re-file's own wait can time out (503).
    expect([200, 503]).toContain(result.status);
  }, 30000);

  it('(c) stands down with 503 lock_unavailable when a live writer holds a bucket row past the timeout', async () => {
    const [x, other] = await newBucket(2);
    const s = await holdRow(other);
    let res;
    try {
      res = await refile(x);
    } finally {
      await s.release();
    }

    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('lock_unavailable');
  }, 30000);
});
