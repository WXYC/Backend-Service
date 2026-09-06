/**
 * Integration test for `jobs/station-signup-review`'s downgrade against real
 * PostgreSQL. Runs the REAL compiled `queryPendingSelfSignups`
 * (`dist/query.cjs`) and `planDowngrades` / `applyDowngrades`
 * (`dist/downgrade.cjs`) through `@wxyc/database`'s postgres-js driver.
 *
 * **Why this tier exists for this job specifically.** Every unit suite in this
 * repo mocks `drizzle-orm` wholesale, so a predicate is only ever asserted as
 * the SHAPE of a mock argument — `{ and: [{ eq: [...] }, ...] }`. That is a
 * fine check that the code builds the clause it meant to, and no check at all
 * that the clause does what it is supposed to against a database. For the one
 * job in the fleet that changes a DJ's station privileges, that gap shipped a
 * real defect: the downgrade wrote no terminal marker, so a downgraded account
 * never left the pending cohort, satisfied the 30-day cutoff and the
 * `WHERE role = 'dj'` guard again the moment a manager re-promoted it, and was
 * demoted again the next morning — forever. Every unit test was green. The
 * "second run is a no-op" and "re-promotion sticks" cases below are what would
 * have caught it.
 *
 * `dist/query.cjs` and `dist/downgrade.cjs` are produced by the workspace
 * `build` (tsup esm+cjs); CI's Build step runs before the integration tier.
 * Rebuild after editing either file
 * (`npm run build --workspace=@wxyc/station-signup-review`). Needs the Docker
 * integration DB (the `pg` marker tier). Every seeded id carries an `ssr-`
 * marker and is tracked for teardown.
 */

// The repo-wide `tests/__mocks__/drizzle-orm.ts` manual mock (for the ts-jest
// unit tier) is auto-applied to every `drizzle-orm` require, including here.
// The compiled bundles need the REAL drizzle-orm (its query builder produces
// the SQL `@wxyc/database`'s driver runs), so unmock it -- same pattern as
// `metadata-no-match-digest.spec.js` / `artist-unicode-dedup-merge.spec.js`.
// Hoisted above the requires by babel-plugin-jest-hoist.
jest.unmock('drizzle-orm');

const path = require('path');
const { getTestDb } = require('../utils/db');

const distDir = path.join(__dirname, '..', '..', 'jobs', 'station-signup-review', 'dist');
// The REAL compiled cores -- no reimplementation, so the behavior under test
// is the behavior that ships.
const { queryPendingSelfSignups } = require(path.join(distDir, 'query.cjs'));
const { planDowngrades, applyDowngrades, isDowngradeEnabled } = require(path.join(distDir, 'downgrade.cjs'));
const { db } = require('@wxyc/database');

const SCHEMA = process.env.WXYC_SCHEMA_NAME || 'wxyc_schema';

/** `auth_user.role` value seeded on every account here, asserted unchanged after every downgrade. */
const SENTINEL_AUTH_USER_ROLE = 'user';

