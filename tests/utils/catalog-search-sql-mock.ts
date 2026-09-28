/**
 * Content-dispatching mock for the Both-mode catalog search tiers.
 *
 * Every tier of `searchLibraryBothMode` now issues raw `db.execute(sql...)`
 * rather than a chained `db.select()` builder, because each one wraps its query
 * in the album-scoped `DENSE_RANK` + `DISTINCT ON (id)` shape that the chained
 * builder cannot express. That collapsed the old mocking strategy: tests used to
 * hand `db.select` a different chain per tier, which is no longer called, and
 * sequencing `db.execute` by call index instead is fragile — `db.execute` is
 * also used by `checkLibraryArtistNameHealth` (twice, before either tier runs)
 * and by the CTA cascade arm, so any change to how many probes a request makes
 * would silently reassign every test's rows to the wrong tier.
 *
 * So dispatch on the SQL's own content instead. A tier is identified by a
 * literal that only it emits, which makes the mapping robust to call order and
 * to new probes appearing elsewhere in the request.
 */

/**
 * Render a mocked `sql` fragment to text.
 *
 * The unit suite auto-mocks `drizzle-orm` (`tests/__mocks__/drizzle-orm.ts`), so
 * the `sql` tag returns `{ sql: TemplateStringsArray, values }` and a nested
 * fragment appears as one of those `values` — rendering is "interleave the
 * literals with the recursively-rendered values". Columns come from the mocked
 * `@wxyc/database`, whose tables are plain string maps, so an unmapped column
 * renders as `undefined`; harmless here, because every literal this module
 * matches on is SQL text written in the service, not a column reference.
 */
export function renderSqlWithParams(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return String(node);
  const literals = (node as { sql?: unknown }).sql;
  if (Array.isArray(literals)) {
    const values = (node as { values?: unknown[] }).values ?? [];
    return literals
      .map((text, i) => `${String(text)}${i < values.length ? renderSqlWithParams(values[i]) : ''}`)
      .join('');
  }
  const raw = (node as { raw?: unknown }).raw;
  if (typeof raw === 'string') return raw;
  return JSON.stringify(node) ?? '';
}

/** The query shapes a Both-mode catalog search can issue. */
export type CatalogQueryTier =
  /** `searchLibraryByTsvector` — ranks on `ts_rank * plays`. */
  | 'tsvector'
  /** `searchLibraryByTrigramBoth`, alias flag OFF — ranks on `GREATEST(similarity(...))`. */
  | 'trigram'
  /** `searchLibraryByTrigramBoth`, alias flag ON — the `alias_hits` CTE + UNION ALL. */
  | 'alias'
  /** `searchLibraryByCTARaw` — the compilation-track arm, windowed on `library_rank`. */
  | 'cta'
  /** `checkLibraryArtistNameHealth`'s two denormalization probes. */
  | 'health'
  /** Anything else, so an unrecognized query fails loudly rather than borrowing another tier's rows. */
  | 'other';

/**
 * Classify a rendered catalog query by a literal only that tier emits.
 *
 * Order matters in two places. `alias` is tested before `trigram` because the
 * alias path contains the same `GREATEST(similarity(...))` ranking as the
 * alias-off path — the `alias_hits` CTE is what distinguishes them. And `cta` is
 * tested before the rankers because its window alias (`library_rank`) is
 * deliberately different from theirs (`album_rank`).
 */
export function classifyCatalogQuery(rendered: string): CatalogQueryTier {
  if (rendered.includes('alias_hits')) return 'alias';
  if (rendered.includes('library_rank')) return 'cta';
  if (rendered.includes('ts_rank(')) return 'tsvector';
  if (rendered.includes('GREATEST(similarity(')) return 'trigram';
  if (rendered.includes('count(*)::int AS n')) return 'health';
  return 'other';
}

/** Rows to return per tier. Omitted tiers return `[]`. */
export type CatalogTierRows = Partial<Record<CatalogQueryTier, unknown[]>>;

/**
 * Point `db.execute` at per-tier rows, dispatching on SQL content.
 *
 * `alias` falls back to `trigram` when unset, so a test that only cares "the
 * trigram tier returned a row" does not have to know which of the two trigram
 * shapes the alias flag selected.
 */
export function mockCatalogTiers(execute: jest.Mock, rows: CatalogTierRows): void {
  activeRows = { ...rows };
  execute.mockReset();
  execute.mockImplementation((query: unknown) => {
    const tier = classifyCatalogQuery(renderSqlWithParams(query));
    const current = activeRows ?? {};
    const forTier = tier === 'alias' ? (current.alias ?? current.trigram) : current[tier];
    return Promise.resolve(forTier ?? []);
  });
}

