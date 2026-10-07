/**
 * A reporter's `DELETE /fcc-notes/{id}` and a music director's `POST /fcc-notes/{id}/confirm` of one note, with the
 * overlap forced (BS#2863, slice 13d of BS#2791). Each is one conditional statement on the note's own row, so whichever
 * takes the row lock second re-checks its `WHERE` against the other's committed result: a delete that loses to a confirm
 * matches nothing (the reporter's `status = 'reported'` condition is in the `DELETE` itself, not in a prior read) and is
 * refused, and a confirm that loses to a delete finds no note.
 *
 * Nothing here races. A raw transaction takes the note's row `FOR UPDATE` and holds it. The two requests are then fired
 * one at a time, in the order under test, and the spec waits by `pg_blocking_pids` until each one's backend is provably
 * queued on that lock before it fires the next, so the order they take the lock in is the order they were fired in.
 * Releasing the raw transaction then lets them run. Every wait is bounded.
 *
 * Rows come from `tests/utils/intake_seed.js`. `djA` is a raw user-id Bearer (the reporter, holding no
 * `reviews: manage`); `manager` is the station-manager fixture account.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { seedIntakeItem, removeSeededIntakeItems, seedFccNote, managerAccessToken } = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-FCC-RACE';
/** How long to wait for a request's backend to appear as blocked before giving up. */
const BLOCKED_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a reporter’s delete and a music director’s confirm of one FCC note (BS#2863)', () => {
  let manager;
  let djA;
  let sql;

  const cleanup = async () => {
    await removeSeededIntakeItems();
  };

  /** Polls until at least `count` backends are waiting on a lock that `pid` holds; throws when they do not show up in time. */
  const waitUntilBlockedBy = async (pid, count) => {
    const deadline = Date.now() + BLOCKED_WAIT_MS;
    while (Date.now() < deadline) {
      const waiting = await sql`
        SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
      if (waiting.length >= count) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`fewer than ${count} backends were blocked on the note's row lock within ${BLOCKED_WAIT_MS} ms`);
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    djA = createAuthRequest(request, `Bearer ${global.primary_dj_id}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  test.each([
    ['the confirm first', 'confirm', 200, 403, 'confirmed'],
    ['the delete first', 'delete', 404, 204, 'gone'],
  ])(
    'with %s: the note ends %s, and the reporter’s delete never removes a confirmed one',
    async (_name, first, confirmStatus, deleteStatus, ending) => {
      const item = await seedIntakeItem({ artist_name: `${PREFIX} ${first}`, album_title: `${PREFIX} album` });
      const note = await seedFccNote({ intake_item_id: item.id, reported_by_user_id: global.primary_dj_id });
      const confirm = () => manager.post(`/fcc-notes/${note.id}/confirm`).then((res) => res);
      const remove = () => djA.delete(`/fcc-notes/${note.id}`).then((res) => res);

      let responses = [];
      await sql.begin(async (tx) => {
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        await tx.unsafe(`SELECT id FROM "${SCHEMA}".fcc_notes WHERE id = $1 FOR UPDATE`, [note.id]);
        const [start, second] = first === 'confirm' ? [confirm, remove] : [remove, confirm];
        const firstRequest = start();
        await waitUntilBlockedBy(pid, 1);
        const secondRequest = second();
        await waitUntilBlockedBy(pid, 2);
        responses = [firstRequest, secondRequest];
      });

      const [firstRes, secondRes] = await Promise.all(responses);
      const [confirmRes, deleteRes] = first === 'confirm' ? [firstRes, secondRes] : [secondRes, firstRes];
      expect([confirmRes.status, deleteRes.status]).toEqual([confirmStatus, deleteStatus]);
      const rows = await sql.unsafe(`SELECT status, confirmed_by FROM "${SCHEMA}".fcc_notes WHERE id = $1`, [note.id]);
      expect(rows.map((row) => [row.status, typeof row.confirmed_by])).toEqual(
        ending === 'gone' ? [] : [['confirmed', 'string']]
      );
    },
    20000
  );
});
