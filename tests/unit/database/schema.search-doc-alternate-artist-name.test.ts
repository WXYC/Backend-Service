import * as fs from 'fs';
import * as path from 'path';

/**
 * BS#3733: `library.search_doc` gets a third segment, `alternate_artist_name`
 * at weight C, behind its own position gap.
 *
 * The station librarian could not find a release by `shapiro` when its
 * alternate artist name was `Kath Bloom & David Shapiro`, because the column
 * indexed only `artist_name` (A) and `album_title` (B). The integration specs
 * (`library-search-alternate-artist-name.spec.js`,
 * `library-search-doc-position-gap.spec.js`) cover the behaviour. This suite
 * is the source-text oracle for the three places the expression is written
 * down agreeing with one another:
 *
 *  - `schema.ts`, which Drizzle reads;
 *  - the latest migration that adds the column, which is what the database
 *    actually holds;
 *  - the latest `meta/*_snapshot.json`, which drizzle-kit diffs `schema.ts`
 *    against. A mismatch there is what makes `drizzle-kit generate` propose a
 *    spurious rewrite.
 *
 * The comparisons find "the latest" from the journal rather than naming 0208,
 * so a later migration that redefines the column (BS#871 plans to add
 * `label`) keeps them meaningful instead of breaking them.
 */
describe('schema: library.search_doc indexes alternate_artist_name (BS#3733)', () => {
  const root = path.resolve(__dirname, '../../..');
  const schemaSource = fs.readFileSync(path.join(root, 'shared/database/src/schema.ts'), 'utf-8');
  const migrationsDir = path.join(root, 'shared/database/src/migrations');
  const journal: { entries: Array<{ idx: number; tag: string }> } = JSON.parse(
    fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8')
  );

  const MIGRATION_TAG = '0208_3733-library-search-doc-alternate-artist-name';
  const SENTINEL = 'wxycsearchdocgap';
  const GAP = `to_tsvector('simple', '${SENTINEL} ${SENTINEL} ${SENTINEL}')`;

  /** Migration SQL with `--` comments stripped, so prose cannot satisfy an assertion. */
  const ddl = (tag: string): string =>
    fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf-8').replace(/--[^\n]*/g, '');

  /** Collapse formatting so a multi-line migration compares with a one-line schema literal. */
  const normalize = (expr: string): string =>
    expr.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

  /** The SQL inside library's `search_doc: tsvector(...).generatedAlwaysAs(sql`…`)`. */
  const schemaExpression = (): string => {
    const def = schemaSource.match(/export const library\b[\s\S]*?^\);/m)?.[0];
    if (!def) {
      throw new Error('library table definition not found in schema.ts');
    }
    const code = def.replace(/^[^\n]*\/\/[^\n]*$/gm, '');
    const expr = code.match(/search_doc:\s*tsvector\([^)]*\)\s*\.generatedAlwaysAs\(\s*sql`([\s\S]*?)`\s*\)/)?.[1];
    if (!expr) {
      throw new Error('library.search_doc generated expression not found in schema.ts');
    }
    return expr;
  };

  const ADD_COLUMN =
    /ALTER TABLE\s+"wxyc_schema"\."library"\s+ADD COLUMN\s+"search_doc"\s+tsvector\s+GENERATED ALWAYS AS\s*\(([\s\S]*)\)\s*STORED/i;

  /** The newest migration, by journal order, that adds `library.search_doc`. */
  const latestDefiningMigration = (): { tag: string; expression: string } => {
    for (const { tag } of [...journal.entries].reverse()) {
      const match = ddl(tag).match(ADD_COLUMN);
      if (match) {
        return { tag, expression: match[1] };
      }
    }
    throw new Error('no migration adds library.search_doc');
  };

  it('schema.ts indexes artist (A), title (B) and alternate name (C), in that order, with a gap before each later segment', () => {
    const expr = schemaExpression();
    const segments = [...expr.matchAll(/setweight\(to_tsvector\('simple', coalesce\("(\w+)", ''\)\), '(\w)'\)/g)].map(
      (m) => [m[1], m[2]]
    );
    expect(segments).toEqual([
      ['artist_name', 'A'],
      ['album_title', 'B'],
      ['alternate_artist_name', 'C'],
    ]);
    // Exactly one gap between each pair of segments, and ts_delete strips the
    // sentinel so it never reaches the GIN index.
    const parts = expr.split(' || ');
    expect(parts.map((part) => part.includes(GAP))).toEqual([false, true, false, true, false]);
    expect(expr).toMatch(new RegExp(`^ts_delete\\([\\s\\S]*, '${SENTINEL}'\\)$`));
  });

  it(`the latest migration that defines the column is ${MIGRATION_TAG}, and its expression matches schema.ts`, () => {
    const { tag, expression } = latestDefiningMigration();
    expect(tag).toBe(MIGRATION_TAG);
    expect(normalize(expression)).toBe(normalize(schemaExpression()));
  });

  it('the latest snapshot carries the schema.ts expression byte for byte, so drizzle-kit sees no drift', () => {
    const last = journal.entries[journal.entries.length - 1];
    const snapshotPath = path.join(migrationsDir, `meta/${String(last.idx).padStart(4, '0')}_snapshot.json`);
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    const column = snapshot.tables['wxyc_schema.library'].columns.search_doc;
    expect(column.generated).toEqual({ as: schemaExpression(), type: 'stored' });
  });

  it.each([
    ['bounds the lock wait', /SET\s+LOCAL\s+lock_timeout\s*=/i],
    ['bounds the rewrite', /SET\s+LOCAL\s+statement_timeout\s*=/i],
    [
      'drops the column idempotently',
      /ALTER TABLE\s+"wxyc_schema"\."library"\s+DROP COLUMN\s+IF EXISTS\s+"search_doc"/i,
    ],
    ['re-adds it as a STORED generated column', ADD_COLUMN],
    [
      'rebuilds the GIN index the DROP took with it',
      /CREATE INDEX\s+IF NOT EXISTS\s+"library_search_doc_idx"[\s\S]*USING\s+gin/i,
    ],
    ['re-analyzes the table after the rewrite', /ANALYZE\s+"wxyc_schema"\."library"/i],
  ])(`${MIGRATION_TAG} %s`, (_what, pattern) => {
    expect(ddl(MIGRATION_TAG)).toMatch(pattern);
  });

  it(`${MIGRATION_TAG} avoids PG17+ syntax and needs no precondition guard`, () => {
    const sql = ddl(MIGRATION_TAG);
    // Prod RDS is PG 14, which rejects `SET EXPRESSION AS`.
    expect(sql).not.toMatch(/SET\s+EXPRESSION\s+AS/i);
    // The expression is total over any row, NULLs included (coalesce).
    expect(sql).not.toMatch(/RAISE\s+EXCEPTION/i);
  });
});
