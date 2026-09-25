/**
 * Schema-source assertions for the `flowsheet_show_radio_hour_breakpoint_idx`
 * partial unique index on `wxyc_schema.flowsheet`.
 *
 * BS#2569 — at most one hourly breakpoint per (show_id, radio_hour). The
 * duplicates this index forbids came from a concurrent-fill race, not from
 * historical residue: `fillMissingHourlyBreakpoints` re-derives its watermark
 * on every POST /flowsheet, so a *stale* watermark is impossible, but two
 * requests on one show can both read the last breakpoint before either has
 * inserted and both then generate the same hour.
 *
 * Deploy order is the load-bearing part and is asserted here as prose rather
 * than code: a269b724 gave the fill `ON CONFLICT DO NOTHING` and shipped
 * BEFORE this index was built, so the losing request drops only the colliding
 * marker instead of raising in front of an on-air DJ.
 *
 * Mirrors the shape of `schema.cta-unique-null-track-partial.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');

const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /breakpoint-hour-uniq/i.test(e.tag));
if (!journalEntry) {
  throw new Error('No journal entry matches /breakpoint-hour-uniq/. Did the 0175 migration land?');
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');

// Strip line comments so the header's prose — which legitimately discusses
// CONCURRENTLY, the predicate, and the 0071/0072 contrast — cannot false-match
// the DDL assertions below. Same pattern as the cta partial-index spec.
const ddlOnly = migrationSql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('schema: flowsheet_show_radio_hour_breakpoint_idx partial unique (BS#2569)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('creates the partial UNIQUE index on (show_id, radio_hour)', () => {
    expect(ddlOnly).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+"flowsheet_show_radio_hour_breakpoint_idx"\s+ON\s+"wxyc_schema"\."flowsheet"[\s\S]*?\(\s*"show_id"\s*,\s*"radio_hour"\s*\)/i
    );
  });

  it('restricts the index to breakpoints carrying a radio_hour', () => {
    // Both legs matter. Without `entry_type = 'breakpoint'` the index would
    // constrain track rows, which legitimately repeat within an hour; without
    // `radio_hour IS NOT NULL` it would still admit unlimited NULL rows (PG
    // treats NULLs as distinct) but would needlessly index 170k legacy
    // breakpoints that carry no hour.
    const where = ddlOnly.match(/WHERE[\s\S]*$/i);
    if (where === null) throw new Error('expected a WHERE clause on the index');
    expect(where[0]).toMatch(/"entry_type"\s*=\s*'breakpoint'/i);
    expect(where[0]).toMatch(/"radio_hour"\s+IS\s+NOT\s+NULL/i);
  });

  it('carries IF NOT EXISTS so it no-ops against the pre-built prod index', () => {
    // The index was built out-of-band with CONCURRENTLY on 2026-09-23 before
    // this migration was authored (docs/migrations.md `if-not-exists-index`).
    // Without IF NOT EXISTS the deploy would fail on an already-present index.
    expect(ddlOnly).toMatch(/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
  });

  it('carries a precondition guard counting duplicate (show_id, radio_hour) groups (issue #705)', () => {
    const guard = migrationSql.match(/DO\s+\$\$[\s\S]*?RAISE\s+EXCEPTION[\s\S]*?END\s+\$\$/i);
    if (guard === null) {
      throw new Error('expected a DO $$ ... RAISE EXCEPTION ... END $$ block in the migration');
    }
    expect(guard[0]).toMatch(/entry_type\s*=\s*'breakpoint'/i);
    expect(guard[0]).toMatch(/radio_hour\s+IS\s+NOT\s+NULL/i);
    expect(guard[0]).toMatch(/GROUP\s+BY\s+show_id\s*,\s*radio_hour/i);
    expect(guard[0]).toMatch(/HAVING\s+COUNT\(\*\)\s*>\s*1/i);
  });

  it('does NOT use CONCURRENTLY in the actual DDL (incompatible with drizzle txn wrapping)', () => {
    // Drizzle wraps the pending migrations in one transaction, and
    // `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. The
    // header prose may name CONCURRENTLY as the operator runbook, hence the
    // DDL-only view.
    expect(ddlOnly).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+CONCURRENTLY/i);
  });

  it('schema.ts declares the index so drizzle-kit drift detection sees it', () => {
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(/uniqueIndex\(\s*'flowsheet_show_radio_hour_breakpoint_idx'\s*\)/);
    expect(schemaSource).toMatch(/\.on\(\s*table\.show_id\s*,\s*table\.radio_hour\s*\)/);
    expect(schemaSource).toMatch(/\$\{table\.entry_type\}\s*=\s*'breakpoint'/);
  });

  it('acknowledges the #702 source-tagged constraint rather than silently adding one', () => {
    // `flowsheet` is a SOURCE-tagged table and this index reaches
    // tubafrenzy-originated rows (tubafrenzy has its own RADIO_HOUR column),
    // so the eslint suppression is a real acknowledgement, not boilerplate.
    // Pin that the disable sits immediately above THIS index, so a future
    // edit can't detach it and leave the constraint unreviewed.
    const schemaSource = fs.readFileSync(schemaPath, 'utf-8');
    expect(schemaSource).toMatch(
      /eslint-disable-next-line wxyc\/source-tagged-constraint-confirmed\s*\n\s*uniqueIndex\(\s*'flowsheet_show_radio_hour_breakpoint_idx'\s*\)/
    );
  });
});
