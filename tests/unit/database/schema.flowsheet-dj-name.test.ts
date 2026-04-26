import * as fs from 'fs';
import * as path from 'path';

describe('schema: flowsheet.dj_name denormalization (step 5b.1)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0053_flowsheet-dj-name-column.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('flowsheet table declares a dj_name column', () => {
    const def = extractTableDef('flowsheet');
    expect(def).toMatch(/dj_name:\s*text\(['"]dj_name['"]\)/);
  });

  it('migration 0053 exists and adds the column', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"dj_name"\s+text/i);
  });

  it('migration 0053 is DDL-only — no in-migration backfill', () => {
    // The backfill was split out of the migration after the 2026-04 wedge
    // incident: ALTER TABLE acquires AccessExclusiveLock that is held until
    // commit, and a 13-hour UPDATE inside the same txn took the table out of
    // service. Backfill now lives in jobs/backfills/flowsheet-dj-name-backfill
    // and runs as a separate one-shot deploy after this migration ships.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/^\s*UPDATE\s+"wxyc_schema"\."flowsheet"/im);
    expect(sql).not.toMatch(/COALESCE\([^)]*dj_name[^)]*legacy_dj_name[^)]*name/i);
  });

  it('journal includes the 0053 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has53 = journal.entries.some((e: { tag: string }) => e.tag === '0053_flowsheet-dj-name-column');
    expect(has53).toBe(true);
  });

  it('mock includes dj_name on flowsheet', () => {
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');
    const flowsheetMock = mockSource.match(/export const flowsheet\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(flowsheetMock).toBeDefined();
    expect(flowsheetMock).toContain("dj_name: 'dj_name'");
  });
});
