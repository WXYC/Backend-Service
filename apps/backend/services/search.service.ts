import * as Sentry from '@sentry/node';
import { sql, type SQL } from 'drizzle-orm';
import { db, flowsheet, rotation, library, extractSqlState } from '@wxyc/database';
import {
  parseSearchQuery,
  FLOWSHEET_PARSER_CONFIG,
  type FlowsheetField,
  type SearchCondition,
} from './search-parser.service.js';
import { ilikeEscaped } from '../utils/sql-like.js';
import { rotationBinExpr } from '../utils/sql-rotation-bin.js';
import { buildPrefixTsquery } from '../utils/tsquery.js';

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
   * Ignored for non-date sorts (no compound index supports them). Also pins
   * which `Tier` the request runs — see {@link Cursor} and
   * docs/playlist-search/README.md.
   */
  cursor?: string;
};

/**
 * Which predicate shape `buildWhereClause` compiles for the query's
 * conditions. See "Tiered matching and the cascade" in
 * docs/playlist-search/README.md: `'word'` is today's whole-lexeme match,
 * `'prefix'` additionally prefix-matches the typing term, and `'substring'`
 * additionally OR's every tsvector-eligible condition's own predicate against
 * the four-column ILIKE-contains fallback.
 */
export type Tier = 'word' | 'prefix' | 'substring';

export type Cursor = { addTime: string; id: number; tier: Tier };

/**
 * Cursor-token suffix marking a non-`'word'` tier. An unmarked cursor — every
 * one issued before this existed — parses as `'word'`. Exported so a test
 * can round-trip `encodeCursor`/`parseCursor` over every key here, rather
 * than one hand-written case per tier that a future tier could add without
 * a matching test.
 */
export const TIER_CURSOR_SUFFIX: Record<Exclude<Tier, 'word'>, string> = {
  prefix: '_pfx',
  substring: '_sub',
};

/** Encode a cursor for the next page. Format: `${ISO timestamp}_${id}[_pfx|_sub]`. */
export function encodeCursor(addTime: string, id: number, tier: Tier): string {
  const suffix = tier === 'word' ? '' : TIER_CURSOR_SUFFIX[tier];
  return `${addTime}_${id}${suffix}`;
}

