import * as fs from 'fs';
import * as path from 'path';

describe('schema: search_doc augmented with dj_name + dropped trgm indexes (step 5b.3)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0054_flowsheet-search-doc-with-dj-name.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('flowsheet schema declares search_doc with dj_name in the generated expression', () => {
    const def = extractTableDef('flowsheet');
    // dj_name must appear inside the generated expression so drizzle-kit drift
    // detection sees the same expression Postgres has after migration 0054.
    // The generated expression spans `search_doc: tsvector(...).generatedAlwaysAs(...)`
    // and ends at the closing `),` of generatedAlwaysAs. Match through that
    // whole block (rather than the first `),` which would land inside an
    // inner setweight call).
    const generated = def.match(/search_doc[\s\S]*?generatedAlwaysAs\([\s\S]*?`[\s\S]*?`\s*\)/)?.[0];
    expect(generated).toBeDefined();
    expect(generated).toMatch(/coalesce\("dj_name"/i);
  });

  it('migration 0054 exists and recreates search_doc to include dj_name', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    // Drop+re-add is required because Postgres does not allow modifying the
    // generation expression of an existing generated column.
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+DROP COLUMN\s+"search_doc"/i);
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"search_doc"\s+tsvector/i);
    expect(sql).toMatch(/coalesce\("dj_name"/i);
  });

  it('migration 0054 recreates the search_doc GIN index', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE INDEX\s+"flowsheet_search_doc_idx"[\s\S]*USING\s+gin/i);
  });

  it('migration 0054 adds a trigram index on flowsheet.dj_name to support dj: ILIKE', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE INDEX\s+"flowsheet_dj_name_trgm_idx"[\s\S]*"dj_name"\s+gin_trgm_ops/i);
  });

  it('migration 0054 drops the unused dj-name trigram indexes from migration 0051', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/DROP INDEX[^;]*"auth_user_dj_name_trgm_idx"/i);
    expect(sql).toMatch(/DROP INDEX[^;]*"auth_user_name_trgm_idx"/i);
    expect(sql).toMatch(/DROP INDEX[^;]*"shows_legacy_dj_name_trgm_idx"/i);
  });

  it('journal includes the 0054 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has54 = journal.entries.some((e: { tag: string }) => e.tag === '0054_flowsheet-search-doc-with-dj-name');
    expect(has54).toBe(true);
  });

  it('migration 0054 applies unconditionally — no precondition guard', () => {
    // Originally 0054 had a precondition block that aborted the migration if
    // any track row still had dj_name IS NULL (i.e. the backfill hadn't run
    // yet). That block was removed in the hotfix that unblocked production
    // after the backfill stalled on the bloated table. Legacy rows with NULL
    // dj_name get an empty dj-name term in the rebuilt search_doc tsvector —
    // search just doesn't match dj-name queries for those rows until the
    // backfill eventually runs and the generated search_doc recomputes. The
    // search service uses COALESCE(flowsheet.dj_name, 'Unknown DJ') for
    // display so users see "Unknown DJ" rather than a NULL or crash. See
    // issue #511.
    //
    // Strip everything that looks like a SQL line comment ('-- …') before
    // matching, so explanatory comments in the migration file (which may
    // mention historical keywords) don't mask the assertion.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    const sqlNoComments = sql.replace(/--[^\n]*/g, '');
    expect(sqlNoComments).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(sqlNoComments).not.toMatch(/DO\s+\$\$/i);
  });
});
