import * as fs from 'fs';
import * as path from 'path';

describe('schema: artist_search_alias + library_artist_view.artist_id (artist-search-alias plan PR 3)', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const migrationsDir = path.resolve(__dirname, '../../../shared/database/src/migrations');
  const journalPath = path.join(migrationsDir, 'meta/_journal.json');

  // Migration tag (post-#1131): match by the `0089_` tag prefix rather
  // than by idx. The tag prefix is stable across journal renumbers (the
  // .sql file's filename never moves); the idx assignment shifted +1
  // for every entry above the historic idx-47 duplicate. Tags also
  // survive the `drizzle-kit picks the friendly suffix at generate time`
  // case the original comment called out — drizzle-kit fixes the prefix.
  const journal: { entries: Array<{ idx: number; when: number; tag: string }> } = JSON.parse(
    fs.readFileSync(journalPath, 'utf-8')
  );
  const entry89 = journal.entries.find((e) => e.tag.startsWith('0089_'));
  const sqlPath89 = entry89 ? path.join(migrationsDir, `${entry89.tag}.sql`) : null;
  const sql89 = sqlPath89 && fs.existsSync(sqlPath89) ? fs.readFileSync(sqlPath89, 'utf-8') : '';

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('artist_search_alias table', () => {
    it('is declared in schema.ts', () => {
      expect(schemaSource).toMatch(/export const artist_search_alias\s*=\s*wxyc_schema\.table/);
    });

    it('has the source-agnostic column set', () => {
      const def = extractTableDef('artist_search_alias');
      // Composite PK columns (also referenced by writer's UPSERT).
      expect(def).toMatch(/artist_id:\s*integer\(['"]artist_id['"]/);
      expect(def).toMatch(/source:\s*text\(['"]source['"]/);
      expect(def).toMatch(/variant:\s*text\(['"]variant['"]/);
      // Polymorphic payload.
      expect(def).toMatch(/related_artist_id:\s*integer\(['"]related_artist_id['"]/);
      expect(def).toMatch(/external_subject_id:\s*text\(['"]external_subject_id['"]/);
      expect(def).toMatch(/external_object_id:\s*text\(['"]external_object_id['"]/);
      expect(def).toMatch(/active:\s*boolean\(['"]active['"]/);
      expect(def).toMatch(/method:\s*text\(['"]method['"]/);
      expect(def).toMatch(/confidence:\s*real\(['"]confidence['"]/);
      expect(def).toMatch(/last_verified_at:\s*timestamp\(['"]last_verified_at['"]/);
    });

    it('FKs artist_id and related_artist_id to artists.id', () => {
      const def = extractTableDef('artist_search_alias');
      // ON DELETE cascade on artist_id — alias rows belong to the artist.
      expect(def).toMatch(/artist_id[\s\S]*?\.references\(\(\)\s*=>\s*artists\.id[\s\S]*?onDelete:\s*['"]cascade['"]/);
      // ON DELETE SET NULL on related_artist_id — the related artist may be
      // removed independently without nuking the alias row.
      expect(def).toMatch(
        /related_artist_id[\s\S]*?\.references\(\(\)\s*=>\s*artists\.id[\s\S]*?onDelete:\s*['"]set null['"]/
      );
    });

    it('declares the composite (artist_id, source, variant) primary key', () => {
      const def = extractTableDef('artist_search_alias');
      expect(def).toMatch(
        /primaryKey\(\s*\{[\s\S]*?columns:\s*\[[\s\S]*?artist_id[\s\S]*?source[\s\S]*?variant[\s\S]*?\][\s\S]*?\}/
      );
    });

    it('declares CHECK constraints on confidence range and non-blank variant', () => {
      const def = extractTableDef('artist_search_alias');
      expect(def).toMatch(/check\(\s*['"]artist_search_alias_confidence_range['"][\s\S]*?BETWEEN 0 AND 1/);
      expect(def).toMatch(/check\(\s*['"]artist_search_alias_variant_nonblank['"][\s\S]*?length\(trim/);
    });

    it('declares a GIN trigram index on variant', () => {
      const def = extractTableDef('artist_search_alias');
      expect(def).toMatch(
        /index\(\s*['"]artist_search_alias_variant_trgm_idx['"]\)[\s\S]*?using\(['"]gin['"][\s\S]*?variant[\s\S]*?gin_trgm_ops/
      );
    });
  });

  describe('library_artist_view.artist_id projection', () => {
    it('view projection includes library.artist_id (last column, additive)', () => {
      // Locate the view's projection block. Allow trailing whitespace + comments.
      const viewBlock = schemaSource.match(/export const library_artist_view[\s\S]*?\.select\(\s*\{([\s\S]*?)\}\s*\)/);
      expect(viewBlock).not.toBeNull();
      const projection = viewBlock[1];
      expect(projection).toMatch(/artist_id:\s*library\.artist_id/);
    });

    it('LibraryArtistViewEntry type adds artist_id: number', () => {
      // Locate the exported type body.
      const typeBlock = schemaSource.match(/export type LibraryArtistViewEntry\s*=\s*\{([\s\S]*?)\};/);
      expect(typeBlock).not.toBeNull();
      expect(typeBlock[1]).toMatch(/artist_id:\s*number;/);
    });
  });

  describe('migration 0089', () => {
    it('journal has an entry at idx 89', () => {
      expect(entry89).toBeDefined();
      // Tag should be descriptive of the change (drizzle-kit picks the slug
      // suffix; we assert only the idx prefix to stay tolerant of generator
      // output).
      expect(entry89.tag).toMatch(/^0089_/);
    });

    it('journal `when` strictly exceeds the prior tail (0088)', () => {
      const entry88 = journal.entries.find((e) => e.tag.startsWith('0088_'));
      expect(entry88).toBeDefined();
      expect(entry89.when).toBeGreaterThan(entry88.when);
    });

    it('migration SQL file exists and creates artist_search_alias', () => {
      expect(sqlPath89).not.toBeNull();
      expect(sql89).toMatch(/CREATE TABLE[^;]*"wxyc_schema"\."artist_search_alias"/i);
      expect(sql89).toMatch(/CREATE INDEX[^;]*"artist_search_alias_variant_trgm_idx"[\s\S]*?USING gin/i);
    });

    it('migration SQL replaces library_artist_view with the artist_id column', () => {
      // Drizzle emits either `CREATE OR REPLACE VIEW` (precedent: 0056) or
      // `DROP VIEW + CREATE VIEW` (precedent: 0044). Both work in the migration
      // transaction. Asserting on the final-state CREATE is enough.
      expect(sql89).toMatch(
        /CREATE\s+(OR\s+REPLACE\s+)?VIEW[^;]*"wxyc_schema"\."library_artist_view"[\s\S]*?"artist_id"/i
      );
    });

    it('migration is DDL-only — no DML on data', () => {
      // Per docs/migrations.md @rule id=ddl-only — backfill belongs in a
      // separate job; this migration only ships schema.
      expect(sql89).not.toMatch(/^\s*UPDATE\s+"wxyc_schema"/im);
      expect(sql89).not.toMatch(/^\s*INSERT\s+INTO\s+"wxyc_schema"/im);
    });
  });

  describe('database mock', () => {
    const mockPath = path.resolve(__dirname, '../../mocks/database.mock.ts');
    const mockSource = fs.readFileSync(mockPath, 'utf-8');

    it('exports artist_search_alias mock', () => {
      expect(mockSource).toMatch(/export const artist_search_alias\s*=\s*\{/);
    });

    it('library_artist_view mock includes artist_id (PR 5 search-side LATERAL will reference it)', () => {
      const viewMock = mockSource.match(/export const library_artist_view\s*=\s*\{[\s\S]*?\};/)?.[0];
      expect(viewMock).toBeDefined();
      expect(viewMock).toContain("artist_id: 'artist_id'");
    });
  });
});
