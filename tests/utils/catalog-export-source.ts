/**
 * Source-text helpers shared by the tests that read `catalog-export.service.ts` and the
 * migrations as text (the unit suite cannot execute either against a real database):
 * comment stripping, the interpolated-column scrape, and the latest-trigger parse.
 */

import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const migrationsDir = path.join(repoRoot, 'shared/database/src/migrations');

export const exportSource = fs.readFileSync(
  path.join(repoRoot, 'apps/backend/services/catalog-export.service.ts'),
  'utf-8'
);
const schemaSource = fs.readFileSync(path.join(repoRoot, 'shared/database/src/schema.ts'), 'utf-8');
const journal = JSON.parse(fs.readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf-8')) as {
  entries: { tag: string }[];
};

/**
 * Drop `--` line comments so greps assert on the SQL that actually executes, not on prose about it.
 */
export function stripSqlComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** Drizzle property name -> SQL column name for one schema.ts table or materialized view (`prop: type('col'`). */
function schemaColumnNames(table: string): Map<string, string> | undefined {
  const m = new RegExp(`export const ${table} = wxyc_schema\\s*\\.(?:table|materializedView)\\(`).exec(schemaSource);
  if (!m) return undefined;
  const end = schemaSource.indexOf('\nexport const ', m.index + 1);
  const block = schemaSource.slice(m.index, end === -1 ? undefined : end);
  const map = new Map<string, string>();
  for (const c of block.matchAll(/^\s+(\w+): \w+\(\s*'(\w+)'/gm)) map.set(c[1], c[2]);
  return map;
}

/**
 * SQL column names the export reads, per schema table: every `${<table>.<prop>}` interpolation, plus the
 * `library.<prop>` arguments handed to `logicalAlbumKeySql(...)`. Interpolations whose prefix is not a
 * schema table are not column reads and are skipped; a `<table>.<prop>` that is not in schema.ts throws.
 */
export function exportedColumnsByTable(): Map<string, string[]> {
  const props = new Map<string, Set<string>>();
  const add = (table: string, prop: string) => {
    if (!props.has(table)) props.set(table, new Set());
    props.get(table).add(prop);
  };
  for (const m of exportSource.matchAll(/\$\{(\w+)\.(\w+)\}/g)) add(m[1], m[2]);
  for (const call of exportSource.matchAll(/logicalAlbumKeySql\(([^)]*)\)/g)) {
    for (const m of call[1].matchAll(/\blibrary\.(\w+)/g)) add('library', m[1]);
  }
  const result = new Map<string, string[]>();
  for (const [table, set] of props) {
    const names = schemaColumnNames(table);
    if (!names) continue;
    result.set(
      table,
      [...set]
        .map((prop) => {
          const col = names.get(prop);
          if (!col) throw new Error(`${table}.${prop} is read by the export but is not a column in schema.ts`);
          return col;
        })
        .sort()
    );
  }
  return result;
}

export interface WatermarkTrigger {
  tag: string;
  name: string;
  /** The `UPDATE OF` list, or null when the trigger fires on any update. */
  columns: string[] | null;
}

const CREATE_TRIGGER_RE = /CREATE\s+TRIGGER\s+"?(touch_library_watermark\w*)"?(?![\w"])/i;
const DROP_TRIGGER_RE =
  /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(touch_library_watermark\w*)"?\s+ON\s+(?:"?wxyc_schema"?\s*\.\s*)?"?(\w+)"?/i;
const ON_TABLE_RE = /\sON\s+(?:"?wxyc_schema"?\s*\.\s*)?"?(\w+)"?(?![\w"])/i;
const UPDATE_OF_RE = /\bUPDATE\s+OF\s+([\s\S]*?)\s+OR\s+(?:DELETE|TRUNCATE)\b/i;

/**
 * The latest (journal order) `touch_library_watermark*` trigger on each table. Older definitions need not be
 * parseable; a later DROP with no re-create removes the table's entry. A latest definition whose `UPDATE OF`
 * list is present but empty throws rather than falling back to an older migration.
 */
export function latestWatermarkTriggers(): Map<string, WatermarkTrigger> {
  const latest = new Map<string, WatermarkTrigger>();
  for (const { tag } of journal.entries) {
    const sql = stripSqlComments(fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf-8'));
    for (const stmt of sql.split(';')) {
      const drop = DROP_TRIGGER_RE.exec(stmt);
      if (drop) {
        if (latest.get(drop[2])?.name === drop[1]) latest.delete(drop[2]);
        continue;
      }
      const create = CREATE_TRIGGER_RE.exec(stmt);
      const table = create && ON_TABLE_RE.exec(stmt)?.[1];
      if (!create || !table) continue;
      const list = UPDATE_OF_RE.exec(stmt);
      const columns = list
        ? list[1]
            .split(',')
            .map((c) => c.trim().replace(/^"|"$/g, ''))
            .filter(Boolean)
        : null;
      if (columns && columns.length === 0) throw new Error(`${tag}: ${create[1]} has an empty UPDATE OF list`);
      latest.set(table, { tag, name: create[1], columns });
    }
  }
  return latest;
}
