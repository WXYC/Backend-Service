/**
 * Unit tests for jobs/concerts-artist-resolver query.ts (BS#1383).
 *
 * `resolveArtistId` runs two SQL JOINs (strict-then-alias). The alias arm
 * is the load-bearing site for BS#1383: a `discogs_member` row in
 * `artist_search_alias` is a relational signal ("X was a member of Y"),
 * not a synonym signal. Folding it into the FK-write path produced the
 * Geordie Greep → black midi mislabel surfaced by the BS#1368 frequency
 * audit (Greep is touring solo, not in WXYC's library; only black midi's
 * records are).
 *
 * The fix restricts the alias arm to the synonym-class sources via a
 * positive allowlist: `source IN ('discogs_name_variation',
 * 'discogs_alias', 'wxyc_library_alt')`. Positive form is safe-by-
 * default — a future LML source (collaborator, featured-on, side-project)
 * stays out of the FK-write path until we explicitly opt it in. The
 * catalog-search sites take the opposite tack: they DO want relational
 * rows surfaced for a "related artist" UX hint and propagate `source`
 * end-to-end. The resolver has no wire-shape seam for `source` so the
 * partition is enforced in SQL.
 *
 * The mocked `db.execute` returns the post-filter row set the SQL would
 * have produced. The SQL-contract test pins the allowlist literal; the
 * positive- and negative-source tests pin which sources survive and which
 * do not; the ambiguity-disambiguation test pins the semantic shift the
 * filter introduces (pre-filter ambiguous → post-filter singleton
 * resolves).
 */
import { jest } from '@jest/globals';

import { db } from '../../../mocks/database.mock';
import { resolveArtistId } from '../../../../jobs/concerts-artist-resolver/query';

type SqlLike = {
  sql?: string | string[];
  queryChunks?: Array<string | { value?: string | string[] }>;
};
const renderSql = (value: unknown): string => {
  const obj = value as SqlLike | null | undefined;
  if (!obj) return '';
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk.value)) return chunk.value.join('');
        if (typeof chunk.value === 'string') return chunk.value;
        return '';
      })
      .join('');
  }
  return '';
};

// `mockClear` rather than `mockReset` preserves the database mock's
// default `mockResolvedValue([])` so that a test forgetting one
// `mockResolvedValueOnce` fails with a clean assertion mismatch rather
// than the loud "unrecognized db.execute() result shape: undefined" the
// unwrapRows guard throws for safety.
const executeMock = db.execute;

const SYNONYM_SOURCES = ['discogs_name_variation', 'discogs_alias', 'wxyc_library_alt'] as const;
const RELATIONAL_SOURCES = ['discogs_member'] as const;

describe('resolveArtistId — synonym-class allowlist (BS#1383)', () => {
  beforeEach(() => {
    executeMock.mockClear();
  });

  describe('SQL contract', () => {
    it('the alias arm allowlists exactly the synonym-class sources', async () => {
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await resolveArtistId('Geordie Greep');

      expect(executeMock).toHaveBeenCalledTimes(2);
      const aliasSql = renderSql(executeMock.mock.calls[1][0]);

      // Pin the positive-allowlist contract: SOURCE IN (...) — not a
      // negative-form predicate. A negative form would silently admit
      // every future LML source.
      for (const source of SYNONYM_SOURCES) {
        expect(aliasSql).toContain(`'${source}'`);
      }
      expect(aliasSql).toMatch(/"?source"?\s+IN\s*\(/i);
    });

    it('the alias arm does NOT name any relational-class source as a filter literal', async () => {
      // Closes the gap a positive allowlist would otherwise leave: a
      // maintainer who reads only the SQL and reverts the allowlist to a
      // negative `source <> 'discogs_member'` shape silently re-admits
      // any future relational source. This test fails fast on that revert
      // by asserting no relational-class source name appears in the SQL.
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await resolveArtistId('Geordie Greep');

      const aliasSql = renderSql(executeMock.mock.calls[1][0]);
      for (const source of RELATIONAL_SOURCES) {
        expect(aliasSql).not.toContain(`'${source}'`);
      }
    });
  });

  describe('behaviour against the post-filter result set', () => {
    it.each(SYNONYM_SOURCES)(
      "returns { kind: 'alias' } when the alias arm surfaces a row for source=%s",
      async (source) => {
        // The mocked row carries `source` so the per-source coverage
        // claim is honest: each synonym-class source independently
        // produces an alias outcome. If a future change drops one source
        // from the allowlist the SQL would return [] for that source —
        // the contract tests above catch the SQL change, this test
        // documents the per-source semantic.
        executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ artist_id: 42, source }]);

        const result = await resolveArtistId('Thee Oh Sees');

        expect(result).toEqual({ kind: 'alias', artist_id: 42 });
      }
    );

    it("returns { kind: 'unmatched' } when the only candidate row was a discogs_member (filtered out at SQL time)", async () => {
      // Production shape: a single `discogs_member` row exists for the
      // variant. The SQL allowlist excludes it server-side; the mock
      // simulates the empty post-filter result. The orchestrator writes
      // NULL and the row falls to manual review — never mislabeled.
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await resolveArtistId('Geordie Greep');

      expect(result).toEqual({ kind: 'unmatched' });
    });

    it('collapses pre-filter ambiguity to a single resolved alias when only one synonym row survives', async () => {
      // Production shape from the BS#1368 audit: the same variant
      // ("Geordie Greep") points at two artists via two sources — a
      // `discogs_member` row at artist X (the old band) and a
      // `discogs_alias` row at artist Y (the legitimate synonym). Pre-
      // fix the alias arm saw both rows and returned `ambiguous`; the FK
      // stayed NULL. Post-fix the SQL strips the member row server-side
      // so the orchestrator sees only the synonym row and resolves to
      // Y. This is the semantic the BS#1383 filter introduces and the
      // test pins it so a future revert is caught.
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ artist_id: 9999, source: 'discogs_alias' }]);

      const result = await resolveArtistId('Geordie Greep');

      expect(result).toEqual({ kind: 'alias', artist_id: 9999 });
    });

    it('still returns ambiguous when two synonym-class rows point at different artists', async () => {
      // Negative twin of the disambiguation test: when the allowlist
      // does NOT collapse the result set to a singleton, the resolver
      // must still drop to `ambiguous` and leave the FK NULL. Otherwise
      // a future change that loosens the SELECT could silently start
      // picking one of two equally-good matches.
      executeMock.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { artist_id: 100, source: 'discogs_alias' },
        { artist_id: 200, source: 'discogs_name_variation' },
      ]);

      const result = await resolveArtistId('Some Common Variant');

      expect(result).toEqual({ kind: 'ambiguous' });
    });
  });

  describe('strict-wins is unchanged', () => {
    it('a strict singleton skips the alias arm entirely (no SQL filter involvement)', async () => {
      // Only one db.execute call should fire — the strict one. The alias
      // arm (and therefore the allowlist) is irrelevant when strict
      // resolves.
      executeMock.mockResolvedValueOnce([{ artist_id: 7 }]);

      const result = await resolveArtistId('Pavement');

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ kind: 'strict', artist_id: 7 });
    });
  });
});
