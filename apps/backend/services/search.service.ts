import { sql, type SQL } from 'drizzle-orm';
import { db, flowsheet, shows, user } from '@wxyc/database';
import { parseSearchQuery, type SearchCondition } from './search-parser.service.js';

export type SearchParams = {
  q: string;
  page: number;
  limit: number;
  sort: 'date' | 'artist' | 'song' | 'dj';
  order: 'asc' | 'desc';
  /**
   * Opaque cursor token from a previous response's `nextCursor`. When provided
   * with `sort: 'date'`, replaces offset pagination with a `WHERE add_time` /
   * `id` predicate so each page costs O(limit) instead of O(page * limit).
   * Ignored for non-date sorts (no compound index supports them).
   */
  cursor?: string;
};

export type Cursor = { addTime: string; id: number };

/** Encode a cursor for the next page. Format: `${ISO timestamp}_${id}`. */
export function encodeCursor(addTime: string, id: number): string {
  return `${addTime}_${id}`;
}

/** Parse a cursor token, or return null if malformed. */
export function parseCursor(cursor: string): Cursor | null {
  const lastUnderscore = cursor.lastIndexOf('_');
  if (lastUnderscore <= 0) return null;
  const addTime = cursor.slice(0, lastUnderscore);
  const idStr = cursor.slice(lastUnderscore + 1);
  if (!addTime || !idStr) return null;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (Number.isNaN(Date.parse(addTime))) return null;
  return { addTime, id };
}

type SearchResultRow = {
  id: number;
  play_date: Date;
  artist_name: string | null;
  track_title: string | null;
  album_title: string | null;
  record_label: string | null;
  show_id: number | null;
  dj_name: string | null;
};

type CountRow = { total: number };

export type SearchResult = {
  id: number;
  play_date: string;
  artist_name: string;
  track_title: string;
  album_title: string;
  record_label: string;
  show_id: number;
  dj_name: string;
};

const DJ_NAME_EXPR = sql`COALESCE(${user.djName}, ${shows.legacy_dj_name}, ${user.name}, 'Unknown DJ')`;

const SORT_MAP: Record<SearchParams['sort'], SQL> = {
  date: sql`${flowsheet.add_time}`,
  artist: sql`${flowsheet.artist_name}`,
  song: sql`${flowsheet.track_title}`,
  dj: DJ_NAME_EXPR,
};

/** Column references for WHERE clause building, keyed by SearchField name. */
const COLUMN_MAP: Record<string, SQL> = {
  artist_name: sql`${flowsheet.artist_name}`,
  track_title: sql`${flowsheet.track_title}`,
  album_title: sql`${flowsheet.album_title}`,
  record_label: sql`${flowsheet.record_label}`,
};

/** Search historical flowsheet entries with filtering, sorting, and pagination. */
export async function searchFlowsheet(
  params: SearchParams
): Promise<{ results: SearchResult[]; total: number; nextCursor?: string }> {
  const { q, page, limit, sort, order, cursor } = params;
  const conditions = parseSearchQuery(q);

  const whereClause = buildWhereClause(conditions);
  const orderDirection = order === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = SORT_MAP[sort];

  // Cursor pagination is only meaningful for date sort. Other sorts fall back
  // to offset because their sort columns are not unique and there is no
  // compound index to support a (sort_col, id) cursor predicate.
  const parsedCursor = cursor !== undefined && sort === 'date' ? parseCursor(cursor) : null;
  const useCursor = parsedCursor !== null;
  const offset = useCursor ? 0 : page * limit;

  const baseFrom = sql`
    FROM ${flowsheet}
    LEFT JOIN ${shows} ON ${shows.id} = ${flowsheet.show_id}
    LEFT JOIN ${user} ON ${user.id} = ${shows.primary_dj_id}
    WHERE ${flowsheet.entry_type} = 'track'
  `;

  let fullWhere = whereClause ? sql`${baseFrom} AND ${whereClause}` : baseFrom;
  if (parsedCursor) {
    // Compound (add_time, id) cursor handles ties when multiple rows share an
    // add_time — common for batch-imported legacy entries that all carry the
    // same import timestamp.
    const cmp = order === 'asc' ? sql`>` : sql`<`;
    fullWhere = sql`${fullWhere} AND (${flowsheet.add_time}, ${flowsheet.id}) ${cmp} (${parsedCursor.addTime}::timestamptz, ${parsedCursor.id})`;
  }

  // In cursor mode, add id as a tiebreaker so the ORDER BY matches the
  // cursor predicate's compound key — required for stable pagination.
  const orderByClause = useCursor
    ? sql`${sortExpr} ${orderDirection}, ${flowsheet.id} ${orderDirection}`
    : sql`${sortExpr} ${orderDirection}`;

  // Run data and count in parallel. A combined `COUNT(*) OVER()` window query
  // forces Postgres to materialize the full match set before LIMIT can apply,
  // which defeats short-circuiting on the data side. Two queries let the data
  // query stop at LIMIT rows via index, while the count runs concurrently.
  const limitClause = useCursor ? sql`LIMIT ${limit}` : sql`LIMIT ${limit} OFFSET ${offset}`;
  const dataQuery = sql`
    SELECT
      ${flowsheet.id},
      ${flowsheet.add_time} AS play_date,
      ${flowsheet.artist_name},
      ${flowsheet.track_title},
      ${flowsheet.album_title},
      ${flowsheet.record_label},
      ${flowsheet.show_id},
      ${DJ_NAME_EXPR} AS dj_name
    ${fullWhere}
    ORDER BY ${orderByClause}
    ${limitClause}
  `;

  const countQuery = sql`SELECT COUNT(*)::int AS total ${fullWhere}`;

  const [dataRows, countRows] = await Promise.all([db.execute(dataQuery), db.execute(countQuery)]);

  const results = (dataRows as unknown as SearchResultRow[]).map(transformRow);
  const total = (countRows as unknown as CountRow[])[0]?.total ?? 0;

  // nextCursor only when cursor mode is active AND we got a full page —
  // a short page means there are no more rows.
  const nextCursor =
    useCursor && results.length === limit
      ? encodeCursor(results[results.length - 1].play_date, results[results.length - 1].id)
      : undefined;

  return nextCursor !== undefined ? { results, total, nextCursor } : { results, total };
}

