/**
 * Schema-source assertions for the station self-signup substrate (BS#2358):
 * `station_passcode`, `station_signup_attempt`, and the three `auth_user`
 * review columns, all in migration 0160.
 *
 * Pure file-reading guard, mirroring `schema.digital-asset.test.ts` and
 * `schema.anonymous-devices.test.ts`. It pins the properties that a green
 * integration run would NOT protect: a schema property is only regression-safe
 * here if getting it wrong still produces a database that works.
 *
 * The composite index is the clearest case. `(outcome, attempted_at)` and
 * `(attempted_at, outcome)` are both valid indexes, both apply cleanly, and
 * every query against either returns identical rows — so nothing in the test
 * suite goes red if someone "tidies" the column list into alphabetical or
 * declaration order. Only the plan is different, and only under load: every
 * cooldown read filters on `outcome` first (the in-window failure count, the
 * `MAX(attempted_at) WHERE outcome = 'cooldown_cleared'` floor, and the
 * once-per-window `cooldown_refused` check), so a leading `attempted_at` turns
 * all three into range scans over a table that grows *with the attack* this
 * index exists to survive.
 *
 * Deliberately NOT covered here: the four FKs' `ON DELETE SET NULL` actions.
 * `tests/integration/fk-on-delete-general-guard.spec.js` already enumerates
 * EVERY foreign key Drizzle declares and compares each against the live
 * database's `pg_constraint.confdeltype`; re-asserting them from the migration
 * text would be a second, weaker copy of a check that already generalizes (and
 * it is precisely the hand-listed-allowlist shape BS#2239 showed does not
 * work).
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
  fs.readFileSync(journalPath, 'utf-8')
);

const entry = journal.entries.find((e) => e.tag.startsWith('0160_'));
if (!entry) {
  throw new Error('No journal entry matches /^0160_/. Did the station-signup-schema migration land?');
}
const migrationPath = path.join(migrationsDir, `${entry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

// Strip both full-line and inline `--` comments so the header prose can't
// false-match the DDL assertions below. No DDL string literal in this
// migration contains `--`.
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');

const ddl = stripComments(migrationSql);
const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

const extractTableDef = (tableName: string): string => {
  const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
  const match = schemaSource.match(regex);
  if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
  return match[0];
};

/** The `CREATE TABLE "<name>" ( ... );` body from the migration. */
const extractCreateTable = (tableName: string): string => {
  const regex = new RegExp(`CREATE TABLE "${tableName}" \\(([\\s\\S]*?)\\n\\);`);
  const match = ddl.match(regex);
  if (!match) throw new Error(`CREATE TABLE for ${tableName} not found in migration 0160`);
  return match[1];
};

/** The one line declaring `<column>` inside a CREATE TABLE body. */
const columnLine = (createTableBody: string, column: string): string => {
  const line = createTableBody.split('\n').find((l) => l.trim().startsWith(`"${column}"`));
  if (line === undefined) throw new Error(`Column ${column} not found`);
  return line;
};

/*
 * Both sides of every structural claim below are asserted, not just the
 * migration's. Migration 0160's SHA-256 is frozen in applied-hashes.json, so
 * the DDL literally cannot drift — which means a DDL-only assertion pins a
 * file nobody can change and leaves `schema.ts`, the file everyone edits,
 * unguarded. Deleting an index there, renaming one, or adding a column with no
 * migration all used to pass this suite; the parity helpers close that.
 */

