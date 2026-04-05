import * as fs from 'fs';
import * as path from 'path';

describe('schema: cross-reference tables', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('artist_crossreference table', () => {
    it('should exist in the schema', () => {
      expect(schemaSource).toContain('export const artist_crossreference');
    });

    it('should have source_artist_id as NOT NULL FK to artists', () => {
      const def = extractTableDef('artist_crossreference');
      expect(def).toContain('source_artist_id');
      expect(def).toMatch(/source_artist_id[\s\S]*?\.notNull\(\)/);
      expect(def).toMatch(/source_artist_id[\s\S]*?artists\.id/);
    });

    it('should have target_artist_id as NOT NULL FK to artists', () => {
      const def = extractTableDef('artist_crossreference');
      expect(def).toContain('target_artist_id');
      expect(def).toMatch(/target_artist_id[\s\S]*?\.notNull\(\)/);
      expect(def).toMatch(/target_artist_id[\s\S]*?artists\.id/);
    });

    it('should have a comment column', () => {
      const def = extractTableDef('artist_crossreference');
      expect(def).toContain('comment');
    });

    it('should have a unique index on (source_artist_id, target_artist_id)', () => {
      const def = extractTableDef('artist_crossreference');
      expect(def).toMatch(/uniqueIndex.*source_artist_id.*target_artist_id/s);
    });
  });

  describe('artist_library_crossreference table', () => {
    it('should have a comment column', () => {
      const def = extractTableDef('artist_library_crossreference');
      expect(def).toContain('comment');
    });
  });
});
