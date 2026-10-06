/**
 * Source-text helpers shared by the tests that read `catalog-export.service.ts` and the
 * migrations as text (the unit suite cannot execute either against a real database):
 * comment stripping, the interpolated-column scrape, and the latest-trigger parse.
 *
 * Known limitations (documented, not modeled): the export scrape reads only `${<table>.<prop>}` interpolations
 * and `logicalAlbumKeySql(...)` arguments, so a column reached through some other helper call is invisible to
 * it; and a migration that renames a column or table is not tracked, so a trigger or export column that
 * survives a rename under its old name is compared by that old name.
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
 * Drop `--` line comments and block comments so greps assert on the SQL that actually executes, not on prose
 * about it. One left-to-right pass, so a `--` inside a block comment (or a block opener inside a line comment)
 * cannot desynchronize the two.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('/*') ? ' ' : ''));
}

/** Drizzle property name -> SQL column name for one schema.ts table or materialized view (`prop: type('col'`). */
function schemaColumnNames(table: string, schema: string): Map<string, string> | undefined {
  const m = new RegExp(`export const ${table} = wxyc_schema\\s*\\.(?:table|materializedView)\\(`).exec(schema);
  if (!m) {
    // A relation the scrape cannot map must not be skipped: it would dodge both the trigger check and the
    // trigger-less allowlist. Add a base-table read, or extend the parser, instead.
    if (new RegExp(`export const ${table} = (?:wxyc_schema\\s*\\.\\s*view|pgTable)\\(`).test(schema)) {
      throw new Error(
        `${table} is a view or pgTable relation read by the export; it is not a wxyc_schema table or materialized view, so its watermark coverage cannot be derived. Read the base table instead.`
      );
    }
    return undefined;
  }
  const end = schema.indexOf('\nexport const ', m.index + 1);
  const block = schema.slice(m.index, end === -1 ? undefined : end);
  const map = new Map<string, string>();
  for (const c of block.matchAll(/^\s+(\w+): \w+\(\s*'(\w+)'/gm)) map.set(c[1], c[2]);
  return map;
}

/**
 * SQL column names the export reads, per schema table: every `${<table>.<prop>}` interpolation, plus the
 * `library.<prop>` arguments handed to `logicalAlbumKeySql(...)`. Interpolations whose prefix is not a
 * schema relation are not column reads and are skipped; one that is a view or `pgTable` relation throws; a `<table>.<prop>` that is not in schema.ts throws.
 */
export function exportedColumnsByTable(source = exportSource, schema = schemaSource): Map<string, string[]> {
  const props = new Map<string, Set<string>>();
  const add = (table: string, prop: string) => {
    if (!props.has(table)) props.set(table, new Set());
    props.get(table).add(prop);
  };
  for (const m of source.matchAll(/\$\{(\w+)\.(\w+)\}/g)) add(m[1], m[2]);
  for (const call of source.matchAll(/logicalAlbumKeySql\(([^)]*)\)/g)) {
    for (const m of call[1].matchAll(/\blibrary\.(\w+)/g)) add('library', m[1]);
  }
  const result = new Map<string, string[]>();
  for (const [table, set] of props) {
    const names = schemaColumnNames(table, schema);
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
  /** The `UPDATE OF` list; null when the trigger fires on any update; empty when it has no UPDATE event. */
  columns: string[] | null;
}

const CREATE_TRIGGER_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"?(touch_library_watermark\w*)"?(?![\w"])/i;
const DROP_TRIGGER_RE =
  /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(touch_library_watermark\w*)"?\s+ON\s+(?:"?wxyc_schema"?\s*\.\s*)?"?(\w+)"?/i;
const ON_TABLE_RE = /\sON\s+(?:"?wxyc_schema"?\s*\.\s*)?"?(\w+)"?(?![\w"])/i;
const EVENTS_RE = /\b(?:AFTER|BEFORE|INSTEAD\s+OF)\s+([\s\S]*?)\s+ON\s+/i;
const ALTER_TRIGGER_RE =
  /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?wxyc_schema"?\s*\.\s*)?"?(\w+)"?\s+(DISABLE|ENABLE(?:\s+(?:ALWAYS|REPLICA))?)\s+TRIGGER\s+(?:"?(touch_library_watermark\w*)"?(?![\w"])|(ALL|USER)(?![\w"]))/i;
const WHEN_RE = /\bWHEN\s*\(/i;

/**
 * Positive parse of a trigger's event clause (`INSERT OR UPDATE OF a, b OR DELETE`): null for an unrestricted
 * UPDATE, the column list for `UPDATE OF`, an empty list when there is no UPDATE event. Anything else throws,
 * so an unrecognized shape can never be read as "unrestricted".
 */
function parseUpdateColumns(tag: string, name: string, events: string): string[] | null {
  let columns: string[] | undefined;
  for (const raw of events.split(/\s+OR\s+/i)) {
    const event = raw.trim();
    if (/^(?:INSERT|DELETE|TRUNCATE)$/i.test(event)) continue;
    if (/^UPDATE$/i.test(event)) return null;
    const of = /^UPDATE\s+OF\s+([\s\S]*)$/i.exec(event);
    if (!of) throw new Error(`${tag}: ${name} has an unrecognized trigger event "${event}"`);
    const list = of[1]
      .split(',')
      .map((c) => c.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    if (list.length === 0) throw new Error(`${tag}: ${name} has an empty UPDATE OF list`);
    columns = [...(columns ?? []), ...list];
  }
  return columns ?? [];
}

/**
 * Narrow a parsed UPDATE column set by the trigger's `WHEN (...)` clause, failing closed: the trigger then
 * covers only the columns the condition references through `NEW.<col>` / `OLD.<col>`, intersected with any
 * `UPDATE OF` list. A condition that cannot be reduced to column references (no references, or a bare `NEW`
 * / `OLD` row, `NEW.*`) throws rather than being guessed at.
 */
function narrowByWhen(tag: string, name: string, stmt: string, columns: string[] | null): string[] | null {
  const m = WHEN_RE.exec(stmt);
  if (!m) return columns;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < stmt.length && depth > 0; i++) {
    if (stmt[i] === '(') depth++;
    else if (stmt[i] === ')') depth--;
  }
  if (depth !== 0) throw new Error(`${tag}: ${name} has an unbalanced WHEN clause`);
  const cond = stmt.slice(start, i - 1);
  const refs = [...cond.matchAll(/\b(?:NEW|OLD)\s*\.\s*"?(\w+)"?/gi)].map((r) => r[1]);
  if (refs.length === 0 || /\b(?:NEW|OLD)\b(?!\s*\.\s*"?\w)/i.test(cond)) {
    throw new Error(`${tag}: ${name} has a WHEN clause that cannot be reduced to column references: (${cond.trim()})`);
  }
  if (columns !== null && columns.length === 0) return columns;
  const referenced = [...new Set(refs)];
  return columns === null ? referenced : columns.filter((c) => referenced.includes(c));
}

/**
 * The latest (journal order) `touch_library_watermark*` trigger on each table. Older definitions need not be
 * parseable; a later DROP with no re-create, or a later DISABLE TRIGGER with no re-enable, removes the table's entry. A latest
 * definition whose event clause is not positively recognized throws rather than being read as unrestricted.
 */
export function latestWatermarkTriggers(): Map<string, WatermarkTrigger> {
  return parseWatermarkTriggers(
    journal.entries.map(({ tag }) => ({ tag, sql: fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf-8') }))
  );
}

/** The parse behind `latestWatermarkTriggers`, over migrations given in journal order. */
export function parseWatermarkTriggers(migrations: { tag: string; sql: string }[]): Map<string, WatermarkTrigger> {
  const latest = new Map<string, WatermarkTrigger>();
  const disabled = new Set<string>();
  for (const { tag, sql: rawSql } of migrations) {
    const sql = stripSqlComments(rawSql);
    for (const stmt of sql.split(';')) {
      const alter = ALTER_TRIGGER_RE.exec(stmt);
      if (alter) {
        const [, table, action, name, scope] = alter;
        // ENABLE REPLICA fires only under session_replication_role = replica, i.e. not for normal sessions.
        const inert = /^DISABLE|REPLICA/i.test(action);
        // ALL / USER address every trigger on the table, tracked under the `*` wildcard.
        const key = `${table}/${name ?? '*'}`;
        if (inert) disabled.add(key);
        else {
          disabled.delete(key);
          if (scope) for (const k of [...disabled]) if (k.startsWith(`${table}/`)) disabled.delete(k);
        }
        continue;
      }
      const drop = DROP_TRIGGER_RE.exec(stmt);
      if (drop) {
        if (latest.get(drop[2])?.name === drop[1]) latest.delete(drop[2]);
        disabled.delete(`${drop[2]}/${drop[1]}`);
        continue;
      }
      const create = CREATE_TRIGGER_RE.exec(stmt);
      const table = create && ON_TABLE_RE.exec(stmt)?.[1];
      const events = EVENTS_RE.exec(stmt)?.[1];
      if (!create || !table) continue;
      if (events === undefined) throw new Error(`${tag}: ${create[1]} has no parseable event clause`);
      // CREATE [OR REPLACE] TRIGGER yields a fresh, enabled trigger.
      disabled.delete(`${table}/${create[1]}`);
      disabled.delete(`${table}/*`);
      const columns = narrowByWhen(tag, create[1], stmt, parseUpdateColumns(tag, create[1], events));
      latest.set(table, { tag, name: create[1], columns });
    }
  }
  for (const key of disabled) {
    const [table, name] = key.split('/');
    if (name === '*' || latest.get(table)?.name === name) latest.delete(table);
  }
  return latest;
}
