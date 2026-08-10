/**
 * Schema-source assertions for the two expression indexes that make the
 * `rotation_bin` fallback in `FSEntryFieldsRaw` indexable (BS#2080).
 *
 * These indexes are unusually fragile. An expression index only serves a query
 * whose expression is written **character-for-character** the same way, and
 * both sides here are hand-written SQL: the index expression lives in
 * `schema.ts` / the migration, and the predicate lives inside a raw
 * `` sql`...` `` template in `flowsheet.service.ts`. A purely cosmetic edit to
 * either — `btrim` for `trim`, dropping the vestigial `coalesce` on a NOT NULL
 * column, reordering the composite — leaves every behavioural test green while
 * silently reverting the planner to the 21,563-row seq scan of `rotation` that
 * made `GET /flowsheet/range` answer 500 on a 7-day window.
 *
 * `tests/integration/flowsheet-rotation-bin-fallback.spec.js` cannot catch
 * that: it asserts badge semantics, which are identical either way. This file
 * is the plan-shape guard, in the style of the other
 * `tests/unit/database/schema.*-idx.test.ts` files.
 */

import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');
const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
const servicePath = path.resolve(__dirname, '../../../apps/backend/services/flowsheet.service.ts');

// Resolve the migration filename from the journal so the test stays correct if
// the idx number shifts during a rebase against main.
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
const journalEntry = journal.entries.find((e: { tag: string }) => /rotation-bin-fallback-indexes/i.test(e.tag));
if (!journalEntry) {
  throw new Error(
    'No journal entry matches /rotation-bin-fallback-indexes/. Did `npm run drizzle:generate` run after schema.ts was edited?'
  );
}
const migrationPath = path.join(migrationsDir, `${journalEntry.tag}.sql`);
const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
const schemaSrc = fs.readFileSync(schemaPath, 'utf-8');
const serviceSrc = fs.readFileSync(servicePath, 'utf-8');

/**
 * The migration with `--` comment lines stripped. The header deliberately
 * quotes the `CREATE INDEX CONCURRENTLY ...` runbook for ops, so any assertion
 * about what actually EXECUTES has to look here, not at the whole file.
 */
const executableSql = migrationSql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

/** The `rotation_bin` raw-SQL template, isolated from the rest of the file. */
const rotationBinSql = (() => {
  const start = serviceSrc.indexOf('rotation_bin: sql<string | null>`');
  expect(start).toBeGreaterThan(-1);
  const end = serviceSrc.indexOf('`,', start);
  expect(end).toBeGreaterThan(start);
  return serviceSrc.slice(start, end);
})();

