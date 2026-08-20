import * as Sentry from '@sentry/node';
import { inArray, sql, type SQL } from 'drizzle-orm';
import {
  db,
  library,
  library_artist_view,
  genres,
  format as formatTable,
  album_plays,
  ROTATION_BINS,
} from '@wxyc/database';
import type { TrackMatchHint } from '@wxyc/shared/dtos';
import {
  parseSearchQuery,
  CATALOG_PARSER_CONFIG,
  type CatalogField,
  type SearchCondition,
} from './search-parser.service.js';
import { runCatalogTrackSearchCascade, type TaggedLibraryViewEntry } from './library.service.js';
import type { ArtistMatchHint, ArtistSearchAliasSource } from './requestLine/types.js';
import { getConfig as getCatalogSearchAliasConfig } from '../config/catalogSearchAlias.js';
import WxycError from '../utils/error.js';
import { ilikeEscaped } from '../utils/sql-like.js';
import { buildAliasHitsCte, buildAliasOnlyTier } from '../utils/alias-hits.js';

export type CatalogSort = 'artist' | 'album' | 'plays' | 'date';
export type CatalogOrder = 'asc' | 'desc';

/**
 * Bins exposed as catalog tag filters — the complete set, not a subset.
 * Aliased rather than redeclared so it cannot drift from `freq_enum`; the array
 * (ordered) form is load-bearing because `parseRotationBinsQueryList` renders it
 * into a user-facing error via `.join(', ')`.
 */
export const VALID_ROTATION_BINS = ROTATION_BINS;
export type CatalogRotationBin = (typeof VALID_ROTATION_BINS)[number];

export type LibraryQueryParams = {
  q: string;
  page: number;
  limit: number;
  sort: CatalogSort;
  order: CatalogOrder;
  on_streaming?: boolean;
  /** When true, only albums currently marked missing in the library. */
  missing?: boolean;
  /** OR filter — empty/undefined means no genre constraint. */
  genres?: string[];
  /** OR filter — empty/undefined means no format constraint. */
  formats?: string[];
  /** OR filter — active rotation_bin must be one of these values. */
  rotation_bins?: CatalogRotationBin[];
};

export type AlbumSearchResultRow = {
  id: number;
  add_date: string;
  album_title: string;
  artist_name: string;
  artist_id: number;
  code_letters: string;
  code_number: number;
  code_artist_number: number;
  format_name: string;
  genre_name: string;
  label: string;
  label_id: number | null;
  rotation_bin: string | null;
  plays: number | null;
  on_streaming: boolean | null;
  album_artist: string | null;
  matched_via?: TrackMatchHint[];
  matched_via_alias?: ArtistMatchHint[];
  // BS#1895 (Not-on-Discogs epic #1280 sub-issue 5): the MD-set flag, so
  // catalog-search cards can gate rendering the same way album-detail does.
  discogsUnavailable: boolean;
  discogsUnavailableNote: string | null;
  lastDiscogsRecheckAt: Date | string | null;
};

const FIELD_COLUMNS: Record<CatalogField, SQL> = {
  artist_name: sql`${library_artist_view.artist_name}`,
  album_title: sql`${library_artist_view.album_title}`,
  label: sql`${library_artist_view.label}`,
};

// BS#1489: `library_artist_view.plays` projects the physical `library.plays`
// column, which nothing maintains — it is 0 for every row, so `sort=plays`
// ordered a constant (silently a no-op, falling through to the secondary
// tiebreak). The real per-album play count lives in the `album_plays` MV
// (migration 0059) — the same live `COUNT(*)` over flowsheet track entries the
// catalog export and the tsvector ranker read. Scope a LEFT JOIN to it into the
// search query and source `plays` from it, rather than redefining the view (the
// view is read by several other code paths; this keeps the blast radius on the
// one surface with the bug). The join is 1:1 (unique index on
// `album_plays.album_id`), so it never changes the result set or `COUNT(*)`;
// COALESCE 0 covers never-played albums, which have no MV row.
const albumPlaysJoin = sql`LEFT JOIN ${album_plays} ON ${album_plays.album_id} = ${library_artist_view.id}`;
const playsColumn = sql`COALESCE(${album_plays.plays}, 0)`;

// BS#1554: when an album has more than one active rotation row (e.g. H and
// M simultaneously), the DISTINCT ON (id) dedup below must keep the
// heaviest active bin, not the lightest. `rotation_bin`'s underlying
// `freq_enum` sorts S < L < M < H — declaration order, which runs lightest to
// heaviest — so a bare `rotation_bin ASC` keeps the lightest. This explicit
// CASE assigns H the lowest ordinal so the `ASC` used at every DISTINCT-ON
// site surfaces the heaviest bin instead.
//
// The `ELSE` is not a totality guard for a hypothetical: it is the hot
// path. `library_artist_view` LEFT JOINs `rotation` (filtered to live rows), so
// `rotation_bin` is NULL for every catalog album not currently in rotation —
// the large majority — and `CASE NULL WHEN 'H' ...` falls through to 5 on all
// of them. That is correct: a LEFT JOIN cannot produce both a NULL and a
// non-NULL row for the same `id`, so ordinal 5 never competes inside a
// `DISTINCT ON` group. Keep the `ELSE` regardless — without it the expression
// yields NULL, which sorts last under the bare `ASC` used here but FIRST under
// a `DESC`, a trap for any future caller that flips the direction.
const ROTATION_BIN_DEDUP_ORDINAL = sql`CASE rotation_bin WHEN 'H' THEN 1 WHEN 'M' THEN 2 WHEN 'L' THEN 3 WHEN 'S' THEN 4 ELSE 5 END`;

