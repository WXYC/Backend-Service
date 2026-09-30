import * as Sentry from '@sentry/node';
import { sql, type SQL } from 'drizzle-orm';
import { db, flowsheet, rotation, library } from '@wxyc/database';
import {
  parseSearchQuery,
  FLOWSHEET_PARSER_CONFIG,
  type FlowsheetField,
  type SearchCondition,
} from './search-parser.service.js';
import { ilikeEscaped } from '../utils/sql-like.js';
import { rotationBinExpr } from '../utils/sql-rotation-bin.js';

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
  rotation_bin: string | null;
  request_flag: boolean;
  /** `null` means no linked library row; only an explicit `false` is a known negative. */
  on_streaming: boolean | null;
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
  rotation_bin: string | null;
  request_flag: boolean;
  on_streaming: boolean | null;
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

  // The two joins that feed rotation_bin/on_streaming. Left off `baseFrom`
  // (and so off the count query below) on purpose — see "The trap, and the
  // shape that avoids it" on BS#2699: appending them there would make the
  // capped count scan two joins over up to COUNT_CAP + 1 rows.
  const dataFrom = sql`
    FROM ${flowsheet}
    LEFT JOIN ${rotation} ON ${rotation.id} = ${flowsheet.rotation_id}
    LEFT JOIN ${library} ON ${library.id} = ${flowsheet.album_id}
    WHERE ${flowsheet.entry_type} = 'track'
  `;

  /** Append the shared predicates (text filter, cursor) to a FROM/WHERE fragment. */
  function composeWhere(from: SQL): SQL {
    let where = whereClause ? sql`${from} AND ${whereClause}` : from;
    if (parsedCursor) {
      // Compound (add_time, id) cursor handles ties when multiple rows share
      // an add_time — common for batch-imported legacy entries that all
      // carry the same import timestamp.
      const cmp = order === 'asc' ? sql`>` : sql`<`;
      where = sql`${where} AND (${flowsheet.add_time}, ${flowsheet.id}) ${cmp} (${parsedCursor.addTime}::timestamptz, ${parsedCursor.id})`;
    }
    return where;
  }

  const countWhere = composeWhere(baseFrom);
  const dataWhere = composeWhere(dataFrom);

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
      ${DJ_NAME_EXPR} AS dj_name,
      ${rotationBinExpr()} AS rotation_bin,
      ${flowsheet.request_flag},
      ${library.on_streaming}
    ${dataWhere}
    ORDER BY ${orderByClause}
    ${limitClause}
  `;

  // Capped count (BS#1681): `COUNT(*)` over a `LIMIT COUNT_CAP + 1` derived
  // table stops scanning once the cap is reached, bounding cost regardless of
  // how many rows the predicate actually matches. Reuses `baseFrom` (via
  // `countWhere`) with no joins, so the two new joins above never reach it.
  const countQuery = sql`SELECT COUNT(*)::int AS total FROM (SELECT 1 ${countWhere} LIMIT ${COUNT_CAP + 1}) AS capped`;

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
    rotation_bin: row.rotation_bin ?? null,
    request_flag: row.request_flag,
    // `?? null`, never `?? false`: null means "no linked library row", which
    // says nothing about streaming — only an explicit `false` is a known
    // negative. Matches `transformToV2` (flowsheet.service.ts).
    on_streaming: row.on_streaming ?? null,
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
    return ilikeEscaped(col, value, 'exact');
  }
  return ilikeEscaped(col, value, 'contains');
}

/**
 * Decide whether an `all`-field bare-term query should use the tsvector path
 * or the trigram ILIKE path. Tsvector handles whole-word matching cleanly via
 * `websearch_to_tsquery`, but it tokenizes — so pure-punctuation strings
 * (`!!!`, `$$$`) and single-character fragments are better served by trigram,
 * which can match arbitrary substrings.
 *
 * **The `/[a-zA-Z0-9]/` test is ASCII-only, and that routes every non-Latin
 * script to the trigram branch too** (WXYC/Backend-Service#2739) — Cyrillic,
 * Greek, CJK, Arabic, Hebrew queries never see `websearch_to_tsquery` at all,
 * since they have no character this regex matches. That is a deliberate
 * choice, not an oversight, but the choice is NOT "the `simple` config can't
 * tokenize these scripts" — it can. Verified on PG 18.6:
 * `to_tsvector('simple', 'Кино')` -> `'кино':1`, and
 * `to_tsvector('simple', 'Кино Группа крови') @@ websearch_to_tsquery('simple', 'Кино')`
 * -> `true`. The tsvector path could serve every non-Latin query in
 * `tests/fixtures/charset-torture.json`'s 33 no-ASCII-alphanumeric entries;
 * this predicate does not ask that question. It stays ASCII-only because the
 * alternative is unmeasured, not because it is known to be worse: trigram
 * substring-matches a partial word inside a longer one, tsvector matches
 * whole lexemes only, and nobody knows which of those non-Latin DJ queries
 * usually need. Swapping the test for
 * `/[\p{L}\p{N}]/u` (matching `hasAlphanumeric` in
 * `apps/backend/utils/text-query.ts`) is a user-visible recall change on the
 * live `GET /flowsheet/search` surface (33 charset classes move from
 * ILIKE-substring to tsvector-whole-lexeme), and evaluating it needs a
 * before/after row-count measurement against flowsheet-bearing data, which no
 * local environment has (`dev_env/seed-clone.sql` is catalog-only, zero
 * flowsheet rows). `tests/unit/services/search.service.test.ts` pins the
 * current (a)-decision routing for every no-ASCII-alphanumeric entry in the
 * corpus, so a future switch to the script-aware regex fails loudly here
 * instead of silently reaching production.
 *
 * **`websearch_to_tsquery` does NOT do prefix matching**, and this comment
 * used to say it did. `websearch_to_tsquery('simple', 'autec')` lexes to the
 * lexeme `autec`; the flowsheet holds `autechre`. Two different lexemes, no
 * overlap, zero rows. So the `< 3` floor below is NOT the boundary between
 * "tsvector can serve this" and "it cannot" — every partially-typed term is on
 * the wrong side of that line, the floor just happens to route the shortest
 * ones elsewhere. Correcting the claim only; the behavior is
 * WXYC/Backend-Service#2712, which also carries the harder half: unlike the
 * catalog's `searchLibraryByTsvector`, `buildAllFieldMatch` returns a single
 * predicate with no zero-row fallback, so a 3+ character partial returns a
 * hard, silent zero rather than a slow answer.
 *
 * WXYC/Backend-Service#670 has since landed the catalog's last-token prefix
 * builder (`apps/backend/utils/tsquery.ts`), so this gate is no longer "wait
 * for that to settle" — it is a flowsheet-specific hazard #670's builder does
 * not share. `flowsheet.search_doc` concatenates FIVE weighted segments
 * (artist A, track B, dj_name B, album C, label D — migration 0054 added
 * dj_name to 0052's original four), and `tsvector || tsvector` leaves no
 * position gap, so a prefix-phrase query straddles FOUR field seams. Porting
 * `:*` here is WXYC/Backend-Service#2712, which is blocked on
 * WXYC/Backend-Service#2726 closing those seams first.
 *
 * `library.search_doc` had the same defect across its single seam and migration
 * 0178 closed it (WXYC/Backend-Service#2714) by concatenating a sentinel
 * between the segments and removing it with `ts_delete`, which shifts positions
 * without leaving a queryable lexeme behind. Flowsheet is deliberately NOT
 * fixed there: the same rewrite costs about 1.7 s of ACCESS EXCLUSIVE on the
 * 64K-row catalog, and flowsheet carries ~2.6M rows across five segments, on a
 * table the live flowsheet writes to during every show. That needs its own
 * lock-budget measurement and window, so it is tracked separately — and it is
 * this gate, not the column, that keeps the defect unreachable meanwhile.
 */
export function shouldUseTsvector(value: string): boolean {
  if (value.length < 3) return false;
  return /[a-zA-Z0-9]/.test(value);
}

function buildAllFieldMatch(value: string, exact: boolean): SQL {
  if (exact) {
    // Whole-value, but case-insensitively: quoting narrows "contains" to "is",
    // and nothing about it is meant to start distinguishing "hi scores" from
    // "Hi Scores". The tsvector path below folds case via the `simple`
    // configuration and the trigram path via ILIKE, so `=` was the one
    // predicate in this file that did not.
    return sql`(${ilikeEscaped(flowsheet.artist_name, value, 'exact')} OR ${ilikeEscaped(flowsheet.track_title, value, 'exact')} OR ${ilikeEscaped(flowsheet.album_title, value, 'exact')} OR ${ilikeEscaped(flowsheet.record_label, value, 'exact')})`;
  }
  if (shouldUseTsvector(value)) {
    // Tsvector path: tokenized whole-word matching across all four weighted
    // fields via the GIN index on flowsheet.search_doc. websearch_to_tsquery
    // handles natural query input (quoted phrases, OR, etc.) and never raises
    // on user text — but it matches WHOLE LEXEMES only, so a partially-typed
    // term reaches this branch and returns nothing. See shouldUseTsvector's
    // docstring and WXYC/Backend-Service#2712.
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
  // on the row the predicate collapses to one column.
  //
  // Nothing indexes dj_name. The standalone flowsheet_dj_name_trgm_idx that
  // originally backed this path was dropped in migration 0083 (#1060) after
  // pg_stat_user_indexes showed zero scans across months, and nothing replaced
  // it — `pg_stat_user_indexes` in prod lists 17 indexes on flowsheet, none on
  // this column. flowsheet_search_doc_idx does not stand in for it: a GIN
  // tsvector index answers `@@`, not a pattern or equality predicate on the
  // underlying text. So every dj-name search, quoted or not, is a Parallel Seq
  // Scan of the whole flowsheet heap (prod EXPLAIN 2026-09-08: cost ~230,971
  // either way) against a 5s statement_timeout, and 500s. That predates this
  // predicate's operator and is not fixed by it — BS#2400 owns it.
  if (exact) {
    return ilikeEscaped(flowsheet.dj_name, value, 'exact');
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
