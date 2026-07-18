/**
 * Schema-shape sanity check for the artist_metadata table (migration 0121,
 * BS#1624). Mirrors schema.concerts.test.ts: read the schema source + the
 * migration SQL as text and assert the columns / PK are declared as the
 * migration expects.
 *
 * If you rename a column or change a constraint, this test fails — read the
 * assertion before "fixing" it; usually the right fix is the companion
 * migration, not the test.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('schema: artist_metadata (migration 0121, concerts-genre-enrichment)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  const entry = journal.entries.find((e) => e.tag.startsWith('0121_'));
  const sqlPath = entry ? path.join(migrationsDir, `${entry.tag}.sql`) : null;
  const sql = sqlPath && fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    // Bound to the table's own `});` close (drizzle `wxyc_schema.table(...)`
    // literals end with `});` at line-start). An earlier `^\);` stopped at the
    // first line beginning with `);`, which — since no table closes that way —
    // over-captured into whatever construct followed, sweeping in an adjacent
    // table's FK (e.g. artist_similar_artists, BS#1626).
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\}\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('journal + migration file', () => {
    it('registers the 0121 migration in the journal', () => {
      expect(entry).toBeDefined();
      expect(entry?.tag).toBe('0121_concerts-artist-genres');
    });

    it('has a strictly-increasing `when` above 0119', () => {
      const prev = journal.entries.find((e) => e.tag.startsWith('0119_'));
      expect(entry?.when).toBeGreaterThan(prev?.when ?? 0);
    });

    it('creates the artist_metadata table (DDL-only, single fresh CREATE TABLE)', () => {
      expect(sql).toMatch(/CREATE TABLE "wxyc_schema"\."artist_metadata"/);
      // Additive/DDL-only: no destructive statements, no data rewrites.
      expect(sql).not.toMatch(/\bDROP TABLE\b/);
      expect(sql).not.toMatch(/\bUPDATE\b/);
      expect(sql).not.toMatch(/\bDELETE\b/);
    });

    it('declares the Discogs id primary key, genres/styles text[], and updated_at', () => {
      expect(sql).toMatch(/"discogs_artist_id" integer PRIMARY KEY NOT NULL/);
      expect(sql).toMatch(/"genres" text\[\]/);
      expect(sql).toMatch(/"styles" text\[\]/);
      expect(sql).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
    });
  });

  describe('schema.ts declaration', () => {
    const tableDef = extractTableDef('artist_metadata');

    it('is a bare Discogs artist id PK — no FK to artists.id (touring artists are absent from the library)', () => {
      expect(tableDef).toMatch(/discogs_artist_id:\s*integer\('discogs_artist_id'\)\.primaryKey\(\)\.notNull\(\)/);
      expect(tableDef).not.toMatch(/references\(/);
    });

    it('declares nullable genres + styles arrays', () => {
      expect(tableDef).toMatch(/genres:\s*text\('genres'\)\.array\(\)/);
      expect(tableDef).toMatch(/styles:\s*text\('styles'\)\.array\(\)/);
    });

    it('exports the ArtistMetadata select + insert model types', () => {
      expect(schemaSource).toMatch(/export type ArtistMetadata = InferSelectModel<typeof artist_metadata>/);
      expect(schemaSource).toMatch(/export type NewArtistMetadata = InferInsertModel<typeof artist_metadata>/);
    });
  });
});