const SORT_COLUMNS: Record<CatalogSort, SQL> = {
  artist: sql`${library_artist_view.artist_name}`,
  album: sql`${library_artist_view.album_title}`,
  plays: playsColumn,
  date: sql`${library_artist_view.add_date}`,
};

const SECONDARY_SORT: Record<CatalogSort, SQL> = {
  artist: sql`${library_artist_view.album_title}`,
  album: sql`${library_artist_view.artist_name}`,
  plays: sql`${library_artist_view.artist_name}`,
  date: sql`${library_artist_view.artist_name}`,
};

// Bare-column variants for use in an outer ORDER BY after a UNION ALL — once
// the union closes, the outer query sees the combined column set by SELECT
// alias, not by underlying table. The qualified `library_artist_view.col`
// reference in SORT_COLUMNS / SECONDARY_SORT wouldn't resolve at that level.
const SORT_COLUMNS_UNQUALIFIED: Record<CatalogSort, SQL> = {
  artist: sql`artist_name`,
  album: sql`album_title`,
  plays: sql`plays`,
  date: sql`add_date`,
};

const SECONDARY_SORT_UNQUALIFIED: Record<CatalogSort, SQL> = {
  artist: sql`album_title`,
  album: sql`artist_name`,
  plays: sql`artist_name`,
  date: sql`artist_name`,
};

export const MIN_CASCADE_QUERY_LENGTH = 4;
export const MAX_CASCADE_CONDITIONS = 6;

export function isPlainTextQuery(conditions: SearchCondition<CatalogField>[]): boolean {
  if (conditions.length === 0 || conditions.length > MAX_CASCADE_CONDITIONS) return false;
  return conditions.every((c) => c.field === 'all' && !c.exact && !c.negated && c.operator === 'AND');
}

export function passesCascadeGate(trimmedQ: string, conditions: SearchCondition<CatalogField>[]): boolean {
  if (trimmedQ.length < MIN_CASCADE_QUERY_LENGTH) return false;
  return isPlainTextQuery(conditions);
}

/**
 * Search the catalog with parsed query conditions, enum filters, sort,
 * and offset pagination. Reads `library_artist_view` so callers get the
 * same flat shape as the `/library/` endpoint.
 *
 * Pagination is offset-based (catalog sorts are non-temporal — relevance,
 * title, plays, addition date — and the secondary `artist_name` tiebreaker
 * makes paginated results deterministic without a cursor). When `q` is
 * empty, the call degenerates to a sorted page over the filter intersection.
 */
