import * as Sentry from '@sentry/node';
import { sql, type SQL } from 'drizzle-orm';
import { db, flowsheet } from '@wxyc/database';
import {
  parseSearchQuery,
  FLOWSHEET_PARSER_CONFIG,
  type FlowsheetField,
  type SearchCondition,
} from './search-parser.service.js';
import { ilikeEscaped } from '../utils/sql-like.js';

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

/**
 * Upper bound on the exact count reported by /flowsheet/search (BS#1681).
 *
 * An unbounded `COUNT(*)` over the `entry_type = 'track'` set is a parallel seq
 * scan of the whole 3.3 GB / ~2M-row flowsheet heap — ~12s in prod, well past
 * the 5s HTTP `statement_timeout`, which 500'd the endpoint for every query
 * (the empty default listing and broad terms like "the" match nearly every
 * row). Wrapping the count in a `LIMIT COUNT_CAP + 1` derived table bounds the
 * work to at most this many matching rows regardless of selectivity (33-105ms
 * measured), at the cost of reporting `COUNT_CAP + 1` as a "10000+" sentinel
 * once the true match set exceeds the cap. Deep offset pagination past the cap
 * was never meaningful for the multi-million-row historical archive, and the
 * forward path (cursor mode) doesn't depend on `total` at all.
 */
export const COUNT_CAP = 10000;

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

// Display projection for the resolved DJ name. Reads the denormalized column
// added in step 5b (migrations 0053/0054) instead of joining shows -> auth_user
// per row. The 'Unknown DJ' fallback guards rows that somehow carry NULL —
// 0053 backfilled all existing rows and 5b.2 keeps inserts populated, so this
// branch should be dead in practice, but leaving it keeps the API contract
// stable (clients see a non-null string).
const DJ_NAME_EXPR = sql`COALESCE(${flowsheet.dj_name}, 'Unknown DJ')`;

const SORT_MAP: Record<SearchParams['sort'], SQL> = {
  date: sql`${flowsheet.add_time}`,
  artist: sql`${flowsheet.artist_name}`,
  song: sql`${flowsheet.track_title}`,
  dj: sql`${flowsheet.dj_name}`,
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
  const conditions = parseSearchQuery(q, FLOWSHEET_PARSER_CONFIG);

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

  // Capped count (BS#1681): `COUNT(*)` over a `LIMIT COUNT_CAP + 1` derived
  // table stops scanning once the cap is reached, bounding cost regardless of
  // how many rows the predicate actually matches.
  const countQuery = sql`SELECT COUNT(*)::int AS total FROM (SELECT 1 ${fullWhere} LIMIT ${COUNT_CAP + 1}) AS capped`;

  // allSettled, not all: the count is now cheap enough that it should never
  // time out, but if it (or a future predicate) does, the data page is already
  // in hand — degrade to a lower-bound total rather than 500-ing the whole
  // request the way the pre-BS#1681 `Promise.all` did.
  const [dataSettled, countSettled] = await Promise.allSettled([db.execute(dataQuery), db.execute(countQuery)]);

  if (dataSettled.status === 'rejected') {
    // No data page means nothing to serve — a data-query failure stays fatal
    // and propagates to the error handler as a 500.
    throw dataSettled.reason;
  }

  const results = (dataSettled.value as unknown as SearchResultRow[]).map(transformRow);

  let total: number;
  if (countSettled.status === 'fulfilled') {
    total = (countSettled.value as unknown as CountRow[])[0]?.total ?? 0;
  } else {
    // Best-effort total when the count is unavailable: the rows we've already
    // paged past plus this page. Exact for a partial final page, a lower bound
    // for a full page, and — only in the rare empty-page-past-end offset case —
    // an over-estimate bounded by `offset`. In cursor mode `offset` is 0, so
    // this collapses to the current page size.
    total = offset + results.length;
    Sentry.captureException(countSettled.reason, {
      tags: { subsystem: 'flowsheet-search' },
      extra: { q, page, limit },
    });
    console.error('flowsheet search count query failed; returning lower-bound total', countSettled.reason);
  }

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

function buildWhereClause(conditions: SearchCondition<FlowsheetField>[]): SQL | null {
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

function buildConditionFragment(condition: SearchCondition<FlowsheetField>): SQL | null {
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
  return ilikeEscaped(col, value, 'contains');
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
  return sql`(${ilikeEscaped(flowsheet.artist_name, value, 'contains')} OR ${ilikeEscaped(flowsheet.track_title, value, 'contains')} OR ${ilikeEscaped(flowsheet.album_title, value, 'contains')} OR ${ilikeEscaped(flowsheet.record_label, value, 'contains')})`;
}

function buildDjNameMatch(value: string, exact: boolean): SQL {
  // Single-column predicate on the denormalized flowsheet.dj_name (step 5b.3).
  // The OR-decomposition this replaced (across user.djName, user.name, and
  // shows.legacy_dj_name) was a workaround for Postgres not pushing ILIKE
  // through the COALESCE display expression; with the resolved value stored
  // on the row the predicate collapses to one column. ILIKE pattern matches
  // here are served by flowsheet_search_doc_idx (the search_doc tsvector
  // includes dj_name); the standalone flowsheet_dj_name_trgm_idx that
  // originally backed this path was dropped in migration 0083 (#1060) after
  // pg_stat_user_indexes showed it had zero scans across months in prod.
  if (exact) {
    return sql`${flowsheet.dj_name} = ${value}`;
  }
  return ilikeEscaped(flowsheet.dj_name, value, 'contains');
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
