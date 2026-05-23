/**
 * Schema-source assertions for the partial B-tree index covering the
 * `metadata_attempt_at IS NOT NULL` slice — the complement to the
 * `_metadata_attempt_pending_*` indexes that cover the `IS NULL` partition.
 *
 * The partial WHERE predicate must appear identically in three places:
 *   1. The migration SQL                         — what runs in production
 *   2. The Drizzle schema declaration            — drift detection / typing
 *   3. The verify query in album-metadata-backfill (`jobs/album-metadata-backfill/job.ts`)
 * If any drifts, the others become dead weight (planner declines the partial
 * index when the query's filter doesn't match) or silently regress to a
 * seq scan — exactly the BS#1022 / BS#1019 failure mode this index exists
 * to fix.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const jobPath = path.resolve(__dirname, '../../../jobs/album-metadata-backfill/job.ts');

// Resolve the migration filename from the journal at load-time so the test
// stays correct if the idx number shifts during rebase. Throwing here turns
// "no journal entry yet" into a clear top-level setup failure rather than a
// confusing per-test cascade.
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /album-id-enriched/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /album-id-enriched/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

describe('schema: flowsheet_album_id_enriched_idx (partial B-tree on album_id)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates the index with IF NOT EXISTS so a prod-prebuilt CONCURRENTLY index is a no-op', () => {
    // The prod ops flow for this index is: build first via
    // `CREATE INDEX CONCURRENTLY` against the live RDS to avoid the
    // ShareLock window, then merge the migration. Without IF NOT EXISTS
    // the migration's regular CREATE INDEX would fail on prod. Same shape
    // as 0070 / 0074 / 0078 — see docs/migrations.md#if-not-exists-index.
    expect(migrationSql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_album_id_enriched_idx"/i);
  });

  it('migration scopes the index to the flowsheet table on column album_id', () => {
    expect(migrationSql).toMatch(/ON\s+"wxyc_schema"\."flowsheet"\s+(?:USING\s+btree\s+)?\(\s*"album_id"\s*\)/i);
  });

  it('migration carries the partial WHERE predicate exactly matching the verify query', () => {
    // Two clauses (album_id IS NOT NULL, metadata_attempt_at IS NOT NULL) —
    // both must be present. NO `entry_type='track'` guard, on purpose: the
    // verify query in album-metadata-backfill doesn't carry it either, and
    // adding it would prevent the planner from picking the index up.
    // Non-track entries always have `album_id IS NULL`, so the predicate
    // restricts to track rows naturally.
    expect(migrationSql).toMatch(/WHERE[\s\S]*"album_id"\s+IS\s+NOT\s+NULL/i);
    expect(migrationSql).toMatch(/WHERE[\s\S]*"metadata_attempt_at"\s+IS\s+NOT\s+NULL/i);
    // Guard against accidental drift to a track-only predicate.
    const ddlOnly = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(ddlOnly).not.toMatch(/WHERE[\s\S]*"entry_type"\s*=\s*'track'/i);
  });

  it('migration does NOT use CREATE INDEX CONCURRENTLY in actual DDL (incompatible with drizzle txn wrapping)', () => {
    // Drizzle wraps each migration in a transaction. CONCURRENTLY would
    // raise "CREATE INDEX CONCURRENTLY cannot run inside a transaction
    // block". The prod ops runbook is to build CONCURRENTLY out-of-band
    // and let the migration's IF NOT EXISTS make the apply a no-op. Same
    // pattern as 0068 / 0070 / 0074 / 0078.
    //
    // The comment block legitimately mentions CONCURRENTLY in its prose
    // and includes the runbook's `CREATE INDEX CONCURRENTLY` example, so
    // a plain string match would false-positive. Filter SQL-comment lines
    // (`-- ...`) before matching the keyword sequence.
    const ddlOnly = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
  });

  it('schema.ts declares the index so drizzle-kit drift detection sees it', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/index\(\s*'flowsheet_album_id_enriched_idx'\s*\)/);
    // The schema's WHERE expression must mirror the migration's two
    // clauses. Loose match on whitespace and template-literal quoting; the
    // structure is what matters.
    expect(schemaSource).toMatch(/\$\{table\.album_id\}\s+IS\s+NOT\s+NULL/);
    expect(schemaSource).toMatch(/\$\{table\.metadata_attempt_at\}\s+IS\s+NOT\s+NULL/);
  });

  it('verify query in album-metadata-backfill carries the same WHERE clause the index covers', () => {
    // The three-way invariant: if this consumer's predicate ever drifts
    // from the migration's predicate, the partial index becomes dead
    // weight (planner declines it; query falls back to a seq scan; we
    // re-hit BS#1022). Pin the verify query's WHERE shape here so a
    // future PR that changes one side surfaces in CI.
    const jobSource = fs.readFileSync(jobPath, 'utf-8');
    expect(jobSource).toMatch(/"album_id"\s+IS\s+NOT\s+NULL[\s\S]*?AND[\s\S]*?"metadata_attempt_at"\s+IS\s+NOT\s+NULL/);
  });
});
