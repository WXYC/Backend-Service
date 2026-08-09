import * as fs from 'fs';
import * as path from 'path';

describe('schema: legacy ID columns for ETL deduplication', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('library table should have legacy_release_id column', () => {
    const def = extractTableDef('library');
    expect(def).toContain('legacy_release_id');
  });

  // Slice one column's declaration out of a table body, so an assertion about
  // this column can't be satisfied by a chained call on a later one.
  const extractColumnDef = (tableDef: string, columnName: string): string => {
    const start = tableDef.indexOf(`${columnName}: `);
    if (start === -1) throw new Error(`Column ${columnName} not found in table definition`);
    const rest = tableDef.slice(start);
    // A declaration runs until the next one at the same (4-space) indentation.
    const next = rest.slice(1).search(/\n {4}\w+: /);
    return next === -1 ? rest : rest.slice(0, next + 1);
  };

  // Pins the two facts the surrounding comments assert (BS#1963 / migration
  // 0137). Without this, relaxing the column leaves the prose stale and CI
  // green — the drift #2028 was filed to repair.
  it('library.legacy_release_id should be NOT NULL with a nextval default off the mint sequence', () => {
    const col = extractColumnDef(extractTableDef('library'), 'legacy_release_id');
    expect(col).toContain('.notNull()');
    expect(col).toContain(`nextval('"wxyc_schema"."library_legacy_release_id_seq"'::regclass)`);
  });

  it('flowsheet table should have legacy_entry_id column', () => {
    const def = extractTableDef('flowsheet');
    expect(def).toContain('legacy_entry_id');
  });

  it('shows table should have legacy_show_id column', () => {
    const def = extractTableDef('shows');
    expect(def).toContain('legacy_show_id');
  });
});
