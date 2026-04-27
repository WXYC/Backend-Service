import * as fs from 'fs';
import * as path from 'path';

describe('schema: library.artist_name + library.search_doc denormalization (A.1)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const migrationPath = path.join(migrationsDir, '0058_library-artist-name-and-search-doc.sql');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  it('library table declares an artist_name column (nullable)', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/artist_name:\s*varchar\(['"]artist_name['"]/);
    // Nullable initially — A.2 backfills, A.3 keeps it current.
    expect(def).not.toMatch(/artist_name:\s*varchar\([^)]*\)\.notNull\(\)/);
  });

  it('library table declares a STORED search_doc tsvector column', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/search_doc:\s*tsvector\(['"]search_doc['"]\)/);
    expect(def).toMatch(/generatedAlwaysAs/);
    // Weight bands: artist=A, album=B
    expect(def).toMatch(
      /setweight\(\s*to_tsvector\(\s*'simple'\s*,\s*coalesce\(\s*"artist_name"\s*,\s*''\s*\)\s*\)\s*,\s*'A'\s*\)/
    );
    expect(def).toMatch(
      /setweight\(\s*to_tsvector\(\s*'simple'\s*,\s*coalesce\(\s*"album_title"\s*,\s*''\s*\)\s*\)\s*,\s*'B'\s*\)/
    );
  });

  it('library table declares a GIN index on search_doc', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/library_search_doc_idx[\s\S]*?gin/);
  });

  it('library table declares a trigram index on artist_name', () => {
    const def = extractTableDef('library');
    expect(def).toMatch(/library_artist_name_trgm_idx[\s\S]*?gin[\s\S]*?artist_name[\s\S]*?gin_trgm_ops/);
  });

  it('migration 0058 exists and adds artist_name + search_doc columns', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/ALTER TABLE\s+"wxyc_schema"\."library"\s+ADD COLUMN\s+"artist_name"\s+varchar/i);
    expect(sql).toMatch(/ADD COLUMN\s+"search_doc"\s+tsvector\s+GENERATED ALWAYS AS/i);
    expect(sql).toMatch(/STORED/);
  });

  it('migration 0058 creates the GIN index on search_doc and the trigram index on artist_name', () => {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).toMatch(/CREATE INDEX[^;]*"library_search_doc_idx"[\s\S]*?USING gin\s*\(\s*"search_doc"\s*\)/i);
    expect(sql).toMatch(
      /CREATE INDEX[^;]*"library_artist_name_trgm_idx"[\s\S]*?USING gin\s*\(\s*"artist_name"\s+gin_trgm_ops\s*\)/i
    );
  });

  it('migration 0058 is DDL-only — no in-migration backfill', () => {
    // Adding nullable columns is metadata-only, but a backfill UPDATE inside
    // the same transaction would hold AccessExclusiveLock and could wedge the
    // table. Backfill belongs in jobs/<name>-backfill (A.2). See issue #511
    // for the incident pattern this rule encodes.
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    expect(sql).not.toMatch(/^\s*UPDATE\s+"wxyc_schema"\."library"/im);
  });

  it('journal includes the 0058 entry', () => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));
    const has58 = journal.entries.some((e: { tag: string }) => e.tag === '0058_library-artist-name-and-search-doc');
    expect(has58).toBe(true);
  });

  it('mock includes artist_name and search_doc on library', () => {
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');
    const libraryMock = mockSource.match(/export const library\s*=\s*\{[\s\S]*?\};/)?.[0];
    expect(libraryMock).toBeDefined();
    expect(libraryMock).toContain("artist_name: 'artist_name'");
    expect(libraryMock).toContain("search_doc: 'search_doc'");
  });
});
