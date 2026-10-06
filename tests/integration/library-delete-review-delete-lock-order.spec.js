/**
 * `DELETE /library/{id}` against a review writer on a review of the release, with the interleaving forced
 * (BS#2928, slice of BS#2791). A review writer (`deleteReview`, through `lockReviewAfterItem`) locks the
 * intake item and then the review. The library delete used to lock the review (the capture's `FOR SHARE`)
 * before the item, so a writer that held the item and was about to take the review met the delete in a lock
 * cycle, and the librarian got 503 `lock_unavailable`. The delete now locks the release's items first, so it
 * waits on the item before it holds any review.
 *
 * Nothing here races. A raw transaction takes the item `FOR UPDATE`, which is the writer's first lock. The
 * `DELETE /library/{id}` is then fired and the spec waits, by `pg_blocking_pids`, until its backend is
 * provably waiting on that raw transaction. Only then does the raw transaction take the writer's second lock,
 * the review, with `NOWAIT`: granted when the delete holds no review yet (the fix), refused with `55P03` when
 * the delete already holds the review `FOR SHARE` (the old order). Releasing the item then lets the delete
 * finish. The whole probe runs inside the delete's `lock_timeout` (750 ms, from when it starts waiting), and
 * every wait here is bounded.
 *
 * Rows come from `tests/utils/intake_seed.js`. `reviews:manage` is the station-manager fixture account.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const {
  seedIntakeItem,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  managerAccessToken,
} = require('../utils/intake_seed');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';
const PREFIX = 'ITEST-LOCK-ORDER';
/** How long to wait for the delete's backend to appear as blocked before giving up. */
const BLOCKED_WAIT_MS = 5000;
const POLL_INTERVAL_MS = 15;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DELETE /library/:id takes the release items before any review (BS#2928)', () => {
  let manager;
  let sql;
  const releaseIds = [];

  const cleanup = async () => {
    await sql.unsafe(`DELETE FROM "${SCHEMA}".reviews WHERE author LIKE $1`, [`${PREFIX}%`]);
    await sql.unsafe(`DELETE FROM "${SCHEMA}".intake_items WHERE artist_name LIKE $1`, [`${PREFIX}%`]);
    if (releaseIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.catalog_delete_snapshot WHERE entity_kind = 'library' AND entity_id = ANY(${releaseIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.library_delete_denylist WHERE library_id = ANY(${releaseIds})`;
    }
    await removeSeededLibraryReleases();
  };

  /** Polls until some backend is waiting on a lock that `pid` holds; throws when none shows up in time. */
  const waitUntilBlockedBy = async (pid) => {
    const deadline = Date.now() + BLOCKED_WAIT_MS;
    while (Date.now() < deadline) {
      const waiting = await sql`
        SELECT pid FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND ${pid}::int = ANY(pg_blocking_pids(pid))`;
      if (waiting.length > 0) return;
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(`no backend was blocked on the item lock within ${BLOCKED_WAIT_MS} ms`);
  };

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    await cleanup();
  });

  afterAll(cleanup);

  it('is waiting on the item, holding no review, when a review writer takes the review next', async () => {
    const release = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} release` });
    releaseIds.push(release.id);
    const item = await seedIntakeItem({ artist_name: `${PREFIX} item`, state: 'filed', album_id: release.id });
    const review = await seedReview({ album_id: release.id, author: `${PREFIX} author` });

    let deletion;
    let reviewLock;
    try {
      await sql.begin(async (tx) => {
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        // The review writer's first lock.
        await tx.unsafe(`SELECT id FROM "${SCHEMA}".intake_items WHERE id = $1 FOR UPDATE`, [item.id]);
        deletion = manager.delete(`/library/${release.id}`).then((res) => res);
        await waitUntilBlockedBy(pid);
        // The review writer's second lock, in a savepoint so a refusal leaves the transaction usable.
        reviewLock = await tx
          .savepoint(async (probe) => {
            await probe.unsafe(`SELECT id FROM "${SCHEMA}".reviews WHERE id = $1 FOR UPDATE NOWAIT`, [review.id]);
            return 'granted';
          })
          .catch((error) => error.code);
      });
    } finally {
      // The raw transaction has ended either way, so the delete is free to finish or time out.
      if (deletion) await deletion.catch(() => {});
    }

    // 55P03 (lock_not_available) means the delete already held the review: the old lock order.
    expect(reviewLock).toBe('granted');
    const res = await deletion;
    expect(res.status).toBe(204);
  }, 20000);
});
