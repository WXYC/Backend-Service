/**
 * Integration tests for `pruneSignupAttempts` (BS#2363) and
 * `pruneAccountAuditEvents` (BS#2536, parent epic #2534), pinning each
 * table's retention-cutoff boundary against real Postgres — the property a
 * mocked `drizzle-orm` cannot prove (see tests/integration/station-passcode.spec.js
 * for the fuller rationale, which this spec's harness mirrors).
 *
 * `jobs/auth-log-prune/job.ts` is a thin lifecycle wrapper around both
 * exported functions (see that job's job.ts); this spec exercises them
 * directly rather than the process entrypoint.
 */

jest.unmock('drizzle-orm');

const { randomUUID } = require('crypto');
const { pruneSignupAttempts } = require('../../shared/authentication/dist/station-passcode.js');
const { pruneAccountAuditEvents } = require('../../shared/database/dist/index.js');
const { getTestDb } = require('../utils/db');

describe('pruneSignupAttempts (BS#2363, real Postgres)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    await sql`DELETE FROM station_signup_attempt`;
  });

  afterAll(async () => {
    await sql`DELETE FROM station_signup_attempt`;
  });

  async function insertAttemptAt(attemptedAt) {
    const id = randomUUID();
    await sql`
      INSERT INTO station_signup_attempt (id, attempted_at, outcome)
      VALUES (${id}, ${attemptedAt}, 'passcode_fail')
    `;
    return id;
  }

  async function remainingIds() {
    const rows = await sql`SELECT id FROM station_signup_attempt`;
    return rows.map((row) => row.id);
  }

  it('deletes rows strictly older than the retention window and keeps the rest', async () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const retentionDays = 30;
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    const oldId = await insertAttemptAt(new Date(cutoff.getTime() - 1000));
    const boundaryId = await insertAttemptAt(cutoff);
    const freshId = await insertAttemptAt(new Date(cutoff.getTime() + 1000));

    const deletedCount = await pruneSignupAttempts({ olderThanDays: retentionDays, now });

    expect(deletedCount).toBe(1);
    const remaining = await remainingIds();
    expect(remaining.sort()).toEqual([boundaryId, freshId].sort());
    expect(remaining).not.toContain(oldId);
  });

  it('is a no-op when every row is within the retention window', async () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    await insertAttemptAt(new Date(now.getTime() - 1000));

    const deletedCount = await pruneSignupAttempts({ olderThanDays: 30, now });

    expect(deletedCount).toBe(0);
    expect(await remainingIds()).toHaveLength(1);
  });
});

describe('pruneAccountAuditEvents (BS#2536, real Postgres)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  beforeEach(async () => {
    await sql`DELETE FROM account_audit_event`;
  });

  afterAll(async () => {
    await sql`DELETE FROM account_audit_event`;
  });

  async function insertEventAt(occurredAt) {
    const id = randomUUID();
    await sql`
      INSERT INTO account_audit_event (id, occurred_at, action, outcome, source)
      VALUES (${id}, ${occurredAt}, 'admin.set-role', 200, 'http')
    `;
    return id;
  }

  async function remainingIds() {
    const rows = await sql`SELECT id FROM account_audit_event`;
    return rows.map((row) => row.id);
  }

  it('deletes rows strictly older than the retention window and keeps the rest', async () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    const retentionDays = 730;
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    const oldId = await insertEventAt(new Date(cutoff.getTime() - 1000));
    const boundaryId = await insertEventAt(cutoff);
    const freshId = await insertEventAt(new Date(cutoff.getTime() + 1000));

    const deletedCount = await pruneAccountAuditEvents({ olderThanDays: retentionDays, now });

    expect(deletedCount).toBe(1);
    const remaining = await remainingIds();
    expect(remaining.sort()).toEqual([boundaryId, freshId].sort());
    expect(remaining).not.toContain(oldId);
  });

  it('is a no-op when every row is within the retention window', async () => {
    const now = new Date('2026-09-06T00:00:00.000Z');
    await insertEventAt(new Date(now.getTime() - 1000));

    const deletedCount = await pruneAccountAuditEvents({ olderThanDays: 730, now });

    expect(deletedCount).toBe(0);
    expect(await remainingIds()).toHaveLength(1);
  });
});
