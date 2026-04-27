import * as fs from 'fs';
import * as path from 'path';

describe('schema: flowsheet linkage audit columns (B-1.4)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0062_flowsheet-linkage-audit-columns.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('flowsheet table declares a nullable linkage_source text column', () => {
    const def = extractTableDef('flowsheet');
    expect(def).toMatch(/linkage_source:\s*text\(['"]linkage_source['"]\)/);
    // No `.notNull()` on the column — backfill cannot fill every row.
    expect(def).not.toMatch(/linkage_source:\s*text\(['"]linkage_source['"]\)[^,]*notNull/);
  });

  it('flowsheet table declares a nullable linkage_confidence real column', () => {
    const def = extractTableDef('flowsheet');
    expect(def).toMatch(/linkage_confidence:\s*real\(['"]linkage_confidence['"]\)/);
    expect(def).not.toMatch(/linkage_confidence:\s*real\(['"]linkage_confidence['"]\)[^,]*notNull/);
  });

  it('flowsheet table declares a nullable linked_at timestamptz column', () => {
    const def = extractTableDef('flowsheet');
    expect(def).toMatch(/linked_at:\s*timestamp\(['"]linked_at['"],\s*\{\s*withTimezone:\s*true\s*\}\)/);
    expect(def).not.toMatch(
      /linked_at:\s*timestamp\(['"]linked_at['"],\s*\{\s*withTimezone:\s*true\s*\}\)[^,]*notNull/
    );
  });

  it('migration 0062 exists and adds the three columns', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"linkage_source"\s+text/i);
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"linkage_confidence"\s+real/i);
    expect(sql).toMatch(
      /ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"linked_at"\s+timestamp with time zone/i
    );
  });

  it('migration 0062 is DDL-only — no in-migration backfill', () => {
    // Bulk DML inside a migration holds the AccessExclusiveLock acquired by
    // ALTER TABLE for the duration of the UPDATE, which can wedge the table
    // for hours on a 2M-row flowsheet. The backfill lives in its own
    // one-shot job (jobs/flowsheet-linkage-audit-backfill). See issue #511.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/^\s*UPDATE\s+"wxyc_schema"\."flowsheet"/im);
  });

  it('journal includes the 0062 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has62 = journal.entries.some((e: { tag: string }) => e.tag === '0062_flowsheet-linkage-audit-columns');
    expect(has62).toBe(true);
  });

  it('mock includes linkage_source, linkage_confidence, and linked_at on flowsheet', () => {
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');
    const flowsheetMock = mockSource.match(/export const flowsheet\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(flowsheetMock).toBeDefined();
    expect(flowsheetMock).toContain("linkage_source: 'linkage_source'");
    expect(flowsheetMock).toContain("linkage_confidence: 'linkage_confidence'");
    expect(flowsheetMock).toContain("linked_at: 'linked_at'");
  });
});
