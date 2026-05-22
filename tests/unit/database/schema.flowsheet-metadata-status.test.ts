/**
 * Schema-source assertions for the `metadata_status` enum column (BS#891).
 *
 * The column replaces the implicit two-column state machine ({metadata_attempt_at,
 * artwork_url/discogs_url}) with an explicit enum, and gives Epic C's CDC-driven
 * consumer a column it can claim via `pending → enriching` to win the race
 * against sibling instances.
 *
 * Three places must stay in lockstep:
 *   1. The migration SQL                — what runs in production
 *   2. The Drizzle schema declaration  — drift detection / typing
 *   3. The transform layer              — what the V2 API exposes to clients
 *
 * This file pins (1) and (2); the V2 projection is covered by
 * `tests/unit/services/flowsheet.transformToV2.metadata-status.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /metadata-status/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /metadata-status/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

describe('schema: flowsheet.metadata_status enum + enriching_since (BS#891)', () => {
  describe('migration', () => {
    it('exists at the journal-pointed path', () => {
      expect(fs.existsSync(migrationPath)).toBe(true);
    });

    it('creates the enum type with all five states in the documented order', () => {
      // Order matters for psql `\dT+` output and for any consumer that does
      // an ordinal comparison. The order encodes the lifecycle:
      //   pending → enriching → (enriched_match | enriched_no_match | failed_no_retry)
      expect(migrationSql).toMatch(
        /CREATE TYPE\s+"wxyc_schema"\."metadata_status_enum"\s+AS ENUM\s*\(\s*'pending'\s*,\s*'enriching'\s*,\s*'enriched_match'\s*,\s*'enriched_no_match'\s*,\s*'failed_no_retry'\s*\)/i
      );
    });

    it('adds metadata_status NOT NULL DEFAULT pending so the catalog-only ALTER stays metadata-only on PG11+', () => {
      // PG11+ stores a constant default in pg_attribute and computes it
      // virtually on read; the ADD COLUMN does not rewrite the 2.6M-row
      // table. Without the constant default, ADD COLUMN NOT NULL would
      // require a full table rewrite under AccessExclusiveLock — the
      // exact failure mode we're avoiding.
      expect(migrationSql).toMatch(
        /ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"metadata_status"\s+"wxyc_schema"\."metadata_status_enum"\s+DEFAULT\s+'pending'\s+NOT NULL/i
      );
    });

    it('adds enriching_since as a nullable timestamptz with no default', () => {
      // Set when a consumer flips metadata_status to 'enriching' (Epic C
      // C2 race-claim). NULL otherwise. Default-NULL ADD COLUMN is also
      // metadata-only on PG11+.
      expect(migrationSql).toMatch(
        /ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"enriching_since"\s+timestamp\s+with\s+time\s+zone(?!\s+(?:NOT NULL|DEFAULT))/i
      );
    });

    it('creates the pending partial index with IF NOT EXISTS for prod-prebuilt CONCURRENTLY', () => {
      // Same pattern as 0070/0074: build CONCURRENTLY out-of-band on prod
      // first, then merge the migration. IF NOT EXISTS keeps the apply a
      // no-op against a prod DB where the index already exists.
      expect(migrationSql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_metadata_status_pending_idx"/i);
    });

    it('pending partial index scopes to entry_type=track, artist_name NOT NULL, metadata_status=pending', () => {
      // Predicate must match the cron query in Epic C C6 exactly or the
      // planner declines the partial index and falls back to a seq scan
      // over 2.6M rows. The artist_name guard mirrors the existing
      // metadata_attempt_at partial — talkset / message rows never need
      // enrichment.
      expect(migrationSql).toMatch(
        /"flowsheet_metadata_status_pending_idx"[\s\S]*WHERE[\s\S]*"entry_type"\s*=\s*'track'/i
      );
      expect(migrationSql).toMatch(
        /"flowsheet_metadata_status_pending_idx"[\s\S]*WHERE[\s\S]*"artist_name"\s+IS\s+NOT\s+NULL/i
      );
      expect(migrationSql).toMatch(
        /"flowsheet_metadata_status_pending_idx"[\s\S]*WHERE[\s\S]*"metadata_status"\s*=\s*'pending'/i
      );
    });

    it('creates the stale-enriching partial index keyed on enriching_since for the C6 recovery sweep', () => {
      // Stale claims (process died mid-LML-call) need to be swept back to
      // 'pending' so the row stays retryable. The recovery query is:
      //   UPDATE ... SET metadata_status='pending', enriching_since=NULL
      //   WHERE metadata_status='enriching' AND enriching_since < now() - interval '60 seconds'
      // The index is keyed on enriching_since (not id) so the planner can
      // range-scan the stale slice directly.
      expect(migrationSql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_metadata_status_enriching_stale_idx"/i);
      expect(migrationSql).toMatch(
        /"flowsheet_metadata_status_enriching_stale_idx"[\s\S]*USING\s+btree\s*\(\s*"enriching_since"\s*\)[\s\S]*WHERE[\s\S]*"metadata_status"\s*=\s*'enriching'/i
      );
    });

    it('does NOT use CREATE INDEX CONCURRENTLY in actual DDL (Drizzle wraps in a transaction)', () => {
      // Same constraint as 0057, 0061, 0068, 0070, 0074. The prose may
      // mention CONCURRENTLY in the prod runbook; filter -- comments
      // before matching DDL.
      const ddlOnly = migrationSql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
    });

    it('does NOT inline the row-rewriting backfill UPDATE in the migration', () => {
      // Migrations are DDL-only (CLAUDE.md). The CASE-derived backfill
      // from existing metadata_attempt_at + populated-column state is a
      // separate one-shot ops step gated by the bulk-update playbook
      // (sync_commit=off, batched). A 2.6M-row UPDATE in a migration
      // transaction would block writes for the duration.
      const ddlOnly = migrationSql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      expect(ddlOnly).not.toMatch(/UPDATE\s+"wxyc_schema"\."flowsheet"\s+SET/i);
    });
  });

  describe('schema.ts', () => {
    it('declares the metadata_status_enum with all five states', () => {
      expect(schemaSource).toMatch(/metadataStatusEnum\s*=\s*wxyc_schema\.enum\(\s*'metadata_status_enum'/);
      expect(schemaSource).toMatch(
        /'pending'[\s\S]*'enriching'[\s\S]*'enriched_match'[\s\S]*'enriched_no_match'[\s\S]*'failed_no_retry'/
      );
    });

    it('declares metadata_status on flowsheet with the pending default and NOT NULL', () => {
      expect(schemaSource).toMatch(/metadata_status:\s*metadataStatusEnum\('metadata_status'\)[\s\S]*\.notNull\(\)/);
      expect(schemaSource).toMatch(/metadata_status:[\s\S]*\.default\('pending'\)/);
    });

    it('declares enriching_since as nullable timestamptz', () => {
      expect(schemaSource).toMatch(
        /enriching_since:\s*timestamp\(\s*'enriching_since',\s*\{\s*withTimezone:\s*true\s*\}\s*\)(?!\s*\.notNull)/
      );
    });

    it('declares the pending partial index with predicate mirroring the migration', () => {
      expect(schemaSource).toMatch(/index\(\s*'flowsheet_metadata_status_pending_idx'\s*\)/);
      expect(schemaSource).toMatch(/\$\{table\.metadata_status\}\s*=\s*'pending'/);
    });

    it('declares the stale-enriching partial index keyed on enriching_since', () => {
      expect(schemaSource).toMatch(/index\(\s*'flowsheet_metadata_status_enriching_stale_idx'\s*\)/);
      expect(schemaSource).toMatch(/\$\{table\.metadata_status\}\s*=\s*'enriching'/);
    });
  });
});
