import * as fs from 'fs';
import * as path from 'path';

describe('schema audit: F19 and F20', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  describe('F19: flowsheet.play_order should be integer, not serial', () => {
    it('play_order column should use integer() instead of serial()', () => {
      // Extract the flowsheet table definition
      const flowsheetMatch = schemaSource.match(
        /(?:export const flowsheet\b[\s\S]*?(?:^\);|^\};\s*$))/m
      );
      expect(flowsheetMatch).not.toBeNull();
      const flowsheetDef = flowsheetMatch![0];

      // play_order should be integer, not serial
      expect(flowsheetDef).toMatch(/play_order:\s*integer\(/);
      expect(flowsheetDef).not.toMatch(/play_order:\s*serial\(/);
    });
  });

  describe('F20: artist_library_crossreference FK columns should be NOT NULL', () => {
    it('artist_id should have .notNull()', () => {
      const crossrefMatch = schemaSource.match(
        /export const artist_library_crossreference[\s\S]*?^\);/m
      );
      expect(crossrefMatch).not.toBeNull();
      const crossrefDef = crossrefMatch![0];

      // artist_id line should include .notNull()
      const artistIdLine = crossrefDef.split('\n').find((line) => line.includes('artist_id'));
      expect(artistIdLine).toBeDefined();
      expect(artistIdLine).toContain('.notNull()');
    });

    it('library_id should have .notNull()', () => {
      const crossrefMatch = schemaSource.match(
        /export const artist_library_crossreference[\s\S]*?^\);/m
      );
      expect(crossrefMatch).not.toBeNull();
      const crossrefDef = crossrefMatch![0];

      // library_id line should include .notNull()
      const libraryIdLine = crossrefDef.split('\n').find((line) => line.includes('library_id'));
      expect(libraryIdLine).toBeDefined();
      expect(libraryIdLine).toContain('.notNull()');
    });
  });
});
