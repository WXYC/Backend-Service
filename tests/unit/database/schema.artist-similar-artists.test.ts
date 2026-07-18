/**
 * Schema-shape sanity check for the artist_similar_artists table (migration
 * 0122, BS#1626). Mirrors schema.artist-metadata.test.ts: read the schema
 * source + the migration SQL as text and assert the columns / PK / FK are
 * declared as the migration expects.
 *
 * If you rename a column or change a constraint, this test fails — read the
 * assertion before "fixing" it; usually the right fix is the companion
 * migration, not the test.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('schema: artist_similar_artists (migration 0122, concerts-similar-artists-enrichment)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  const entry = journal.entries.find((e) => e.tag.startsWith('0122_'));
  const sqlPath = entry ? path.join(migrationsDir, `${entry.tag}.sql`) : null;
  const sql = sqlPath && fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\}\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('journal + migration file', () => {
    it('registers the 0122 migration in the journal', () => {
      expect(entry).toBeDefined();
      expect(entry?.tag).toBe('0122_concerts-similar-artists');
    });

    it('has a strictly-increasing `when` above 0121', () => {
      const prev = journal.entries.find((e) => e.tag.startsWith('0121_'));
      expect(entry?.when).toBeGreaterThan(prev?.when ?? 0);
    });

    it('creates the table + FK (DDL-only, no destructive statements)', () => {
      expect(sql).toMatch(/CREATE TABLE "wxyc_schema"\."artist_similar_artists"/);
      expect(sql).toMatch(/ADD CONSTRAINT .* FOREIGN KEY \("artist_id"\) REFERENCES "wxyc_schema"\."artists"/);
      expect(sql).toMatch(/ON DELETE cascade/);
      // Statement-anchored (^): the header comment legitimately mentions the
      // job's runtime UPSERT/OVERWRITE, so a bare `\bUPDATE\b` would false-fire
      // on prose. The DDL-only guarantee is about actual DML statements.
      expect(sql).not.toMatch(/^\s*DROP TABLE\b/im);
      expect(sql).not.toMatch(/^\s*UPDATE\b/im);
      expect(sql).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    });

    it('declares the artist_id PK, jsonb neighbors, and updated_at', () => {
      expect(sql).toMatch(/"artist_id" integer PRIMARY KEY NOT NULL/);
      expect(sql).toMatch(/"neighbors" jsonb NOT NULL/);
      expect(sql).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
    });

    it('documents the no-precondition-needed marker (FK on a fresh empty table)', () => {
      expect(sql).toMatch(/@no-precondition-needed/);
    });
  });

  describe('schema.ts declaration', () => {
    const tableDef = extractTableDef('artist_similar_artists');

    it('keys on artists.id with a real FK + ON DELETE CASCADE (in-library headliners only)', () => {
      expect(tableDef).toMatch(/artist_id:\s*integer\('artist_id'\)/);
      expect(tableDef).toMatch(/\.primaryKey\(\)/);
      expect(tableDef).toMatch(/\.references\(\(\)\s*=>\s*artists\.id,\s*\{\s*onDelete:\s*'cascade'\s*\}\)/);
    });

    it('declares neighbors as a typed jsonb column (the SimilarArtist wire array)', () => {
      expect(tableDef).toMatch(/neighbors:\s*jsonb\('neighbors'\)\.\$type<SimilarArtistNeighbor\[\]>\(\)\.notNull\(\)/);
    });

    it('exports the SimilarArtistNeighbor type and the select + insert models', () => {
      expect(schemaSource).toMatch(/export type SimilarArtistNeighbor = \{ artist_id: number; weight: number \}/);
      expect(schemaSource).toMatch(
        /export type ArtistSimilarArtists = InferSelectModel<typeof artist_similar_artists>/
      );
      expect(schemaSource).toMatch(
        /export type NewArtistSimilarArtists = InferInsertModel<typeof artist_similar_artists>/
      );
    });
  });
});