export async function searchLibrary(
  params: LibraryQueryParams
): Promise<{ results: AlbumSearchResultRow[]; total: number }> {
  await validateEnumFilters(params.genres, params.formats);

  const conditions = parseSearchQuery(params.q, CATALOG_PARSER_CONFIG);
  // Alias is keyed on the raw `q` (matched as a single string in the
  // alias_hits CTE). Read once per request so a `getConfig()` invalidation
  // mid-call doesn't give the SELECT projection and the WHERE predicate
  // different views of the flag — alias rows would surface in the SELECT
  // but get re-filtered out by the WHERE.
  //
  // Also gate on `hasAllField`: alias substrate matching is only routed
  // for queries that include at least one `field === 'all'` condition.
  // Field-specific queries (`artist:foo`, `album:bar`) stay on the legacy
  // single-SELECT plan — they're narrow searches where alias expansion
  // would surface canonical-name-mismatched rows that the user explicitly
  // scoped against. Preserves pre-#1318 behavior for those paths; opening
  // alias expansion to field-specific queries is a future product call.
  const hasAllFieldCondition = conditions.some((c) => c.field === 'all');
  const aliasConfig = getCatalogSearchAliasConfig();
  const aliasActive = aliasConfig.enabled && params.q.trim().length > 0 && hasAllFieldCondition;
  const filterWhere = buildFilterClause(params);

  const orderDirection = params.order === 'asc' ? sql`ASC` : sql`DESC`;
  const offset = params.page * params.limit;

  let dataQuery: SQL;
  let countQuery: SQL;
  if (aliasActive) {
    // ALT1 UNION ALL (BS#1318). The CTE runs the trigram bitmap scan over
    // `artist_search_alias` once, then we emit two branches:
    //   (a) byte-identical to the alias-OFF path — query conditions
    //       evaluated WITHOUT the alias-OR — so the planner can pick the
    //       same per-column GIN trigram / ILIKE plan it picks today, and
    //       LIMIT pushdown stays intact.
    //   (b) alias-only hits, INNER JOIN'd to alias_hits on artist_id, with
    //       a dedupe predicate that excludes anything already in (a).
    //
    // The (a)-shaped WHERE is referenced by reference equality in (b)'s
    // dedupe so the two branches can't drift on what counts as a match.
    const queryWhereAliasOff = buildWhereClause(conditions);
    const branchAWhere = combineWhere(queryWhereAliasOff, filterWhere);
    // Branch (b): the row satisfies `filterWhere` AND its artist_id has an
    // alias hit AND the row would NOT have matched branch (a). Uses the
    // NULL-safe `IS NOT TRUE` rather than `NOT (...)` (BS#1557): `label` is
    // nullable, so an alias-only hit on a NULL-label row makes
    // queryWhereAliasOff evaluate to NULL — `NOT NULL` is NULL (dropped from
    // both arms), but `NULL IS NOT TRUE` is TRUE (kept in b), which is exactly
    // the alias-only row the feature exists to surface. When queryWhereAliasOff
    // is null (defensive — aliasActive gates on hasAllFieldCondition so this is
    // unreachable today), (b) emits nothing, which is what we want.
    const dedupeWhere = queryWhereAliasOff ? sql`(${queryWhereAliasOff}) IS NOT TRUE` : sql`FALSE`;
    const branchBWhere = combineWhere(dedupeWhere, filterWhere);

    // BS#2018 Fix 1: tier the sort so branch-(b) rows — matched only through
    // a fuzzy alias variant — always land after branch-(a) rows, which matched
    // the query text itself. `alias_max_sim` was computed and projected from
    // day one but never ordered on, so a 0.333 typo collision ("Monore" for a
    // "monolake" query) sorted identically to an exact hit and, via the
    // `artist_id` INNER JOIN, put an entire unrelated discography at the top
    // of the page. `FALSE < TRUE` in Postgres, so ASC puts the real matches
    // first; the caller's own sort follows, unchanged, within each tier.
    //
    // The tier is deliberately "is it alias-only", NOT `alias_max_sim DESC`:
    // the score never reaches the wire shape, so `sortAlbumRows` (which
    // re-sorts this same row set in memory when the cascade fires) could not
    // reproduce a score-based order and the two would drift. The boolean
    // survives that round trip; a score does not.
    //
    // It stays UNCONDITIONAL here. BS#2020 narrowed the equivalent tier on the
    // two relevance-ranked paths in `library.service.ts` to fuzzy hits only,
    // which does not transfer: this ORDER BY has no relevance term for an
    // exempted row to be ranked by, so exempting one would merely alphabetize
    // it among the real matches — an exact-variant artist with 30
    // early-alphabet albums would take page 0 outright. The narrowing is
    // justified there by the absence of an OFFSET, which this path has.
    const orderBy = sql`${buildAliasOnlyTier()}, ${SORT_COLUMNS_UNQUALIFIED[params.sort]} ${orderDirection}, ${SECONDARY_SORT_UNQUALIFIED[params.sort]} ASC, id ASC`;

    // BS#2018 Fix 2 (the `similarity(...) >= floor` post-filter) lives inside
    // the shared builder in `utils/alias-hits.ts`, so this path and the two in
    // `library.service.ts` can't drift on what counts as an alias match.
    const cte = buildAliasHitsCte(params.q, aliasConfig.minSimilarity);

    const branchAProjection = sql`
      ${library_artist_view.id} AS id,
      ${library_artist_view.add_date} AS add_date,
      ${library_artist_view.album_title} AS album_title,
      ${library_artist_view.artist_name} AS artist_name,
      ${library_artist_view.artist_id} AS artist_id,
      ${library_artist_view.code_letters} AS code_letters,
      ${library_artist_view.code_number} AS code_number,
      ${library_artist_view.code_artist_number} AS code_artist_number,
      ${library_artist_view.format_name} AS format_name,
      ${library_artist_view.genre_name} AS genre_name,
      ${library_artist_view.label} AS label,
      ${library_artist_view.label_id} AS label_id,
      ${library_artist_view.rotation_bin} AS rotation_bin,
      ${playsColumn} AS plays,
      ${library_artist_view.on_streaming} AS on_streaming,
      ${library_artist_view.album_artist} AS album_artist,
      ${library_artist_view.discogs_unavailable} AS discogs_unavailable,
      ${library_artist_view.discogs_unavailable_note} AS discogs_unavailable_note,
      ${library_artist_view.last_discogs_recheck_at} AS last_discogs_recheck_at,
      NULL::real AS alias_max_sim,
      NULL::text AS alias_matched_variant,
      NULL::text AS alias_matched_source`;
    const branchBProjection = sql`
      ${library_artist_view.id} AS id,
      ${library_artist_view.add_date} AS add_date,
      ${library_artist_view.album_title} AS album_title,
      ${library_artist_view.artist_name} AS artist_name,
      ${library_artist_view.artist_id} AS artist_id,
      ${library_artist_view.code_letters} AS code_letters,
      ${library_artist_view.code_number} AS code_number,
      ${library_artist_view.code_artist_number} AS code_artist_number,
      ${library_artist_view.format_name} AS format_name,
      ${library_artist_view.genre_name} AS genre_name,
      ${library_artist_view.label} AS label,
      ${library_artist_view.label_id} AS label_id,
      ${library_artist_view.rotation_bin} AS rotation_bin,
      ${playsColumn} AS plays,
      ${library_artist_view.on_streaming} AS on_streaming,
      ${library_artist_view.album_artist} AS album_artist,
      ${library_artist_view.discogs_unavailable} AS discogs_unavailable,
      ${library_artist_view.discogs_unavailable_note} AS discogs_unavailable_note,
      ${library_artist_view.last_discogs_recheck_at} AS last_discogs_recheck_at,
      alias_hits.max_sim AS alias_max_sim,
      alias_hits.matched_variant AS alias_matched_variant,
      alias_hits.matched_source AS alias_matched_source`;

    const branchAFrom = branchAWhere
      ? sql`FROM ${library_artist_view} ${albumPlaysJoin} WHERE ${branchAWhere}`
      : sql`FROM ${library_artist_view} ${albumPlaysJoin}`;
    const branchBFrom = branchBWhere
      ? sql`FROM ${library_artist_view} INNER JOIN alias_hits ON alias_hits.artist_id = ${library_artist_view.artist_id} ${albumPlaysJoin} WHERE ${branchBWhere}`
      : sql`FROM ${library_artist_view} INNER JOIN alias_hits ON alias_hits.artist_id = ${library_artist_view.artist_id} ${albumPlaysJoin}`;

    const unionBody = sql`(
      SELECT ${branchAProjection}
      ${branchAFrom}
    )
    UNION ALL
    (
      SELECT ${branchBProjection}
      ${branchBFrom}
    )`;

    dataQuery = sql`
      ${cte}
      SELECT * FROM (
        SELECT DISTINCT ON (id) * FROM (${unionBody}) AS raw
        ORDER BY id ASC, ${ROTATION_BIN_DEDUP_ORDINAL} ASC
      ) AS deduped
      ORDER BY ${orderBy}
      LIMIT ${params.limit} OFFSET ${offset}
    `;
    // BS#1885: also count non-alias rows, so the caller can tell "matched
    // via alias only" (cascade must run) apart from "matched for real"
    // (short-circuit as today) without re-deriving it from the page rows —
    // a genuine non-alias row can sort beyond `limit` and be absent from
    // `results` on page 0. Safe to carry `alias_max_sim` through the same
    // DISTINCT ON (id) dedupe as the data query: branch (a) always projects
    // NULL, branch (b) always projects non-null, and branch (b)'s dedupe
    // predicate guarantees a given id can't appear in both.
    countQuery = sql`
      ${cte}
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE alias_max_sim IS NULL)::int AS total_non_alias
      FROM (
        SELECT DISTINCT ON (id) id, alias_max_sim FROM (${unionBody}) AS raw
        ORDER BY id ASC, ${ROTATION_BIN_DEDUP_ORDINAL} ASC
      ) AS deduped
    `;
  } else {
    // Alias OFF (legacy path). Single SELECT against library_artist_view,
    // no CTE, no UNION ALL — byte-identical to pre-#1318 behavior.
    const queryWhere = buildWhereClause(conditions);
    const where = combineWhere(queryWhere, filterWhere);
    const fromClause = where
      ? sql`FROM ${library_artist_view} ${albumPlaysJoin} WHERE ${where}`
      : sql`FROM ${library_artist_view} ${albumPlaysJoin}`;
    const orderBy = sql`${SORT_COLUMNS_UNQUALIFIED[params.sort]} ${orderDirection}, ${SECONDARY_SORT_UNQUALIFIED[params.sort]} ASC, id ASC`;
    const innerSelect = sql`
      SELECT
        ${library_artist_view.id} AS id,
        ${library_artist_view.add_date} AS add_date,
        ${library_artist_view.album_title} AS album_title,
        ${library_artist_view.artist_name} AS artist_name,
        ${library_artist_view.artist_id} AS artist_id,
        ${library_artist_view.code_letters} AS code_letters,
        ${library_artist_view.code_number} AS code_number,
        ${library_artist_view.code_artist_number} AS code_artist_number,
        ${library_artist_view.format_name} AS format_name,
        ${library_artist_view.genre_name} AS genre_name,
        ${library_artist_view.label} AS label,
        ${library_artist_view.label_id} AS label_id,
        ${library_artist_view.rotation_bin} AS rotation_bin,
        ${playsColumn} AS plays,
        ${library_artist_view.on_streaming} AS on_streaming,
        ${library_artist_view.album_artist} AS album_artist,
        ${library_artist_view.discogs_unavailable} AS discogs_unavailable,
        ${library_artist_view.discogs_unavailable_note} AS discogs_unavailable_note,
        ${library_artist_view.last_discogs_recheck_at} AS last_discogs_recheck_at
      ${fromClause}
    `;
    dataQuery = sql`
      SELECT * FROM (
        SELECT DISTINCT ON (id) * FROM (${innerSelect}) AS raw
        ORDER BY id ASC, ${ROTATION_BIN_DEDUP_ORDINAL} ASC
      ) AS deduped
      ORDER BY ${orderBy}
      LIMIT ${params.limit} OFFSET ${offset}
    `;
    countQuery = sql`
      SELECT COUNT(*)::int AS total FROM (
        SELECT DISTINCT ON (id) id FROM (${innerSelect}) AS raw
        ORDER BY id ASC, ${ROTATION_BIN_DEDUP_ORDINAL} ASC
      ) AS deduped
    `;
  }

  const [dataRows, countRows] = await Promise.all([db.execute(dataQuery), db.execute(countQuery)]);

  const results = (dataRows as unknown as RawRow[]).map(toAlbumSearchResultRow);
  const countRow = (countRows as unknown as { total: number; total_non_alias?: number }[])[0];
  const total = countRow?.total ?? 0;
  // BS#1885: alias-branch hits must not count toward "primary search found
  // something." Alias OFF: totalNonAlias === total, so the gate below is
  // byte-identical to the pre-fix `total > 0 || results.length > 0`. Alias
  // ON: a genuine (non-alias) row still short-circuits with zero new LML
  // traffic; an alias-only (or empty) primary set falls through to the
  // cascade guards below.
  const totalNonAlias = aliasActive ? (countRow?.total_non_alias ?? 0) : total;
  if (totalNonAlias > 0 || (!aliasActive && results.length > 0)) return { results, total };

  // Catalog-track-search cascade (BS#977, multi-word relaxation BS#1146).
  // Guards trim worst-case inputs (typo storms, query-builder abuse) before
  // LML's `Semaphore(5) + TokenBucket(50/min)` chokepoint; pagination beyond
  // page 0 stays empty so clients don't scroll a bounded fallback list.
  if (params.page !== 0) return { results, total };
  // Cascade rows carry no date_lost/date_found, so they can never be
  // known-missing — skip the cascade only for `missing=true` (BS#1552).
  // `missing=false` (dj-site's default "hide lost records" filter) still runs
  // it: cascade rows are, by construction, non-missing and must surface.
  if (params.missing === true) return { results, total };
  const trimmed = params.q.trim();
  if (!passesCascadeGate(trimmed, conditions)) return { results, total };

  // Attribute set at startSpan creation so Sentry indexes it numerically
  // (avoids the BS#1081 string-typing trap that breaks avg/p50/p90).
  const cascadeResults = await Sentry.startSpan(
    {
      name: 'catalog.cascade',
      op: 'catalog.cascade',
      attributes: { 'cascade.query_word_count': conditions.length },
    },
    () => runCascade(params, trimmed)
  );
  if (cascadeResults.length === 0) return { results, total };
  // Today's pure-fallback path (zero primary rows at all — alias OFF or
  // alias ON with no alias hits either), unchanged.
  if (results.length === 0) return { results: cascadeResults, total: cascadeResults.length };

  // BS#1885: alias rows and cascade rows both exist — merge rather than
  // overwrite so the alias-noise rows (e.g. "Duane" for a "Nuane" query)
  // don't hide the cascade's real answer, and vice versa.
  const aliasById = new Map(results.map((r) => [r.id, r]));
  const enrichedCascade = cascadeResults.map((r) => {
    const dup = aliasById.get(r.id);
    // Id collision: the cascade already resolved this row for real — keep
    // the cascade row (its matched_via is the stronger signal) but carry the
    // alias hint along too so the UI can show both.
    return dup?.matched_via_alias ? { ...r, matched_via_alias: dup.matched_via_alias } : r;
  });
  const cascadeIds = new Set(cascadeResults.map((r) => r.id));
  // BS#2018 Fix 1, merge half. We reach here only when `totalNonAlias === 0`,
  // so every row in `results` matched via alias and nothing else — which makes
  // "not in `cascadeIds`" an exact statement of alias-only over this row set,
  // with no dependence on which optional hint fields a cascade row happens to
  // carry.
  const merged = sortAlbumRows(
    [...enrichedCascade, ...results.filter((r) => !cascadeIds.has(r.id))],
    params,
    (row) => !cascadeIds.has(row.id)
  ).slice(0, params.limit);
  const added = cascadeResults.filter((r) => !aliasById.has(r.id)).length;
  // Known imprecision, acceptable: this merge only runs on page 0 (the
  // `page !== 0` guard above returns first), so both a count skew and a
  // row-set skew are possible against later pages — all bounded by cascade
  // size (<= limit) and, by construction, over alias *noise* rows, never the
  // cascade's real answer:
  //   - `total`: a cascade row that duplicates an alias row beyond page 0 can
  //     be double-counted, and page 0's total (inflated by `added`) can
  //     disagree with the same query's page 1 total (not inflated).
  //   - row set: when there are more than `limit` alias rows, the sort+slice
  //     can bump some page-0 alias rows out of the page; page 1 is served by
  //     the raw SQL query at `OFFSET limit`, so those displaced alias-noise
  //     rows aren't picked up there either. The cascade's real answer stays on
  //     page 0, so the dropped rows are only fuzzy alias noise.
  // Not worth chasing exactness for a bounded fallback page.
  return { results: merged, total: total + added };
}

