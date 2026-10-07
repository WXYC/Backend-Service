/**
 * `POST /library/artists/:id/refile` bucket lock (BS#2643), with the interleavings forced rather than raced.
 *
 * The re-file locks, on its transaction and in this order: (1) the artist's own `artists` row, `FOR NO KEY UPDATE`,
 * before the card is read; (2) the `(code_letters, genre_id)` bucket plus the artist's own memberships in one statement
 * over `genre_artist_crossreference` alone, `ORDER BY genre_id, artist_id`, plain `FOR UPDATE`. Four properties, each
 * pinned here, in this order: (a), (b), (d), (c).
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
 *  (b) The bucket lock does not reach OTHER artists' `artists` rows. S holds a bucket row ABOVE mover X, so the re-file
 *      locks X's crossreference row and blocks on S's. While it is blocked, `SELECT ... FROM artists WHERE id = <other>
 *      FOR KEY SHARE NOWAIT` succeeds. A joined `.for('update')` would have locked up to 263 `artists` rows and the
 *      probe would be refused with 55P03. The mover's OWN `artists` row is locked FOR NO KEY UPDATE (first, before the
 *      card is read, matching `deleteArtistFromDB`'s order), which does not conflict with KEY SHARE: the same probe on
 *      the mover succeeds too.
 *  (d) Stale letters. A re-file must lock the artist's `artists` row BEFORE reading `code_letters`, or it checks one
 *      bucket and writes into another. S has an uncommitted `UPDATE artists SET code_letters = <holder's>` on mover X.
 *      BOTH the old and the fixed code wait on S, but for different reasons and with different outcomes: every catalog
 *      write fires a statement-level trigger that UPDATEs the single `library_watermark` row, so S holds that row and
 *      the OLD code's crossreference UPDATE queues behind it, after it has already checked the stale bucket; it then
 *      writes, and answers 200 with a duplicate holder. The FIXED code waits at its first statement, on X's `artists`
 *      row, before reading the card, so after S commits it sees the new letters and answers 409 naming the holder. The
 *      test therefore discriminates on the outcome (final status 409 plus exactly one holder), not on whether a wait
 *      was seen. The spec races "the response arrives" against "the request is seen waiting on S"; the response-first
 *      branch is a safety net that neither version normally takes. A 503 is inconclusive (lock timeout on a slow
 *      runner) and is never retried.
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

  /** Opens a raw transaction holding an uncommitted `UPDATE artists SET code_letters` on `artistId`'s row. */
  const holdLettersUpdate = async (artistId, letters) => {
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
      await tx`UPDATE ${sql(SCHEMA)}.artists SET code_letters = ${letters} WHERE id = ${artistId}`;
      resolvePid(pid);
      await released;
    });
    const pid = await held;
    return {
      pid,
      commit: async () => {
        release();
        await done;
      },
    };
  };

  /** Resolves true once a request backend is seen blocked behind `sPid`; false after `ms`, or once `stop.done`. */
  const seenWaitingOn = async (sPid, stop, ms = BLOCKED_WAIT_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !stop.done) {
      const waiting = await sql`
        SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND ${sPid}::int = ANY(pg_blocking_pids(pid))`;
      if (waiting.length > 0) return true;
      await sleep(POLL_INTERVAL_MS);
    }
    return false;
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

  it("(b) locks no other artist's row: KEY SHARE on the mover and on the others succeeds while the re-file is blocked", async () => {
    const [x, above] = await newBucket(2);
    const s = await holdRow(above);
    let released = false;
    let result;
    let probe;
    let ownLockProbe;
    try {
      const pending = refile(x).then((r) => r);
      await waitForWaiters(s.pid, 1);
      probe = await sql
        .begin(async (tx) => {
          await tx.unsafe(`SELECT id FROM "${SCHEMA}".artists WHERE id IN ($1, $2) FOR KEY SHARE NOWAIT`, [x, above]);
          return 'granted';
        })
        .catch((error) => error.code);
      // The mover's own row IS locked FOR NO KEY UPDATE: a competing NO KEY UPDATE is refused. Without the artists
      // lock this would be granted, so it is what tells "locked" from "not locked at all".
      ownLockProbe = await sql
        .begin(async (tx) => {
          await tx.unsafe(`SELECT id FROM "${SCHEMA}".artists WHERE id = $1 FOR NO KEY UPDATE NOWAIT`, [x]);
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
    expect(ownLockProbe).toBe('55P03');
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

  it("(d) waits on an uncommitted re-letter of the mover's row instead of checking the stale bucket: 409 naming the holder", async () => {
    const [holder] = await newBucket(1);
    const [mover] = await newBucket(1);
    const [{ code_letters: holderLetters }] =
      await sql`SELECT code_letters FROM ${sql(SCHEMA)}.artists WHERE id = ${holder}`;
    await sql`UPDATE ${sql(SCHEMA)}.genre_artist_crossreference SET artist_genre_code = ${TARGET} WHERE artist_id = ${holder}`;
    const s = await holdLettersUpdate(mover, holderLetters);
    const stop = { done: false };
    let committed = false;
    let pending;
    let response;
    try {
      pending = refile(mover).then((r) => ({ kind: 'response', r }));
      const waiting = seenWaitingOn(s.pid, stop).then((seen) => ({ kind: seen ? 'waiting' : 'never' }));
      const first = await Promise.race([pending, waiting]);
      if (first.kind === 'response') {
        response = first.r;
      } else if (first.kind === 'waiting') {
        await s.commit();
        committed = true;
        response = (await pending).r;
      } else {
        throw new Error('inconclusive: the request neither answered nor waited on S within the budget');
      }
    } finally {
      stop.done = true;
      if (!committed) await s.commit();
      if (pending) await pending.catch(() => {});
    }

    if (response.status === 503) {
      throw new Error('inconclusive: lock timeout on a slow runner (503); not retried');
    }
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('artist_code_conflict');
    expect(response.body.artist).toMatchObject({ id: holder, code_artist_number: TARGET });
    const holders = await sql`
      SELECT x.artist_id FROM ${sql(SCHEMA)}.genre_artist_crossreference x
      JOIN ${sql(SCHEMA)}.artists a ON a.id = x.artist_id
      WHERE a.code_letters = ${holderLetters} AND x.genre_id = ${GENRE} AND x.artist_genre_code = ${TARGET}`;
    expect(holders.map((h) => h.artist_id)).toEqual([holder]);
  }, 30000);

  it('re-files the right membership of a multi-genre artist: previous number from that genre, the other row untouched', async () => {
    const [lowGenre] = await sql`SELECT id FROM ${sql(SCHEMA)}.genres WHERE id < ${GENRE} ORDER BY id LIMIT 1`;
    const [x] = await newBucket(1);
    await sql`
      INSERT INTO ${sql(SCHEMA)}.genre_artist_crossreference (artist_id, genre_id, artist_genre_code)
      VALUES (${x}, ${lowGenre.id}, 7)`;

    const res = await refile(x);

    expect(res.status).toBe(200);
    expect(res.body.previous_code_artist_number).toBe(1);
    expect(res.body.code_artist_number).toBe(TARGET);
    const rows = await sql`
      SELECT genre_id, artist_genre_code FROM ${sql(SCHEMA)}.genre_artist_crossreference
      WHERE artist_id = ${x} ORDER BY genre_id`;
    expect(rows.map((r) => [r.genre_id, r.artist_genre_code])).toEqual([
      [lowGenre.id, 7],
      [GENRE, TARGET],
    ]);
  }, 30000);

  it('serializes a rename (PATCH) of the mover with the re-file: both succeed', async () => {
    const [x, above] = await newBucket(2);
    const s = await holdRow(above);
    const renamed = `${PREFIX} renamed`;
    let released = false;
    let results;
    try {
      const refiling = refile(x).then((r) => r);
      await waitForWaiters(s.pid, 1);
      const renaming = manager
        .patch(`/library/artists/${x}`)
        .send({ artist_name: renamed })
        .then((r) => r);
      const deadline = Date.now() + BLOCKED_WAIT_MS;
      for (;;) {
        const blocked = await sql`
          SELECT pid FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND pid <> ${s.pid}::int AND query ILIKE '%update%artists%set%'`;
        if (blocked.length > 0) break;
        if (Date.now() > deadline) throw new Error('the rename was not seen waiting on the re-file');
        await sleep(POLL_INTERVAL_MS);
      }
      await s.release();
      released = true;
      results = await Promise.all([refiling, renaming]);
    } finally {
      if (!released) await s.release();
    }

    const [refiled, rename] = results;
    if (refiled.status === 503) throw new Error('inconclusive: lock timeout on a slow runner (503); not retried');
    expect(refiled.status).toBe(200);
    expect(rename.status).toBe(200);
    const [row] = await sql`
      SELECT a.artist_name, x.artist_genre_code FROM ${sql(SCHEMA)}.artists a
      JOIN ${sql(SCHEMA)}.genre_artist_crossreference x ON x.artist_id = a.id AND x.genre_id = ${GENRE}
      WHERE a.id = ${x}`;
    expect(row).toMatchObject({ artist_name: renamed, artist_genre_code: TARGET });
  }, 30000);
});
