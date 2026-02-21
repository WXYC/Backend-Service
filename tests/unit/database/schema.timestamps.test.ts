import * as fs from 'fs';
import * as path from 'path';

describe('schema timestamp consistency', () => {
  const schemaPath = path.resolve(__dirname, '../../../shared/database/src/schema.ts');
  const schemaSource = fs.readFileSync(schemaPath, 'utf-8');

  it('every timestamp() call should include { withTimezone: true }', () => {
    // Match all timestamp( calls — captures the full invocation up to the closing paren
    // of the column-type function (not chained methods).
    // Pattern: timestamp('col_name') or timestamp('col_name', { ... })
    const timestampCallRegex = /timestamp\(\s*'[^']+'\s*(?:,\s*\{[^}]*\})?\s*\)/g;
    const matches = schemaSource.match(timestampCallRegex);

    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const match of matches!) {
      if (!match.includes('withTimezone: true')) {
        missing.push(match);
      }
    }

    expect(missing).toEqual([]);
  });
});
