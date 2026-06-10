/**
 * Unit tests for jobs/concerts-artist-resolver query.ts (BS#1383).
 *
 * `resolveArtistId` runs two SQL JOINs (strict-then-alias). The alias
 * arm is the load-bearing site for BS#1383: a `discogs_member` row in
 * `artist_search_alias` is a relational signal ("X was a member of Y"),
 * not a synonym signal. Folding it into the FK-write path produced the
 * Geordie Greep → black midi mislabel surfaced by the BS#1368 frequency
 * audit (Greep tours solo; WXYC only has his old band's records).
 *
 * The fix restricts the alias arm to the synonym-class sources via a
 * positive allowlist sourced from `SYNONYM_ALIAS_SOURCES` in query.ts.
 * Positive form is safe-by-default — a future LML source stays out of
 * the FK-write path until it is explicitly classified.
 *
 * Tests import the partition constants directly from the production
 * file so the SQL contract and the fixture sources cannot drift. The
 * mock returns the post-filter row set the SQL would have produced;
 * SQL-contract tests inspect the rendered SQL via `renderSql`,
 * behaviour tests assert outcome shapes against a parameterised mock.
 */
import { db } from '../../../mocks/database.mock';
import {
  resolveArtistId,
  SYNONYM_ALIAS_SOURCES,
  RELATIONAL_ALIAS_SOURCES,
} from '../../../../jobs/concerts-artist-resolver/query';

type SqlLike = {
  sql?: string | string[];
  values?: unknown[];
  queryChunks?: Array<unknown>;
  value?: string | string[];
  raw?: string;
};
/**
 * Best-effort render of a Drizzle SQL fragment back to its underlying
 * textual form so SQL-contract assertions can inspect the IN-list, the
 * predicate shape, etc.
 *
 * Drizzle's exact in-memory representation varies across (build mode,
 * driver, ts-jest transform): the most common shapes observed are
 *   - `{ sql: string[], values: any[] }` — fragments interleaved with
 *     values; this is what surfaces under ts-jest's CJS transform of
 *     `sql\`...\``.
 *   - `{ queryChunks: Chunk[] }` — Drizzle's internal AST form (visible
 *     directly via `node` REPL against the ESM build).
 *   - `{ value: string | string[] }` — a StringChunk (what `sql.raw(s)`
 *     produces internally).
 * Each branch is exercised by either the renderer-itself or by a parent
 * call that recurses. Parameter-bound substitutions (the `${raw}` user
 * input) render to empty — the helper inspects SQL SHAPE, not param
 * values. Brittle on purpose: a drizzle major bump that reshapes any of
 * the three forms will surface as a noisy assertion failure, not a
 * silent pass.
 */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  const obj = value as SqlLike;
  if (Array.isArray(obj.sql) && Array.isArray(obj.values)) {
    // Interleave: sql[0] + render(values[0]) + sql[1] + render(values[1]) + ... + sql[n]
    const fragments = obj.sql;
    const values = obj.values;
    const parts: string[] = [];
    fragments.forEach((fragment, i) => {
      parts.push(fragment);
      if (i < values.length) {
        parts.push(renderSql(values[i]));
      }
    });
    return parts.join('');
  }
  if (Array.isArray(obj.sql)) return obj.sql.join('');
  if (typeof obj.sql === 'string') return obj.sql;
  if (obj.queryChunks) {
    return obj.queryChunks.map((chunk) => renderSql(chunk)).join('');
  }
  if (typeof obj.raw === 'string') return obj.raw;
  if (Array.isArray(obj.value)) return obj.value.join('');
  if (typeof obj.value === 'string') return obj.value;
  return '';
};

