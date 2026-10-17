/**
 * `GET /reviews/reviewers` (BS#3058). Real Postgres, seeded through tests/utils/intake_seed.js. The CI containers run
 * AUTH_BYPASS=true, so who may call the route is pinned by tests/unit/routes/reviews-permissions.route.test.ts; this tier
 * pins the SQL: which accounts are listed (a lapsed ban is lifted, one in force is not), the name fallback, the order, that `name` is never the `dj_name`, and the three
 * activity fields (BS#3384): `on_air_name`, `records_out` and `last_submitted_at`. The caller is the station manager the other `reviews` specs use.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const {
  seedAuthUser,
  seedMember,
  removeSeededAuthUsers,
  seedIntakeItem,
  removeSeededIntakeItems,
  seedLibraryRelease,
  removeSeededLibraryReleases,
  seedReview,
  managerAccessToken,
} = require('../utils/intake_seed');

const PREFIX = 'itest-reviewers-';

describe('GET /reviews/reviewers (BS#3058, BS#3384)', () => {
  let manager;

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    // [suffix, role, account name, real name, banned, ban expiry, dj_name]
    const accounts = [
      ['dj', 'dj', 'zed Handle', 'Zed Test Reviewer', false, null, 'On Air dj'],
      ['md', 'musicDirector', 'bee Handle', 'bee Test Reviewer', false, null, 'Anonymous'],
      ['sm', 'stationManager', 'Cat Handle', null, false, null, null],
      ['blank', 'dj', 'Dan Handle', ' \t ', false, null, '  On Air blank  '],
      ['member', 'member', 'Eve Handle', 'Eve Test Reviewer', false, null, 'On Air member'],
      ['autodj', 'dj', 'Auto Handle', null, false, null, 'On Air autodj'],
      ['banned', 'dj', 'Fay Handle', 'Fay Test Reviewer', true, null, 'On Air banned'],
      // A ban that lapsed an hour ago: better-auth clears `banned` only at the next sign-in, so the row still says true.
      ['lapsed', 'dj', 'Gus Handle', 'Gus Test Reviewer', true, new Date(Date.now() - 3_600_000), 'On Air lapsed'],
    ];
    for (const [suffix, role, name, realName, banned, banExpires, djName] of accounts) {
      const user = await seedAuthUser({
        id: PREFIX + suffix,
        name,
        email: `${PREFIX}${suffix}@test.wxyc.org`,
        real_name: realName,
        dj_name: djName,
        banned,
        ban_expires: banExpires,
        // The auto-DJ service account is recognised by its username; it holds the dj role yet is never listed.
        ...(suffix === 'autodj' && { username: 'autodj' }),
      });
      await seedMember(user.id, role);
    }
    // `dj` holds two records (one checked out, one reviewed disc still out) and submitted twice; `md` holds only a filed record and never submitted.
    const holder = `${PREFIX}dj`;
    const held = [
      await seedIntakeItem({ checkout: { by: holder }, state: 'checked_out' }),
      await seedIntakeItem({ checkout: { by: holder }, state: 'reviewed' }),
    ];
    const filed = await seedLibraryRelease({ artist_name: PREFIX, album_title: `${PREFIX} filed` });
    await seedIntakeItem({
      checkout: { by: `${PREFIX}md` },
      state: 'filed',
      album_id: filed.id,
      filed_at: new Date().toISOString(),
    });
    await seedReview({ intake_item_id: held[0].id, author_user_id: holder, submitted_at: '2026-09-01T12:00:00Z' });
    await seedReview({ intake_item_id: held[1].id, author_user_id: holder, submitted_at: '2026-10-01T12:00:00Z' });
  });

  afterAll(async () => {
    await removeSeededIntakeItems();
    await removeSeededLibraryReleases();
    await removeSeededAuthUsers();
  });

  const listed = async () => {
    const res = await manager.get('/reviews/reviewers');
    expect(res.status).toBe(200);
    return res.body.reviewers.filter((r) => r.id.startsWith(PREFIX));
  };

  test('lists the accounts that can write reviews, by real name else account name, sorted case-insensitively', async () => {
    expect((await listed()).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: `${PREFIX}md`, name: 'bee Test Reviewer' },
      { id: `${PREFIX}sm`, name: 'Cat Handle' },
      { id: `${PREFIX}blank`, name: 'Dan Handle' },
      { id: `${PREFIX}lapsed`, name: 'Gus Test Reviewer' },
      { id: `${PREFIX}dj`, name: 'Zed Test Reviewer' },
    ]);
  });

  test('carries the on-air name, the records out and the newest submission of each account', async () => {
    const byId = Object.fromEntries((await listed()).map((r) => [r.id, r]));
    const fields = ({ on_air_name, records_out, last_submitted_at }) => ({
      on_air_name,
      records_out,
      last_submitted_at,
    });
    expect(fields(byId[`${PREFIX}dj`])).toEqual({
      on_air_name: 'On Air dj',
      records_out: 2,
      last_submitted_at: '2026-10-01T12:00:00.000Z',
    });
    // "Anonymous" counts as no on-air name; a filed record is no longer out; no submission is null.
    expect(fields(byId[`${PREFIX}md`])).toEqual({ on_air_name: null, records_out: 0, last_submitted_at: null });
    expect(fields(byId[`${PREFIX}sm`])).toEqual({ on_air_name: null, records_out: 0, last_submitted_at: null });
    expect(byId[`${PREFIX}blank`].on_air_name).toBe('On Air blank');
  });

  test('name is never the dj_name, and each reviewer carries exactly the contract fields', async () => {
    const own = await listed();
    expect(own.every((r) => !r.name.includes('On Air'))).toBe(true);
    expect(own.every((r) => Object.keys(r).sort().join() === 'id,last_submitted_at,name,on_air_name,records_out')).toBe(
      true
    );
  });
});
