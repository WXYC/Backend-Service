import * as fs from 'fs';
import * as path from 'path';

describe('schema: library.artist_name + search_doc denormalization (A.1)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0056_library-search-doc.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\s*=\\s*wxyc_schema[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('library table declares an artist_name column', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/artist_name:\s*varchar\(['"]artist_name['"],\s*\{\s*length:\s*128\s*\}\)/);
  });

  it('library.artist_name is nullable (no .notNull() chained on the declaration)', () => {
    const def = extractTableDef('library');
    // Capture only the artist_name declaration line
    const line = def.match(/artist_name:\s*varchar\([^)]*\)[^,]*/)?.[0] ?? '';
    expect(line).not.toMatch(/notNull/);
  });

  it('library table declares a STORED generated search_doc tsvector column', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/search_doc:\s*tsvector\(['"]search_doc['"]\)\.generatedAlwaysAs/);
    // Weight bands: artist=A, album=B, in that order, both wrapped in coalesce.
    expect(def).toMatch(
      /setweight\(to_tsvector\('simple',\s*coalesce\("artist_name",\s*''\)\),\s*'A'\)\s*\|\|\s*setweight\(to_tsvector\('simple',\s*coalesce\("album_title",\s*''\)\),\s*'B'\)/
    );
  });

  it('library declares the new GIN indexes (search_doc + artist_name trigram)', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/library_search_doc_idx[\s\S]*using\(['"]gin['"]/);
    expect(def).toMatch(/library_artist_name_trgm_idx[\s\S]*gin_trgm_ops/);
  });

  it('migration 0056 exists and adds the columns + indexes', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."library"\s+ADD COLUMN\s+"artist_name"\s+varchar\(128\)/i);
    expect(sql).toMatch(/ADD COLUMN\s+"search_doc"\s+"?tsvector"?\s+GENERATED ALWAYS AS/i);
    expect(sql).toMatch(/STORED/);
    expect(sql).toMatch(
      /CREATE INDEX\s+"library_search_doc_idx"\s+ON\s+"wxyc_schema"\."library"\s+USING gin\s*\(\s*"search_doc"\s*\)/i
    );
    expect(sql).toMatch(
      /CREATE INDEX\s+"library_artist_name_trgm_idx"\s+ON\s+"wxyc_schema"\."library"\s+USING gin\s*\(\s*"artist_name"\s+gin_trgm_ops\s*\)/i
    );
  });

  it('migration 0056 weight expression matches the schema declaration', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(
      /setweight\(to_tsvector\('simple',\s*coalesce\("artist_name",\s*''\)\),\s*'A'\)\s*\|\|\s*setweight\(to_tsvector\('simple',\s*coalesce\("album_title",\s*''\)\),\s*'B'\)/
    );
  });

  it('migration 0056 does NOT backfill artist_name (deferred to A.2)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    // No UPDATE statement should touch library.artist_name in this migration.
    expect(sql).not.toMatch(/UPDATE\s+"wxyc_schema"\."library"/i);
  });

  it('journal includes the 0056 entry with a timestamp after 0055', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const entry56 = journal.entries.find((e: { tag: string }) => e.tag === '0056_library-search-doc');
    expect(entry56).toBeDefined();
    const entry55 = journal.entries.find((e: { tag: string }) => e.tag === '0055_add-reconciled-identity-to-artists');
    expect(entry55).toBeDefined();
    expect(entry56.when).toBeGreaterThan(entry55.when);
  });

  it('snapshot 0056 exists and chains back to snapshot 0055 via prevId', () => {
    const snap56Path = path.join(migrationsDir, 'meta/0056_snapshot.json');
    const snap55Path = path.join(migrationsDir, 'meta/0055_snapshot.json');
    expect(fs.existsSync(snap56Path)).toBe(true);
    const snap56 = JSON.parse(fs.readFileSync(snap56Path, 'utf-8'));
    const snap55 = JSON.parse(fs.readFileSync(snap55Path, 'utf-8'));
    expect(snap56.prevId).toBe(snap55.id);
  });

  it('mock includes artist_name + search_doc on library', () => {
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');
    const libraryMock = mockSource.match(/export const library\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(libraryMock).toBeDefined();
    expect(libraryMock).toContain("artist_name: 'artist_name'");
    expect(libraryMock).toContain("search_doc: 'search_doc'");
  });
});