/** Parse a cursor token, or return null if malformed. */
export function parseCursor(cursor: string): Cursor | null {
  let working = cursor;
  let tier: Tier = 'word';
  // Iterate TIER_CURSOR_SUFFIX's own entries rather than one hand-written
  // `endsWith` branch per tier, so the encoder and parser can never drift —
  // adding a tier to the map is enough; no suffix here is a suffix of
  // another, so matching order never matters.
  for (const [candidateTier, suffix] of Object.entries(TIER_CURSOR_SUFFIX) as [Tier, string][]) {
    if (working.endsWith(suffix)) {
      tier = candidateTier;
      working = working.slice(0, -suffix.length);
      break;
    }
  }
  const lastUnderscore = working.lastIndexOf('_');
  if (lastUnderscore <= 0) return null;
  const addTime = working.slice(0, lastUnderscore);
  const idStr = working.slice(lastUnderscore + 1);
  if (!addTime || !idStr) return null;
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (Number.isNaN(Date.parse(addTime))) return null;
  return { addTime, id, tier };
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

/**
 * Postgres SQLSTATE for a statement cancelled by `statement_timeout` — the
 * ONLY error class a fallback tier may swallow, see `searchFlowsheet`.
 *
 * Read via `extractSqlState` (`@wxyc/database`), not a bare `error.code`:
 * `db.execute` goes through drizzle-orm, which wraps every query rejection in
 * `DrizzleQueryError` whose own `.code` is `undefined` — the SQLSTATE is on
 * `.cause.code`. Confirmed empirically through a real `db.execute` call
 * against a real Postgres (per-connection `statement_timeout: 50`,
 * `select pg_sleep(1)`): `code: '57014'` on `.cause`, not on the thrown error
 * itself. `extractSqlState`'s own header has the full mechanics and the
 * BS#2409-class failure mode of a classifier that reads only `.code`.
 */
const STATEMENT_TIMEOUT_SQLSTATE = '57014';

function isStatementTimeout(error: unknown): boolean {
  return extractSqlState(error) === STATEMENT_TIMEOUT_SQLSTATE;
}

/**
 * Hard ceiling, in milliseconds, on how long the cascade spends retrying
 * tiers — measured from when the FIRST tier started, checked only at the
 * point the loop decides to start the NEXT one. Each tier re-runs the whole
 * WHERE clause, so a slow unrelated condition (an unindexed `dj:` ILIKE scan,
 * say) or a slow `'word'` tier is otherwise paid up to three times over, each
 * holding a connection-pool slot. See docs/playlist-search/README.md.
 */
export const CASCADE_BUDGET_MS = 1500;

/** One tier's data + count attempt — the shape `searchFlowsheet`'s cascade tries in turn. */
type TierAttempt = {
  tier: Tier;
  dataSettled: PromiseSettledResult<unknown>;
  countSettled: PromiseSettledResult<unknown>;
};

/**
 * Build and run one tier's data + count queries. Everything here is
 * identical across tiers except `buildWhereClause`'s own `tier` argument —
 * the FROM/JOIN/ORDER BY/LIMIT shape, the cursor predicate, and the capped
 * count are all today's unchanged machinery (BS#1681, BS#2344, BS#2699).
 */
async function runTierQuery(
  tier: Tier,
  conditions: SearchCondition<FlowsheetField>[],
  typingTermIndex: number,
  ctx: {
    sort: SearchParams['sort'];
    order: SearchParams['order'];
    limit: number;
    offset: number;
    parsedCursor: Cursor | null;
    cursorEligible: boolean;
  }
): Promise<TierAttempt> {
  const { sort, order, limit, offset, parsedCursor, cursorEligible } = ctx;
  const whereClause = buildWhereClause(conditions, tier, typingTermIndex);
  const orderDirection = order === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = SORT_MAP[sort];

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
  // See docs/playlist-search/README.md ("Where the chain starts", BS#2344)
  // for why this is not gated on an inbound cursor.
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

  const [dataSettled, countSettled] = await Promise.allSettled([db.execute(dataQuery), db.execute(countQuery)]);
  return { tier, dataSettled, countSettled };
}

/**
 * Search historical flowsheet entries with filtering, sorting, and
 * pagination. Tries `tiersFor`'s tiers in order, stopping at the first with
 * rows — see "Tiered matching and the cascade" in
 * docs/playlist-search/README.md for the cascade rule and two accepted
 * limitations: a phrase-forming typing term re-runs a `'prefix'`-tier
 * predicate equivalent to the `'word'` tier's (one redundant statement pair
 * on a zero-result query — Postgres decides the routing at plan time, which
 * JS cannot know in advance), and offset-mode paging (no cursor) decides its
 * tier fresh on every request, so date-sort clients should page by cursor,
 * not `page`.
 *
 * **Fallback-tier failure.** Only a tier reached BY CASCADING — i.e. a prior
 * tier in this same request already settled with a result in hand — may
 * degrade to that prior result instead of failing the request, and only for
 * a statement timeout (`isStatementTimeout`): the expected case is the cold
 * `add_time` walk WXYC/Backend-Service#2688 records. Every other case is
 * fatal (throws, a 500): the `'word'` tier's own failure, a cursor pinned
 * directly to a non-`'word'` tier with nothing to fall back to, and any
 * non-timeout error at any point (a broken fallback-tier predicate must
 * surface as a real error, not hide under one fixed-fingerprint Sentry
 * capture). A swallowed timeout reports once under the fingerprint
 * `flowsheet-search-fallback-tier` rather than once per query.
 */
export async function searchFlowsheet(
  params: SearchParams
): Promise<{ results: SearchResult[]; total: number; nextCursor?: string }> {
  const { q, page, limit, sort, order, cursor } = params;
  const conditions = parseSearchQuery(q, FLOWSHEET_PARSER_CONFIG);
  const typingTermIndex = findTypingTermIndex(conditions);

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

  // A cursor pins its own tier and never cascades — EXCEPT a `_pfx`/`_sub`
  // cursor whose query no longer qualifies for that tier (e.g. the DJ
  // deleted characters since the link was issued): there is nothing left for
  // that tier to change, so treat the request as the 'word' tier. Its own
  // nextCursor, if any, comes back unmarked, which self-corrects every later
  // page.
  const tiers =
    parsedCursor !== null
      ? [resolvePinnedTier(parsedCursor.tier, conditions, typingTermIndex)]
      : tiersFor(conditions, typingTermIndex, sort);

  let lastGood: TierAttempt | null = null;
  const cascadeStartedAt = Date.now();
  for (let i = 0; i < tiers.length; i++) {
    // CASCADE_BUDGET_MS: do not START a later tier once the elapsed time
    // since the first tier began exceeds the budget. The tier already in
    // flight always finishes; this only stops the NEXT one. `lastGood` is
    // already the prior tier's own (empty) result, so breaking here just
    // returns that page — no warn, no Sentry report, identical to today's
    // natural end-of-cascade behaviour.
    if (i > 0 && Date.now() - cascadeStartedAt > CASCADE_BUDGET_MS) break;
    const tier = tiers[i];
    const attempt = await runTierQuery(tier, conditions, typingTermIndex, {
      sort,
      order,
      limit,
      offset,
      parsedCursor,
      cursorEligible,
    });

    if (attempt.dataSettled.status === 'rejected') {
      const reason: unknown = attempt.dataSettled.reason;
      if (i === 0 || !isStatementTimeout(reason)) {
        throw reason;
      }
      console.warn(`flowsheet search: '${tier}' tier timed out, falling back to the prior tier's result`, reason);
      Sentry.captureException(reason, {
        fingerprint: ['flowsheet-search-fallback-tier'],
        tags: { subsystem: 'flowsheet-search', tier },
        extra: { q, page, limit, cursor },
      });
      break;
    }

    lastGood = attempt;
    const rows = attempt.dataSettled.value as SearchResultRow[];
    const isLastTier = i === tiers.length - 1;
    if (rows.length > 0 || isLastTier) break;

    const countTotal =
      attempt.countSettled.status === 'fulfilled' ? ((attempt.countSettled.value as CountRow[])[0]?.total ?? 0) : null;
    if (!(offset === 0 || countTotal === 0)) break;
  }

  if (lastGood === null) {
    // Unreachable: a rejection with no prior successful attempt (i === 0)
    // always throws above instead of reaching here.
    throw new Error('searchFlowsheet: no tier produced a result');
  }

  const resolvedTier = lastGood.tier;
  // lastGood.dataSettled is always the fulfilled attempt that won the
  // cascade -- the rejected branch above always throws or breaks before
  // lastGood is assigned from it.
  const rows = (lastGood.dataSettled as PromiseFulfilledResult<unknown>).value as SearchResultRow[];
  const results = rows.map(transformRow);

  // allSettled, not all: the count is cheap enough that it should never time
  // out, but if it (or a future predicate) does, the data page is already in
  // hand — degrade to a lower-bound total rather than 500-ing the whole
  // request the way the pre-BS#1681 `Promise.all` did.
  let total: number;
  if (lastGood.countSettled.status === 'fulfilled') {
    total = (lastGood.countSettled.value as CountRow[])[0]?.total ?? 0;
  } else {
    // Best-effort total when the count is unavailable: the rows we've already
    // paged past plus this page. Exact for a partial final page, a lower bound
    // for a full page, and — only in the rare empty-page-past-end offset case —
    // an over-estimate bounded by `offset`. In cursor mode `offset` is 0, so
    // this collapses to the current page size.
    total = offset + results.length;
    const reason: unknown = lastGood.countSettled.reason;
    if (resolvedTier !== 'word' && isStatementTimeout(reason)) {
      // A cascaded tier's COUNT query timing out is the same expected-cold
      // `add_time` walk as a cascaded tier's DATA query timing out (see
      // "Fallback-tier failure" above) — fingerprint it the same way so an
      // expected timeout opens one Sentry issue, not one per distinct query.
      // The `'word'` tier's own count failure is unaffected: it keeps
      // today's un-fingerprinted reporting exactly, in the branch below.
      console.warn(
        `flowsheet search: '${resolvedTier}' tier's count query timed out; returning lower-bound total`,
        reason
      );
      Sentry.captureException(reason, {
        fingerprint: ['flowsheet-search-fallback-tier-count'],
        tags: { subsystem: 'flowsheet-search', tier: resolvedTier },
        extra: { q, page, limit, cursor },
      });
    } else {
      Sentry.captureException(reason, {
        tags: { subsystem: 'flowsheet-search' },
        // `cursor`, not just `page`: in cursor mode `page` is always 0, so
        // without the token there is nothing in this report that says WHERE in
        // a walk the count gave out.
        extra: { q, page, limit, cursor },
      });
      console.error('flowsheet search count query failed; returning lower-bound total', reason);
    }
  }

  // nextCursor whenever this sort supports cursors AND we got a full page —
  // a short page means there are no more rows. Carries `resolvedTier` so the
  // next request stays pinned to the tier that actually produced this page.
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
      ? encodeCursor(rows[rows.length - 1].cursor_time, rows[rows.length - 1].id, resolvedTier)
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

/**
 * Index of the query's typing term, or -1 if none. Scans back from the end:
 * skips field conditions and negated or quoted bare terms, then at the
 * first positive unquoted bare `all` term, returns its index if
 * `shouldUseTsvector(value)`, else -1. A short or otherwise ineligible
 * trailing term ENDS the search rather than being skipped past —
 * `autechre am` has no typing term, because `am` is what the DJ is typing.
 * See docs/playlist-search/README.md.
 */
function findTypingTermIndex(conditions: SearchCondition<FlowsheetField>[]): number {
  for (let i = conditions.length - 1; i >= 0; i--) {
    const condition = conditions[i];
    if (condition.field !== 'all' || condition.negated || condition.exact) continue;
    return shouldUseTsvector(condition.value) ? i : -1;
  }
  return -1;
}

/**
 * The single source of truth for substring-tier eligibility: a condition
 * whose `'substring'`-tier predicate differs from its `'word'`-tier
 * predicate at all — a positive (non-negated), unquoted, bare `all`
 * condition whose value is tsvector-eligible (`shouldUseTsvector`). Read by
 * `hasSubstringEligibleTerm` (via `tiersFor`/`resolvePinnedTier`) AND by
 * `buildWhereClause`'s own per-condition `substring` flag, so the
 * `'substring'` tier is scheduled exactly when at least one condition's SQL
 * would actually change — never when the whole tier would be byte-identical
 * to `'word'`'s, and never silently out of step with which conditions
 * actually get widened.
 */
export function isSubstringEligible(condition: SearchCondition<FlowsheetField>): boolean {
  return condition.field === 'all' && !condition.negated && !condition.exact && shouldUseTsvector(condition.value);
}

/** Whether any condition would change under the `'substring'` tier — see `isSubstringEligible`. */
function hasSubstringEligibleTerm(conditions: SearchCondition<FlowsheetField>[]): boolean {
  return conditions.some(isSubstringEligible);
}

/** Tiers to try in order: always `'word'`; `'prefix'` when a typing term exists; `'substring'` when any term is tsvector-eligible. A non-date sort returns `['word']` only. See docs/playlist-search/README.md. */
function tiersFor(
  conditions: SearchCondition<FlowsheetField>[],
  typingTermIndex: number,
  sort: SearchParams['sort']
): Tier[] {
  if (sort !== 'date') return ['word'];
  const tiers: Tier[] = ['word'];
  if (typingTermIndex !== -1) tiers.push('prefix');
  if (hasSubstringEligibleTerm(conditions)) tiers.push('substring');
  return tiers;
}

/** A cursor's own tier, downgraded to `'word'` if its query no longer qualifies for it (the `_pfx` rule, extended to `_sub`). */
function resolvePinnedTier(tier: Tier, conditions: SearchCondition<FlowsheetField>[], typingTermIndex: number): Tier {
  if (tier === 'prefix' && typingTermIndex === -1) return 'word';
  if (tier === 'substring' && !hasSubstringEligibleTerm(conditions)) return 'word';
  return tier;
}

/**
 * Exported so `tests/unit/services/search.service.substring-tier.test.ts`
 * can render the `'word'` and `'substring'` tiers' WHERE clauses directly
 * and assert the single-eligibility-predicate invariant (see
 * `isSubstringEligible`) without reaching through the cascade. Not part of
 * the HTTP-facing contract.
 */
export function buildWhereClause(
  conditions: SearchCondition<FlowsheetField>[],
  tier: Tier,
  typingTermIndex: number
): SQL | null {
  if (conditions.length === 0) return null;

  // Only the 'prefix' tier prefix-matches the typing term; the 'word' tier
  // ignores `typingTermIndex` entirely, which keeps its compiled SQL
  // byte-identical to pre-#2712 `main`. The 'substring' tier never prefixes
  // (substring already subsumes a prefix) but widens every eligible,
  // non-negated condition's own predicate with the ILIKE-contains OR.
  const prefixIndex = tier === 'prefix' ? typingTermIndex : -1;
  const substringTier = tier === 'substring';

  const parts: { operator: 'AND' | 'OR'; fragment: SQL }[] = [];

  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    const fragment = buildConditionFragment(condition, {
      prefix: i === prefixIndex,
      substring: substringTier && isSubstringEligible(condition),
    });
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

function buildConditionFragment(
  condition: SearchCondition<FlowsheetField>,
  options: { prefix: boolean; substring: boolean }
): SQL | null {
  const { field, value, exact, negated } = condition;

  let fragment: SQL;

  switch (field) {
    case 'all':
      fragment = buildAllFieldMatch(value, { exact, prefix: options.prefix, substring: options.substring });
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
 * Whether an `all`-field bare term reads the tsvector path (in any tier) or
 * stays on trigram ILIKE. The `< 3` floor counts INPUT characters, not the
 * lexeme(s) Postgres resolves them to — `..a` clears the floor and reaches
 * this branch, but re-lexes to the single lexeme `a` (leading punctuation
 * dropped, the same mechanism that drops a leading `-`; see
 * docs/adr/0015-catalog-search-query-operators.md). The floor is therefore a
 * semantics choice — trigram substring matching (`tv` matches `mtv`) vs
 * tsvector word matching for a short typed-so-far term — not a correctness
 * boundary. ASCII-only routing is a second, independent, deliberate decision
 * (WXYC/Backend-Service#2739). See docs/playlist-search/README.md for both.
 */
export function shouldUseTsvector(value: string): boolean {
  if (value.length < 3) return false;
  return /[a-zA-Z0-9]/.test(value);
}

/**
 * Read-time rebuild of `flowsheet.search_doc`'s five weighted segments WITH
 * a position gap between each pair (the migration 0178 mechanism, applied
 * per query rather than baked into a `STORED GENERATED` column because
 * flowsheet cannot afford that rewrite's lock), so a `<->` phrase query
 * cannot straddle a field seam. Named as a sentinel constant so a test can
 * pin it against `library.search_doc`'s own copy of the same mechanism —
 * `tests/unit/services/search.service.gapped-vector-schema-drift.test.ts`.
 * See docs/playlist-search/README.md ("The segments touch") for the
 * mechanism and the verified counts.
 */
export const SEARCH_DOC_GAP_SENTINEL = 'wxycsearchdocgap';

function gappedSearchDocSql(): SQL {
  // Literal SQL text, not a bound parameter -- matching migration 0178's own
  // shape rather than introducing an extra param the planner has no reason
  // to see.
  const gapVector = `${SEARCH_DOC_GAP_SENTINEL} ${SEARCH_DOC_GAP_SENTINEL} ${SEARCH_DOC_GAP_SENTINEL}`;
  const gap = sql.raw(`to_tsvector('simple', '${gapVector}')`);
  const sentinel = sql.raw(`'${SEARCH_DOC_GAP_SENTINEL}'`);
  return sql`ts_delete(setweight(to_tsvector('simple', coalesce(${flowsheet.artist_name}, '')), 'A') || ${gap} || setweight(to_tsvector('simple', coalesce(${flowsheet.track_title}, '')), 'B') || ${gap} || setweight(to_tsvector('simple', coalesce(${flowsheet.dj_name}, '')), 'B') || ${gap} || setweight(to_tsvector('simple', coalesce(${flowsheet.album_title}, '')), 'C') || ${gap} || setweight(to_tsvector('simple', coalesce(${flowsheet.record_label}, '')), 'D'), ${sentinel})`;
}

/**
 * Four-column ILIKE-contains predicate (`artist_name`, `track_title`,
 * `album_title`, `record_label` — no `dj_name`, which has no trigram index;
 * see `buildDjNameMatch`). The trigram fallback for an ineligible term
 * (`shouldUseTsvector` false) and, as of WXYC/Backend-Service#2712, the
 * `'substring'` tier's OR-partner for every eligible term.
 */
function ilikeContainsFragment(value: string): SQL {
  return sql`(${ilikeEscaped(flowsheet.artist_name, value, 'contains')} OR ${ilikeEscaped(flowsheet.track_title, value, 'contains')} OR ${ilikeEscaped(flowsheet.album_title, value, 'contains')} OR ${ilikeEscaped(flowsheet.record_label, value, 'contains')})`;
}

/**
 * Predicate for an `all`-field (bare-term) condition. `options.exact` means
 * quoted — whole-value ILIKE, the same in every tier. `options.prefix` is
 * true for exactly one condition per `'prefix'`-tier query, the typing term
 * `searchFlowsheet` resolves via `findTypingTermIndex`; always false in the
 * `'word'` and `'substring'` tiers. `options.substring` is true for every
 * `isSubstringEligible` condition in the `'substring'` tier.
 *
 * **Word tier:** `search_doc @@ E AND (strpos((E)::text, '<') = 0 OR gapped
 * @@ E)`, where `E = buildPrefixTsquery(value).exactTsquery` matches whole
 * lexemes only. The `strpos` guard closes the field-seam gaps
 * `flowsheet.search_doc` cannot close at the column (WXYC/Backend-Service#2726)
 * — see docs/playlist-search/README.md for the mechanism and the EXPLAIN
 * evidence that Postgres folds it away for a plain word.
 *
 * **Prefix tier:** one outer boolean CASE, `CASE WHEN strpos((E)::text, '<')
 * = 0 THEN search_doc @@ P ELSE (search_doc @@ E AND gapped @@ E) END`,
 * where `P = buildPrefixTsquery(value).tsquery` (last token suffixed `:*`).
 * A single-lexeme `E` takes THEN (no gapped recheck needed — one prefix
 * operand cannot straddle a seam); a phrase-forming `E` takes ELSE and is
 * NEVER prefixed: Postgres's `:*` lands on every lexeme such a phrase
 * re-lexes into, not just the last one, and a capped count against that
 * shape measured 15.6s on production against the endpoint's 5s timeout — a
 * cost reason, not a recall one. See docs/playlist-search/README.md for the
 * full design and the EXPLAIN verification that both arms fold cleanly.
 *
 * **Substring tier:** `(<word tier's own predicate> OR <ilikeContainsFragment>)`
 * — never the prefix CASE, which substring matching already subsumes. The OR
 * keeps `dj_name` coverage: `search_doc` includes `dj_name` but
 * `ilikeContainsFragment` does not, so a term that only matched via `dj_name`
 * in an earlier tier keeps matching here. See docs/playlist-search/README.md.
 *
 * `built` is `null` only when no token carries a letter or digit —
 * `shouldUseTsvector` already guarantees one, so the trigram fallback below
 * only actually triggers if that guarantee ever loosens.
 */
function buildAllFieldMatch(value: string, options: { exact: boolean; prefix: boolean; substring: boolean }): SQL {
  const { exact, prefix, substring } = options;
  if (exact) {
    // Whole-value, but case-insensitively: quoting narrows "contains" to "is",
    // and nothing about it is meant to start distinguishing "hi scores" from
    // "Hi Scores". The tsvector path below folds case via the `simple`
    // configuration and the trigram path via ILIKE, so `=` was the one
    // predicate in this file that did not.
    return sql`(${ilikeEscaped(flowsheet.artist_name, value, 'exact')} OR ${ilikeEscaped(flowsheet.track_title, value, 'exact')} OR ${ilikeEscaped(flowsheet.album_title, value, 'exact')} OR ${ilikeEscaped(flowsheet.record_label, value, 'exact')})`;
  }
  if (shouldUseTsvector(value)) {
    const built = buildPrefixTsquery(value);
    if (built !== null) {
      const q = built.exactTsquery;
      const wordMatch = prefix
        ? // One outer boolean CASE (see docstring): THEN picks the prefix
          // form directly, ELSE is exactly the word tier's own predicate.
          sql`(CASE WHEN strpos((${q})::text, '<') = 0 THEN ${flowsheet.search_doc} @@ ${built.tsquery} ELSE (${flowsheet.search_doc} @@ ${q} AND ${gappedSearchDocSql()} @@ ${q}) END)`
        : // Word tier: byte-identical to pre-#2712 `main`.
          sql`(${flowsheet.search_doc} @@ ${q} AND (strpos((${q})::text, '<') = 0 OR ${gappedSearchDocSql()} @@ ${q}))`;
      return substring ? sql`(${wordMatch} OR ${ilikeContainsFragment(value)})` : wordMatch;
    }
  }
  // Trigram fallback: short queries, pure-punctuation strings, and any other
  // input that the tsvector path would tokenize away.
  return ilikeContainsFragment(value);
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
