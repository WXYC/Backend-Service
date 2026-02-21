import * as fs from 'fs';
import * as path from 'path';

const schemaSource = fs.readFileSync(
  path.resolve(__dirname, '../../../shared/database/src/schema.ts'),
  'utf-8'
);

function extractTableBlock(source: string, tableName: string): string {
  const pattern = new RegExp(
    `export const ${tableName}\\s*=\\s*wxyc_schema\\.table\\([\\s\\S]*?\\);`
  );
  const match = source.match(pattern);
  if (!match) throw new Error(`Table "${tableName}" not found in schema.ts`);
  return match[0];
}

describe('artist_library_crossreference schema', () => {
  const block = extractTableBlock(schemaSource, 'artist_library_crossreference');

  it('artist_id column has .notNull()', () => {
    const artistIdLine = block
      .split('\n')
      .find((line) => line.includes("artist_id:") || line.includes("'artist_id'"));
    expect(artistIdLine).toBeDefined();
    expect(artistIdLine).toContain('.notNull()');
  });

  it('library_id column has .notNull()', () => {
    const libraryIdLine = block
      .split('\n')
      .find((line) => line.includes("library_id:") || line.includes("'library_id'"));
    expect(libraryIdLine).toBeDefined();
    expect(libraryIdLine).toContain('.notNull()');
  });
});
