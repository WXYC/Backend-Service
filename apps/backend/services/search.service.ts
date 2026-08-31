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
  /**
   * `Date | string` because which one arrives is the driver's decision, not
   * this file's: a raw `db.execute` gets Postgres's text rendering while a
   * typed query — and every unit test that mocks this row — gets a `Date`.
   * `transformRow` normalizes both; see `CURSOR_TIME_EXPR` for the mechanism.
   */
  play_date: Date | string;
  /**
   * The same instant as a full-precision ISO-8601 UTC string, rendered by
   * Postgres. This — never `play_date` — is what the emitted cursor is built
   * from; `CURSOR_TIME_EXPR` says why.
   */
  cursor_time: string;
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

/**
 * The cursor's timestamp half, rendered by Postgres rather than by JavaScript.
 *
 * `add_time` is `timestamptz` (migration 0030 widened migration 0019's naive
 * `timestamp`) defaulting to `now()`, which is microsecond-resolution, and
 * every live insert omits the column — so production rows carry microseconds
 * that a JS `Date` cannot hold. A `Date`-derived cursor would name
 * `floor_ms(T)` rather than the boundary row's real `T`, while `parseCursor`
 * binds it back at full `::timestamptz` precision: ascending, the row-value
 * comparison `(T, id) > (floor_ms(T), id)` then re-serves the boundary row on
 * every page; descending, any row inside the open interval `(floor_ms(T), T)`
 * fails `< floor_ms(T)` and is stepped over.
 *
 * Today that does not happen, but only by accident of a dependency: drizzle's
 * postgres-js driver installs a transparent parser over OID 1184 so its own
 * column mappers can do the converting, which leaves a raw `db.execute` with
 * Postgres's text rendering and its full precision. Nothing in this file asks
 * for that, no test outside the integration tier can see it, and the unit
 * suite's mocks assert the opposite shape. Selecting the cursor value
 * explicitly makes the precision a property of the query instead of a
 * property of the driver — and yields the ISO-8601 form
 * `docs/playlist-search/README.md` already documents, which the text rendering
 * (`2026-08-30 12:00:00.1234+00`) is not.
 */
const CURSOR_TIME_EXPR = sql`to_char(${flowsheet.add_time} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

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

  // Whether this request can take part in cursor pagination at all — as the
  // page that RECEIVES a cursor, as the page that EMITS one, or both. Date
  // sort is the whole condition: `parseCursor` is consulted only when this
  // holds, so a cursor handed out under any other sort would be silently
  // ignored on the way back in and the client would re-request the same page
  // forever. Non-date sorts fall back to offset regardless — their sort
  // columns are not unique and there is no compound (sort_col, id) index to
  // support a cursor predicate for them.
  const cursorEligible = sort === 'date';
  const parsedCursor = cursorEligible && cursor !== undefined ? parseCursor(cursor) : null;
  const offset = parsedCursor !== null ? 0 : page * limit;

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

  // Add id as a tiebreaker whenever a cursor could be involved — received OR
  // handed out — so the ORDER BY matches the cursor predicate's compound key.
  //
  // This is deliberately NOT gated on an INBOUND cursor (BS#2344). `add_time`
  // alone is not a total order: batch-imported legacy entries carry one shared
  // import timestamp, so tie groups are large and routinely straddle a page
  // boundary. Under the untied clause Postgres may return such a group in any
  // order, which is harmless while the page is only ever addressed by OFFSET
  // but not once the last row of the page becomes the cursor for the next one
  // — that row is then an arbitrary member of its tie group, and the rest of
  // the group is either re-served (duplicate) or stepped over (skipped). The
  // first page emits a cursor now, so the first page has to be totally ordered
  // too.
  //
  // Cost: the partial `flowsheet_track_add_time_idx` (migration 0050) still
  // drives the scan — its `WHERE entry_type = 'track'` predicate is this
  // query's own, which is what 0050's header means by "matches the exact
  // predicate in apps/backend/services/search.service.ts" — and Postgres adds
  // an Incremental Sort over each timestamp group. (The unpartitioned ASC
  // `flowsheet_add_time_idx` from migration 0144 is a different index, built
  // for `GET /flowsheet/range`.) `getEntriesByPage` (BS#2133) and
  // `fetchRecentRows` (BS#2132) measured that sort node in production and
  // found it cheap, but neither measurement covers this query: both are
  // DESC-only, unfiltered, and over small timestamp groups, where this one
  // also serves `order=asc` and can carry a text predicate that changes which
  // rows reach the sort. Read them as evidence that the plan SHAPE is
  // affordable, not as a measurement of this query. Non-date sorts keep the
  // untied clause: they never emit or accept a cursor, so a tiebreaker there
  // would buy nothing and only add sort work.
  const orderByClause = cursorEligible
    ? sql`${sortExpr} ${orderDirection}, ${flowsheet.id} ${orderDirection}`
    : sql`${sortExpr} ${orderDirection}`;

  // Run data and count in parallel. A combined `COUNT(*) OVER()` window query
  // forces Postgres to materialize the full match set before LIMIT can apply,
  // which defeats short-circuiting on the data side. Two queries let the data
  // query stop at LIMIT rows via index, while the count runs concurrently.
  const limitClause = parsedCursor !== null ? sql`LIMIT ${limit}` : sql`LIMIT ${limit} OFFSET ${offset}`;
  const dataQuery = sql`
    SELECT
      ${flowsheet.id},
      ${flowsheet.add_time} AS play_date,
      ${CURSOR_TIME_EXPR} AS cursor_time,
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

  const rows = dataSettled.value as unknown as SearchResultRow[];
  const results = rows.map(transformRow);

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
      // `cursor`, not just `page`: in cursor mode `page` is always 0, so
      // without the token there is nothing in this report that says WHERE in
      // a walk the count gave out.
      extra: { q, page, limit, cursor },
    });
    console.error('flowsheet search count query failed; returning lower-bound total', countSettled.reason);
  }

  // nextCursor whenever this sort supports cursors AND we got a full page —
  // a short page means there are no more rows.
  //
  // The gate is `cursorEligible`, not "a cursor was passed in" (BS#2344).
  // Conditioning the emit on an inbound cursor meant the first request of
  // every session — which by definition carries none — never handed back the
  // link to the second, so the forward chain had no first link and dj-site's
  // `getNextPageParam` stopped at one page. The page's own row count is the
  // only thing that says whether there is more; whether the caller arrived by
  // cursor or by offset says nothing about it.
  //
  // A final page that happens to hold exactly `limit` rows emits a cursor and
  // costs one extra request that returns nothing. That is correct and standard
  // for cursor pagination — the alternative is an extra row fetch or a count
  // on every page, and the count here is capped (COUNT_CAP) precisely because
  // exact counts are what this endpoint cannot afford.
  const nextCursor =
    cursorEligible && rows.length === limit
      ? encodeCursor(rows[rows.length - 1].cursor_time, rows[rows.length - 1].id)
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
