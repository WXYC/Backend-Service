import { sql, type SQL } from 'drizzle-orm';
import { db, library_artist_view, genres, format as formatTable } from '@wxyc/database';
import {
  parseSearchQuery,
  CATALOG_PARSER_CONFIG,
  type CatalogField,
  type SearchCondition,
} from './search-parser.service.js';

export type CatalogSort = 'artist' | 'album' | 'plays' | 'date';
export type CatalogOrder = 'asc' | 'desc';

export type LibraryQueryParams = {
  q: string;
  page: number;
  limit: number;
  sort: CatalogSort;
  order: CatalogOrder;
  on_streaming?: boolean;
  genre?: string;
  format?: string;
};

export type AlbumSearchResultRow = {
  id: number;
  add_date: string;
  album_title: string;
  artist_name: string;
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
};

const FIELD_COLUMNS: Record<CatalogField, SQL> = {
  artist_name: sql`${library_artist_view.artist_name}`,
  album_title: sql`${library_artist_view.album_title}`,
  label: sql`${library_artist_view.label}`,
};

const SORT_COLUMNS: Record<CatalogSort, SQL> = {
  artist: sql`${library_artist_view.artist_name}`,
  album: sql`${library_artist_view.album_title}`,
  plays: sql`${library_artist_view.plays}`,
  date: sql`${library_artist_view.add_date}`,
};

const SECONDARY_SORT: Record<CatalogSort, SQL> = {
  artist: sql`${library_artist_view.album_title}`,
  album: sql`${library_artist_view.artist_name}`,
  plays: sql`${library_artist_view.artist_name}`,
  date: sql`${library_artist_view.artist_name}`,
};

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
  await validateEnumFilters(params.genre, params.format);

  const conditions = parseSearchQuery(params.q, CATALOG_PARSER_CONFIG);
  const queryWhere = buildWhereClause(conditions);
  const filterWhere = buildFilterClause(params);

  const where = combineWhere(queryWhere, filterWhere);

  const orderDirection = params.order === 'asc' ? sql`ASC` : sql`DESC`;
  const orderBy = sql`${SORT_COLUMNS[params.sort]} ${orderDirection}, ${SECONDARY_SORT[params.sort]} ASC, ${library_artist_view.id} ASC`;

  const offset = params.page * params.limit;
  const fromClause = where ? sql`FROM ${library_artist_view} WHERE ${where}` : sql`FROM ${library_artist_view}`;

  const dataQuery = sql`
    SELECT
      ${library_artist_view.id} AS id,
      ${library_artist_view.add_date} AS add_date,
      ${library_artist_view.album_title} AS album_title,
      ${library_artist_view.artist_name} AS artist_name,
      ${library_artist_view.code_letters} AS code_letters,
      ${library_artist_view.code_number} AS code_number,
      ${library_artist_view.code_artist_number} AS code_artist_number,
      ${library_artist_view.format_name} AS format_name,
      ${library_artist_view.genre_name} AS genre_name,
      ${library_artist_view.label} AS label,
      ${library_artist_view.label_id} AS label_id,
      ${library_artist_view.rotation_bin} AS rotation_bin,
      ${library_artist_view.plays} AS plays,
      ${library_artist_view.on_streaming} AS on_streaming,
      ${library_artist_view.album_artist} AS album_artist
    ${fromClause}
    ORDER BY ${orderBy}
    LIMIT ${params.limit} OFFSET ${offset}
  `;
  const countQuery = sql`SELECT COUNT(*)::int AS total ${fromClause}`;

  const [dataRows, countRows] = await Promise.all([db.execute(dataQuery), db.execute(countQuery)]);

  const results = (dataRows as unknown as RawRow[]).map(toAlbumSearchResultRow);
  const total = (countRows as unknown as { total: number }[])[0]?.total ?? 0;

  return { results, total };
}

type RawRow = {
  id: number;
  add_date: Date | string;
  album_title: string;
  artist_name: string | null;
  code_letters: string;
  code_number: number;
  code_artist_number: number;
  format_name: string;
  genre_name: string;
  label: string | null;
  label_id: number | null;
  rotation_bin: string | null;
  plays: number | null;
  on_streaming: boolean | null;
  album_artist: string | null;
};

function toAlbumSearchResultRow(row: RawRow): AlbumSearchResultRow {
  return {
    id: row.id,
    add_date: row.add_date instanceof Date ? row.add_date.toISOString() : String(row.add_date ?? ''),
    album_title: row.album_title,
    artist_name: row.artist_name ?? '',
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
  };
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
  return sql`${col} ILIKE ${'%' + value + '%'}`;
}

function buildAllFieldMatch(value: string, exact: boolean): SQL {
  if (exact) {
    return sql`(${library_artist_view.artist_name} = ${value} OR ${library_artist_view.album_title} = ${value} OR ${library_artist_view.label} = ${value})`;
  }
  // Trigram-backed ILIKE across artist/album/label. Tsvector ranking is the
  // deferred follow-up flagged in the plan (add `label` to library.search_doc
  // first, then route this branch through it); v1 stays correct and reviewable
  // with the same path the flowsheet trigram fallback uses.
  const pattern = '%' + value + '%';
  return sql`(${library_artist_view.artist_name} ILIKE ${pattern} OR ${library_artist_view.album_title} ILIKE ${pattern} OR ${library_artist_view.label} ILIKE ${pattern})`;
}

function buildFilterClause(params: LibraryQueryParams): SQL | null {
  const parts: SQL[] = [];
  if (params.on_streaming !== undefined) {
    parts.push(sql`${library_artist_view.on_streaming} = ${params.on_streaming}`);
  }
  if (params.genre !== undefined) {
    parts.push(sql`${library_artist_view.genre_name} = ${params.genre}`);
  }
  if (params.format !== undefined) {
    parts.push(sql`${library_artist_view.format_name} = ${params.format}`);
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

export class UnknownEnumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownEnumError';
  }
}

async function validateEnumFilters(genre?: string, format?: string): Promise<void> {
  if (genre !== undefined) {
    const set = await getGenreSet();
    if (!set.has(genre)) {
      throw new UnknownEnumError(`Unknown genre: ${genre}`);
    }
  }
  if (format !== undefined) {
    const set = await getFormatSet();
    if (!set.has(format)) {
      throw new UnknownEnumError(`Unknown format: ${format}`);
    }
  }
}

/** For tests: drop the cached enum values so the next call re-queries. */
export function __resetEnumCachesForTests(): void {
  genreCache = null;
  formatCache = null;
}
