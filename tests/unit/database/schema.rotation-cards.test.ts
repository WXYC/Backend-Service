/**
 * Schema-source assertions for the rotation_cards / rotation_urls substrate
 * (BS#2471, WXYC/dj-site#1480 Rotation Admin backend PR B1): migration 0164.
 *
 * Pure file-reading guard, in the style of `schema.station-signup.test.ts`
 * and `schema.rotation-bin-fallback-idx.test.ts`. This PR is schema only —
 * no reader or writer exists yet for a green integration test to protect —
 * so this file is the only thing pinning the shapes B2/B3/B7 build against.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
  fs.readFileSync(journalPath, 'utf-8')
);

const entry = journal.entries.find((e) => e.tag.startsWith('0164_'));
if (!entry) {
  throw new Error('No journal entry matches /^0164_/. Did the rotation-cards-urls migration land?');
}
const migrationPath = path.join(migrationsDir, `${entry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

// Strip full-line and inline `--` comments so the header prose can't
// false-match the DDL assertions below.
const stripComments = (sql: string) =>
  sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');

const ddl = stripComments(migrationSql);

const extractTableDef = (tableName: string): string => {
  const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
  const match = schemaSource.match(regex);
  if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
  return match[0];
};

describe('schema: rotation_cards / rotation_urls substrate (migration 0164, BS#2471)', () => {
  it('migration 0164 exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  describe('rotation_cards', () => {
    it('creates the table with a stable id, the existing rotation_bin enum, display-order number, and nullable name', () => {
      expect(ddl).toMatch(
        /CREATE TABLE "wxyc_schema"\."rotation_cards" \(\s*"id" serial PRIMARY KEY NOT NULL,\s*"bin" "freq_enum" NOT NULL,\s*"number" integer NOT NULL,\s*"name" text\s*\);/
      );
    });

    it('is unique on (bin, number), not on number alone', () => {
      // A bare `number` unique index would forbid the same display position
      // from existing in two different bins, which is not the invariant —
      // card 1 in bin H and card 1 in bin S are unrelated rows.
      expect(ddl).toMatch(
        /CREATE UNIQUE INDEX "rotation_cards_bin_number_idx" ON "wxyc_schema"\."rotation_cards" USING btree \("bin","number"\)/
      );
      expect(ddl).not.toMatch(/CREATE UNIQUE INDEX "rotation_cards_bin_number_idx"[^\n]*\("number"\)/);
    });

    it('has no uniqueness or check constraint on number contiguity', () => {
      // Contiguity is a service-layer rule per the issue, not a DB
      // constraint — gaps and renumbers must be legal at the schema level.
      expect(ddl).not.toMatch(/CHECK[\s\S]*"number"/i);
    });

    it('declares the matching table in schema.ts with the same columns and index', () => {
      const def = extractTableDef('rotation_cards');
      expect(def).toMatch(/id:\s*serial\('id'\)\.primaryKey\(\)/);
      expect(def).toMatch(/bin:\s*freqEnum\('bin'\)\.notNull\(\)/);
      expect(def).toMatch(/number:\s*integer\('number'\)\.notNull\(\)/);
      expect(def).toMatch(/name:\s*text\('name'\)/);
      expect(def).not.toMatch(/name:\s*text\('name'\)\.notNull\(\)/);
      expect(def).toMatch(/uniqueIndex\('rotation_cards_bin_number_idx'\)\.on\(table\.bin,\s*table\.number\)/);
    });
  });

  describe('rotation.card_id', () => {
    it('adds card_id as a nullable integer column (no backfill in this PR)', () => {
      expect(ddl).toMatch(/ALTER TABLE "wxyc_schema"\."rotation" ADD COLUMN "card_id" integer;/);
      expect(ddl).not.toMatch(/ADD COLUMN "card_id" integer NOT NULL/);
    });

    it('FKs card_id to rotation_cards.id with no ON DELETE action', () => {
      expect(ddl).toMatch(
        /ALTER TABLE "wxyc_schema"\."rotation" ADD CONSTRAINT "rotation_card_id_rotation_cards_id_fk" FOREIGN KEY \("card_id"\) REFERENCES "wxyc_schema"\."rotation_cards"\("id"\) ON DELETE no action ON UPDATE no action;/
      );
    });

    it('indexes card_id, partial on the active set (kill_date IS NULL) — Postgres does not auto-index FK columns', () => {
      expect(ddl).toMatch(
        /CREATE INDEX IF NOT EXISTS "rotation_card_id_idx" ON "wxyc_schema"\."rotation" USING btree \("card_id"\) WHERE "wxyc_schema"\."rotation"\."kill_date" IS NULL;/
      );
    });

    it('is the non-CONCURRENTLY form in the executed DDL, with the CONCURRENTLY runbook quoted in the header for ops', () => {
      expect(ddl).not.toMatch(/CREATE INDEX\s+CONCURRENTLY/i);
      expect(migrationSql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "rotation_card_id_idx"/);
    });

    it("declares the matching nullable, FK'd, partially-indexed column in schema.ts", () => {
      const def = extractTableDef('rotation');
      expect(def).toMatch(/card_id:\s*integer\('card_id'\)\.references\(\(\)\s*=>\s*rotation_cards\.id\)/);
      expect(def).not.toMatch(/card_id:[^,]*notNull\(\)/);
      expect(def).toMatch(
        /cardIdIdx:\s*index\('rotation_card_id_idx'\)\s*\.on\(table\.card_id\)\s*\.where\(sql`\$\{table\.kill_date\}\s*IS NULL`\)/
      );
    });
  });

  describe('rotation_urls', () => {
    it('creates the table with a stable id, a NOT NULL rotation_id, url, and position', () => {
      expect(ddl).toMatch(
        /CREATE TABLE "wxyc_schema"\."rotation_urls" \(\s*"id" serial PRIMARY KEY NOT NULL,\s*"rotation_id" integer NOT NULL,\s*"url" text NOT NULL,\s*"position" integer NOT NULL\s*\);/
      );
    });

    it('FKs rotation_id to rotation.id ON DELETE cascade, so a deleted rotation row drops its URLs', () => {
      expect(ddl).toMatch(
        /ALTER TABLE "wxyc_schema"\."rotation_urls" ADD CONSTRAINT "rotation_urls_rotation_id_rotation_id_fk" FOREIGN KEY \("rotation_id"\) REFERENCES "wxyc_schema"\."rotation"\("id"\) ON DELETE cascade ON UPDATE no action;/
      );
    });

    it('indexes rotation_id — Postgres does not auto-index FK columns', () => {
      expect(ddl).toMatch(
        /CREATE INDEX "rotation_urls_rotation_id_idx" ON "wxyc_schema"\."rotation_urls" USING btree \("rotation_id"\)/
      );
    });

    it('declares the matching table in schema.ts with the same columns, FK, and index', () => {
      const def = extractTableDef('rotation_urls');
      expect(def).toMatch(/id:\s*serial\('id'\)\.primaryKey\(\)/);
      expect(def).toMatch(
        /rotation_id:\s*integer\('rotation_id'\)\s*\.notNull\(\)\s*\.references\(\(\)\s*=>\s*rotation\.id,\s*\{\s*onDelete:\s*'cascade'\s*\}\)/
      );
      expect(def).toMatch(/url:\s*text\('url'\)\.notNull\(\)/);
      expect(def).toMatch(/position:\s*integer\('position'\)\.notNull\(\)/);
      expect(def).toMatch(/rotationIdIdx:\s*index\('rotation_urls_rotation_id_idx'\)\.on\(table\.rotation_id\)/);
    });
  });

  describe('precondition guards (Check 8)', () => {
    it('annotates the file rather than gating the fresh-table unique index and FKs behind a DO $$ guard', () => {
      // rotation_cards / rotation_urls are freshly created (zero rows) and
      // rotation.card_id is an all-NULL new column, so none of these
      // constraint additions can find a violating row — safe by
      // construction, per the `@no-precondition-needed` escape hatch
      // documented in docs/migrations.md.
      expect(migrationSql).toMatch(/--\s*@no-precondition-needed:/i);
    });
  });

  it('creates both new tables under wxyc_schema, matching rotation itself', () => {
    expect(ddl).toMatch(/CREATE TABLE "wxyc_schema"\."rotation_cards"/);
    expect(ddl).toMatch(/CREATE TABLE "wxyc_schema"\."rotation_urls"/);
    expect(schemaSource).toMatch(/export const rotation_cards = wxyc_schema\.table\(/);
    expect(schemaSource).toMatch(/export const rotation_urls = wxyc_schema\.table\(/);
  });
});
