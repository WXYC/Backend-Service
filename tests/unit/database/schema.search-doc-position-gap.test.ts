import * as fs from 'fs';
import * as path from 'path';

/**
 * BS#2714 — `library.search_doc` gets a position gap between its two segments.
 *
 * `tsvector || tsvector` shifts the right operand's positions to continue from
 * the left's with NO gap, so the album title's first lexeme sits adjacent to
 * the artist name's last one and a phrase query matches across the field
 * boundary. Measured on the production clone: `'d':* <-> 'a':*` (what
 * `to_tsquery` makes of a `d'a` prefix token) matched 760 of 64,193 rows, 184
 * of them straddling the seam (`Amor Belhom Duo / Amor Belhom Duo`,
 * `It's a Beautiful Day / At Carnegie Hall`).
 *
 * The gap is bought with a sentinel and then removed with `ts_delete`, which
 * deletes a lexeme's entry WITHOUT renumbering the survivors' positions. So
 * the positions shift but no sentinel lexeme lands in the index — which
 * matters because a sentinel left in place would be prefix-reachable, and
 * `'w':*` would then match every row in the catalog.
 *
 * Companion to the migration's own header. This suite is the only oracle for
 * the schema declaration and the migration DDL agreeing: the older
 * `schema.library-artist-name-search-doc.test.ts` asserts the two `setweight`
 * fragments appear *somewhere* in the table def, and both survive the
 * `ts_delete` wrapper, so it would stay green either way.
 *
 * Modelled on `schema.flowsheet-search-doc-with-dj-name.test.ts`, the
 * equivalent per-migration test for migration 0054's `search_doc` rewrite.
 */
describe('schema: library.search_doc position gap (BS#2714)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationTag = '0178_2714-library-search-doc-position-gap';
  const migrationPath = path.join(migrationsDir, `${migrationTag}.sql`);
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const SENTINEL = 'wxycsearchdocgap';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  /**
   * The SQL inside `generatedAlwaysAs(sql`…`)`, and nothing else.
   *
   * Deliberately not the whole matched block: the comment above the column
   * names both source columns and the sentinel, so a positional assertion over
   * the block would compare offsets in prose rather than in the expression.
   */
  const generatedExpression = (tableName: string): string => {
    const def = extractTableDef(tableName);
    const code = def.replace(/^[^\n]*\/\/[^\n]*$/gm, '');
    const match = code.match(/search_doc:\s*tsvector\([^)]*\)\s*\.generatedAlwaysAs\(\s*sql`([\s\S]*?)`\s*\)/);
    if (!match) throw new Error(`search_doc generated expression not found on ${tableName}`);
    return match[1];
  };

  /**
   * The migration's DDL with `--` line comments stripped.
   *
   * The header explains why `SET EXPRESSION AS` is unusable and names the
   * sentinel, so asserting over the raw file would match the prose describing
   * the thing rather than the thing.
   */
  const migrationDdl = (): string => fs.readFileSync(migrationPath, 'utf-8').replace(/--[^\n]*/g, '');

  it('library schema wraps search_doc in ts_delete of the gap sentinel', () => {
    const generated = generatedExpression('library');
    expect(generated).toMatch(/ts_delete\(/i);
    // The sentinel is concatenated between the two weighted segments to buy
    // the position shift, then deleted by name.
    expect(generated).toContain(SENTINEL);
    expect(generated).toMatch(new RegExp(`ts_delete\\([\\s\\S]*'${SENTINEL}'\\s*\\)`, 'i'));
  });

  it('library schema keeps both weight bands either side of the sentinel', () => {
    const generated = generatedExpression('library');
    const artistAt = generated.indexOf('"artist_name"');
    const sentinelAt = generated.indexOf(SENTINEL);
    const albumAt = generated.indexOf('"album_title"');
    expect(artistAt).toBeGreaterThan(-1);
    expect(albumAt).toBeGreaterThan(-1);
    // Order is load-bearing: the sentinel has to sit BETWEEN the segments, or
    // it shifts nothing and the seam stays adjacent.
    expect(sentinelAt).toBeGreaterThan(artistAt);
    expect(albumAt).toBeGreaterThan(sentinelAt);
    expect(generated).toMatch(/'A'/);
    expect(generated).toMatch(/'B'/);
  });

  it('migration 0178 exists and drop-and-re-adds the generated column', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = migrationDdl();
    // Drop+re-add, not `ALTER COLUMN ... SET EXPRESSION AS`: that syntax is
    // PG17+ and prod RDS is 14.22. Verified rejected on 14.24 with
    // `syntax error at or near "EXPRESSION"`.
    expect(sql).not.toMatch(/SET\s+EXPRESSION\s+AS/i);
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."library"\s+DROP COLUMN\s+IF EXISTS\s+"search_doc"/i);
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."library"\s+ADD COLUMN\s+"search_doc"\s+tsvector/i);
    expect(sql).toMatch(/GENERATED ALWAYS AS[\s\S]*STORED/i);
  });

  it('migration 0178 bounds the lock it takes and the rewrite it runs', () => {
    const sql = migrationDdl();
    // The DROP COLUMN takes ACCESS EXCLUSIVE on `library` and `migrate()`
    // wraps every pending migration in ONE transaction, so the lock is held
    // until the whole batch commits. These bound the wait and the rewrite so
    // contention surfaces as a clear error rather than a wedged deploy.
    expect(sql).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=/i);
    expect(sql).toMatch(/SET\s+LOCAL\s+statement_timeout\s*=/i);
  });

  it('migration 0178 recreates the GIN index and re-analyzes the table', () => {
    const sql = migrationDdl();
    // DROP COLUMN takes `library_search_doc_idx` with it, so the index has to
    // be rebuilt in the same migration.
    expect(sql).toMatch(/CREATE INDEX\s+IF NOT EXISTS\s+"library_search_doc_idx"[\s\S]*USING\s+gin/i);
    // A table rewrite discards the column's pg_stats row and bumps no
    // counters, so autoanalyze never repairs it. Without this the catalog
    // search can revert to a sequential scan (the BS#934 shape).
    expect(sql).toMatch(/ANALYZE\s+"wxyc_schema"\."library"/i);
  });

  it('migration 0178 carries the same sentinel the schema declares', () => {
    const sql = migrationDdl();
    expect(sql).toContain(SENTINEL);
    expect(sql).toMatch(/ts_delete\(/i);
  });

  it('journal includes the 0178 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has178 = journal.entries.some((e: { tag: string }) => e.tag === migrationTag);
    expect(has178).toBe(true);
  });

  it('migration 0178 applies unconditionally — no precondition guard', () => {
    // Nothing about the rewrite depends on row state: the expression is total
    // over any (artist_name, album_title) pair, including NULLs, which the
    // coalesce handles.
    const sqlNoComments = migrationDdl();
    expect(sqlNoComments).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(sqlNoComments).not.toMatch(/DO\s+\$\$/i);
  });
});
