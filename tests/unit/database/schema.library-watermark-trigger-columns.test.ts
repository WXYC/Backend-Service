/**
 * Pins the `UPDATE OF` column list of the `touch_library_watermark` trigger on
 * `wxyc_schema.library` to the columns the catalog export actually reads.
 *
 * Migration 0142's OBLIGATION block: any `library` column the export starts reading
 * MUST be added to the trigger's `UPDATE OF` list in the same PR, or a write that
 * touches only that column never advances `library_watermark` and GET /library/catalog
 * serves a stale body / 304.
 *
 * Both sides are DERIVED from source text, so neither can drift silently:
 *   - the expected set is every `${library.<prop>}` token in
 *     `apps/backend/services/catalog-export.service.ts` (the export queries) plus the
 *     `library.<prop>` arguments handed to `logicalAlbumKeySql(...)`, mapped from Drizzle
 *     property names to SQL column names via the `library` table in
 *     `shared/database/src/schema.ts`;
 *   - the actual set is the `UPDATE OF` list of the LATEST migration (journal order)
 *     whose `CREATE TRIGGER touch_library_watermark ... ON wxyc_schema.library` statement
 *     (any identifier quoting or whitespace) defines it. If that latest definition cannot
 *     be parsed the test throws rather than falling back to an older migration.
 *
 * The two sets must be EQUAL: a missing column is a stale-cache bug; an extra one is a
 * trigger firing on columns the export never reads (0142 narrowed it deliberately).
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../../..');
const migrationsDir = path.join(repoRoot, 'shared/database/src/migrations');
const exportSource = fs.readFileSync(path.join(repoRoot, 'apps/backend/services/catalog-export.service.ts'), 'utf-8');
const schemaSource = fs.readFileSync(path.join(repoRoot, 'shared/database/src/schema.ts'), 'utf-8');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8')) as {
  entries: { tag: string }[];
};

const stripSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');

/** Drizzle property name -> SQL column name for the `library` table (`prop: type('col'`). */
function libraryColumnNames(): Map<string, string> {
  const start = schemaSource.indexOf("export const library = wxyc_schema.table(\n  'library',");
  if (start === -1) throw new Error('Could not find the library table in schema.ts');
  const end = schemaSource.indexOf('\nexport const ', start + 1);
  const block = schemaSource.slice(start, end === -1 ? undefined : end);
  const map = new Map<string, string>();
  for (const m of block.matchAll(/^ {4}(\w+): \w+\(\s*'(\w+)'/gm)) map.set(m[1], m[2]);
  return map;
}

/** SQL column names of `library` the export queries read (interpolated refs + logicalAlbumKeySql args). */
function exportedLibraryColumns(): string[] {
  const props = new Set<string>();
  for (const m of exportSource.matchAll(/\$\{library\.(\w+)\}/g)) props.add(m[1]);
  const calls = [...exportSource.matchAll(/logicalAlbumKeySql\(([^)]*)\)/g)];
  for (const call of calls) for (const m of call[1].matchAll(/\blibrary\.(\w+)/g)) props.add(m[1]);
  const names = libraryColumnNames();
  return [...props]
    .map((prop) => {
      const col = names.get(prop);
      if (!col) throw new Error(`library.${prop} is read by the export but is not a column in schema.ts`);
      return col;
    })
    .sort();
}

const TRIGGER_NAME_RE = /CREATE\s+TRIGGER\s+"?touch_library_watermark"?(?![\w"])/i;
const ON_LIBRARY_RE = /\sON\s+(?:"?wxyc_schema"?\s*\.\s*)?"?library"?(?![\w"])/i;
const UPDATE_OF_RE = /\bUPDATE\s+OF\s+([\s\S]*?)\s+OR\s+(?:DELETE|TRUNCATE)\b/i;

/** The `UPDATE OF` list of the latest migration (journal order) that defines the library trigger. */
function latestLibraryTriggerColumns(): { tag: string; columns: string[] } {
  // Older definitions (e.g. 0104's unrestricted trigger) need not be parseable; only the latest counts.
  let latest: { tag: string; stmt: string } | undefined;
  for (const { tag } of journal.entries) {
    const sql = stripSqlComments(fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf-8'));
    for (const stmt of sql.split(';')) {
      if (TRIGGER_NAME_RE.test(stmt) && ON_LIBRARY_RE.test(stmt)) latest = { tag, stmt };
    }
  }
  if (!latest) throw new Error('No migration creates the touch_library_watermark trigger on wxyc_schema.library');
  const list = latest.stmt.match(UPDATE_OF_RE);
  if (!list) {
    throw new Error(`${latest.tag} defines touch_library_watermark on library but its UPDATE OF list cannot be parsed`);
  }
  const columns = list[1]
    .split(',')
    .map((c) => c.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (columns.length === 0) throw new Error(`${latest.tag}: touch_library_watermark has an empty UPDATE OF list`);
  return { tag: latest.tag, columns };
}

describe('touch_library_watermark UPDATE OF list equals the catalog export read set', () => {
  const expected = exportedLibraryColumns();
  const { tag, columns } = latestLibraryTriggerColumns();

  it('derives a non-trivial export read set that includes code_volume_letters', () => {
    expect(expected.length).toBeGreaterThanOrEqual(15);
    expect(expected).toContain('code_volume_letters');
  });

  it('lists no duplicate columns', () => {
    expect(new Set(columns).size).toBe(columns.length);
  });

  it.each(expected.map((column) => [column]))('includes %s', (column) => {
    expect(columns).toContain(column);
  });

  it('lists no column the export never reads', () => {
    expect(columns.filter((c) => !expected.includes(c))).toEqual([]);
  });

  it(`matches exactly (latest definition: ${tag})`, () => {
    expect([...columns].sort()).toEqual(expected);
  });
});
