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

    it('specifies ip_hash as a KEYED hash, not a bare digest', () => {
      // The column comment is the entire carrier of this decision until BS#2359
      // implements it — nothing executable pins it yet. An unkeyed sha256 over
      // IPv4's 2^32 keyspace is exhaustively invertible, so "sha256 truncated to
      // 16 hex chars" is not the privacy property the column claims to have.
      const def = extractTableDef('station_signup_attempt');
      const ipHashComment = def.slice(0, def.indexOf('ipHash:'));
      expect(ipHashComment).toMatch(/HMAC-SHA256/);
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