async function runCascade(params: LibraryQueryParams, q: string): Promise<AlbumSearchResultRow[]> {
  const cascade: TaggedLibraryViewEntry[] = await runCatalogTrackSearchCascade(q, params.limit, params.on_streaming);
  if (cascade.length === 0) return [];

  // Neither raw cascade primitive applies enum filters (genre/format), and
  // `searchLibraryByTrackRaw` does not honor `on_streaming` (`searchLibraryByCTARaw`
  // already does, but re-checking is a harmless no-op). Apply both filters
  // in-memory over the bounded fallback list before serializing.
  const filtered = cascade.filter((row) => {
    if (params.on_streaming !== undefined && row.on_streaming !== params.on_streaming) return false;
    if (params.genres !== undefined && params.genres.length > 0 && !params.genres.includes(row.genre_name)) {
      return false;
    }
    if (params.formats !== undefined && params.formats.length > 0 && !params.formats.includes(row.format_name)) {
      return false;
    }
    if (
      params.rotation_bins !== undefined &&
      params.rotation_bins.length > 0 &&
      (row.rotation_bin === null || !params.rotation_bins.includes(row.rotation_bin as CatalogRotationBin))
    ) {
      return false;
    }
    return true;
  });
  if (filtered.length === 0) return [];

  const projected = filtered.map(taggedRowToAlbumSearchResultRow);
  return sortAlbumRows(projected, params);
}

