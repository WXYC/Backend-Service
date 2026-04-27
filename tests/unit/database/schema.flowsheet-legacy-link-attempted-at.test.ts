import * as fs from 'fs';
import * as path from 'path';

describe('schema: flowsheet.legacy_link_attempted_at marker (B-0.5)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0063_flowsheet-legacy-link-attempted-at.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('flowsheet table declares a legacy_link_attempted_at column', () => {
    // The column marks rows where the legacy_release_id → library.id FK
    // resolver ran and could not link. B-2.2's LML backfill picks these up
    // alongside the 889K rows that never had a legacy_release_id at all.
    const def = extractTableDef('flowsheet');
    expect(def).toMatch(
      /legacy_link_attempted_at:\s*timestamp\(\s*['"]legacy_link_attempted_at['"][\s\S]*?withTimezone:\s*true/
    );
  });

  it('migration 0063 exists and adds the nullable timestamptz column', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(
      /ALTER TABLE\s+"wxyc_schema"\."flowsheet"\s+ADD COLUMN\s+"legacy_link_attempted_at"\s+timestamp\s+with\s+time\s+zone/i
    );
  });

  it('migration 0063 is DDL-only — no in-migration UPDATE', () => {
    // The marking pass lives in jobs/broken-fk-recovery, run as a one-shot
    // deploy after this DDL ships. Same pattern as 0053+dj-name-backfill.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/^\s*UPDATE\s+"wxyc_schema"\."flowsheet"/im);
  });

  it('journal includes the 0063 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has63 = journal.entries.some((e: { tag: string }) => e.tag === '0063_flowsheet-legacy-link-attempted-at');
    expect(has63).toBe(true);
  });

  it('mock includes legacy_release_id and legacy_link_attempted_at on flowsheet', () => {
    // The recovery job reads legacy_release_id and writes legacy_link_attempted_at;
    // both must be addressable through the mocked schema or a unit test that
    // references them via Drizzle's column proxy will throw.
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');
    const flowsheetMock = mockSource.match(/export const flowsheet\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(flowsheetMock).toBeDefined();
    expect(flowsheetMock).toContain("legacy_release_id: 'legacy_release_id'");
    expect(flowsheetMock).toContain("legacy_link_attempted_at: 'legacy_link_attempted_at'");
  });
});
