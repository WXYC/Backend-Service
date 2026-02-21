import * as fs from 'fs';
import * as path from 'path';

const schemaSource = fs.readFileSync(
  path.resolve(__dirname, '../../../shared/database/src/schema.ts'),
  'utf-8'
);

/**
 * Extract the full column definition block for a given column in a given table.
 * Captures from the column's DB name through to the next column or closing brace.
 */
function getColumnBlock(tableVar: string, columnDbName: string): string | null {
  const tablePattern = new RegExp(`export\\s+const\\s+${tableVar}\\s*=`);
  const tableMatch = tablePattern.exec(schemaSource);
  if (!tableMatch) return null;

  const afterTable = schemaSource.slice(tableMatch.index);

  // Find the column by its DB name, then grab everything until the next
  // property definition (a line starting with whitespace + identifier + colon)
  // or until a closing brace/paren.
  const colPattern = new RegExp(
    `(${columnDbName}:\\s*(?:integer|varchar|serial)\\([\\s\\S]*?)(?=\\n\\s+\\w+:\\s|\\n\\s*\\}|\\n\\s*\\))`
  );
  const colMatch = colPattern.exec(afterTable);
  if (!colMatch) return null;

  return colMatch[1];
}

function expectOnDelete(tableVar: string, columnDbName: string, expectedAction: 'set null' | 'cascade') {
  const block = getColumnBlock(tableVar, columnDbName);
  expect(block).not.toBeNull();
  expect(block).toContain('.references(');
  expect(block).toContain('onDelete');
  expect(block).toContain(`'${expectedAction}'`);
}

describe('FK cascade/set-null rules in schema.ts', () => {
  describe('should use onDelete: "set null"', () => {
    it('schedule.assigned_dj_id → user.id', () => {
      expectOnDelete('schedule', 'assigned_dj_id', 'set null');
    });

    it('schedule.assigned_dj_id2 → user.id', () => {
      expectOnDelete('schedule', 'assigned_dj_id2', 'set null');
    });

    it('schedule.specialty_id → specialty_shows.id', () => {
      expectOnDelete('schedule', 'specialty_id', 'set null');
    });

    it('shows.primary_dj_id → user.id', () => {
      expectOnDelete('shows', 'primary_dj_id', 'set null');
    });

    it('shift_covers.cover_dj_id → user.id', () => {
      expectOnDelete('shift_covers', 'cover_dj_id', 'set null');
    });

    it('flowsheet.show_id → shows.id', () => {
      expectOnDelete('flowsheet', 'show_id', 'set null');
    });

    it('flowsheet.album_id → library.id', () => {
      expectOnDelete('flowsheet', 'album_id', 'set null');
    });

    it('flowsheet.rotation_id → rotation.id', () => {
      expectOnDelete('flowsheet', 'rotation_id', 'set null');
    });
  });

  describe('should use onDelete: "cascade"', () => {
    it('rotation.album_id → library.id', () => {
      expectOnDelete('rotation', 'album_id', 'cascade');
    });

    it('reviews.album_id → library.id', () => {
      expectOnDelete('reviews', 'album_id', 'cascade');
    });

    it('genre_artist_crossreference.artist_id → artists.id', () => {
      expectOnDelete('genre_artist_crossreference', 'artist_id', 'cascade');
    });

    it('genre_artist_crossreference.genre_id → genres.id', () => {
      expectOnDelete('genre_artist_crossreference', 'genre_id', 'cascade');
    });

    it('artist_library_crossreference.artist_id → artists.id', () => {
      expectOnDelete('artist_library_crossreference', 'artist_id', 'cascade');
    });

    it('artist_library_crossreference.library_id → library.id', () => {
      expectOnDelete('artist_library_crossreference', 'library_id', 'cascade');
    });

    it('show_djs.show_id → shows.id', () => {
      expectOnDelete('show_djs', 'show_id', 'cascade');
    });
  });

  describe('should NOT have onDelete (intentional NO ACTION)', () => {
    it('library.artist_id → artists.id', () => {
      const block = getColumnBlock('library', 'artist_id');
      expect(block).not.toBeNull();
      expect(block).toContain('.references(');
      expect(block).not.toContain('onDelete');
    });

    it('library.genre_id → genres.id', () => {
      const block = getColumnBlock('library', 'genre_id');
      expect(block).not.toBeNull();
      expect(block).toContain('.references(');
      expect(block).not.toContain('onDelete');
    });

    it('library.format_id → format.id', () => {
      const block = getColumnBlock('library', 'format_id');
      expect(block).not.toBeNull();
      expect(block).toContain('.references(');
      expect(block).not.toContain('onDelete');
    });

    it('artists.genre_id → genres.id', () => {
      const block = getColumnBlock('artists', 'genre_id');
      expect(block).not.toBeNull();
      expect(block).toContain('.references(');
      expect(block).not.toContain('onDelete');
    });
  });
});