describe('station-signup-review downgrade (REAL fns, real PG)', () => {
  let sql;
  let organizationId;
  let previousFlag;
  const userIds = [];
  const showIds = [];

  const uniqueId = () => `ssr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * Seed one self-signed-up account: an `auth_user` row carrying the review
   * columns, plus its `auth_member` row in the default organization (which is
   * where the role that actually gates flowsheet writes lives).
   */
  async function seedAccount({ daysPending = 31, memberRole = 'dj', reviewed = false } = {}) {
    const id = uniqueId();
    await sql`
      INSERT INTO auth_user
        (id, name, email, role, self_signup_at, self_signup_reviewed_at, self_signup_downgraded_at)
      VALUES (
        ${id},
        'SSR Test DJ',
        ${`${id}@test.wxyc.org`},
        ${SENTINEL_AUTH_USER_ROLE},
        now() - make_interval(days => ${daysPending}),
        ${reviewed ? sql`now()` : null},
        NULL
      )
    `;
    userIds.push(id);
    await sql`
      INSERT INTO auth_member (id, organization_id, user_id, role)
      VALUES (${`${id}-m`}, ${organizationId}, ${id}, ${memberRole})
    `;
    return id;
  }

  /** Open a show (`end_time IS NULL`) with the account as either its primary DJ or a `show_djs` member. */
  async function seedOpenShow(userId, { asPrimary = true } = {}) {
    const rows = await sql`
      INSERT INTO ${sql(SCHEMA)}.shows (show_name, start_time, end_time, primary_dj_id)
      VALUES ('ssr-open-show', now(), NULL, ${asPrimary ? userId : null})
      RETURNING id
    `;
    const showId = Number(rows[0].id);
    showIds.push(showId);
    if (!asPrimary) {
      await sql`
        INSERT INTO ${sql(SCHEMA)}.show_djs (show_id, dj_id, active)
        VALUES (${showId}, ${userId}, true)
      `;
    }
    return showId;
  }

  const memberRoleOf = async (userId) => {
    const rows = await sql`SELECT role FROM auth_member WHERE user_id = ${userId}`;
    return rows[0]?.role ?? null;
  };

  const authUserRowOf = async (userId) => {
    const rows = await sql`
      SELECT role, self_signup_reviewed_at, self_signup_downgraded_at
      FROM auth_user WHERE id = ${userId}
    `;
    return rows[0];
  };

  /** One full actuator pass: plan, then apply, exactly as `orchestrate.run()` does. */
  async function runDowngradePass(userId, now = new Date()) {
    const pending = (await queryPendingSelfSignups()).filter((r) => r.userId === userId);
    const decisions = await planDowngrades(db, pending, now);
    const applied = await applyDowngrades(db, decisions, now);
    return { pending, decisions, applied };
  }

  beforeAll(async () => {
    sql = getTestDb();
    previousFlag = process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'true';

    const orgs = await sql`SELECT id FROM auth_organization ORDER BY created_at ASC LIMIT 1`;
    if (orgs.length === 0) {
      throw new Error('No auth_organization row in the integration database; cannot seed auth_member.');
    }
    organizationId = orgs[0].id;
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.STATION_SIGNUP_DOWNGRADE_ENABLED;
    else process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = previousFlag;
  });

  afterEach(async () => {
    if (showIds.length > 0) {
      await sql`DELETE FROM ${sql(SCHEMA)}.show_djs WHERE show_id = ANY(${showIds})`;
      await sql`DELETE FROM ${sql(SCHEMA)}.shows WHERE id = ANY(${showIds})`;
      showIds.length = 0;
    }
    if (userIds.length > 0) {
      // auth_member's FK to auth_user is ON DELETE CASCADE, so this removes
      // the membership rows too.
      await sql`DELETE FROM auth_user WHERE id = ANY(${userIds})`;
      userIds.length = 0;
    }
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'true';
  });

  it('reads the kill switch from the environment (sanity: the compiled bundle sees process.env)', () => {
    expect(isDowngradeEnabled()).toBe(true);
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'TRUE';
    expect(isDowngradeEnabled()).toBe(false);
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'true';
  });

  it('downgrades a 31-day-pending dj: auth_member.role -> member, auth_user.role untouched, marker stamped', async () => {
    const userId = await seedAccount({ daysPending: 31, memberRole: 'dj' });

    const { pending, decisions, applied } = await runDowngradePass(userId);

    expect(pending).toHaveLength(1);
    expect(decisions[0].status).toBe('downgraded');
    expect(applied.downgraded.map((r) => r.userId)).toEqual([userId]);

    expect(await memberRoleOf(userId)).toBe('member');

    const user = await authUserRowOf(userId);
    // The invariant the epic turns on: auth_user.role is never written, so the
    // admin flag cannot desync (WXYC/Backend-Service#2171).
    expect(user.role).toBe(SENTINEL_AUTH_USER_ROLE);
    // And the review queue is NOT emptied -- that column is the manager's, and
    // dj-site's roster predicate reads it.
    expect(user.self_signup_reviewed_at).toBeNull();
    expect(user.self_signup_downgraded_at).not.toBeNull();
  });

  it('is a genuine no-op on a second run -- the marker takes the account out of the actuator', async () => {
    const userId = await seedAccount({ daysPending: 31, memberRole: 'dj' });

    await runDowngradePass(userId);
    const firstMarker = (await authUserRowOf(userId)).self_signup_downgraded_at;

    const second = await runDowngradePass(userId, new Date(Date.now() + 24 * 60 * 60 * 1000));

    expect(second.decisions[0].status).toBe('already-downgraded');
    expect(second.applied.downgraded).toEqual([]);
    expect(second.applied.raced).toEqual([]);
    // Same marker instant: nothing was rewritten.
    expect((await authUserRowOf(userId)).self_signup_downgraded_at).toEqual(firstMarker);
  });

  it("does not undo a manager's re-promotion -- the re-fire loop this marker closes", async () => {
    const userId = await seedAccount({ daysPending: 31, memberRole: 'dj' });
    await runDowngradePass(userId);
    expect(await memberRoleOf(userId)).toBe('member');

    // The manager promotes the account back to `dj` in the roster, without
    // reviewing it. Before the marker, this account satisfied the cutoff and
    // the `WHERE role = 'dj'` guard again and was demoted the next morning.
    await sql`UPDATE auth_member SET role = 'dj' WHERE user_id = ${userId}`;

    const next = await runDowngradePass(userId, new Date(Date.now() + 24 * 60 * 60 * 1000));

    expect(next.decisions[0].status).toBe('already-downgraded');
    expect(await memberRoleOf(userId)).toBe('dj');
  });

  it('keeps a downgraded-but-unreviewed account in the digest cohort, so it still nags daily', async () => {
    const userId = await seedAccount({ daysPending: 31, memberRole: 'dj' });
    await runDowngradePass(userId);

    const stillPending = (await queryPendingSelfSignups()).filter((r) => r.userId === userId);

    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].selfSignupDowngradedAt).toBeInstanceOf(Date);
  });

  it('drops an account out of the cohort once a manager actually reviews it', async () => {
    const userId = await seedAccount({ daysPending: 31, memberRole: 'dj', reviewed: true });

    const pending = (await queryPendingSelfSignups()).filter((r) => r.userId === userId);

    expect(pending).toEqual([]);
    expect(await memberRoleOf(userId)).toBe('dj');
  });

  it('leaves an account inside the 30-day window alone', async () => {
    const userId = await seedAccount({ daysPending: 29, memberRole: 'dj' });

    const { decisions } = await runDowngradePass(userId);

    expect(decisions[0].status).toBe('pending');
    expect(await memberRoleOf(userId)).toBe('dj');
    expect((await authUserRowOf(userId)).self_signup_downgraded_at).toBeNull();
  });

  it('writes nothing when STATION_SIGNUP_DOWNGRADE_ENABLED is off', async () => {
    process.env.STATION_SIGNUP_DOWNGRADE_ENABLED = 'false';
    const userId = await seedAccount({ daysPending: 45, memberRole: 'dj' });

    const { decisions } = await runDowngradePass(userId);

    expect(decisions[0].status).toBe('downgrade-disabled');
    expect(await memberRoleOf(userId)).toBe('dj');
    expect((await authUserRowOf(userId)).self_signup_downgraded_at).toBeNull();
  });

  it('defers an overdue DJ who is the primary_dj_id of an open show', async () => {
    const userId = await seedAccount({ daysPending: 60, memberRole: 'dj' });
    await seedOpenShow(userId, { asPrimary: true });

    const { decisions } = await runDowngradePass(userId);

    expect(decisions[0]).toMatchObject({ status: 'deferred-on-air', deferReason: 'open-show' });
    expect(await memberRoleOf(userId)).toBe('dj');
    expect((await authUserRowOf(userId)).self_signup_downgraded_at).toBeNull();
  });

  it('defers an overdue DJ who is only a show_djs member of an open show (the co-host case)', async () => {
    const userId = await seedAccount({ daysPending: 60, memberRole: 'dj' });
    await seedOpenShow(userId, { asPrimary: false });

    const { decisions } = await runDowngradePass(userId);

    expect(decisions[0]).toMatchObject({ status: 'deferred-on-air', deferReason: 'open-show' });
    expect(await memberRoleOf(userId)).toBe('dj');
  });

  it('downgrades once the show is closed -- the guard defers, it does not exempt', async () => {
    const userId = await seedAccount({ daysPending: 60, memberRole: 'dj' });
    const showId = await seedOpenShow(userId, { asPrimary: true });
    expect((await runDowngradePass(userId)).decisions[0].status).toBe('deferred-on-air');

    await sql`UPDATE ${sql(SCHEMA)}.shows SET end_time = now() WHERE id = ${showId}`;

    const { decisions } = await runDowngradePass(userId);

    expect(decisions[0].status).toBe('downgraded');
    expect(await memberRoleOf(userId)).toBe('member');
  });

  it('reports an overdue account that is already a member, and writes nothing', async () => {
    const userId = await seedAccount({ daysPending: 60, memberRole: 'member' });

    const { decisions, applied } = await runDowngradePass(userId);

    expect(decisions[0].status).toBe('already-member');
    expect(applied.downgraded).toEqual([]);
    // No marker: the actuator did not fire, so it must not claim it did.
    expect((await authUserRowOf(userId)).self_signup_downgraded_at).toBeNull();
  });

  it('never touches an account outside the self-signup cohort', async () => {
    // A plain account with no self_signup_at is invisible to the query, and
    // therefore to the actuator, no matter how old or what role it holds.
    const id = uniqueId();
    await sql`
      INSERT INTO auth_user (id, name, email, role, created_at)
      VALUES (${id}, 'SSR Bystander', ${`${id}@test.wxyc.org`}, ${SENTINEL_AUTH_USER_ROLE}, now() - interval '400 days')
    `;
    userIds.push(id);
    await sql`INSERT INTO auth_member (id, organization_id, user_id, role) VALUES (${`${id}-m`}, ${organizationId}, ${id}, 'dj')`;

    const pending = (await queryPendingSelfSignups()).filter((r) => r.userId === id);

    expect(pending).toEqual([]);
    expect(await memberRoleOf(id)).toBe('dj');
  });
});
