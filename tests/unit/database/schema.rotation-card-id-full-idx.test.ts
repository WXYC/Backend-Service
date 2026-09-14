/**
 * Schema-source assertions for migration 0167 (BS#2479): swap 0164's
 * `rotation_card_id_idx` — partial on `kill_date IS NULL`, which the
 * canonical active-rotation predicate (`kill_date IS NULL OR kill_date >
 * CURRENT_DATE`) can never use — for a non-partial btree on `(card_id)`
 * the broad predicate CAN use. Plain, not a `(card_id, kill_date)`
 * composite: plain is the minimal shape both consumers need — measured at
 * the table's documented scale, both shapes answer both queries in well
 * under a millisecond (the migration's own header has the numbers and the
 * fixture), and the plain form is smaller and cheaper to maintain.
 *
 * Pure file-reading guard, in the style of
 * `schema.rotation-bin-fallback-idx.test.ts` and `schema.rotation-cards.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
  fs.readFileSync(journalPath, 'utf-8')
);
const entry = journal.entries.find((e) => e.tag.startsWith('0167_'));
if (!entry) {
  throw new Error('No journal entry matches /^0167_/. Did the rotation-card-id-full-idx migration land?');
}
const migrationPath = path.join(migrationsDir, `${entry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

const executableSql = migrationSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('schema: rotation_card_id_full_idx (migration 0167, BS#2479)', () => {
  it('migration 0167 exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('creates a NON-partial btree on (card_id)', () => {
    expect(executableSql).toMatch(
      /CREATE INDEX IF NOT EXISTS "rotation_card_id_full_idx" ON "wxyc_schema"\."rotation" USING btree \("card_id"\);/
    );
    // The whole point of the swap: no WHERE clause, so the canonical broad
    // predicate (which does not imply `kill_date IS NULL`) can still use it.
    expect(executableSql).not.toMatch(/rotation_card_id_full_idx"[^;]*WHERE/);
  });

  it('does NOT composite kill_date onto the index (plain is the minimal shape both consumers need)', () => {
    expect(executableSql).not.toMatch(/rotation_card_id_full_idx"[^;]*"kill_date"/);
  });

  it('drops the old partial index it replaces', () => {
    expect(executableSql).toMatch(/DROP INDEX IF EXISTS "wxyc_schema"\."rotation_card_id_idx";/);
  });

  it('creates the new index before dropping the old one (card_id is never left uncovered)', () => {
    const createAt = executableSql.indexOf('CREATE INDEX IF NOT EXISTS "rotation_card_id_full_idx"');
    const dropAt = executableSql.indexOf('DROP INDEX IF EXISTS "wxyc_schema"."rotation_card_id_idx"');
    expect(createAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(createAt);
  });

  it('is the non-CONCURRENTLY form in the executed DDL, with the CONCURRENTLY runbook quoted in the header for ops', () => {
    expect(executableSql).not.toMatch(/CREATE INDEX\s+CONCURRENTLY/i);
    expect(executableSql).not.toMatch(/DROP INDEX\s+CONCURRENTLY/i);
    expect(migrationSql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "rotation_card_id_full_idx"/);
    expect(migrationSql).toMatch(/DROP INDEX CONCURRENTLY IF EXISTS "wxyc_schema"\."rotation_card_id_idx"/);
  });

  it('declares the matching non-partial index in schema.ts', () => {
    expect(schemaSource).toMatch(/cardIdIdx:\s*index\('rotation_card_id_full_idx'\)\.on\(table\.card_id\)/);
    // The old partial predicate must not survive alongside the new index.
    expect(schemaSource).not.toMatch(/rotation_card_id_full_idx'\)[\s\S]{0,80}\.where\(/);
  });

  it('carries a @no-precondition-needed annotation (index swap, no data or constraint change)', () => {
    expect(migrationSql).toMatch(/--\s*@no-precondition-needed:/i);
  });

  it('carries an @intentional-create-revert annotation (validate-migrations Check for the CREATE+DROP pair)', () => {
    expect(migrationSql).toMatch(/--\s*@intentional-create-revert:/i);
  });
});