describe('resolveArtistId — synonym-class allowlist (BS#1383)', () => {
  beforeEach(() => {
    // `mockReset` matches the project convention used by 24 other
    // unit-test files. It clears the default `mockResolvedValue([])`
    // set by `tests/mocks/database.mock.ts`, so a test that forgets a
    // `mockResolvedValueOnce` causes `unwrapRows` in query.ts to throw
    // its "unrecognized db.execute() result shape: undefined" diagnostic.
    // That throw is preferable to a silent default-array fallthrough:
    // the message names the file and the failure mode directly, vs an
    // "expected alias got unmatched" assertion mismatch that doesn't
    // hint at the missing mock.
    db.execute.mockReset();
  });

  describe('partition completeness', () => {
    // Guards the test fixtures themselves against drift. A future
    // refactor that derives SYNONYM_ALIAS_SOURCES (e.g., a filter that
    // returns `[]` due to a renamed classifier) would silently produce
    // zero parameterised tests below. These assertions ensure that
    // dead-suite case fails noisily instead of reporting green.
    it('SYNONYM_ALIAS_SOURCES is non-empty', () => {
      expect(SYNONYM_ALIAS_SOURCES.length).toBeGreaterThan(0);
    });

    it('RELATIONAL_ALIAS_SOURCES is non-empty', () => {
      expect(RELATIONAL_ALIAS_SOURCES.length).toBeGreaterThan(0);
    });

    it('the two classes do not overlap', () => {
      const overlap = SYNONYM_ALIAS_SOURCES.filter((s) => (RELATIONAL_ALIAS_SOURCES as readonly string[]).includes(s));
      expect(overlap).toEqual([]);
    });
  });

  describe('SQL contract', () => {
    it('the alias arm allowlists every synonym-class source as a SQL literal', async () => {
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await resolveArtistId('Geordie Greep');

      expect(db.execute).toHaveBeenCalledTimes(2);
      const aliasSql = renderSql(db.execute.mock.calls[1][0]);

      // Positive contract: every synonym-class source appears as a
      // quoted SQL literal inside an `IN (...)` predicate. A negative-
      // form predicate (`<>`) would silently admit every future source
      // and reintroduce the BS#1368 mislabel under a new label.
      for (const source of SYNONYM_ALIAS_SOURCES) {
        expect(aliasSql).toContain(`'${source}'`);
      }
      expect(aliasSql).toMatch(/"?source"?\s+IN\s*\(/i);
    });

    it('the alias arm does NOT name any relational-class source as a filter literal', async () => {
      // Pinned against a revert to negative form. If a maintainer
      // swaps the IN-list for `source <> 'discogs_member'` the literal
      // would appear here and this test would fail.
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await resolveArtistId('Geordie Greep');

      // Both arms must have fired before mock.calls[1] is readable.
      // Indexing without the guard would crash with TypeError if a
      // future strict-arm change short-circuits before the alias call.
      expect(db.execute).toHaveBeenCalledTimes(2);
      const aliasSql = renderSql(db.execute.mock.calls[1][0]);
      for (const source of RELATIONAL_ALIAS_SOURCES) {
        expect(aliasSql).not.toContain(`'${source}'`);
      }
    });
  });

  describe('behaviour against the post-filter result set', () => {
    it.each(SYNONYM_ALIAS_SOURCES)(
      "returns { kind: 'alias' } when the alias arm surfaces a row for source=%s",
      async (source) => {
        // Each synonym-class source independently produces an alias
        // outcome. The mock carries `source` on the row so the per-
        // source coverage claim is honest — a future change that
        // drops one source from the allowlist would no longer surface
        // a row for that source in production; the SQL-contract test
        // above is what catches that path.
        db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ artist_id: 42, source }]);

        const result = await resolveArtistId('Thee Oh Sees');

        expect(result).toEqual({ kind: 'alias', artist_id: 42 });
      }
    );

    it("returns { kind: 'unmatched' } when the only candidate row was a discogs_member (filtered out at SQL time)", async () => {
      // Production shape: a single `discogs_member` row exists for
      // the variant. The SQL allowlist excludes it server-side; the
      // mock simulates the empty post-filter result. The orchestrator
      // writes NULL and the row falls to manual review — never
      // mislabeled.
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await resolveArtistId('Geordie Greep');

      expect(result).toEqual({ kind: 'unmatched' });
    });

    it('collapses pre-filter ambiguity to a single resolved alias when only one synonym row survives', async () => {
      // Production shape from the BS#1368 audit: the same variant
      // ("Geordie Greep") points at two artists via two sources — a
      // `discogs_member` row at artist X (the old band) and a
      // `discogs_alias` row at artist Y (the legitimate synonym).
      // Pre-fix the alias arm saw both rows and returned `ambiguous`;
      // the FK stayed NULL. Post-fix the SQL strips the member row
      // server-side so the orchestrator sees only the synonym row and
      // resolves to Y. This is the semantic the BS#1383 filter
      // introduces and the test pins it so a future revert is caught.
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ artist_id: 9999, source: 'discogs_alias' }]);

      const result = await resolveArtistId('Geordie Greep');

      expect(result).toEqual({ kind: 'alias', artist_id: 9999 });
    });

    it('still returns ambiguous when two synonym-class rows point at different artists', async () => {
      // Negative twin of the disambiguation test: when the allowlist
      // does NOT collapse the result set to a singleton, the resolver
      // must still drop to `ambiguous` and leave the FK NULL.
      // Otherwise a future change that loosens the SELECT could
      // silently start picking one of two equally-good matches.
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { artist_id: 100, source: 'discogs_alias' },
        { artist_id: 200, source: 'discogs_name_variation' },
      ]);

      const result = await resolveArtistId('Some Common Variant');

      expect(result).toEqual({ kind: 'ambiguous' });
    });
  });

  describe('strict-wins is unchanged', () => {
    it('a strict singleton skips the alias arm entirely (no SQL filter involvement)', async () => {
      // Only one db.execute call should fire — the strict one. The
      // alias arm (and therefore the allowlist) is irrelevant when
      // strict resolves.
      db.execute.mockResolvedValueOnce([{ artist_id: 7 }]);

      const result = await resolveArtistId('Pavement');

      expect(db.execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ kind: 'strict', artist_id: 7 });
    });
  });
});
