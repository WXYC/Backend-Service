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
 *   6. Mark-and-exclude: an undecryptable INACTIVE row must be marked on the
 *      first classification that meets it and excluded from every later
 *      sweep, so the brute-force cooldown goes blind for one attempt rather
 *      than for the 30-day classification horizon. Both halves are a
 *      statement's effect on a real row, which is precisely what a mock
 *      cannot show.
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
  computeSignupCooldownState,
  clearSignupCooldown,
  encryptStationPasscodeValue,
  stationPasscodeKeyId,
  StationPasscodeDecryptionError,
  STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON,
  SIGNUP_COOLDOWN_TRIGGER_ROW_LIMIT,
  SIGNUP_COOLDOWN_THRESHOLD,
} = require('../../shared/authentication/dist/station-passcode.js');

// The key this spec's process starts with. Captured so the dual-key and
// auto-revoke cases can swap `STATION_PASSCODE_KEY` for a test and put it
// back — the module resolves both key vars per call, never at import.
const CURRENT_KEY_HEX = process.env.STATION_PASSCODE_KEY;

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

  /** Insert an ACTIVE passcode row nothing in the key ring can decrypt. */
  async function insertUndecryptableActiveRow(id, plaintext = 'WXYC2026', ttlMs = 60_000) {
    const ciphertext = encryptStationPasscodeValue(plaintext, randomBytes(32));
    await sql`
      INSERT INTO station_passcode (id, code_encrypted, expires_at, max_uses)
      VALUES (${id}, ${ciphertext}, ${new Date(Date.now() + ttlMs)}, 25)
    `;
    return id;
  }

  describe('active-row decrypt failure fails closed', () => {
    it('throws rather than silently reporting no match', async () => {
      const id = await insertUndecryptableActiveRow(`test-decrypt-fail-${Date.now()}`);

      await expect(verifyStationPasscode('WXYC2026')).rejects.toBeInstanceOf(StationPasscodeDecryptionError);

      // The broken row must not have been mutated by the failed attempt.
      const row = await sql`SELECT use_count FROM station_passcode WHERE id = ${id}`;
      expect(row[0].use_count).toBe(0);
    });

    it('records a passcode_unverifiable attempt row before throwing', async () => {
      // BS#2359 review: previously the throw happened before any
      // insertSignupAttempt, so a gate that was down for EVERY request left
      // no trace at all in the log #2362's status endpoint and #2364's
      // digest both read.
      await insertUndecryptableActiveRow(`test-decrypt-trace-${Date.now()}`);

      await expect(verifyStationPasscode('WXYC2026')).rejects.toBeInstanceOf(StationPasscodeDecryptionError);

      const attempts = await sql`SELECT outcome, passcode_id FROM station_signup_attempt`;
      expect(attempts).toHaveLength(1);
      expect(attempts[0].outcome).toBe('passcode_unverifiable');
      // Always NULL on this token: the plaintext behind an undecryptable row
      // is unknowable, so attributing the attempt to a row would be a guess.
      expect(attempts[0].passcode_id).toBeNull();
    });

    it('does not let that unverifiable row feed the refusal count', async () => {
      // A broken gate must never also push the station into cooldown — that
      // would stack an outage on top of an outage.
      await insertUndecryptableActiveRow(`test-decrypt-refusal-${Date.now()}`);
      await expect(verifyStationPasscode('WXYC2026')).rejects.toBeInstanceOf(StationPasscodeDecryptionError);

      const evaluation = await evaluateSignupCooldown();
      expect(evaluation.noMatchFailureCount).toBe(0);
      expect(evaluation.allFailureCount).toBe(1);
      expect(evaluation.inCooldown).toBe(false);
    });
  });

  describe('dual-key decryption across a key rotation', () => {
    afterEach(() => {
      process.env.STATION_PASSCODE_KEY = CURRENT_KEY_HEX;
      delete process.env.STATION_PASSCODE_KEY_PREVIOUS;
    });

    it('verifies a code minted under the PREVIOUS key after the current key changes', async () => {
      const { code } = await rotateStationPasscode();

      // Step 1 + 2 of the runbook: previous <- old key, current <- new key.
      process.env.STATION_PASSCODE_KEY_PREVIOUS = CURRENT_KEY_HEX;
      process.env.STATION_PASSCODE_KEY = randomBytes(32).toString('hex');

      const result = await verifyStationPasscode(code);
      expect(result.ok).toBe(true);
      expect(result.cooldown).toBe(false);

      const attempts = await sql`SELECT outcome FROM station_signup_attempt`;
      expect(attempts.map((a) => a.outcome)).toEqual(['passcode_ok']);
    });

    it('fails closed on that same row when the previous key is NOT set', async () => {
      // The pre-dual-key behavior, and the whole reason the documented
      // one-step rotation bricked the gate.
      const { code } = await rotateStationPasscode();
      process.env.STATION_PASSCODE_KEY = randomBytes(32).toString('hex');

      await expect(verifyStationPasscode(code)).rejects.toBeInstanceOf(StationPasscodeDecryptionError);
    });

    it('encrypts new rows under the CURRENT key only, so the old key drains out', async () => {
      process.env.STATION_PASSCODE_KEY_PREVIOUS = CURRENT_KEY_HEX;
      const newKeyHex = randomBytes(32).toString('hex');
      process.env.STATION_PASSCODE_KEY = newKeyHex;

      const { id } = await rotateStationPasscode();
      const rows = await sql`SELECT code_encrypted FROM station_passcode WHERE id = ${id}`;
      const keyId = rows[0].code_encrypted.split(':')[0];

      expect(keyId).toBe(stationPasscodeKeyId(Buffer.from(newKeyHex, 'hex')));
      expect(keyId).not.toBe(stationPasscodeKeyId(Buffer.from(CURRENT_KEY_HEX, 'hex')));
    });
  });

  describe('rotation auto-revokes undecryptable active rows', () => {
    it('revokes the poisoned row, mints a new code, and reports what it revoked', async () => {
      const id = await insertUndecryptableActiveRow(`test-autorevoke-${Date.now()}`);

      const rotated = await rotateStationPasscode();
      expect(rotated.autoRevokedPasscodeIds).toEqual([id]);

      const [row] = await sql`SELECT revoked_at, revoked_reason FROM station_passcode WHERE id = ${id}`;
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_reason).toBe(STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON);

      // Exactly one active row remains — the one just minted — and the gate
      // works again on it.
      expect(await activeCount()).toBe(1);
      expect((await verifyStationPasscode(rotated.code)).ok).toBe(true);
    });

    it('unwedges the two-row cap that two poisoned rows would otherwise hold shut', async () => {
      // The CAP-EXCEEDED brick shape: both rows are "active" by the SQL
      // predicate, so rotation itself threw and there was no way to mint a
      // working code without raw SQL on prod.
      const first = await insertUndecryptableActiveRow(`test-cap-a-${Date.now()}`);
      const second = await insertUndecryptableActiveRow(`test-cap-b-${Date.now()}`);
      expect(await activeCount()).toBe(2);

      const rotated = await rotateStationPasscode();
      expect(rotated.autoRevokedPasscodeIds.sort()).toEqual([first, second].sort());
      expect(await activeCount()).toBe(1);
    });

    it('leaves a decryptable active row alone', async () => {
      const { id } = await rotateStationPasscode();
      const rotated = await rotateStationPasscode();

      expect(rotated.autoRevokedPasscodeIds).toEqual([]);
      const [row] = await sql`SELECT revoked_at FROM station_passcode WHERE id = ${id}`;
      expect(row.revoked_at).toBeNull();
      expect(await activeCount()).toBe(2);
    });

    it('does not revoke a row the PREVIOUS key can still open', async () => {
      // Auto-revoke is a last resort, not the rotation mechanism. Follow the
      // runbook and nothing gets destroyed.
      const { id, code } = await rotateStationPasscode();
      process.env.STATION_PASSCODE_KEY_PREVIOUS = CURRENT_KEY_HEX;
      process.env.STATION_PASSCODE_KEY = randomBytes(32).toString('hex');
      try {
        const rotated = await rotateStationPasscode();
        expect(rotated.autoRevokedPasscodeIds).toEqual([]);
        const [row] = await sql`SELECT revoked_at FROM station_passcode WHERE id = ${id}`;
        expect(row.revoked_at).toBeNull();
        expect((await verifyStationPasscode(code)).ok).toBe(true);
      } finally {
        process.env.STATION_PASSCODE_KEY = CURRENT_KEY_HEX;
        delete process.env.STATION_PASSCODE_KEY_PREVIOUS;
      }
    });
  });

  describe('passcode_unverifiable classification heals itself (mark-and-exclude)', () => {
    /** An INACTIVE (already expired) row encrypted under a key nobody holds. */
    async function insertUndecryptableInactiveRow(id, { revokedAt = null, revokedReason = null } = {}) {
      await sql`
        INSERT INTO station_passcode (id, code_encrypted, expires_at, max_uses, revoked_at, revoked_reason)
        VALUES (
          ${id},
          ${encryptStationPasscodeValue('WXYC2026', randomBytes(32))},
          ${new Date(Date.now() - 60_000)},
          25,
          ${revokedAt},
          ${revokedReason}
        )
      `;
      return id;
    }

    it('logs unverifiable and MARKS the poisoned row on the first attempt, then classifies cleanly on the second', async () => {
      // The finding this closes (BS#2359 review 3): `passcode_unverifiable`
      // is refusal-exempt by design, so ONE undecryptable in-horizon row used
      // to relabel 100% of would-be `passcode_fail` attempts, pin
      // noMatchFailureCount at 0, and disable the brute-force cooldown — whose
      // trigger reads only `passcode_fail` — for up to the whole 30-day
      // classification horizon. Both production paths create that state:
      // rotation's auto-revoke, and the runbook's key-retirement step.
      const id = await insertUndecryptableInactiveRow(`test-unverifiable-${Date.now()}`);
      expect(await activeCount()).toBe(0);

      // FIRST attempt: honest about not knowing, and refusal-exempt.
      const first = await verifyStationPasscode('ZZZZZZZZ');
      expect(first.ok).toBe(false);
      expect(first.cooldown).toBe(false);

      const afterFirst = await sql`SELECT outcome, passcode_id FROM station_signup_attempt`;
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].outcome).toBe('passcode_unverifiable');
      expect(afterFirst[0].passcode_id).toBeNull();

      // ...and it healed the row on its way out: marked, and revoked_at
      // filled in because it was still NULL (expired but never revoked).
      const [marked] = await sql`SELECT revoked_at, revoked_reason FROM station_passcode WHERE id = ${id}`;
      expect(marked.revoked_reason).toBe(STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON);
      expect(marked.revoked_at).not.toBeNull();

      // SECOND attempt: the marked row is excluded from the sweep, so the
      // no-match classifies as passcode_fail and reaches the cooldown.
      const second = await verifyStationPasscode('ZZZZZZZZ');
      expect(second.ok).toBe(false);

      const outcomes = await sql`SELECT outcome FROM station_signup_attempt ORDER BY attempted_at`;
      expect(outcomes.map((a) => a.outcome)).toEqual(['passcode_unverifiable', 'passcode_fail']);

      const evaluation = await evaluateSignupCooldown();
      expect(evaluation.noMatchFailureCount).toBe(1);
      expect(evaluation.allFailureCount).toBe(2);
    });

    it('excludes an already-marked row from classification from the very first attempt', async () => {
      // The post-rotation path. rotateStationPasscode's auto-revoke writes
      // this exact marker, so a row it retired never blinds classification
      // for even one attempt.
      await insertUndecryptableInactiveRow(`test-premarked-${Date.now()}`, {
        revokedAt: new Date(Date.now() - 30_000),
        revokedReason: STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON,
      });

      await verifyStationPasscode('ZZZZZZZZ');

      const attempts = await sql`SELECT outcome FROM station_signup_attempt`;
      expect(attempts.map((a) => a.outcome)).toEqual(['passcode_fail']);
      expect((await evaluateSignupCooldown()).noMatchFailureCount).toBe(1);
    });

    it('overwrites a different revoked_reason but keeps the original revoked_at', async () => {
      // The marker is what the cooldown depends on, so it wins; the operator
      // prose it replaces survives in the loud log line instead. revoked_at
      // is COALESCEd, never overwritten — the row was already dead at that
      // timestamp and rewriting it would falsify the audit trail.
      const revokedAt = new Date(Date.now() - 5 * 60_000);
      const id = await insertUndecryptableInactiveRow(`test-remark-${Date.now()}`, {
        revokedAt,
        revokedReason: 'manager revoked it',
      });

      await verifyStationPasscode('ZZZZZZZZ');

      const [row] = await sql`SELECT revoked_at, revoked_reason FROM station_passcode WHERE id = ${id}`;
      expect(row.revoked_reason).toBe(STATION_PASSCODE_UNDECRYPTABLE_REVOKED_REASON);
      expect(new Date(row.revoked_at).getTime()).toBe(revokedAt.getTime());
    });

    it('still returns passcode_fail when every in-horizon inactive row decrypted cleanly', async () => {
      const { id } = await rotateStationPasscode();
      await revokeStationPasscode(id, { revokedReason: 'test revoke' });

      await verifyStationPasscode('ZZZZZZZZ');

      const attempts = await sql`SELECT outcome FROM station_signup_attempt`;
      expect(attempts.map((a) => a.outcome)).toEqual(['passcode_fail']);

      // A decryptable row must NOT be marked — mark-and-exclude only ever
      // touches rows nothing can read.
      const [row] = await sql`SELECT revoked_reason FROM station_passcode WHERE id = ${id}`;
      expect(row.revoked_reason).toBe('test revoke');
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

  describe('cooldown counts are computed in SQL, not materialized in Node', () => {
    /** Bulk-seed `count` attempt rows of one outcome, 1ms apart, ending at `endTime`. */
    async function seedAttempts(outcome, count, endTime) {
      // Explicit casts throughout: postgres.js sends bare parameters as
      // unknown-typed, and `$n || g` / `generate_series(1, $n)` are both
      // ambiguous without them.
      await sql`
        INSERT INTO station_signup_attempt (id, attempted_at, outcome)
        SELECT ${`seed-${outcome}-${endTime.getTime()}-`}::text || g::text,
               ${endTime}::timestamptz - ((${count}::int - g) * interval '1 millisecond'),
               ${outcome}::varchar(24)
        FROM generate_series(1, ${count}::int) AS g
      `;
    }

    /**
     * The whole point of the aggregate query. `passcode_exhausted` and
     * `passcode_unverifiable` are refusal-exempt BY DESIGN, so they are
     * unbounded — anyone looping a dead code grows the set without ever
     * engaging the cooldown that would stop them. If the counts came from a
     * materialized row fetch capped at SIGNUP_COOLDOWN_TRIGGER_ROW_LIMIT,
     * this would come back clipped at 500.
     */
    it('returns an exact allFailureCount well past the trigger-fetch LIMIT', async () => {
      const now = new Date();
      const overLimit = SIGNUP_COOLDOWN_TRIGGER_ROW_LIMIT + 100;
      await seedAttempts('passcode_exhausted', overLimit, now);

      const evaluation = await evaluateSignupCooldown(new Date(now.getTime() + 1000));
      expect(evaluation.allFailureCount).toBe(overLimit);
      expect(evaluation.noMatchFailureCount).toBe(0);
      // Refusal-exempt: a pile this size must still not close the gate.
      expect(evaluation.inCooldown).toBe(false);
    });

    it('returns an exact noMatchFailureCount past the LIMIT, and still triggers', async () => {
      // The LIMIT cannot cause a false negative: the retained rows are the
      // newest, and 500 >> the 20-failure threshold.
      const now = new Date();
      const overLimit = SIGNUP_COOLDOWN_TRIGGER_ROW_LIMIT + 100;
      await seedAttempts('passcode_fail', overLimit, now);

      const evaluation = await evaluateSignupCooldown(new Date(now.getTime() + 1000));
      expect(evaluation.noMatchFailureCount).toBe(overLimit);
      expect(evaluation.allFailureCount).toBe(overLimit);
      expect(evaluation.inCooldown).toBe(true);
    });

    it('splits the two counts exactly as computeSignupCooldownState does', async () => {
      // computeSignupCooldownState stays the executable specification of what
      // the SQL must produce; this pins the two together.
      const now = new Date();
      await seedAttempts('passcode_fail', SIGNUP_COOLDOWN_THRESHOLD - 5, now);
      await seedAttempts('passcode_expired', 4, now);
      await seedAttempts('passcode_revoked', 3, now);
      await seedAttempts('passcode_exhausted', 2, now);
      await seedAttempts('passcode_unverifiable', 6, now);
      // Non-failure outcomes must be invisible to both counts.
      await seedAttempts('cooldown_refused', 7, now);
      await seedAttempts('passcode_ok', 5, now);

      const at = new Date(now.getTime() + 1000);
      const rows = await sql`
        SELECT outcome, attempted_at FROM station_signup_attempt
        WHERE outcome IN ('passcode_fail','passcode_expired','passcode_revoked','passcode_exhausted','passcode_unverifiable')
      `;
      const expected = computeSignupCooldownState(
        rows.map((r) => ({ outcome: r.outcome, attemptedAt: new Date(r.attempted_at) })),
        at
      );

      const evaluation = await evaluateSignupCooldown(at);
      expect(evaluation).toEqual(expected);
      expect(evaluation.noMatchFailureCount).toBe(SIGNUP_COOLDOWN_THRESHOLD - 5);
      expect(evaluation.allFailureCount).toBe(SIGNUP_COOLDOWN_THRESHOLD - 5 + 4 + 3 + 2 + 6);
      expect(evaluation.inCooldown).toBe(false);
    });

    it('scopes the counts to the 10-minute window, not the full trigger lookback', async () => {
      const now = new Date();
      await seedAttempts('passcode_fail', 3, now);
      // Older than the count window but inside the window+hold lookback the
      // trigger check reads.
      await seedAttempts('passcode_fail', 4, new Date(now.getTime() - 11 * 60 * 1000));

      const evaluation = await evaluateSignupCooldown(new Date(now.getTime() + 1000));
      expect(evaluation.noMatchFailureCount).toBe(3);
      expect(evaluation.allFailureCount).toBe(3);
    });
  });
});