describe('schema: rotation_bin fallback expression indexes (BS#2080)', () => {
  it('migration exists at the journal-pointed path', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it.each([
    [
      'rotation_norm_artist_album_idx',
      'rotation',
      /CREATE INDEX\s+IF NOT EXISTS\s+"rotation_norm_artist_album_idx"\s+ON\s+"wxyc_schema"\."rotation"\s+USING\s+btree\s+\(\s*lower\(trim\(coalesce\("artist_name",\s*''\)\)\)\s*,\s*lower\(trim\(coalesce\("album_title",\s*''\)\)\)\s*\)/i,
    ],
    [
      'library_norm_album_title_idx',
      'library',
      /CREATE INDEX\s+IF NOT EXISTS\s+"library_norm_album_title_idx"\s+ON\s+"wxyc_schema"\."library"\s+USING\s+btree\s+\(\s*lower\(trim\(coalesce\("album_title",\s*''\)\)\)\s*\)/i,
    ],
  ])('migration creates %s on %s with the exact expression', (_name, _table, pattern) => {
    expect(executableSql).toMatch(pattern);
  });

  it('the executed DDL is NOT the CONCURRENTLY form (Drizzle wraps each file in a transaction)', () => {
    expect(executableSql).not.toMatch(/CREATE INDEX\s+CONCURRENTLY/i);
    // ...while the header still hands ops the CONCURRENTLY form to pre-build.
    expect(migrationSql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  });

  it('the CONCURRENTLY runbook in the header matches the DDL it tells ops to pre-build', () => {
    // A runbook that drifts from the DDL is worse than none: ops builds an
    // index the query cannot use, the IF NOT EXISTS migration no-ops, and the
    // rewrite ships un-indexed.
    for (const name of ['rotation_norm_artist_album_idx', 'library_norm_album_title_idx']) {
      const ddl = executableSql.match(new RegExp(`^CREATE INDEX IF NOT EXISTS "${name}".*$`, 'm'));
      if (ddl === null) throw new Error(`no executable CREATE INDEX for ${name}`);
      const body = ddl[0].replace(/^CREATE INDEX IF NOT EXISTS /, '').replace(/;.*$/, '');
      expect(migrationSql).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${body}`);
    }
  });

  it.each([['rotation_norm_artist_album_idx'], ['library_norm_album_title_idx']])(
    '%s is declared in schema.ts so drizzle-kit detects drift',
    (name) => {
      expect(schemaSrc).toContain(`index('${name}')`);
    }
  );

  it('does NOT add a fourth artist-name index (measured slower; near-name collision)', () => {
    // `artists_norm_name_idx` was measured at 8.88ms vs 7.02ms without it —
    // the planner reaches `artists` already holding l2.artist_id and probes
    // artists_pkey. It would also sit one character class from
    // `artists_normalized_name_idx` (0092) and `artists_fold_name_idx` (0134).
    expect(executableSql).not.toContain('artists_norm_name_idx');
    expect(schemaSrc).not.toContain("index('artists_norm_name_idx')");
  });

  describe('query ↔ index expression identity', () => {
    it.each([
      ["arm 2's rotation artist", "lower(trim(coalesce(r2.artist_name, '')))"],
      ["arm 2's rotation album", "lower(trim(coalesce(r2.album_title, '')))"],
      ["arm 3's library album", "lower(trim(coalesce(l2.album_title, '')))"],
    ])('the fallback subquery still spells %s exactly as the index does', (_label, expr) => {
      expect(rotationBinSql).toContain(expr);
    });

    it('every indexed expression appears verbatim in the subquery', () => {
      // Normalize the migration's quoted-identifier form ("artist_name") to the
      // query's aliased form (r2.artist_name / l2.album_title) and require each
      // to be present. This is the assertion that fails when someone "cleans
      // up" one side alone.
      const indexed = [...executableSql.matchAll(/lower\(trim\(coalesce\("(\w+)",\s*''\)\)\)/g)].map((m) => m[1]);
      expect(indexed.length).toBeGreaterThanOrEqual(3);
      for (const column of new Set(indexed)) {
        expect(rotationBinSql).toMatch(new RegExp(`lower\\(trim\\(coalesce\\([lr]2\\.${column}, ''\\)\\)\\)`));
      }
    });

    it('the arms stay a UNION ALL, not an OR the indexes cannot serve', () => {
      // Two UNION ALLs = three arms. Collapsing them back into an OR is the
      // exact regression this migration exists to undo.
      expect(rotationBinSql.match(/UNION ALL/g)).toHaveLength(2);
    });
  });

  it('the outer guard is untrimmed — it gates all three arms, not just arm 3', () => {
    // Tightening this to `trim(coalesce(...)) <> ''` drops legitimate arm-1
    // badges: arm 1 matches on album_id and never reads the text, so an entry
    // with a real artist, a blank album title and a populated album_id loses
    // its badge. Verified against the clone (album_id 36962: 'M' -> none).
    expect(rotationBinSql).toMatch(/coalesce\(.*artist_name.*, ''\) <> ''/);
    expect(rotationBinSql).not.toMatch(/trim\(coalesce\(.*artist_name.*, ''\)\) <> ''/);
  });
});