/**
 * Rows for the dispatcher installed by the most recent `mockCatalogTiers`.
 *
 * Held at module scope so a test can add a later tier's rows — typically the CTA
 * arm's — without a handle to the dispatcher. That is what lets the cascade tests
 * keep reading as "primary tiers miss, then CTA answers" in the order the request
 * actually makes those calls, rather than having to declare every tier up front.
 */
let activeRows: CatalogTierRows | null = null;

/**
 * Forget the active dispatcher's rows.
 *
 * Call from a suite's `beforeEach`. `jest.clearAllMocks()` clears recorded calls
 * but leaves the `db.execute` implementation installed, and `activeRows` is
 * module scope, so without this a test that never calls `mockCatalogTiers`
 * inherits the previous test's rows instead of the empty result it expects —
 * silently, where an unstubbed `db.execute` used to fail loudly.
 */
export function resetCatalogTierRows(): void {
  activeRows = null;
}

/**
 * Merge more per-tier rows into the active dispatcher.
 *
 * Replaces a bare `db.execute.mockResolvedValue(rows)` placed after
 * `mockCatalogTiers`, which would clobber the dispatcher and hand those rows to
 * every tier — including the primary ones the test wants to return empty.
 */
export function setCatalogTierRows(patch: CatalogTierRows): void {
  activeRows = { ...(activeRows ?? {}), ...patch };
}

/**
 * The search tiers `db.execute` was asked for, in order.
 *
 * Replaces the `expect(db.select).toHaveBeenCalledTimes(n)` assertions that used
 * to stand in for "which tiers ran". Counting calls was only ever a proxy, and a
 * brittle one — it could not say WHICH tier ran, and it broke the moment a tier
 * changed how it builds its query. Naming the tiers asserts the routing directly.
 *
 * `health` is filtered out: `checkLibraryArtistNameHealth` runs two probes on
 * every request and is not part of the routing under test.
 */
export function catalogTierCallLog(execute: jest.Mock): CatalogQueryTier[] {
  return execute.mock.calls
    .map(([query]) => classifyCatalogQuery(renderSqlWithParams(query)))
    .filter((tier) => tier !== 'health');
}

/**
 * The rendered SQL of the last query issued for a tier, or `''` if it never ran.
 *
 * For assertions that used to inspect the chained builder — `chain.from` called
 * with `library` rather than `library_artist_view`, `album_plays` among the
 * `leftJoin` arguments. Those checked the builder's arguments as a proxy for the
 * SQL; this reads the SQL itself, so it keeps holding if the query is rebuilt a
 * third way.
 *
 * Note what renders: the mocked `@wxyc/database` exposes tables as plain string
 * maps, so a bare `${table}` interpolation renders EMPTY while a column renders
 * as `table.column`. So assert on column references (`library.search_doc`,
 * `album_plays.plays`), never on a bare table name.
 */
export function lastCatalogQuerySql(execute: jest.Mock, tier: CatalogQueryTier): string {
  const rendered = execute.mock.calls
    .map(([query]) => renderSqlWithParams(query))
    .filter((text) => classifyCatalogQuery(text) === tier);
  return rendered[rendered.length - 1] ?? '';
}

/**
 * The raw query object of the last call for a tier, for assertions that need the
 * bound VALUES rather than the SQL text — e.g. that `on_streaming` was threaded
 * through as a parameter.
 *
 * Replaces `db.execute.mock.calls[0]?.[0]`, which no longer names the query the
 * test means: `checkLibraryArtistNameHealth` issues two probes before any tier
 * runs, so index 0 is a health probe.
 */
export function lastCatalogQueryArg(execute: jest.Mock, tier: CatalogQueryTier): unknown {
  const matching = execute.mock.calls
    .map(([query]) => query)
    .filter((query) => classifyCatalogQuery(renderSqlWithParams(query)) === tier);
  return matching[matching.length - 1];
}

/**
 * Shorthand for the common alias-path setup: the tsvector tier misses, and the
 * alias-enabled trigram tier returns `rows`.
 *
 * Exists because a bare `db.execute.mockResolvedValue(rows)` no longer expresses
 * that — every tier goes through `db.execute`, so one blanket resolution hands
 * the alias rows to the tsvector tier as well, which then short-circuits and the
 * alias path never runs.
 */
export function mockAliasTierRows(execute: jest.Mock, rows: unknown[]): void {
  mockCatalogTiers(execute, { tsvector: [], alias: rows });
}
