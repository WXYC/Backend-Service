/**
 * Schema-source assertions for the `cta_unique_null_track_idx` partial
 * unique index on `wxyc_schema.compilation_track_artist`.
 *
 * BS#1135 — Postgres treats NULLs as distinct in unique B-tree
 * comparisons by default, so the original 0037 `cta_unique_idx` on
 * `(library_id, artist_name, track_title)` never blocked the case where
 * two rows share `(library_id, artist_name)` and both have NULL
 * `track_title`. PG 15's `NULLS NOT DISTINCT` modifier would be the
 * single-index fix, but prod RDS runs PostgreSQL 14.22 (verified via
 * the migrate-dryrun job's RDS describe output), so we close the
 * loophole with a complementary partial unique index restricted to the
 * `track_title IS NULL` slice. The base index continues to enforce
 * uniqueness on the non-NULL slice.
 *
 * Mirrors the shape of `schema.flowsheet-album-id-enriched-idx.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /cta-unique-null-track-partial/i.test(e.tag));
if (!journalEntry) {
  throw new Error('No journal entry matches /cta-unique-null-track-partial/. Did the 0099 migration land?');
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

// Strip line comments so prose discussing `track_title IS NULL` etc. in
// the header doesn't false-match the SQL assertions below. Same pattern
// as schema.flowsheet-album-id-enriched-idx.test.ts.
const ddlOnly = migrationSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('schema: cta_unique_null_track_idx partial unique (BS#1135)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates the partial unique index with the IS NULL predicate on (library_id, artist_name)', () => {
    // The partial WHERE restricts the unique constraint to the NULL slice;
    // the base 0037 `cta_unique_idx` continues to enforce the non-NULL
    // slice. Together they cover the full intended semantics on PG 14.
    expect(ddlOnly).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+"cta_unique_null_track_idx"\s+ON\s+"wxyc_schema"\."compilation_track_artist"[\s\S]*?\(\s*"library_id"\s*,\s*"artist_name"\s*\)[\s\S]*?WHERE[\s\S]*?"track_title"\s+IS\s+NULL/i
    );
  });

  it('migration does NOT drop or alter the existing cta_unique_idx (additive only)', () => {
    // The fix is purely additive — the 0037 index keeps enforcing the
    // non-NULL slice, the new partial covers the NULL slice. Touching the
    // base index would broaden the apply blast radius and isn't needed.
    expect(ddlOnly).not.toMatch(/DROP\s+INDEX[^;]*"cta_unique_idx"/i);
    expect(ddlOnly).not.toMatch(/ALTER\s+INDEX[^;]*"cta_unique_idx"/i);
  });

  it('migration carries a precondition guard that counts duplicate NULL-track groups (issue #705)', () => {
    // Guard must appear before the DDL so a populated prod DB with
    // existing duplicates aborts the migration cleanly inside its
    // transaction, rather than wedging mid-build. Same shape as 0071.
    const guard = migrationSql.match(/DO\s+\$\$[\s\S]*?RAISE\s+EXCEPTION[\s\S]*?END\s+\$\$/i);
    if (guard === null) {
      throw new Error('expected a DO $$ ... RAISE EXCEPTION ... END $$ block in the migration');
    }
    expect(guard[0]).toMatch(/track_title\s+IS\s+NULL/i);
    expect(guard[0]).toMatch(/GROUP\s+BY\s+library_id\s*,\s*artist_name/i);
    expect(guard[0]).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
  });

  it('migration does NOT use CREATE INDEX CONCURRENTLY in actual DDL (incompatible with drizzle txn wrapping)', () => {
    // Drizzle wraps each migration in a transaction. CONCURRENTLY would
    // raise "CREATE INDEX CONCURRENTLY cannot run inside a transaction
    // block". Same pattern as 0068 / 0070 / 0074 / 0078. The header
    // prose may legitimately mention CONCURRENTLY (operator runbook), so
    // we check against the DDL-only view.
    expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
  });

  it('migration does NOT use NULLS NOT DISTINCT (unavailable on prod PG 14)', () => {
    // Prod RDS is PostgreSQL 14.22 (verified 2026-06-13 via migrate-dryrun
    // `aws rds describe-db-instances`). The PG15+ `NULLS NOT DISTINCT`
    // modifier would parse as a syntax error there. The partial-index
    // pair is the PG14-compatible substitute.
    expect(ddlOnly).not.toMatch(/NULLS\s+NOT\s+DISTINCT/i);
  });

  it('schema.ts declares both indexes so drizzle-kit drift detection sees them', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    // Base index unchanged.
    expect(schemaSource).toMatch(
      /uniqueIndex\(\s*'cta_unique_idx'\s*\)\.on\(\s*table\.library_id\s*,\s*table\.artist_name\s*,\s*table\.track_title\s*\)/
    );
    // New partial unique. Loose match on whitespace and template-literal
    // quoting; the structure is what matters.
    expect(schemaSource).toMatch(/uniqueIndex\(\s*'cta_unique_null_track_idx'\s*\)/);
    expect(schemaSource).toMatch(/\.on\(\s*table\.library_id\s*,\s*table\.artist_name\s*\)/);
    expect(schemaSource).toMatch(/\$\{table\.track_title\}\s+IS\s+NULL/);
  });
});
