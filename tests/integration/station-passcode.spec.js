/**
 * Integration tests for the station-passcode lifecycle module (BS#2359).
 *
 * `jest.unit.config.ts` maps `@wxyc/database` (and, via automock, drizzle-orm
 * itself — see the `jest.unmock` below) to canned stubs, so no atomicity
 * claim can be proven there — a mock enforces nothing and every concurrency
 * case would pass vacuously. This file exists for exactly the properties the
 * unit suite cannot touch:
 *
 *   1. The two-row cap under concurrent rotation. Two `rotateStationPasscode`
 *      calls racing from one active row must yield exactly two active rows,
 *      never three — the failure mode `SELECT ... FOR UPDATE` cannot prevent
 *      (see the module header / issue body for why).
 *   2. The use-claim conditional UPDATE under concurrent verification of the
 *      SAME code near its use cap must never over-issue.
 *   3. A failed verification attempt must mutate no `station_passcode` row.
 *   4. An ACTIVE row that fails to decrypt must fail the whole request
 *      closed, never silently classify as "no match".
 *   5. The cooldown must never revoke a passcode, and clearing it must
 *      delete no attempt rows while still acting as a floor on the window.
 */

// See jobs/artist-unicode-dedup-merge.spec.js for the fuller explanation:
// `tests/__mocks__/drizzle-orm.ts` is auto-applied to every `drizzle-orm`
// require, including here. `@wxyc/authentication`'s compiled dist calls the
// REAL drizzle-orm to build its queries, so it must be unmocked.
jest.unmock('drizzle-orm');

// Real keys for this process only — never read from `.env`, so this spec has
// no external configuration dependency. The module resolves both lazily per
// call (see station-passcode.ts's resolveStationPasscodeKey doc), so it does
// not matter that these are set after the require below.
const { randomBytes } = require('crypto');
process.env.STATION_PASSCODE_KEY = process.env.STATION_PASSCODE_KEY || randomBytes(32).toString('hex');
process.env.STATION_SIGNUP_IP_HMAC_KEY = process.env.STATION_SIGNUP_IP_HMAC_KEY || randomBytes(32).toString('hex');

// `@wxyc/authentication`'s barrel (`src/index.ts`) also re-exports
// `auth.definition.ts`, which imports `better-auth` — a pure-ESM package
// Jest's plain CJS `require` cannot load. `station-passcode.ts` has no
// better-auth dependency, so it is a SECOND tsup entry (see
// shared/authentication/tsup.config.ts), letting this spec require the
// REAL compiled module directly and bypass the barrel entirely. Rebuild
// (`npm run build --workspace=@wxyc/authentication`) after editing
// station-passcode.ts — CI's Build step runs before the integration tier.
const {
  rotateStationPasscode,
  revokeStationPasscode,
  verifyStationPasscode,
  evaluateSignupCooldown,
  clearSignupCooldown,
  encryptStationPasscodeValue,
  StationPasscodeDecryptionError,
} = require('../../shared/authentication/dist/station-passcode.js');

const { getTestDb } = require('../utils/db');

// `station_passcode` and `station_signup_attempt` are deliberately
// unprefixed and UNQUALIFIED tables living in `public`, not `wxyc_schema` —
// see the doc comment above their `pgTable(...)` declarations in
// shared/database/src/schema.ts: they're grouped with the other hand-rolled
// auth-adjacent tables (`anonymous_devices`, `user_activity`), which sit
// alongside better-auth's own `public`-schema tables rather than the
// `wxyc_schema.table(...)`-wrapped domain tables. No `${SCHEMA}.` prefix
// here, unlike every other integration spec in this directory.

