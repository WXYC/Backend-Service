/**
 * Unit tests asserting the search service no longer joins through shows or
 * auth_user (step 5b.3): the dj-name filter, the dj sort, and the display
 * column all read directly from flowsheet.dj_name.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('search.service: dj_name read path (step 5b.3)', () => {
  const servicePath = path.resolve(__dirname, '../../../apps/backend/services/search.service.ts');
  const source = fs.readFileSync(servicePath, 'utf-8');

  it('does not import shows or user from @wxyc/database', () => {
    // The shows and auth_user joins have been eliminated; importing them would
    // be dead code that could mislead a reader into thinking the joins are
    // still wired up.
    const importLine = source.match(/import\s*\{[^}]*\}\s*from\s*'@wxyc\/database'/);
    expect(importLine).not.toBeNull();
    const text = importLine?.[0] ?? '';
    expect(text).not.toMatch(/\bshows\b/);
    expect(text).not.toMatch(/\buser\b/);
  });

  it('does not LEFT JOIN shows or auth_user in the search FROM clause', () => {
    expect(source).not.toMatch(/LEFT JOIN\s+\$\{shows\}/i);
    expect(source).not.toMatch(/LEFT JOIN\s+\$\{user\}/i);
  });

  it('reads the resolved DJ name directly from flowsheet.dj_name (with Unknown DJ fallback)', () => {
    // The display projection should resolve the column directly. A COALESCE
    // fallback to 'Unknown DJ' guards rows that somehow carry NULL (legacy
    // imports prior to migration 0053 should all be backfilled, but the
    // fallback keeps the API contract stable).
    expect(source).toMatch(/COALESCE\(\$\{flowsheet\.dj_name\},\s*'Unknown DJ'\)/);
  });

  it('builds the dj-name WHERE filter as a single column predicate on flowsheet.dj_name', () => {
    // The OR-decomposition added in migration 0051 (across the three legacy
    // columns) collapses to a single predicate now that the value lives on
    // the row. The "no user/shows imports" test above already proves we
    // can't reference the old columns as code; this test confirms the new
    // function references the new column.
    const buildDjNameMatch = source.match(/function buildDjNameMatch[\s\S]*?\n\}/)?.[0];
    expect(buildDjNameMatch).toBeDefined();
    expect(buildDjNameMatch).toMatch(/flowsheet\.dj_name/);
  });

  it('sorts by dj using flowsheet.dj_name, not the COALESCE expression', () => {
    // The SORT_MAP entry for dj should be a plain column reference; the
    // COALESCE expression is only needed in the SELECT projection for
    // NULL handling.
    const sortMap = source.match(/SORT_MAP[\s\S]*?\};/)?.[0];
    expect(sortMap).toBeDefined();
    expect(sortMap).toMatch(/dj:\s*sql`\$\{flowsheet\.dj_name\}`/);
  });
});
