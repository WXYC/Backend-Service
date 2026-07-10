/**
 * Pins the REAL shared conflict-clear fragment (shared/database/src/
 * concerts-sql.ts) — the writer suites exercise it only through the
 * database mock's stub, so this is the one place the actual module's
 * mechanism text and column bindings are asserted. Under the unit
 * harness, 'drizzle-orm' resolves to tests/__mocks__/drizzle-orm.ts,
 * whose sql tag returns { sql: templateStrings, values: interpolations }
 * — which makes both halves directly inspectable.
 */
import { headliningArtistIdConflictClear } from '../../../shared/database/src/concerts-sql';
import { concerts } from '../../../shared/database/src/schema';

describe('headliningArtistIdConflictClear', () => {
  it('builds the conditional clear: NULL only when the stored raw headliner differs from the incoming one', () => {
    const frag = headliningArtistIdConflictClear() as unknown as {
      sql: readonly string[];
      values: unknown[];
    };
    const text = frag.sql.join('<col>');

    expect(text).toMatch(/^CASE WHEN /);
    expect(text).toContain('IS DISTINCT FROM excluded."headlining_artist_raw"');
    expect(text).toContain('THEN NULL ELSE');
    expect(text).toMatch(/ END$/);
  });

  it('binds the stored-row column refs (evaluated against the pre-update row in a DO UPDATE SET): raw for the comparison, id for the ELSE', () => {
    const frag = headliningArtistIdConflictClear() as unknown as { values: unknown[] };

    expect(frag.values).toHaveLength(2);
    expect(frag.values[0]).toBe(concerts.headlining_artist_raw);
    expect(frag.values[1]).toBe(concerts.headlining_artist_id);
  });

  it('returns a fresh fragment per call (no shared mutable descriptor across upserts)', () => {
    expect(headliningArtistIdConflictClear()).not.toBe(headliningArtistIdConflictClear());
  });
});