describe('station-passcode lifecycle (BS#2359, real Postgres)', () => {
  let sql;

  beforeAll(() => {
    sql = getTestDb();
  });

  // Exclusive to this spec in the test database — safe to wipe both tables
  // wholesale between tests.
  beforeEach(async () => {
    await sql`DELETE FROM station_signup_attempt`;
    await sql`DELETE FROM station_passcode`;
  });

  afterAll(async () => {
    await sql`DELETE FROM station_signup_attempt`;
    await sql`DELETE FROM station_passcode`;
  });

  async function activeCount() {
    const rows = await sql`
      SELECT COUNT(*)::int AS c FROM station_passcode
      WHERE revoked_at IS NULL AND expires_at > now()
    `;
    return rows[0].c;
  }

  describe('rotation cap under concurrency', () => {
    it('two concurrent rotations from one active row yield exactly two active rows, never three', async () => {
      await rotateStationPasscode();
      expect(await activeCount()).toBe(1);

      const results = await Promise.allSettled([rotateStationPasscode(), rotateStationPasscode()]);

      expect(await activeCount()).toBe(2);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.name).toBe('StationPasscodeCapExceededError');
    });

    it('three concurrent rotations from zero active rows yield exactly two active rows, never three', async () => {
      expect(await activeCount()).toBe(0);

      const results = await Promise.allSettled([
        rotateStationPasscode(),
        rotateStationPasscode(),
        rotateStationPasscode(),
      ]);

      expect(await activeCount()).toBe(2);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    });
  });

  describe('use-claim under concurrency', () => {
    it('never lets concurrent verifications over-issue past max_uses', async () => {
      const { code } = await rotateStationPasscode({ maxUses: 3 });

      // 5 concurrent attempts against a code capped at 3 uses.
      const results = await Promise.all(Array.from({ length: 5 }, () => verifyStationPasscode(code)));
      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(3);

      const rows = await sql`SELECT use_count, max_uses FROM station_passcode`;
      expect(rows).toHaveLength(1);
      expect(rows[0].use_count).toBe(3);
      expect(rows[0].use_count).toBeLessThanOrEqual(rows[0].max_uses);
    });
  });

  describe('a failed verification mutates no passcode row', () => {
    it('leaves use_count/last_used_at untouched on a genuine no-match', async () => {
      const { id } = await rotateStationPasscode();
      const before = await sql`SELECT use_count, last_used_at FROM station_passcode WHERE id = ${id}`;

      const result = await verifyStationPasscode('ZZZZZZZZ');
      expect(result.ok).toBe(false);

      const after = await sql`SELECT use_count, last_used_at FROM station_passcode WHERE id = ${id}`;
      expect(after[0]).toEqual(before[0]);

      const attempts = await sql`SELECT outcome, passcode_id FROM station_signup_attempt`;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].outcome).toBe('passcode_fail');
      expect(attempts[0].passcode_id).toBeNull();
    });

    it('classifies a match against a revoked row as passcode_revoked without reactivating it', async () => {
      const { id, code } = await rotateStationPasscode();
      await revokeStationPasscode(id, { revokedReason: 'test revoke' });

      const result = await verifyStationPasscode(code);
      expect(result.ok).toBe(false);

      const row = await sql`SELECT revoked_at, use_count FROM station_passcode WHERE id = ${id}`;
      expect(row[0].revoked_at).not.toBeNull();
      expect(row[0].use_count).toBe(0);

      const attempts = await sql`SELECT outcome, passcode_id FROM station_signup_attempt`;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].outcome).toBe('passcode_revoked');
      expect(attempts[0].passcode_id).toBe(id);
    });
  });

  describe('active-row decrypt failure fails closed', () => {
    it('throws rather than silently reporting no match', async () => {
      const now = new Date();
      const wrongKeyCiphertext = encryptStationPasscodeValue('WXYC2026', randomBytes(32));
      const id = `test-decrypt-fail-${Date.now()}`;
      await sql`
        INSERT INTO station_passcode (id, code_encrypted, expires_at, max_uses)
        VALUES (${id}, ${wrongKeyCiphertext}, ${new Date(now.getTime() + 60_000)}, 25)
      `;

      await expect(verifyStationPasscode('WXYC2026')).rejects.toBeInstanceOf(StationPasscodeDecryptionError);

      // The broken row must not have been mutated by the failed attempt.
      const row = await sql`SELECT use_count FROM station_passcode WHERE id = ${id}`;
      expect(row[0].use_count).toBe(0);
    });
  });

  describe('cooldown', () => {
    async function seedNoMatchFailures(count, endTime) {
      const rows = Array.from({ length: count }, (_, i) => ({
        id: `test-cooldown-${endTime.getTime()}-${i}`,
        attempted_at: new Date(endTime.getTime() - (count - 1 - i) * 1000),
        outcome: 'passcode_fail',
      }));
      for (const row of rows) {
        await sql`
          INSERT INTO station_signup_attempt (id, attempted_at, outcome)
          VALUES (${row.id}, ${row.attempted_at}, ${row.outcome})
        `;
      }
    }

    it('never revokes a passcode, even once the cooldown is tripped', async () => {
      const { id } = await rotateStationPasscode();
      await seedNoMatchFailures(25, new Date());

      const evaluation = await evaluateSignupCooldown();
      expect(evaluation.inCooldown).toBe(true);

      const result = await verifyStationPasscode('ZZZZZZZZ');
      expect(result.ok).toBe(false);
      expect(result.cooldown).toBe(true);

      const row = await sql`SELECT revoked_at FROM station_passcode WHERE id = ${id}`;
      expect(row[0].revoked_at).toBeNull();
    });

    it('a cooldown_refused attempt during cooldown is logged without touching any passcode row', async () => {
      await rotateStationPasscode();
      await seedNoMatchFailures(25, new Date());

      const before = await sql`SELECT COUNT(*)::int AS c FROM station_signup_attempt`;
      await verifyStationPasscode('ZZZZZZZZ');
      const after = await sql`SELECT COUNT(*)::int AS c FROM station_signup_attempt`;
      expect(after[0].c).toBe(before[0].c + 1);

      const latest = await sql`
        SELECT outcome, passcode_id, ip_hash FROM station_signup_attempt
        ORDER BY attempted_at DESC LIMIT 1
      `;
      expect(latest[0].outcome).toBe('cooldown_refused');
      expect(latest[0].passcode_id).toBeNull();
    });

    it('clearSignupCooldown deletes no rows and acts as a floor on the window', async () => {
      const now = new Date();
      await seedNoMatchFailures(25, now);

      const countBefore = await sql`SELECT COUNT(*)::int AS c FROM station_signup_attempt`;
      expect((await evaluateSignupCooldown(now)).inCooldown).toBe(true);

      // Real seeded user id (dev_env/seed_db.sql) — actor_user_id FKs to
      // auth_user, so an arbitrary string 400s the insert with a foreign
      // key violation.
      const TEST_STATION_MANAGER_ID = 'test-sm-id-0000000000000000001';
      await clearSignupCooldown(TEST_STATION_MANAGER_ID, new Date(now.getTime() + 1000));

      const countAfter = await sql`SELECT COUNT(*)::int AS c FROM station_signup_attempt`;
      // The clear is an INSERT, not a DELETE — every pre-clear row survives.
      expect(countAfter[0].c).toBe(countBefore[0].c + 1);

      // Evaluated strictly after the clear: the 25 pre-clear failures must no
      // longer count toward refusal — the clear is a floor on the window.
      const evaluationAfterClear = await evaluateSignupCooldown(new Date(now.getTime() + 2000));
      expect(evaluationAfterClear.noMatchFailureCount).toBe(0);
      expect(evaluationAfterClear.inCooldown).toBe(false);
    });
  });
});