/**
 * Sort album rows by the caller's `sort`/`order`, with the same alias tier,
 * secondary tiebreak, and id tiebreak the catalog's primary SQL query uses.
 * Shared by the cascade (whose rows never touch SQL `ORDER BY`) and the
 * alias/cascade merge (BS#1885), which re-sorts a combined row set after
 * `runCascade` and the primary alias rows are spliced together.
 *
 * `isAliasOnly` is the in-memory mirror of `buildAliasOnlyTier()` (BS#2018
 * Fix 1) — this path's SQL tier, which BS#2020 deliberately left
 * unconditional; the narrowed `buildFuzzyAliasTier()` is not used here, so the
 * mirror stays exact. Callers pass it explicitly rather than letting
 * this function infer it from the row's fields. Inference was tried and is
 * wrong: `matched_via` is set on a Track-2 cascade row only when LML returned
 * a non-empty hint list, so a real cascade answer can arrive bare, and if it
 * also collides on `id` with an alias row the BS#1885 merge copies
 * `matched_via_alias` onto it — making it indistinguishable from noise by
 * shape alone. Both call sites know exactly which rows came from where, so
 * they say so. Defaults to "nothing is alias-only", which is correct for the
 * pure-cascade path.
 */
function sortAlbumRows(
  rows: AlbumSearchResultRow[],
  params: Pick<LibraryQueryParams, 'sort' | 'order'>,
  isAliasOnly: (row: AlbumSearchResultRow) => boolean = () => false
): AlbumSearchResultRow[] {
  const direction = params.order === 'asc' ? 1 : -1;
  const primaryKey = SORT_KEYS[params.sort];
  const secondaryKey = SECONDARY_SORT_KEYS[params.sort];
  const sorted = [...rows];
  sorted.sort((a, b) => {
    // Tier first, and independent of `order` — `desc` reverses the ranking
    // within each tier, never the tiers themselves. Fuzzy alias noise stays
    // below real matches in both directions.
    const tier = Number(isAliasOnly(a)) - Number(isAliasOnly(b));
    if (tier !== 0) return tier;
    const primary = compareSortable(a[primaryKey], b[primaryKey]) * direction;
    if (primary !== 0) return primary;
    const secondary = compareSortable(a[secondaryKey], b[secondaryKey]);
    if (secondary !== 0) return secondary;
    return a.id - b.id;
  });
  return sorted;
}

