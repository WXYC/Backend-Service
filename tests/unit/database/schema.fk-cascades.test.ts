import * as fs from 'fs';
import * as path from 'path';

const schemaSource = fs.readFileSync(path.resolve(__dirname, '../../../shared/database/src/schema.ts'), 'utf-8');

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

function expectNoOnDelete(tableVar: string, columnDbName: string) {
  const block = getColumnBlock(tableVar, columnDbName);
  expect(block).not.toBeNull();
  expect(block).toContain('.references(');
  expect(block).not.toContain('onDelete');
}

describe('FK cascade/set-null rules in schema.ts', () => {
  describe('should use onDelete: "set null"', () => {
    it('schedule.assigned_dj_id → user.id', () => {
      expectOnDelete('schedule', 'assigned_dj_id', 'set null');
    });

    it('schedule.assigned_dj_id2 → user.id', () => {
      expectOnDelete('schedule', 'assigned_dj_id2', 'set null');
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

    it('artist_library_crossreference.library_id → library.id', () => {
      expectOnDelete('artist_library_crossreference', 'library_id', 'cascade');
    });
  });

  describe('should NOT have onDelete (intentional NO ACTION)', () => {
    // The five below were DE-DECLARED by WXYC/Backend-Service#2239. schema.ts
    // used to claim CASCADE (or SET NULL, for schedule.specialty_id) on each,
    // but every one of them is plain NO ACTION in production and in a CI
    // database built from the migration chain from empty -- no migration ever
    // created them any other way. #2239 corrected schema.ts to describe what
    // the database actually enforces rather than patching the database to
    // match a declaration nothing relied on: no code path in apps/ or shared/
    // deletes a shows, artists, genres, or specialty_shows row, so adding the
    // cascades would have armed five destructive deletes across decades of
    // flowsheet and library history for zero callers.
    //
    // These assertions are the reason the decision cannot silently rot back.
    // If a future change genuinely needs one of these to cascade, add the
    // cascade in the PR that introduces the delete path, update the matching
    // case here, and pair it with a migration -- the deployed constraint has
    // to move too. Do not simply re-add `onDelete` to schema.ts; that is the
    // exact drift #2239 existed to remove, and the integration guard at
    // tests/integration/fk-on-delete-general-guard.spec.js will fail on it.

    it('schedule.specialty_id → specialty_shows.id (#2239)', () => {
      expectNoOnDelete('schedule', 'specialty_id');
    });

    it('genre_artist_crossreference.artist_id → artists.id (#2239)', () => {
      expectNoOnDelete('genre_artist_crossreference', 'artist_id');
    });

    it('genre_artist_crossreference.genre_id → genres.id (#2239)', () => {
      expectNoOnDelete('genre_artist_crossreference', 'genre_id');
    });

    it('artist_library_crossreference.artist_id → artists.id (#2239)', () => {
      expectNoOnDelete('artist_library_crossreference', 'artist_id');
    });

    it('show_djs.show_id → shows.id (#2239)', () => {
      expectNoOnDelete('show_djs', 'show_id');
    });

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
