/**
 * Schema-source assertions for the composite `(show_id, play_order DESC)`
 * index that backs the per-show `nextPlayOrder()` MAX query
 * (BS#1133, replacing the misaligned single-column 0073 index).
 *
 * The composite shape must appear identically in three places:
 *   1. The migration SQL (DROP + CREATE)              — what runs in prod
 *   2. The Drizzle schema declaration                  — drift detection
 *   3. The `nextPlayOrder()` query in
 *      apps/backend/services/flowsheet.service.ts      — the actual caller
 *
 * If the schema's declaration drifts from the migration, drizzle-kit
 * detects it on the next `drizzle:generate` and emits a noisy catch-up
 * migration. If the `nextPlayOrder()` query loses its `WHERE show_id = ?`
 * predicate, the composite index becomes useless on its leading-column
 * filter and we're back to the slow path #693 fixed once already.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const servicePath = path.resolve(__dirname, '../../../apps/backend/services/flowsheet.service.ts');

// Resolve the migration filename from the journal so the test stays correct
// if the idx number shifts during a rebase against main.
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /show-id-play-order-idx/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /show-id-play-order-idx/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

describe('schema: flowsheet_show_id_play_order_idx (composite index for per-show nextPlayOrder, BS#1133)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('migration creates the composite index with (show_id, play_order DESC)', () => {
    // The composite ordering is load-bearing: `show_id` must be the leading
    // column so the index can be used for the WHERE filter, and `play_order`
    // must be DESC so the per-show MAX is a leaf-page peek at the run's edge.
    expect(migrationSql).toMatch(
      /CREATE INDEX\s+IF NOT EXISTS\s+"flowsheet_show_id_play_order_idx"\s+ON\s+"wxyc_schema"\."flowsheet"\s+USING\s+btree\s+\(\s*"show_id"\s*,\s*"play_order"\s+DESC\s*\)/i
    );
  });

  it('migration drops the predecessor `flowsheet_play_order_idx` (0073) in the same transaction', () => {
    // The single-column DESC index served the global MAX shape that #693
    // retired. Dropping it in the same migration reclaims 17 MB and stops
    // the planner from picking it up over the composite for the per-show
    // WHERE+MAX shape. The only remaining global-MAX caller is the ETL
    // job's one-shot resetSequences(), which is not perf-sensitive.
    expect(migrationSql).toMatch(/DROP INDEX\s+IF EXISTS\s+"wxyc_schema"\."flowsheet_play_order_idx"/i);
  });

  it('migration does NOT use CREATE INDEX CONCURRENTLY in actual DDL (incompatible with drizzle txn wrapping)', () => {
    // The comment block legitimately mentions CONCURRENTLY in its
    // runbook example, so filter SQL-comment lines (`-- ...`) before
    // matching — same pattern as schema.flowsheet-album-link-lookup-idx.test.ts.
    const ddlOnly = migrationSql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
    expect(ddlOnly).not.toMatch(/DROP\s+INDEX\s+CONCURRENTLY/i);
  });

  it('schema.ts declares the composite index so drizzle-kit drift detection sees it', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/index\(\s*'flowsheet_show_id_play_order_idx'\s*\)/);
    // The schema declaration must list `show_id` first (leading column) and
    // `play_order` with DESC ordering. If a future schema edit reorders the
    // columns or drops the DESC, this assertion catches it before the next
    // drizzle:generate emits a noisy catch-up migration.
    expect(schemaSource).toMatch(
      /index\(\s*'flowsheet_show_id_play_order_idx'\s*\)\s*\.on\(\s*table\.show_id\s*,\s*sql`\$\{table\.play_order\}\s+DESC`\s*\)/
    );
  });

  it('schema.ts no longer declares the single-column `flowsheet_play_order_idx`', () => {
    // Drift guard: if the predecessor index sneaks back into schema.ts,
    // drizzle:generate will emit a CREATE INDEX for it, undoing the cleanup.
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).not.toMatch(/index\(\s*'flowsheet_play_order_idx'\s*\)/);
  });

  it('nextPlayOrder() filters by show_id so the composite index leading column is usable', () => {
    // The composite's leading column is show_id; without a `WHERE show_id = ?`
    // predicate the planner cannot use it for the filter, and the per-show
    // MAX collapses back to the slow path. This pins the post-#693 query
    // shape: the SELECT must scope to one show.
    const serviceSource = fs.readFileSync(servicePath, 'utf-8');
    // Locate the function body, then assert its WHERE shape.
    const fnMatch = serviceSource.match(/const nextPlayOrder = async \(showId: number\)[\s\S]*?\n};/);
    if (!fnMatch) {
      throw new Error(
        'Could not locate nextPlayOrder() in flowsheet.service.ts. Did the function signature or body shape change?'
      );
    }
    const fnBody = fnMatch[0];
    expect(fnBody).toMatch(/\.where\(\s*eq\(\s*flowsheet\.show_id\s*,\s*showId\s*\)\s*\)/);
    expect(fnBody).toMatch(/coalesce\(max\(\$\{flowsheet\.play_order\}\),\s*0\)/);
  });
});
