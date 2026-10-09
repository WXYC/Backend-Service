/**
 * `GET /reviews/reviewers` (BS#3058). Real Postgres, seeded through tests/utils/intake_seed.js. The CI containers run
 * AUTH_BYPASS=true, so who may call the route is pinned by tests/unit/routes/reviews-permissions.route.test.ts; this tier
 * pins the SQL: which accounts are listed (a lapsed ban is lifted, one in force is not), the name fallback, the order, and that no `dj_name` reaches the body. The caller
 * is the station manager the other `reviews` specs use.
 */

const request = require('supertest')(`${process.env.TEST_HOST}:${process.env.PORT}`);
const { createAuthRequest } = require('../utils/test_helpers');
const { getTestDb } = require('../utils/db');
const { seedAuthUser, removeSeededAuthUsers, managerAccessToken } = require('../utils/intake_seed');

const PREFIX = 'itest-reviewers-';

describe('GET /reviews/reviewers (BS#3058)', () => {
  let manager;
  let sql;

  beforeAll(async () => {
    manager = createAuthRequest(request, `Bearer ${await managerAccessToken()}`);
    sql = getTestDb();
    const [{ id: organizationId }] = await sql`SELECT id FROM auth_organization LIMIT 1`;
    const accounts = [
      ['dj', 'dj', 'zed Handle', 'Zed Test Reviewer', false],
      ['md', 'musicDirector', 'bee Handle', 'bee Test Reviewer', false],
      ['sm', 'stationManager', 'Cat Handle', null, false],
      ['blank', 'dj', 'Dan Handle', ' \t ', false],
      ['member', 'member', 'Eve Handle', 'Eve Test Reviewer', false],
      ['autodj', 'dj', 'Auto Handle', null, false],
      ['banned', 'dj', 'Fay Handle', 'Fay Test Reviewer', true],
      // A ban that lapsed an hour ago: better-auth clears `banned` only at the next sign-in, so the row still says true.
      ['lapsed', 'dj', 'Gus Handle', 'Gus Test Reviewer', true, new Date(Date.now() - 3_600_000)],
    ];
    for (const [suffix, role, name, realName, banned, banExpires = null] of accounts) {
      const user = await seedAuthUser({
        id: PREFIX + suffix,
        name,
        email: `${PREFIX}${suffix}@test.wxyc.org`,
        real_name: realName,
        dj_name: `On Air ${suffix}`,
        banned,
        ban_expires: banExpires,
        // The auto-DJ service account is recognised by its username; it holds the dj role yet is never listed.
        ...(suffix === 'autodj' && { username: 'autodj' }),
      });
      await sql`INSERT INTO auth_member (id, organization_id, user_id, role) VALUES (${`${user.id}-m`}, ${organizationId}, ${user.id}, ${role})`;
    }
  });

  afterAll(async () => {
    await removeSeededAuthUsers();
  });

  test('lists the accounts that can write reviews, by real name else account name, sorted case-insensitively', async () => {
    const res = await manager.get('/reviews/reviewers');
    expect(res.status).toBe(200);
    const own = res.body.reviewers.filter((r) => r.id.startsWith(PREFIX));
    expect(own).toEqual([
      { id: `${PREFIX}md`, name: 'bee Test Reviewer' },
      { id: `${PREFIX}sm`, name: 'Cat Handle' },
      { id: `${PREFIX}blank`, name: 'Dan Handle' },
      { id: `${PREFIX}lapsed`, name: 'Gus Test Reviewer' },
      { id: `${PREFIX}dj`, name: 'Zed Test Reviewer' },
    ]);
  });

  test('carries no dj_name', async () => {
    const res = await manager.get('/reviews/reviewers');
    expect(JSON.stringify(res.body)).not.toContain('On Air');
    expect(res.body.reviewers.every((r) => Object.keys(r).sort().join() === 'id,name')).toBe(true);
  });
});
