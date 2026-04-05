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

  it('flowsheet table should have legacy_entry_id column', () => {
    const def = extractTableDef('flowsheet');
    expect(def).toContain('legacy_entry_id');
  });

  it('shows table should have legacy_show_id column', () => {
    const def = extractTableDef('shows');
    expect(def).toContain('legacy_show_id');
  });
});
