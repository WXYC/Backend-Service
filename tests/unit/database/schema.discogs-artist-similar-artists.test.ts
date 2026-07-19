/**
 * Schema-shape sanity check for the discogs_artist_similar_artists table
 * (BS#1701 — the Discogs lane of the two-lane similar-artists design). Mirrors
 * schema.artist-metadata.test.ts (the bare-Discogs-PK, no-FK sibling): read the
 * schema source + the migration SQL as text and assert the columns / PK are
 * declared as the migration expects.
 *
 * The migration is located by its descriptive tag SUFFIX
 * (`discogs-artist-similar-artists`), not a hardcoded index, because the
 * numeric prefix is a merge-order race (a parallel branch may claim the same
 * number first, forcing a renumber). If you rename a column or change a
 * constraint, this test fails — read the assertion before "fixing" it; usually
 * the right fix is the companion migration, not the test.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('schema: discogs_artist_similar_artists (BS#1701, concerts-similar-artists-enrichment discogs lane)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  // Renumber-robust: match on the tag suffix, not the numeric prefix.
  const entry = journal.entries.find((e) => e.tag.endsWith('_discogs-artist-similar-artists'));
  const sqlPath = entry ? path.join(migrationsDir, `${entry.tag}.sql`) : null;
  const sql = sqlPath && fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\}\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('journal + migration file', () => {
    it('registers the discogs-artist-similar-artists migration in the journal', () => {
      expect(entry).toBeDefined();
      expect(entry?.tag).toMatch(/^\d{4}_discogs-artist-similar-artists$/);
    });

    it('has a strictly-increasing `when` above the prior journal entry', () => {
      // The immediately-preceding entry by idx — robust to whatever number this
      // migration lands on after any merge-order renumber.
      const prev = journal.entries.filter((e) => (entry ? e.idx < entry.idx : false)).sort((a, b) => b.idx - a.idx)[0];
      expect(entry?.when).toBeGreaterThan(prev?.when ?? 0);
    });

    it('creates the table (DDL-only, single fresh CREATE TABLE)', () => {
      expect(sql).toMatch(/CREATE TABLE "wxyc_schema"\."discogs_artist_similar_artists"/);
      // Additive/DDL-only: no destructive statements, no data rewrites.
      // Statement-anchored (^): the header comment legitimately mentions the
      // job's runtime UPSERT/OVERWRITE, so a bare `\bUPDATE\b` would false-fire
      // on prose.
      expect(sql).not.toMatch(/^\s*DROP TABLE\b/im);
      expect(sql).not.toMatch(/^\s*UPDATE\b/im);
      expect(sql).not.toMatch(/^\s*DELETE\s+FROM\b/im);
    });

    it('declares the Discogs id primary key, jsonb neighbors, and updated_at', () => {
      expect(sql).toMatch(/"discogs_artist_id" integer PRIMARY KEY NOT NULL/);
      expect(sql).toMatch(/"neighbors" jsonb NOT NULL/);
      expect(sql).toMatch(/"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
    });

    it('documents the no-precondition-needed marker (bare-PK fresh table)', () => {
      expect(sql).toMatch(/@no-precondition-needed/);
    });
  });

  describe('schema.ts declaration', () => {
    const tableDef = extractTableDef('discogs_artist_similar_artists');

    it('is a bare Discogs artist id PK — no FK to artists.id (touring artists are absent from the library)', () => {
      expect(tableDef).toMatch(/discogs_artist_id:\s*integer\('discogs_artist_id'\)\.primaryKey\(\)\.notNull\(\)/);
      expect(tableDef).not.toMatch(/references\(/);
    });

    it('declares neighbors as a typed jsonb column (the SimilarArtist wire array), same as the library lane', () => {
      expect(tableDef).toMatch(/neighbors:\s*jsonb\('neighbors'\)\.\$type<SimilarArtistNeighbor\[\]>\(\)\.notNull\(\)/);
    });

    it('exports the DiscogsArtistSimilarArtists select + insert model types', () => {
      expect(schemaSource).toMatch(
        /export type DiscogsArtistSimilarArtists = InferSelectModel<typeof discogs_artist_similar_artists>/
      );
      expect(schemaSource).toMatch(
        /export type NewDiscogsArtistSimilarArtists = InferInsertModel<typeof discogs_artist_similar_artists>/
      );
    });
  });
});
