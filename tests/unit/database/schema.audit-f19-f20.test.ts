import * as fs from 'fs';
import * as path from 'path';

describe('schema audit: F19 and F20', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  const extractTableDef = (tableName: string): string => {
    const regex = new RegExp(`export const ${tableName}\\b[\\s\\S]*?^\\);`, 'm');
    const match = schemaSource.match(regex);
    if (!match) throw new Error(`Table definition for ${tableName} not found in schema`);
    return match[0];
  };

  describe('F19: flowsheet.play_order should be integer, not serial', () => {
    it('play_order column should use integer() instead of serial()', () => {
      const flowsheetDef = extractTableDef('flowsheet');

      expect(flowsheetDef).toMatch(/play_order:\s*integer\(/);
      expect(flowsheetDef).not.toMatch(/play_order:\s*serial\(/);
    });
  });

  describe('F20: artist_library_crossreference FK columns should be NOT NULL', () => {
    it('artist_id should have .notNull()', () => {
      const crossrefDef = extractTableDef('artist_library_crossreference');
      const artistIdLine = crossrefDef.split('\n').find((line) => line.includes('artist_id'));
      expect(artistIdLine).toBeDefined();
      expect(artistIdLine).toContain('.notNull()');
    });

    it('library_id should have .notNull()', () => {
      const crossrefDef = extractTableDef('artist_library_crossreference');
      const libraryIdLine = crossrefDef.split('\n').find((line) => line.includes('library_id'));
      expect(libraryIdLine).toBeDefined();
      expect(libraryIdLine).toContain('.notNull()');
    });
  });
});