function transformRow(row: SearchResultRow): SearchResult {
  return {
    id: row.id,
    play_date: row.play_date instanceof Date ? row.play_date.toISOString() : String(row.play_date ?? ''),
    artist_name: row.artist_name ?? '',
    track_title: row.track_title ?? '',
    album_title: row.album_title ?? '',
    record_label: row.record_label ?? '',
    show_id: row.show_id ?? 0,
    dj_name: row.dj_name ?? '',
  };
}

function buildWhereClause(conditions: SearchCondition[]): SQL | null {
  if (conditions.length === 0) return null;

  const parts: { operator: 'AND' | 'OR'; fragment: SQL }[] = [];

  for (const condition of conditions) {
    const fragment = buildConditionFragment(condition);
    if (fragment) {
      parts.push({ operator: condition.operator, fragment });
    }
  }

  if (parts.length === 0) return null;

  let result = parts[0].fragment;
  for (let i = 1; i < parts.length; i++) {
    const { operator, fragment } = parts[i];
    if (operator === 'OR') {
      result = sql`${result} OR ${fragment}`;
    } else {
      result = sql`${result} AND ${fragment}`;
    }
  }

  return sql`(${result})`;
}

function buildConditionFragment(condition: SearchCondition): SQL | null {
  const { field, value, exact, negated } = condition;

  let fragment: SQL;

  switch (field) {
    case 'all':
      fragment = buildAllFieldMatch(value, exact);
      break;
    case 'dj_name':
      fragment = buildDjNameMatch(value, exact);
      break;
    case 'add_time':
      fragment = buildDateMatch(value);
      break;
    case 'add_time_range':
      fragment = buildDateRangeMatch(value);
      break;
    default:
      fragment = buildColumnMatch(field, value, exact);
      break;
  }

  return negated ? sql`NOT (${fragment})` : fragment;
}

function buildColumnMatch(column: string, value: string, exact: boolean): SQL {
  const col = COLUMN_MAP[column];
  if (!col) return sql`FALSE`;
  if (exact) {
    return sql`${col} = ${value}`;
  }
  return sql`${col} ILIKE ${'%' + value + '%'}`;
}

/**
 * Decide whether an `all`-field bare-term query should use the tsvector path
 * or fall back to the trigram ILIKE path. Tsvector handles whole-word and
 * prefix matching cleanly via `websearch_to_tsquery`, but it tokenizes — so
 * pure-punctuation strings (`!!!`, `$$$`) and single-character fragments are
 * better served by trigram, which can match arbitrary substrings.
 */
export function shouldUseTsvector(value: string): boolean {
  if (value.length < 3) return false;
  return /[a-zA-Z0-9]/.test(value);
}

function buildAllFieldMatch(value: string, exact: boolean): SQL {
  if (exact) {
    return sql`(${flowsheet.artist_name} = ${value} OR ${flowsheet.track_title} = ${value} OR ${flowsheet.album_title} = ${value} OR ${flowsheet.record_label} = ${value})`;
  }
  if (shouldUseTsvector(value)) {
    // Tsvector path: tokenized whole-word / prefix matching across all four
    // weighted fields via the GIN index on flowsheet.search_doc. websearch_
    // to_tsquery handles natural query input (quoted phrases, OR, etc.).
    return sql`${flowsheet.search_doc} @@ websearch_to_tsquery('simple', ${value})`;
  }
  // Trigram fallback: short queries, pure-punctuation strings, and any other
  // input that the tsvector path would tokenize away.
  const pattern = '%' + value + '%';
  return sql`(${flowsheet.artist_name} ILIKE ${pattern} OR ${flowsheet.track_title} ILIKE ${pattern} OR ${flowsheet.album_title} ILIKE ${pattern} OR ${flowsheet.record_label} ILIKE ${pattern})`;
}

function buildDjNameMatch(value: string, exact: boolean): SQL {
  // OR-decompose across the three underlying columns instead of filtering on
  // the COALESCE expression. Postgres does not push ILIKE predicates through
  // COALESCE to use the per-column trigram indexes; the OR form lets the
  // planner BitmapOr across user.dj_name, user.name, and shows.legacy_dj_name.
  // Display still uses COALESCE (DJ_NAME_EXPR) for the priority-ordered name.
  if (exact) {
    return sql`(${user.djName} = ${value} OR ${user.name} = ${value} OR ${shows.legacy_dj_name} = ${value})`;
  }
  const pattern = '%' + value + '%';
  return sql`(${user.djName} ILIKE ${pattern} OR ${user.name} ILIKE ${pattern} OR ${shows.legacy_dj_name} ILIKE ${pattern})`;
}

function buildDateMatch(value: string): SQL {
  return sql`${flowsheet.add_time} >= ${value}::date AND ${flowsheet.add_time} < (${value}::date + interval '1 day')`;
}

function buildDateRangeMatch(value: string): SQL {
  const [start, end] = value.split('..');
  if (!start || !end) {
    return buildDateMatch(value);
  }
  return sql`${flowsheet.add_time} >= ${start}::date AND ${flowsheet.add_time} < (${end}::date + interval '1 day')`;
}