type SortableKey = 'artist_name' | 'album_title' | 'plays' | 'add_date';

const SORT_KEYS: Record<CatalogSort, SortableKey> = {
  artist: 'artist_name',
  album: 'album_title',
  plays: 'plays',
  date: 'add_date',
};

const SECONDARY_SORT_KEYS: Record<CatalogSort, SortableKey> = {
  artist: 'album_title',
  album: 'artist_name',
  plays: 'artist_name',
  date: 'artist_name',
};

function compareSortable(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function taggedRowToAlbumSearchResultRow(row: TaggedLibraryViewEntry): AlbumSearchResultRow {
  const projected: AlbumSearchResultRow = {
    id: row.id,
    add_date: row.add_date instanceof Date ? row.add_date.toISOString() : String(row.add_date ?? ''),
    album_title: row.album_title,
    artist_name: row.artist_name ?? '',
    artist_id: row.artist_id,
    code_letters: row.code_letters,
    code_number: row.code_number,
    code_artist_number: row.code_artist_number,
    format_name: row.format_name,
    genre_name: row.genre_name,
    label: row.label ?? '',
    label_id: row.label_id,
    rotation_bin: row.rotation_bin,
    plays: row.plays,
    on_streaming: row.on_streaming,
    album_artist: row.album_artist,
    discogsUnavailable: row.discogs_unavailable,
    discogsUnavailableNote: row.discogs_unavailable_note,
    lastDiscogsRecheckAt: row.last_discogs_recheck_at,
  };
  if (row.matched_via) projected.matched_via = row.matched_via;
  if (row.matched_via_alias) projected.matched_via_alias = row.matched_via_alias;
  return projected;
}

type RawRow = {
  id: number;
  add_date: Date | string;
  album_title: string;
  artist_name: string | null;
  artist_id: number;
  code_letters: string;
  code_number: number;
  code_artist_number: number;
  format_name: string;
  genre_name: string;
  alias_max_sim?: number | null;
  alias_matched_variant?: string | null;
  alias_matched_source?: string | null;
  label: string | null;
  label_id: number | null;
  rotation_bin: string | null;
  plays: number | null;
  on_streaming: boolean | null;
  album_artist: string | null;
  discogs_unavailable: boolean;
  discogs_unavailable_note: string | null;
  // Raw `db.execute` rows can come back as either a `Date` or an
  // already-serialized string depending on the postgres-js type parser for
  // the query shape (mirrors `add_date` above, which has the same dual
  // shape) — passed through as-is; `res.json()` serializes a `Date` via
  // `toJSON()` and leaves a string alone, so both branches reach the wire as
  // the same ISO shape.
  last_discogs_recheck_at: Date | string | null;
};

function toAlbumSearchResultRow(row: RawRow): AlbumSearchResultRow {
  const projected: AlbumSearchResultRow = {
    id: row.id,
    add_date: row.add_date instanceof Date ? row.add_date.toISOString() : String(row.add_date ?? ''),
    album_title: row.album_title,
    artist_name: row.artist_name ?? '',
    artist_id: row.artist_id,
    code_letters: row.code_letters,
    code_number: row.code_number,
    code_artist_number: row.code_artist_number,
    format_name: row.format_name,
    genre_name: row.genre_name,
    label: row.label ?? '',
    label_id: row.label_id,
    rotation_bin: row.rotation_bin,
    plays: row.plays,
    on_streaming: row.on_streaming,
    album_artist: row.album_artist,
    discogsUnavailable: row.discogs_unavailable,
    discogsUnavailableNote: row.discogs_unavailable_note,
    lastDiscogsRecheckAt: row.last_discogs_recheck_at,
  };
  if (
    row.alias_max_sim !== null &&
    row.alias_max_sim !== undefined &&
    row.alias_matched_variant &&
    row.alias_matched_source
  ) {
    projected.matched_via_alias = [
      { matched_variant: row.alias_matched_variant, source: row.alias_matched_source as ArtistSearchAliasSource },
    ];
  }
  return projected;
}

function buildWhereClause(conditions: SearchCondition<CatalogField>[]): SQL | null {
  if (conditions.length === 0) return null;

  const fragments = conditions
    .map((c) => ({ operator: c.operator, fragment: buildConditionFragment(c) }))
    .filter((f): f is { operator: 'AND' | 'OR'; fragment: SQL } => f.fragment !== null);

  if (fragments.length === 0) return null;

  let result = fragments[0].fragment;
  for (let i = 1; i < fragments.length; i++) {
    const { operator, fragment } = fragments[i];
    result = operator === 'OR' ? sql`${result} OR ${fragment}` : sql`${result} AND ${fragment}`;
  }
  return sql`(${result})`;
}

function buildConditionFragment(condition: SearchCondition<CatalogField>): SQL | null {
  const { field, value, exact, negated } = condition;
  const fragment = field === 'all' ? buildAllFieldMatch(value, exact) : buildColumnMatch(field, value, exact);
  return negated ? sql`NOT (${fragment})` : fragment;
}

function buildColumnMatch(field: CatalogField, value: string, exact: boolean): SQL {
  const col = FIELD_COLUMNS[field];
  if (exact) {
    return sql`${col} = ${value}`;
  }
  return ilikeEscaped(col, value, 'contains');
}

function buildAllFieldMatch(value: string, exact: boolean): SQL {
  if (exact) {
    // Exact matching skips the alias path — alias variants are normalized
    // strings, not exact matches against the canonical name.
    return sql`(${library_artist_view.artist_name} = ${value} OR ${library_artist_view.album_title} = ${value} OR ${library_artist_view.label} = ${value})`;
  }
  // Trigram-backed ILIKE across artist/album/label. Tsvector ranking is the
  // deferred follow-up flagged in the plan (add `label` to library.search_doc
  // first, then route this branch through it); v1 stays correct and reviewable
  // with the same path the flowsheet trigram fallback uses.
  //
  // Alias substrate matching does not route through here — under the
  // UNION ALL design (BS#1318) alias-only hits surface from branch (b)'s
  // INNER JOIN against the `alias_hits` CTE, not from an OR predicate
  // injected into this fragment.
  return sql`(${ilikeEscaped(library_artist_view.artist_name, value, 'contains')} OR ${ilikeEscaped(library_artist_view.album_title, value, 'contains')} OR ${ilikeEscaped(library_artist_view.label, value, 'contains')})`;
}

function buildFilterClause(params: LibraryQueryParams): SQL | null {
  const parts: SQL[] = [];
  if (params.on_streaming !== undefined) {
    parts.push(sql`${library_artist_view.on_streaming} = ${params.on_streaming}`);
  }
  if (params.missing === true) {
    parts.push(sql`EXISTS (
      SELECT 1 FROM ${library}
      WHERE ${library.id} = ${library_artist_view.id}
        AND ${library.date_lost} IS NOT NULL
        AND (${library.date_found} IS NULL OR ${library.date_found} < ${library.date_lost})
    )`);
  } else if (params.missing === false) {
    parts.push(sql`NOT EXISTS (
      SELECT 1 FROM ${library}
      WHERE ${library.id} = ${library_artist_view.id}
        AND ${library.date_lost} IS NOT NULL
        AND (${library.date_found} IS NULL OR ${library.date_found} < ${library.date_lost})
    )`);
  }
  if (params.genres !== undefined && params.genres.length > 0) {
    parts.push(inArray(library_artist_view.genre_name, params.genres));
  }
  if (params.formats !== undefined && params.formats.length > 0) {
    parts.push(inArray(library_artist_view.format_name, params.formats));
  }
  if (params.rotation_bins !== undefined && params.rotation_bins.length > 0) {
    parts.push(inArray(library_artist_view.rotation_bin, params.rotation_bins));
  }
  if (parts.length === 0) return null;
  let result = parts[0];
  for (let i = 1; i < parts.length; i++) {
    result = sql`${result} AND ${parts[i]}`;
  }
  return result;
}

function combineWhere(a: SQL | null, b: SQL | null): SQL | null {
  if (a && b) return sql`${a} AND ${b}`;
  return a ?? b;
}

// --- Enum validation ---

type EnumCache = { values: Set<string>; expiresAt: number };
const ENUM_TTL_MS = 60_000;
let genreCache: EnumCache | null = null;
let formatCache: EnumCache | null = null;

async function loadGenres(): Promise<Set<string>> {
  const rows = await db.select({ name: genres.genre_name }).from(genres);
  return new Set(rows.map((r) => r.name));
}

async function loadFormats(): Promise<Set<string>> {
  const rows = await db.select({ name: formatTable.format_name }).from(formatTable);
  return new Set(rows.map((r) => r.name));
}

async function getGenreSet(): Promise<Set<string>> {
  const now = Date.now();
  if (!genreCache || genreCache.expiresAt < now) {
    genreCache = { values: await loadGenres(), expiresAt: now + ENUM_TTL_MS };
  }
  return genreCache.values;
}

async function getFormatSet(): Promise<Set<string>> {
  const now = Date.now();
  if (!formatCache || formatCache.expiresAt < now) {
    formatCache = { values: await loadFormats(), expiresAt: now + ENUM_TTL_MS };
  }
  return formatCache.values;
}

export class UnknownEnumError extends WxycError {
  constructor(message: string) {
    super(message, 400);
    this.name = 'UnknownEnumError';
  }
}

async function validateEnumFilters(genres?: string[], formats?: string[]): Promise<void> {
  if (genres !== undefined && genres.length > 0) {
    const set = await getGenreSet();
    for (const genre of genres) {
      if (!set.has(genre)) {
        throw new UnknownEnumError(`Unknown genre: ${genre}`);
      }
    }
  }
  if (formats !== undefined && formats.length > 0) {
    const set = await getFormatSet();
    for (const format of formats) {
      if (!set.has(format)) {
        throw new UnknownEnumError(`Unknown format: ${format}`);
      }
    }
  }
}

/** Parse comma-separated rotation bin codes; validates against active bins. */
export function parseRotationBinsQueryList(
  ...raw: (string | string[] | undefined)[]
): CatalogRotationBin[] | undefined {
  const parsed = parseEnumQueryList(...raw);
  if (!parsed) return undefined;
  const valid = new Set<string>(VALID_ROTATION_BINS);
  for (const bin of parsed) {
    if (!valid.has(bin)) {
      throw new WxycError(`rotation_bins must be one of: ${VALID_ROTATION_BINS.join(', ')}`, 400);
    }
  }
  return parsed as CatalogRotationBin[];
}

/**
 * Parse comma-separated enum query values; trims and dedupes. Accepts
 * `string[]` per value because Express's `simple` query parser yields arrays
 * for repeated keys (`?genres=Rock&genres=Jazz`).
 */
export function parseEnumQueryList(...raw: (string | string[] | undefined)[]): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value) continue;
    for (const piece of Array.isArray(value) ? value : [value]) {
      if (typeof piece !== 'string') continue;
      for (const part of piece.split(',')) {
        const trimmed = part.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}
