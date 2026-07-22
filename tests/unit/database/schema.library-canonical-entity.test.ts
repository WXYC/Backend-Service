import * as fs from 'fs';
import * as path from 'path';

describe('schema: library canonical_entity_id columns + index (B-1.1)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0061_library-canonical-entity.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('library table declares a nullable canonical_entity_id text column', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/canonical_entity_id:\s*text\(['"]canonical_entity_id['"]\)/);
    // Nullable — populated by B-1.2 backfill and B-1.3 live writes.
    expect(def).not.toMatch(/canonical_entity_id:\s*text\([^)]*\)\.notNull\(\)/);
  });

  it('library table declares a nullable canonical_entity_confidence real column', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/canonical_entity_confidence:\s*real\(['"]canonical_entity_confidence['"]\)/);
    expect(def).not.toMatch(/canonical_entity_confidence:\s*real\([^)]*\)\.notNull\(\)/);
  });

  it('library table declares a nullable canonical_entity_resolved_at timestamptz column', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(
      /canonical_entity_resolved_at:\s*timestamp\(\s*['"]canonical_entity_resolved_at['"][\s\S]*?withTimezone:\s*true/
    );
    // Bound to the column's own declaration line — an unbounded `[\s\S]*?`
    // would lazily reach the next `.notNull()` column further down the table.
    expect(def).not.toMatch(/canonical_entity_resolved_at:[^\n]*\.notNull\(\)/);
  });

  it('library table declares a B-tree index on canonical_entity_id', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/library_canonical_entity_id_idx[\s\S]*?canonical_entity_id/);
    // No `using('gin', ...)` for this index — it's a default B-tree.
    const idxBlock = def.match(/library_canonical_entity_id_idx[\s\S]{0,200}/)?.[0] ?? '';
    expect(idxBlock).not.toMatch(/using\(\s*['"]gin['"]/);
  });

  it('migration 0061 exists and adds the three canonical_entity columns', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."library"\s+ADD COLUMN\s+"canonical_entity_id"\s+text/i);
    expect(sql).toMatch(/ADD COLUMN\s+"canonical_entity_confidence"\s+real/i);
    expect(sql).toMatch(/ADD COLUMN\s+"canonical_entity_resolved_at"\s+timestamp\s+with\s+time\s+zone/i);
  });

  it('migration 0061 creates a B-tree index on canonical_entity_id', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    // Default B-tree index — no USING clause expected.
    expect(sql).toMatch(
      /CREATE INDEX[^;]*"library_canonical_entity_id_idx"[\s\S]*?ON\s+"wxyc_schema"\."library"\s*\(\s*"canonical_entity_id"\s*\)/i
    );
    const idxStatement = sql.match(/CREATE INDEX[^;]*"library_canonical_entity_id_idx"[^;]*/i)?.[0] ?? '';
    expect(idxStatement).not.toMatch(/USING\s+gin/i);
    expect(idxStatement).not.toMatch(/USING\s+hash/i);
  });

  it('migration 0061 is DDL-only — no in-migration backfill', () => {
    // Adding nullable columns is metadata-only. A backfill UPDATE inside the
    // same transaction would hold AccessExclusiveLock and could wedge the
    // table; backfill belongs in B-1.2 (jobs/<name>-backfill).
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/^\s*UPDATE\s+"wxyc_schema"\."library"/im);
  });

  it('journal includes the 0061 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has61 = journal.entries.some((e: { tag: string }) => e.tag === '0061_library-canonical-entity');
    expect(has61).toBe(true);
  });

  it('mock includes the canonical_entity columns on library', () => {
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');
    const libraryMock = mockSource.match(/export const library\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(libraryMock).toBeDefined();
    expect(libraryMock).toContain("canonical_entity_id: 'canonical_entity_id'");
    expect(libraryMock).toContain("canonical_entity_confidence: 'canonical_entity_confidence'");
    expect(libraryMock).toContain("canonical_entity_resolved_at: 'canonical_entity_resolved_at'");
  });
});
