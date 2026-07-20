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
  loadCandidates,
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

const PARAM_PLACEHOLDER = '<?>';

/**
 * Best-effort render of a Drizzle SQL fragment back to its underlying
 * textual form so SQL-contract assertions can inspect the IN-list, the
 * predicate shape, etc.
 *
 * Drizzle's in-memory shape varies across (build mode, driver, ts-jest
 * transform). The renderer handles three forms:
 *   - `{ sql: string[], values: any[] }` — fragments interleaved with
 *     values; this is what surfaces under ts-jest's CJS transform of
 *     `sql\`...\``.
 *   - `{ queryChunks: Chunk[] }` — Drizzle's internal AST form (visible
 *     directly via `node` REPL against the ESM build).
 *   - `{ value: string | string[] }` — a StringChunk (what `sql.raw(s)`
 *     produces internally).
 *
 * Parameter-bound substitutions (`${raw}` user input passed without
 * `sql.raw`) render to the placeholder `<?>` rather than their actual
 * value. The helper inspects SQL SHAPE, not parameter VALUES: a
 * `not.toContain("'discogs_member'")` assertion must NOT fail just
 * because a future test fixture happens to pass `'discogs_member'` as
 * `${raw}`. The placeholder is the seam that keeps the assertion shape-
 * specific.
 *
 * Distinguishing a parameter from a structural string is heuristic:
 *   - Under `{sql, values}`, values that are plain JS strings/numbers
 *     are parameters; values that are objects (Drizzle SQL / Param /
 *     raw-chunk) are structural.
 *   - Under `{queryChunks}`, parameters appear as `Param` objects (a
 *     class instance carrying `.value`). We render those as the
 *     placeholder too. Static StringChunks have `.value: string[]` (an
 *     array — note the array vs string distinction is load-bearing for
 *     the param check).
 *
 * Brittle on purpose: a drizzle major bump that reshapes any of these
 * forms will surface as a noisy assertion failure, not a silent pass.
 */
const renderSql = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  // Plain JS scalar at the top level → parameter placeholder. Strings
  // and numbers passed via `${...}` in a tagged template surface here.
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return PARAM_PLACEHOLDER;
  }
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
  // StringChunk: `{ value: string[] }`. Drizzle's AST array form for a
  // chunk of static SQL. Concatenate the segments.
  if (Array.isArray(obj.value)) return obj.value.join('');
  // Param: `{ value: string }` (a single string, not array). The Param
  // class is how Drizzle wraps user-supplied template values; render as
  // placeholder so the param value can't leak into shape assertions.
  if (typeof obj.value === 'string') return PARAM_PLACEHOLDER;
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

    it('SYNONYM_ALIAS_SOURCES values are identifier-safe', () => {
      // The production resolver inline-quotes these values into a
      // `sql.raw` IN-list (jobs/concerts-artist-resolver/query.ts).
      // That's safe-by-construction only as long as the values stay
      // within Postgres' identifier charset — anything outside `[A-Za-
      // z0-9_]` (apostrophe, backslash, NUL, etc.) would inject. The
      // check used to live at module-load in query.ts as a thrown Error,
      // but that path runs before Sentry / the structured logger / the
      // safeFinalize teardown initialise — a bad value would crash-loop
      // the container with a bare Node trace, no actionable log line.
      // Pinning the contract in CI instead means a bad PR fails the
      // unit-test step and never deploys; production gets the cheaper,
      // unguarded `sql.raw` call.
      const nonIdentifier = /[^A-Za-z0-9_]/;
      const offenders = SYNONYM_ALIAS_SOURCES.filter((s) => nonIdentifier.test(s));
      expect(offenders).toEqual([]);
    });
  });

  describe('SQL contract', () => {
    it('the alias arm allowlists exactly the synonym-class sources as SQL literals', async () => {
      db.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await resolveArtistId('Geordie Greep');

      expect(db.execute).toHaveBeenCalledTimes(2);
      const aliasSql = renderSql(db.execute.mock.calls[1][0]);

      // Parses the IN-list literals out of the rendered SQL and
      // asserts the alias arm names EXACTLY the synonym-class sources
      // — no extras, no missing, no duplicates. A negative-form
      // predicate (`<>`) or a hotfix that hardcodes an extra source
      // outside the const would fail this. The parser assumes a flat
      // IN-list with single-quoted identifier-safe values; that
      // shape is pinned by `SYNONYM_ALIAS_SOURCES values are
      // identifier-safe` above. Sorted-array comparison rather than
      // Set so duplicates fail too (e.g., an assembly bug that emits
      // `('a','a','b')` for a 2-element tuple).
      const inListMatch = aliasSql.match(/"?source"?\s+IN\s*\(([^)]*)\)/i);
      expect(inListMatch).not.toBeNull();
      const inListLiterals = (inListMatch?.[1] || '')
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .filter((s) => s.length > 0);
      expect([...inListLiterals].sort()).toEqual([...SYNONYM_ALIAS_SOURCES].sort());
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

describe('loadCandidates — candidate predicate', () => {
  beforeEach(() => {
    db.execute.mockReset();
  });

  it('selects only unresolved rows that still carry a raw name', async () => {
    db.execute.mockResolvedValueOnce([{ id: 4062, headlining_artist_raw: 'REM' }]);

    const rows = await loadCandidates();

    expect(rows).toEqual([{ id: 4062, headlining_artist_raw: 'REM' }]);
    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain('"headlining_artist_id" IS NULL');
    expect(text).toContain('"headlining_artist_raw" IS NOT NULL');
    expect(text).toContain('ORDER BY "id" ASC');
  });

  it('excludes tribute-context rows — a tribute billing must never drive an FK write', async () => {
    // The Stanczyks mislabel: "REM Tribute to Lifes Rich Pageant" scraped a
    // raw name of "REM", which the alias arm resolved to the real R.E.M. via
    // a discogs_name_variation variant. In a tribute-framed event the billed
    // name belongs to (or aliases) the HONOREE, not the performer, so rows
    // whose title or raw name carries the word are not candidates at all.
    // Word-start match (\m) so a name like "Tributaries" doesn't trip it;
    // the title arm is NULL-safe because "title" is nullable.
    db.execute.mockResolvedValueOnce([]);

    await loadCandidates();

    const text = renderSql(db.execute.mock.calls[0][0]);
    expect(text).toContain(`("title" IS NULL OR "title" !~* '\\mtribute')`);
    expect(text).toContain(`"headlining_artist_raw" !~* '\\mtribute'`);
  });
});
