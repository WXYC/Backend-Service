/**
 * Schema-source assertions for migration 0132 (BS#895, Epic C C6 retune):
 * cuts `jobs/flowsheet-metadata-backfill`'s sweep predicate over from the
 * pre-BS#891 implicit marker (`metadata_attempt_at IS NULL`) to the
 * explicit `metadata_status = 'pending'` enum column, and adds the partial
 * index the epic #1810 W4 rotation self-heal query needs.
 *
 * Supersedes `schema.flowsheet-metadata-attempt-pending-idx.test.ts`
 * (deleted by this PR): that file pinned `flowsheet_metadata_attempt_pending_idx`
 * / `_covering_idx` as LIVE schema facts, which this migration retires —
 * migrations 0070 / 0074 remain in the repo as an immutable historical
 * record (git history + the already-applied `applied-hashes.json` entries),
 * but there is no longer a "current schema" fact to pin them against.
 *
 * Three things must stay in lockstep:
 *   1. The migration SQL              — what runs in production
 *   2. The Drizzle schema declaration — drift detection / typing
 *   3. The job's own SQL (worklist.ts / orchestrate.ts) — pinned separately
 *      by tests/unit/jobs/flowsheet-metadata-backfill/*.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /metadata-status-cutover-idx/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /metadata-status-cutover-idx/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

describe('schema: flowsheet metadata_status cutover + W4 rotation self-heal index (BS#895, migration 0132)', () => {
  describe('migration', () => {
    it('exists at the journal-pointed path', () => {
      expect(fs.existsSync(migrationPath)).toBe(true);
    });

    it('drops both pre-BS#891 metadata_attempt_at partial indexes', () => {
      expect(migrationSql).toMatch(/DROP INDEX\s+"wxyc_schema"\."flowsheet_metadata_attempt_pending_idx"/i);
      expect(migrationSql).toMatch(/DROP INDEX\s+"wxyc_schema"\."flowsheet_metadata_attempt_pending_covering_idx"/i);
    });

    it('creates flowsheet_rotation_no_match_idx with IF NOT EXISTS for prod-prebuilt CONCURRENTLY', () => {
      expect(migrationSql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_rotation_no_match_idx"/i);
    });

    it('flowsheet_rotation_no_match_idx is a btree on rotation_id scoped to enriched_no_match rotation-linked rows', () => {
      expect(migrationSql).toMatch(
        /"flowsheet_rotation_no_match_idx"\s+ON\s+"wxyc_schema"\."flowsheet"\s+USING\s+btree\s*\(\s*"rotation_id"\s*\)/i
      );
      expect(migrationSql).toMatch(
        /"flowsheet_rotation_no_match_idx"[\s\S]*WHERE[\s\S]*"metadata_status"\s*=\s*'enriched_no_match'/i
      );
      expect(migrationSql).toMatch(/"flowsheet_rotation_no_match_idx"[\s\S]*"rotation_id"\s+IS\s+NOT\s+NULL/i);
    });

    it('does NOT use CREATE INDEX CONCURRENTLY in actual DDL (Drizzle wraps in a transaction)', () => {
      const ddlOnly = migrationSql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
    });

    it('is DDL-only (no bulk UPDATE inlined)', () => {
      const ddlOnly = migrationSql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(ddlOnly).not.toMatch(/UPDATE\s+"wxyc_schema"\."flowsheet"\s+SET/i);
    });
  });

  describe('schema.ts', () => {
    it('no longer declares flowsheet_metadata_attempt_pending_idx or its covering variant', () => {
      expect(schemaSource).not.toMatch(/index\(\s*'flowsheet_metadata_attempt_pending_idx'\s*\)/);
      expect(schemaSource).not.toMatch(/index\(\s*'flowsheet_metadata_attempt_pending_covering_idx'\s*\)/);
    });

    it('declares flowsheet_rotation_no_match_idx on rotation_id with the predicate mirroring the migration', () => {
      expect(schemaSource).toMatch(/index\(\s*'flowsheet_rotation_no_match_idx'\s*\)/);
      expect(schemaSource).toMatch(/\.on\(table\.rotation_id\)/);
      expect(schemaSource).toMatch(/\$\{table\.metadata_status\}\s*=\s*'enriched_no_match'/);
      expect(schemaSource).toMatch(/\$\{table\.rotation_id\}\s+IS\s+NOT\s+NULL/);
    });

    it('still declares flowsheet_metadata_status_pending_idx (BS#891, unaffected by this migration)', () => {
      // Sanity check that this migration only touched the two retired
      // attempt_at indexes and added the new self-heal index — the BS#891
      // pending-status index (the cron's own sweep predicate index) is a
      // different index entirely and must survive untouched.
      expect(schemaSource).toMatch(/index\(\s*'flowsheet_metadata_status_pending_idx'\s*\)/);
    });
  });
});