/** Physical column names declared on a drizzle table, in declaration order. */
const declaredColumns = (tableDef: string): string[] =>
  [...tableDef.matchAll(/\b\w+:\s*(?:varchar|text|timestamp|integer|boolean|serial|jsonb)\(\s*'([a-z0-9_]+)'/g)].map(
    (m) => m[1]
  );

/** Column names in a `CREATE TABLE` body, in declaration order. */
const ddlColumns = (createTableBody: string): string[] =>
  createTableBody
    .split('\n')
    .map((line) => /^"([a-z0-9_]+)"/.exec(line.trim())?.[1])
    .filter((name): name is string => name !== undefined);

/** Index names declared on a drizzle table. */
const declaredIndexes = (tableDef: string): string[] =>
  [...tableDef.matchAll(/\bindex\(\s*'([a-z0-9_]+)'\s*\)/g)].map((m) => m[1]);

/** Index names the migration creates on one table. */
const ddlIndexes = (tableName: string): string[] =>
  [...ddl.matchAll(new RegExp(`CREATE INDEX "([a-z0-9_]+)" ON "${tableName}"`, 'g'))].map((m) => m[1]);

const sorted = (names: string[]): string[] => [...names].sort();

describe('schema: station-signup substrate (migration 0160, BS#2358)', () => {
  it('migration 0160 exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  describe('station_passcode', () => {
    const body = extractCreateTable('station_passcode');

    it('keeps created_by NULLABLE, which is what lets its FK be ON DELETE SET NULL', () => {
      // A NOT NULL here would make deleting the manager who cut a passcode fail
      // outright instead of orphaning the row — the FK action and the column's
      // nullability are one decision, not two (see 0048_fix-fk-on-delete-set-null).
      expect(columnLine(body, 'created_by')).toMatch(/"created_by"\s+varchar\(255\)\s*,?\s*$/);
      expect(columnLine(body, 'created_by')).not.toMatch(/NOT\s+NULL/i);
      const def = extractTableDef('station_passcode');
      const createdBy = def.match(/createdBy:[^\n]*/)?.[0];
      expect(createdBy).toBeDefined();
      expect(createdBy).not.toMatch(/notNull\(\)/);
    });

    it('holds the encrypted code, never a plaintext one, with the TTL and use-cap bookkeeping', () => {
      expect(columnLine(body, 'code_encrypted')).toMatch(/"code_encrypted"\s+text\s+NOT\s+NULL/i);
      expect(body).not.toMatch(/"code"\s/i);
      expect(columnLine(body, 'expires_at')).toMatch(/timestamp with time zone\s+NOT\s+NULL/i);
      expect(columnLine(body, 'use_count')).toMatch(/integer\s+DEFAULT\s+0\s+NOT\s+NULL/i);
      expect(columnLine(body, 'max_uses')).toMatch(/integer\s+DEFAULT\s+25\s+NOT\s+NULL/i);
    });

    it('indexes created_by, the FK referencing side Postgres never indexes on its own', () => {
      expect(ddl).toMatch(/CREATE INDEX "station_passcode_created_by_idx"[\s\S]*?\("created_by"\)/i);
      expect(extractTableDef('station_passcode')).toMatch(
        /index\('station_passcode_created_by_idx'\)\.on\(table\.createdBy\)/
      );
    });

    it('declares the same columns and indexes in schema.ts as migration 0160 creates', () => {
      const def = extractTableDef('station_passcode');
      expect(sorted(declaredColumns(def))).toEqual(sorted(ddlColumns(body)));
      expect(declaredColumns(def).length).toBe(10);
      expect(sorted(declaredIndexes(def))).toEqual(sorted(ddlIndexes('station_passcode')));
      expect(declaredIndexes(def)).toEqual(['station_passcode_created_by_idx']);
    });
  });

  describe('station_signup_attempt', () => {
    const body = extractCreateTable('station_signup_attempt');

    it('declares the composite index as (outcome, attempted_at) — in that ORDER', () => {
      expect(ddl).toMatch(
        /CREATE INDEX "station_signup_attempt_outcome_attempted_at_idx" ON "station_signup_attempt" USING btree \("outcome","attempted_at"\)/i
      );
      // The assertion this file exists for: the reversed pair is a perfectly
      // valid index that breaks every cooldown read's plan and nothing else.
      expect(ddl).not.toMatch(/USING btree \("attempted_at","outcome"\)/i);
      // And it must stay composite — an attempted_at-only index leaves all three
      // cooldown reads scanning.
      expect(ddl).not.toMatch(
        /CREATE INDEX "station_signup_attempt_outcome_attempted_at_idx"[^\n]*\("attempted_at"\)/i
      );

      const def = extractTableDef('station_signup_attempt');
      expect(def).toMatch(
        /index\('station_signup_attempt_outcome_attempted_at_idx'\)\.on\(table\.outcome,\s*table\.attemptedAt\)/
      );
    });

    it('defaults attempted_at to now() and keeps it NOT NULL, on both sides', () => {
      // The other half of the composite index, and unasserted until now.
      // A nullable attempted_at would let a row land outside every cooldown
      // window silently; a missing DEFAULT would push the timestamp onto the
      // writer, where a forgotten field yields the same invisible hole.
      expect(columnLine(body, 'attempted_at')).toMatch(
        /"attempted_at"\s+timestamp with time zone\s+DEFAULT\s+now\(\)\s+NOT\s+NULL/i
      );
      expect(extractTableDef('station_signup_attempt')).toMatch(
        /attemptedAt:\s*timestamp\('attempted_at',\s*\{\s*withTimezone:\s*true\s*\}\)\.notNull\(\)\.defaultNow\(\)/
      );
    });

    it('keeps ip_hash at varchar(16) and nullable', () => {
      // 16 hex characters — the truncation width the derivation is specified
      // against in schema.ts. Widening or narrowing it silently changes what
      // BS#2359 must produce.
      expect(columnLine(body, 'ip_hash')).toMatch(/"ip_hash"\s+varchar\(16\)\s*,?\s*$/);
      expect(columnLine(body, 'ip_hash')).not.toMatch(/NOT\s+NULL/i);
      expect(extractTableDef('station_signup_attempt')).toMatch(
        /ipHash:\s*varchar\('ip_hash',\s*\{\s*length:\s*16\s*\}\)/
      );
    });

    it('specifies ip_hash as a KEYED hash over the X-Real-IP client address', () => {
      // The column comment is the entire carrier of this decision until BS#2359
      // implements it — nothing executable pins it yet, so the prose is the
      // artefact worth regression-testing.
      //
      // KEYED: an unkeyed sha256 over IPv4's 2^32 keyspace is exhaustively
      // invertible, so "sha256 truncated to 16 hex chars" is not the privacy
      // property the column claims to have.
      //
      // X-Real-IP: behind this deployment's nginx the socket peer is nginx
      // itself, identical for every client, so a derivation over
      // `socket.remoteAddress` would write one constant into every row and
      // nothing would go red. XFF is client-appended and spoofable. Same
      // header better-auth and apps/auth/rate-limit-key.ts are pinned to
      // (BS#774, BS#1048).
      const def = extractTableDef('station_signup_attempt');
      const ipHashComment = def.slice(0, def.indexOf('ipHash:'));
      expect(ipHashComment).toMatch(/HMAC-SHA256/);
      expect(ipHashComment).toMatch(/X-Real-IP/);
      expect(ipHashComment).not.toMatch(/sent to the socket/);
      // Key encoding and IP canonicalization are both named, because leaving
      // either open makes "equal IPs hash equal" untrue in practice: a hex key
      // and a base64 key give two hash spaces, and `::ffff:1.2.3.4` and
      // `1.2.3.4` are one address spelled two ways.
      expect(ipHashComment).toMatch(/hex/i);
      expect(ipHashComment).toMatch(/::ffff:/);
    });

    it('states that the cooldown is station-global and ip_hash is not its grouping key', () => {
      // The contradiction this replaces: an earlier revision claimed the
      // derivation left "the cooldown's per-IP grouping" unaffected. There is
      // no per-IP grouping. The epic rejected a per-IP limiter outright —
      // every legitimate user shares the control-room computer's IP, so a few
      // fumbled codes would lock the whole room out — and the table's only
      // non-FK index is (outcome, attempted_at), which could not serve a
      // per-IP read even if one were written. The header comment and the
      // ip_hash comment have to say the same thing or BS#2359 can implement
      // against the wrong one.
      const def = extractTableDef('station_signup_attempt');
      const ipHashComment = def.slice(0, def.indexOf('ipHash:'));
      expect(ipHashComment).toMatch(/STATION-GLOBAL/);
      expect(ipHashComment).toMatch(/NOT A GROUPING KEY/);
      expect(ipHashComment).not.toMatch(/per-IP grouping is unaffected/);
      // No index on ip_hash, in either the migration or schema.ts — the
      // structural half of the same claim.
      expect(ddl).not.toMatch(/CREATE INDEX[^\n]*\("ip_hash"/i);
      expect(def).not.toMatch(/\.on\(table\.ipHash\)/);

      const header = schemaSource.slice(0, schemaSource.indexOf('export const station_signup_attempt'));
      expect(header.slice(header.lastIndexOf('// Station self-signup attempt log'))).toMatch(/STATION-WIDE/);
    });

    it('records the passcode an attempt resolved to, nullably', () => {
      // NULL for passcode_fail / cooldown_refused / cooldown_cleared, which
      // match no passcode row; populated for passcode_ok and passcode_revealed.
      expect(columnLine(body, 'passcode_id')).toMatch(/"passcode_id"\s+varchar\(255\)\s*,?\s*$/);
      expect(columnLine(body, 'passcode_id')).not.toMatch(/NOT\s+NULL/i);
      expect(ddl).toMatch(
        /ALTER TABLE "station_signup_attempt" ADD CONSTRAINT "station_signup_attempt_passcode_id_station_passcode_id_fk"[\s\S]*?REFERENCES "public"\."station_passcode"\("id"\)/i
      );
    });

    it('leaves outcome NOT NULL and actor_user_id nullable', () => {
      expect(columnLine(body, 'outcome')).toMatch(/"outcome"\s+varchar\(24\)\s+NOT\s+NULL/i);
      expect(columnLine(body, 'actor_user_id')).not.toMatch(/NOT\s+NULL/i);
    });

    it('indexes both FK referencing columns', () => {
      expect(ddl).toMatch(/CREATE INDEX "station_signup_attempt_actor_user_id_idx"[\s\S]*?\("actor_user_id"\)/i);
      expect(ddl).toMatch(/CREATE INDEX "station_signup_attempt_passcode_id_idx"[\s\S]*?\("passcode_id"\)/i);
      const def = extractTableDef('station_signup_attempt');
      expect(def).toMatch(/index\('station_signup_attempt_actor_user_id_idx'\)\.on\(table\.actorUserId\)/);
      expect(def).toMatch(/index\('station_signup_attempt_passcode_id_idx'\)\.on\(table\.passcodeId\)/);
    });

    it('declares the same columns and indexes in schema.ts as migration 0160 creates', () => {
      const def = extractTableDef('station_signup_attempt');
      expect(sorted(declaredColumns(def))).toEqual(sorted(ddlColumns(body)));
      expect(declaredColumns(def).length).toBe(6);
      expect(sorted(declaredIndexes(def))).toEqual(sorted(ddlIndexes('station_signup_attempt')));
      expect(declaredIndexes(def)).toHaveLength(3);
    });
  });

  describe('auth_user review columns', () => {
    it('adds all three as nullable timestamptz / varchar', () => {
      expect(ddl).toMatch(/ALTER TABLE "auth_user" ADD COLUMN "self_signup_at" timestamp with time zone;/i);
      expect(ddl).toMatch(/ALTER TABLE "auth_user" ADD COLUMN "self_signup_reviewed_at" timestamp with time zone;/i);
      expect(ddl).toMatch(/ALTER TABLE "auth_user" ADD COLUMN "self_signup_reviewed_by" varchar\(255\);/i);
    });

    it('adds no pending_review boolean — the two timestamps already answer it', () => {
      // Pending review = self_signup_at IS NOT NULL AND self_signup_reviewed_at
      // IS NULL. A third column would be a denormalization that can disagree
      // with the two it derives from.
      expect(ddl).not.toMatch(/pending_review/i);
      expect(extractTableDef('user')).not.toMatch(/pendingReview/);
    });

    it('indexes self_signup_reviewed_by, the self-referencing FK column', () => {
      expect(ddl).toMatch(/CREATE INDEX "auth_user_self_signup_reviewed_by_idx"[\s\S]*?\("self_signup_reviewed_by"\)/i);
      expect(schemaSource).toMatch(
        /index\('auth_user_self_signup_reviewed_by_idx'\)\.on\(table\.selfSignupReviewedBy\)/
      );
    });
  });

  describe('table naming', () => {
    it('creates both tables unprefixed in public, not under auth_ or wxyc_schema', () => {
      // `auth_` marks better-auth-managed tables; these are ours, alongside
      // anonymous_devices (0024) and user_activity (0025).
      expect(ddl).toMatch(/CREATE TABLE "station_passcode" \(/);
      expect(ddl).toMatch(/CREATE TABLE "station_signup_attempt" \(/);
      expect(ddl).not.toMatch(/CREATE TABLE "auth_station/);
      expect(ddl).not.toMatch(/CREATE TABLE "wxyc_schema"\."station_/);
      for (const table of ['station_passcode', 'station_signup_attempt']) {
        expect(schemaSource).toMatch(new RegExp(`export const ${table}\\s*=\\s*pgTable\\(`));
      }
    });
  });
});
