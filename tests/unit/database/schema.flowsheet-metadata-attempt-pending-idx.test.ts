/**
 * Schema-source assertions for the partial B-tree index that supports the
 * `metadata_attempt_at IS NULL` filter shared by #638's historical drain
 * and #639's eventual drift-repair sweep. Without this index, each batch
 * of the drain seq-scans the 2.6M+ row flowsheet table just to find the
 * NULL tail — exactly the failure mode #659 was filed to prevent.
 *
 * The partial WHERE predicate must appear identically in three places:
 *   1. The migration SQL                         — what runs in production
 *   2. The Drizzle schema declaration            — drift detection / typing
 *   3. The drain query in the consumer (#638's `enrich.ts`, not yet shipped)
 * If any drifts, the others become dead weight (planner declines the partial
 * index when the query's filter doesn't match) or silently regress to a
 * seq scan.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

// Resolve the migration filename from the journal at load-time so the test
// stays correct if the idx number shifts during rebase. Throwing here turns
// "no journal entry yet" into a clear top-level setup failure rather than a
// confusing per-test cascade.
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /metadata-attempt-pending/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /metadata-attempt-pending/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

describe('schema: flowsheet_metadata_attempt_pending_idx (partial B-tree on id)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates the index with IF NOT EXISTS so a prod-prebuilt CONCURRENTLY index is a no-op', () => {
    // The prod ops flow for this index is: build first via
    // `CREATE INDEX CONCURRENTLY` against the live RDS to avoid the
    // ShareLock window, then merge the migration. Without IF NOT EXISTS
    // the migration's regular CREATE INDEX would fail on prod.
    expect(migrationSql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_metadata_attempt_pending_idx"/i);
  });

  it('migration scopes the index to the flowsheet table on column id', () => {
    expect(migrationSql).toMatch(/ON\s+"wxyc_schema"\."flowsheet"\s+(?:USING\s+btree\s+)?\(\s*"id"\s*\)/i);
  });

  it('migration carries the partial WHERE predicate exactly once and covers all three filter clauses', () => {
    // The partial predicate must contain entry_type='track', artist_name IS
    // NOT NULL, and metadata_attempt_at IS NULL — the exact filter the drain
    // query in #638 will use. Missing any one would leave the planner unable
    // to use the partial index for the drain.
    expect(migrationSql).toMatch(/WHERE[\s\S]*"entry_type"\s*=\s*'track'/i);
    expect(migrationSql).toMatch(/WHERE[\s\S]*"artist_name"\s+IS\s+NOT\s+NULL/i);
    expect(migrationSql).toMatch(/WHERE[\s\S]*"metadata_attempt_at"\s+IS\s+NULL/i);
  });

  it('migration does NOT use CREATE INDEX CONCURRENTLY in actual DDL (incompatible with drizzle txn wrapping)', () => {
    // Drizzle wraps each migration in a transaction. CONCURRENTLY would
    // raise "CREATE INDEX CONCURRENTLY cannot run inside a transaction
    // block". The prod ops runbook is to build CONCURRENTLY out-of-band
    // and let the migration's IF NOT EXISTS make the apply a no-op. Same
    // pattern as 0068 / 0061.
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
    expect(schemaSource).toMatch(/index\(\s*'flowsheet_metadata_attempt_pending_idx'\s*\)/);
    // The schema's WHERE expression must mirror the migration's three
    // clauses. Loose match on whitespace and template-literal quoting; the
    // structure is what matters.
    expect(schemaSource).toMatch(/\$\{table\.entry_type\}\s*=\s*'track'/);
    expect(schemaSource).toMatch(/\$\{table\.artist_name\}\s+IS\s+NOT\s+NULL/);
    expect(schemaSource).toMatch(/\$\{table\.metadata_attempt_at\}\s+IS\s+NULL/);
  });
});
