# Playlist Search

This document describes the architecture and evolution plan for `GET /flowsheet/search`, the historical playlist search powering the dj-site Previous Sets page.

## Overview

DJs and music directors search the flowsheet to find when a song was last played, who played a particular artist, what label put out an album, and similar lookups against the entire history of WXYC playlists. The flowsheet is append-mostly, bounded to a few million rows over the lifetime of the digital flowsheet, and is served to a small internal audience rather than a public-facing population.

The search is implemented in `apps/backend/services/search.service.ts`, parsed by `apps/backend/services/search-parser.service.ts`, and exposed by `apps/backend/controllers/search.controller.ts` at `GET /flowsheet/search`.

## Query Surface

The parser supports a small DSL on top of a single `q` string parameter:

| Form              | Example                                                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bare term         | `autechre`, `autec`, `utechre`                                             | Word match (3+ chars) across `artist_name`, `track_title`, `album_title`, `record_label`, `dj_name` (see "Tiered matching and the cascade" below). A whole-word match always wins first; when it finds NOTHING and a typing term is present, the term still being typed — the last bare, unquoted, non-negated word — is RETRIED with prefix matching (`autec` matches `autechre`, WXYC/Backend-Service#2712), with earlier words still required to match whole. When that still finds nothing, every eligible positive bare term (not just the typing term) is retried as a substring match (`utechre` matches `autechre`) — this is ordinary ILIKE-contains, not fuzzy or misspelling-tolerant matching; see "Tiered matching and the cascade". 1-2 character terms stay on ILIKE-substring across the four non-`dj_name` columns in every tier |
| Field prefix      | `artist:autechre`, `song:poise`, `album:confield`, `label:warp`, `dj:jake` | Restricts to a single column (or DJ name expression)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Date              | `date:2024-06-15`                                                          | Equality on the calendar day                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Date range        | `dateRange:2024-01-01..2024-12-31`                                         | Inclusive range on `add_time`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Boolean operators | `artist:juana AND label:sonamos`, `dj:jake OR dj:nora`, `NOT label:warp`   | Composes conditions with `AND`, `OR`, `NOT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Exact match       | `artist:"Cat Power"`                                                       | Equality instead of substring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The endpoint accepts `page`, `limit` (max 100), `sort` (`date` \| `artist` \| `song` \| `dj`), and `order` (`asc` \| `desc`). Default sort is `date desc`.

## Schema and Indexes

The `wxyc_schema.flowsheet` table holds one row per playlist entry. Search joins to `shows` and `user` only to resolve the displayed DJ name through `COALESCE(user.dj_name, shows.legacy_dj_name, user.name)`.

| Index                             | Type                                 | Migration | Purpose                                                                       |
| --------------------------------- | ------------------------------------ | --------- | ----------------------------------------------------------------------------- |
| `flowsheet_entry_type_idx`        | btree on `entry_type`                | `0024`    | Filters out break / message rows during search (`WHERE entry_type = 'track'`) |
| `flowsheet_artist_name_trgm_idx`  | GIN `gin_trgm_ops` on `artist_name`  | `0042`    | Substring match on artist (originally added for ghost-text autocomplete)      |
| `flowsheet_track_title_trgm_idx`  | GIN `gin_trgm_ops` on `track_title`  | `0042`    | Substring match on song title                                                 |
| `flowsheet_album_title_trgm_idx`  | GIN `gin_trgm_ops` on `album_title`  | `0049`    | Substring match on album title                                                |
| `flowsheet_record_label_trgm_idx` | GIN `gin_trgm_ops` on `record_label` | `0049`    | Substring match on label                                                      |

Trigram (`pg_trgm`) GIN indexes support `ILIKE '%term%'` queries by indexing every three-character substring. Postgres can `BitmapOr` matches across all four columns when the bare `q` form fans out, which is the path taken when the user types a single unqualified word.

What is **not** indexed:

- `add_time` — the default sort column, used by every query that omits a more specific sort.
- The DJ-name `COALESCE` expression — `dj:` filters and `sort=dj` both fall back to a sequential scan of the joined rows.

## Current Performance Behavior

The implementation has had two iterations. The current shape is a single SQL statement that combines the data fetch with a `COUNT(*) OVER()` window function:

```sql
SELECT
  flowsheet.id,
  flowsheet.add_time AS play_date,
  ...
  COALESCE(user.dj_name, shows.legacy_dj_name, user.name, 'Unknown DJ') AS dj_name,
  (COUNT(*) OVER())::int AS total
FROM flowsheet
LEFT JOIN shows ON shows.id = flowsheet.show_id
LEFT JOIN "user" ON "user".id = shows.primary_dj_id
WHERE flowsheet.entry_type = 'track' AND <where>
ORDER BY <sort> <order>
LIMIT <limit> OFFSET <offset>;
```

The previous shape was two parallel queries via `Promise.all` — a `LIMIT`-bounded data query plus a separate `SELECT COUNT(*)`.

`COUNT(*) OVER()` defeats the `LIMIT` planner optimization. To compute the running count for every row, Postgres must materialize the entire match set before truncating to the page size. For a popular term the bitmap scan can return tens of thousands of rows, which then have to be sorted in memory before the window count can be evaluated. The previous parallel implementation let the data query short-circuit at 50 sorted rows; the count query was expensive but ran concurrently.

The compounding factor is the missing `add_time` btree. Even if the count were not in the way, the planner has no index that satisfies `ORDER BY add_time DESC`, so it falls back to an in-memory sort of the bitmap output.

## Recommended Evolution

The following steps are ordered by impact. Steps 1, 2, and 5a are independent and can land in any order. Step 3 (cursor pagination) is a coordinated frontend/backend change. Step 4 is the upgrade path if word-level matching and relevance ranking become priorities. Steps 1–3 are low-effort and likely sufficient for current scale.

### 1. Drop `COUNT(*) OVER()`

Restore the two-query split, or skip the count on the first page entirely and let the UI display "loading more…" until the user paginates. The latter avoids ever materializing the full match set for queries the user never paginates past, which is the common case.

Either path benefits from step 2 — the `add_time` index satisfies the data query's `ORDER BY` regardless of how the count is computed. The choice between parallel-count and lazy-count is a UX decision (does the page show a precise total up front?) more than a performance one.

### 2. Partial btree on `(add_time DESC) WHERE entry_type = 'track'`

```sql
CREATE INDEX flowsheet_track_add_time_idx
  ON wxyc_schema.flowsheet (add_time DESC)
  WHERE entry_type = 'track';
```

Lets the planner satisfy `ORDER BY add_time DESC LIMIT 50` directly from the index, avoiding the in-memory sort. Also services the empty-query "show recent tracks" default the dj-site Previous Sets page is moving to.

**Amended by step 3 (BS#2344).** The date sort now compiles `ORDER BY add_time <dir>, id <dir>`, so this index no longer satisfies the ordering outright: Postgres keeps the index scan and adds an Incremental Sort over each equal-`add_time` group. That is not the sort this index was built to remove — that one was over the whole trigram bitmap output, this one is over a single timestamp's tie group — and it is what buys the total order cursor pagination needs. See "Where the chain starts" below.

### 3. Cursor-based pagination

The frontend already uses infinite scroll, so `OFFSET` is doing extra work for no benefit — its cost grows linearly with page depth because Postgres still has to scan and discard the skipped rows. Replacing it with a cursor (`WHERE (add_time, id) < (cursor_time, cursor_id)`) makes every page O(limit) regardless of depth and pairs cleanly with the new `add_time` index.

The cursor is **compound** `(add_time, id)` rather than `add_time` alone because the legacy ETL backfilled many rows with batch-import timestamps that share the same `add_time` value to the microsecond — a single-column cursor would silently drop those rows on page boundaries. The compound form orders by `(add_time, id)` and uses row-value comparison `(add_time, id) < (cursor_time, cursor_id)` to break ties on `id`.

**Sort coverage.** Cursor pagination only applies to `sort=date`. Other sorts (`artist`, `song`, `dj`) keep using offset because their sort columns are not unique and there is no compound index supporting a `(sort_col, id)` cursor. This matches usage: the default Previous Sets view and the empty-`q` recent-tracks path both use date sort.

**Where the chain starts (BS#2344).** `nextCursor` is emitted for any full page under `sort=date`, whether or not the request carried a cursor. It was originally gated on a cursor having been passed _in_, which meant the first request of a session — the one that by definition has none — never handed back the link to the second, and every consumer was stuck on page one. The corollary is that page 0 must be totally ordered as well: `sort=date` therefore compiles `ORDER BY add_time <dir>, id <dir>` in both offset and cursor mode. `add_time` alone is not a total order (batch-imported rows share one import timestamp), so a cursor taken off an untied page would name an arbitrary member of its tie group and the rest of that group would be duplicated or skipped on the next page. Non-date sorts keep the untied `ORDER BY`, since they neither emit nor accept a cursor.

A final page holding exactly `limit` rows emits a cursor and costs one extra request that returns nothing. That is expected: knowing there is no next page without fetching would require either an over-fetch or an exact count, and the count on this endpoint is deliberately capped (`COUNT_CAP`).

**Compatibility plan.** The dj-site `useLazySearchPlaylistsQuery` is the only known consumer and currently reads `totalPages`. The response returns both `nextCursor` (on any full `sort=date` page) and `totalPages` (always) so dj-site can migrate when convenient. Once dj-site is migrated, `totalPages` and the `page` query parameter can be removed in a follow-up. New consumers should be guided to the cursor form from the start.

A malformed cursor returns `400`. Encoding format is `${ISO_timestamp}_${id}` — opaque to clients in spirit, debuggable in practice. As of WXYC/Backend-Service#2712, a cursor also carries which search _tier_ produced its page: an unmarked cursor (every one handed out before #2712) means the `'word'` tier, a trailing `_pfx` marker means the `'prefix'` tier, and a trailing `_sub` marker means the `'substring'` tier (PR 2) — see "Tiered matching and the cascade" below. A cursor pins its tier for every later page of that walk, with one exception: a `_pfx`/`_sub` cursor whose query no longer qualifies for that tier falls back to the `'word'` tier and self-corrects to an unmarked cursor from there — see "A `_pfx` cursor whose query no longer has a typing term" below.

**The timestamp half is rendered by Postgres, not by JavaScript** (`CURSOR_TIME_EXPR` in `search.service.ts`), at the column's own microsecond resolution: `2026-08-30T12:00:00.123456Z_4711`. `add_time` is `timestamptz DEFAULT now()` and live inserts omit the column, so production rows carry microseconds a JS `Date` cannot hold. A cursor floored to milliseconds names an instant strictly before the boundary row while `parseCursor` binds it back at full precision, which duplicates the boundary row on every ascending page and steps over anything inside `(floor_ms(T), T)` descending. Today a raw `db.execute` happens to return Postgres's own text rendering — drizzle's postgres-js driver installs a transparent parser over OID 1184 — so the precision was never actually lost; selecting it explicitly makes that a property of the query rather than of a dependency, and produces the ISO-8601 form this section claims (the text rendering, `2026-08-30 12:00:00.1234+00`, is not one).

### 4. Generated `tsvector` column with hybrid trigram fallback

Add a `STORED` generated `tsvector` column combining the four text fields with weight bands:

```sql
ALTER TABLE wxyc_schema.flowsheet
  ADD COLUMN search_doc tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(artist_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(track_title, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(album_title, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(record_label, '')), 'D')
  ) STORED;

CREATE INDEX flowsheet_search_doc_idx
  ON wxyc_schema.flowsheet USING gin (search_doc);
```

Use `'simple'` (no stemming) — music titles are full of proper nouns, foreign words, and stylized spellings that English stemming distorts.

**The segments touch.** `tsvector || tsvector` shifts the right operand's positions to continue from the left's with **no gap**, so each segment's first lexeme is adjacent to the previous segment's last one and a phrase query can match across a field boundary — matching `artist <-> track`, say, where those words were never adjacent in any real text. As shipped, `flowsheet.search_doc` has **five** segments (migration `0054` added `dj_name` to `0052`'s original four, and `0065` replayed it), so there are **four** such seams.

`library.search_doc` had the same defect across its single seam, and migration `0178` fixed it at the column: concatenate a sentinel between the segments to buy a position shift, then remove it with `ts_delete`, which deletes a lexeme's entry without renumbering the survivors. See `docs/catalog-search/README.md` → **Why the segments do not touch** for the mechanism and the numbers.

**Flowsheet cannot take that column fix, and closes the same four seams at the reader instead (BS#2726).** Redefining a `STORED GENERATED` column requires `DROP COLUMN` + `ADD COLUMN` (Postgres cannot change a generation expression in place), which rewrites every row under `ACCESS EXCLUSIVE`. Migration `0178`'s rewrite cost about 1.71 s on the 64K-row catalog; the equivalent measured on a restored production flowsheet snapshot (db.t4g.small, PG 14.22, 2.65M rows) held ACCESS EXCLUSIVE for **~8 m 06 s**, and `migrate()` applies every pending migration in one transaction, so that lock — which blocks every flowsheet read and write — would be held for the whole deploy's migration batch, not just this rewrite. There is no quiet hour that makes an 8-minute outage of the flowsheet acceptable, so this stays a reader-side fix rather than a column rewrite; a planned flowsheet downtime (a PG major-version upgrade, say) is the point at which the column rewrite becomes affordable and the guard below can retire.

An expression index over the gapped vector was considered and rejected: a GIN tsvector index stores lexemes, not positions, so an index built on a gapped expression would return exactly the same candidate rows `flowsheet_search_doc_idx` already returns, and its own phrase recheck recomputes the expression from the row anyway. There is nothing an index buys here that the existing index doesn't already provide.

**The fix.** `buildAllFieldMatch` (`apps/backend/services/search.service.ts`) switched its tsvector branch from `websearch_to_tsquery` to the catalog's own last-token prefix builder (`buildPrefixTsquery(value).exactTsquery`, `apps/backend/utils/tsquery.ts`, WXYC/Backend-Service#670) — a builder that emits only quoted lexemes AND'd together, and never negation or a user operator (docs/adr/0015-catalog-search-query-operators.md). `buildAllFieldMatch` ANDs a second predicate against `gappedSearchDocSql()` — a read-time rebuild of the same five weighted segments with a `wxycsearchdocgap` sentinel between each pair (the 0178 mechanism, applied per-query instead of baked into the column) — gated by `strpos(q::text, '<') = 0 OR gapped @@ q` rather than a JS prediction of which tokens need it (BS#2753 review): `<` can only appear in a tsquery's `::text` rendering as the `<->`/`<N>` phrase-distance operator the `simple` lexer inserts when it splits a quoted lexeme, never as literal lexeme content, because the builder's metacharacter strip already removes `<` and `>` from the raw input before any token is quoted. An earlier version of this guard computed a `phraseCapable` boolean in `apps/backend/utils/tsquery.ts` by re-implementing enough of `to_tsquery`'s word-boundary rules to predict the split — review found that prediction both under-routed (a digit beside a letter, e.g. `4e4abyss` -> `'4e4' <-> 'abyss'`, which no letters-and-digits allowlist can see coming) and depended on how far Postgres's internal Unicode tables had drifted from JS's `\p{L}`, which varies by Postgres build and is not something a docs claim can pin across environments. Asking Postgres the question directly, against the tsquery it actually built, has no such gap and nothing left to re-derive.

```sql-claim
to_tsquery('simple', $$'o''rourke'$$)::text -> 'o' <-> 'rourke'
ts_delete(setweight(to_tsvector('simple', 'Jessica Pratt'), 'A') || to_tsvector('simple', 'wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap') || setweight(to_tsvector('simple', 'Back, Baby'), 'B'), 'wxycsearchdocgap') @@ to_tsquery('simple', $$'pratt' <-> 'back'$$) -> false
```

The first claim is the kind of token that routes to the guard: `to_tsquery` splits a quoted lexeme containing an apostrophe into a `<->` chain, because the `simple` parser treats that character as a word boundary. The second is the mechanism itself, at two segments instead of five: `Jessica Pratt`'s last lexeme (`pratt`) and `Back, Baby`'s first lexeme (`back`) are exactly the artist→track adjacency BS#2726's production measurement used, and gapping the vector by three sentinel repeats pushes their distance past what `<->` (distance 1) can reach, so the phrase built from `pratt'back` fails to match even though it matches the ungapped column. For a **positive** query the gapped matches are a subset of the ungapped matches (gapping can only lengthen a cross-seam distance, never shorten a within-segment one), so `search_doc @@ q AND gapped @@ q` is exactly the gapped semantics, computed from the existing index's candidates rather than a second scan. Measured read-only on production (2026-09-29 PDT): the AND form returns exactly the gapped counts (`it's` 19,235 → 19,234; `b_side` 620 → 612; `pratt'back` — built to straddle the artist→track seam — 62 → 0; `o'rourke`, `rock'n'roll` and `don't` unchanged). Cost, measured warm on production under the earlier JS-routed guard (which only emitted the second predicate's SQL text at all for a flagged token): cursor pages carrying a guarded token increased 2.7× (`it's` 105 → 280 ms) to 4.4× (`don't` 105 → 465 ms); the capped count (`search.service.ts`'s `COUNT_CAP` derived table) stayed in the low hundreds of milliseconds for the heaviest guarded tokens measured (`don't` 29 → 186 ms, `i'm` 30 → 189 ms, `it's` 36 → 136 ms); a forced `add_time`-walk plan was unaffected (`b_side` 11,688 ms column-only vs 11,660 ms with the guard), since the filter evaluates the cheap `search_doc @@` clause first. Under the current SQL-routed guard a plain word pays even less than that: BS#2753 measured (`EXPLAIN (ANALYZE, BUFFERS)`, 200k-row local clone, `PREPARE`/`EXECUTE` under `plan_cache_mode = force_custom_plan` — the plan mode this connection always uses, since `db.execute` resolves to postgres-js's `client.unsafe(query, params)`, which defaults to `{ prepare: false }`) that Postgres's planner constant-folds the entire `strpos(...) = 0 OR gapped @@ q` branch at plan time whenever the bound value is a literal, collapsing a plain word's Filter clause to byte-identical text and cost as the bare `search_doc @@ q` predicate, and a guarded word's Filter clause to byte-identical text and cost as the unconditional AND. Only `force_generic_plan` — a mode this connection never requests — showed the extra per-row cost a naive reading of `strpos` might expect. See WXYC/Backend-Service#2726 and WXYC/Backend-Service#2753.

Keep the trigram indexes. The router logic at the service layer chooses:

- Multi-character word with letters → the tsvector branch above (fast, supports relevance ranking via `ts_rank` on the catalog's sibling surface)
- Short fragment, internal substring (e.g., `tron` matching `Strontium`), or explicit wildcard → ILIKE on the trigram-indexed columns

This hybrid covers both user intents that show up in music search: "I remember a word from the title" and "I remember a fragment of an unusual name."

**The shipped router did not originally make that distinction, and WXYC/Backend-Service#2712 closes it with a cascade, not an unconditional rewrite.** `shouldUseTsvector` tests only `value.length >= 3` plus "contains an alphanumeric" — it cannot tell a complete word from a partially-typed one, so a 3+ character _prefix_ is routed to the tsvector branch the first bullet reserves for whole words. Before #2712, `buildPrefixTsquery(value).exactTsquery` matched whole lexemes only (`'autec'` did not match `autechre`), and `buildAllFieldMatch` returned that single predicate with no zero-row fallback, so such a query returned a hard zero instead of falling through to the trigram branch the second bullet describes.

An EARLIER version of #2712 (reviewed before merge) prefix-matched the typing term unconditionally, in the same predicate the whole-word match already used. Review found that a _completed_ word was then always prefix-matched too: `can` would return `candy`, `canada` and `cannibal` interleaved with whole-word hits by `add_time`, with no way for the DJ to ask for the whole word on an unranked, date-sorted surface. It also widened an existing timeout problem on non-date sorts (production, `sort=artist`: exact `the` already 13s against the 5s `statement_timeout`; a broadened `'lov':*` 14s; `'ste':*` 10s cold). The shipped design instead prefix-matches ONLY when whole-word matching finds nothing — a completed word behaves exactly as it does today, in every sort.

### Tiered matching and the cascade (WXYC/Backend-Service#2712)

`type Tier = 'word' | 'prefix' | 'substring'`. `buildWhereClause(conditions, tier)` compiles one of three shapes:

- **`'word'`** — today's SQL, byte-identical to the predecessor: every condition's tsvector predicate matches whole lexemes only, `buildPrefixTsquery(value).exactTsquery` as always.
- **`'prefix'`** — every condition is identical to `'word'` EXCEPT the query's "typing term": the LAST condition that is `field === 'all'`, not `exact`, not `negated`, AND `shouldUseTsvector(value)` (a 1-2 character typing term never reaches this tier — see below), regardless of what conditions follow it (`findTypingTermIndex` in `search.service.ts`; dj-site's `buildQuery` can append a field or date-range row after a bare-text row, so "regardless of what follows" is load-bearing, not incidental). That one condition's predicate is ONE outer boolean CASE, with `E = buildPrefixTsquery(value).exactTsquery` and `P = buildPrefixTsquery(value).tsquery` (same tokenization, last lexeme suffixed `:*`):

```sql
CASE WHEN strpos((E)::text, '<') = 0
     THEN search_doc @@ P
     ELSE (search_doc @@ E AND gapped @@ E)
END
```

When `E` is a single lexeme (the DJ is mid-word on one token — the common case), the THEN arm applies: a single prefix operand cannot straddle a field seam on its own, so no gapped recheck is needed, and `search_doc @@ P` alone is the predicate. When `E` is a `<->` phrase chain (the token contains an apostrophe or similar), the ELSE arm applies: exactly the `'word'`-tier predicate for `E`, unprefixed.

- **`'substring'`** (WXYC/Backend-Service#2712, PR 2) — every condition that is `field === 'all'`, not `exact`, not `negated`, AND `shouldUseTsvector(value)` — every eligible condition, not only the typing term — becomes `(<its 'word'-tier predicate> OR <the four-column ILIKE-contains predicate also used by the trigram fallback>)`. The typing term is never prefix-matched in this tier: substring matching already subsumes a prefix match, so the CASE form from `'prefix'` never appears here. The OR is necessary, not cosmetic: `search_doc` includes `dj_name` (migration 0054) but the ILIKE-contains predicate only covers `artist_name`/`track_title`/`album_title`/`record_label` (`dj_name` has no trigram index — see `buildDjNameMatch`'s docstring), so a term that matched via `dj_name` in an earlier tier would otherwise stop matching here. Ineligible conditions (quoted, negated, field, date, 1-2 character or non-ASCII bare terms) are unchanged from the `'word'` tier in this tier too.

`searchFlowsheet` runs `tiersFor`'s tiers in order, stopping at the first with rows. `'word'` always runs first. `'prefix'` runs next IF a typing term exists. `'substring'` runs after that IF any condition is tsvector-eligible — a gate independent of the typing term: a trailing 1-2 character bare term (e.g. `autechre am`) disqualifies `'prefix'` (there is no typing term — see `findTypingTermIndex`'s "ends the search" rule below) but does NOT disqualify `'substring'`, since `autechre` alone still qualifies as an eligible condition. This only runs for `sort=date` and only when the request carries no cursor — a cursor pins its own tier (the `_pfx`/`_sub` markers above) and never cascades, and any sort other than `date` would need a full unindexed match-set walk to prove a tier empty (measured 10-14s against the 5s timeout), so non-date sorts stay single-tier (`'word'` only, regardless of how many conditions would otherwise qualify for `'prefix'` or `'substring'`).

**Fallback-tier failure.** Only a tier reached BY CASCADING — a prior tier in the same request already settled with a result in hand — may degrade instead of failing the request, and only for a statement timeout (Postgres SQLSTATE `57014`): the expected case is the cold `add_time` walk WXYC/Backend-Service#2688 records. The SQLSTATE is read via `extractSqlState` (`@wxyc/database`), not a bare `error.code` — `db.execute` goes through drizzle-orm, which wraps every query rejection in `DrizzleQueryError` whose own `.code` is `undefined`; the SQLSTATE is on `.cause.code`. Confirmed empirically through a real `db.execute` call against a real Postgres (per-connection `statement_timeout: 50`, `select pg_sleep(1)`): the thrown `DrizzleQueryError` has `code: undefined` and `cause.code: '57014'`. That degrade ends the cascade, serves the prior tier's own result, and reports once via a fixed-fingerprint Sentry capture (`flowsheet-search-fallback-tier`) rather than once per query. Every other case is fatal: the `'word'` tier's own failure (as before this ticket), a `_pfx` cursor with no prior attempt to fall back to, and any non-timeout error at any point — a broken fallback-tier predicate must surface as a real error, not hide under one Sentry fingerprint.

**Two accepted limitations.** (a) A phrase-forming typing term makes the `'prefix'` tier re-run a predicate equivalent to the `'word'` tier's (one redundant statement pair on a query that will return zero rows) — accepted because which arm the CASE takes is decided by Postgres at plan time, and there is no way to know that in JS before asking. (b) Offset-mode paging under `sort=date` (`page=N` with no `cursor`) decides its tier fresh on every request rather than pinning one for a walk, so a client paging that way across a tier boundary can see rows from two structurally different predicates in the same walk; date-sort clients should page by `cursor`, which pins the tier, not by `page`.

**A `_pfx` cursor whose query no longer has a typing term** (e.g. the DJ deleted characters since the link was issued) has nothing left for the `'prefix'` tier to change, so `searchFlowsheet` treats the request as the `'word'` tier instead of rejecting it; the response's own `nextCursor`, if any, comes back unmarked, which self-corrects every later page of that walk. **A `_sub` cursor whose query no longer has any substring-eligible condition** is handled the same way, falling back to the `'word'` tier rather than rejecting the request.

**Why a phrase-forming typing term is never prefix-matched — a COST reason, not a recall one.** `buildPrefixTsquery`'s `P` suffixes `:*` onto the LAST TOKEN of its whitespace-split list — but when that one token re-lexes into a multi-lexeme phrase (an apostrophe inside a single typed word, e.g. `i'm`), Postgres's `to_tsquery` applies the prefix flag to EVERY lexeme the quoted text re-lexes into, not just the final one:

```sql
to_tsquery('simple', $$'i''m':*$$)::text -> 'i':* <-> 'm':*
```

(verified on PG 18.6, including on a 200k-row scratch Postgres built for this ticket). A capped-count query against that prefix-every-link phrase measured **15.6s** on production (2.65M rows), against the endpoint's 5s HTTP `statement_timeout` — not merely slower than the exact form, reliably over budget. Falling back to `E` (the safe exact phrase, with the gapped guard) for a phrase-forming typing term is therefore a cost decision, not a judgment that there is "no single last lexeme worth prefixing."

**EXPLAIN verification (this ticket, 200k generated rows, `flowsheet_search_doc_idx` present).** Both arms were confirmed to fold to exactly the chosen predicate at plan time, using the GIN index:

```sql
-- plain token 'autec': folds to the THEN arm, no CASE left in the plan
Bitmap Index Scan on flowsheet_search_doc_idx
  Index Cond: (search_doc @@ '''autec'':*'::tsquery)

-- phrase-forming token 'i''m': folds to the ELSE arm, no CASE left in the plan
Bitmap Index Scan on flowsheet_search_doc_idx
  Index Cond: (search_doc @@ '''i'' <-> ''m'''::tsquery)
```

No minimum prefix length beyond the existing `< 3` floor, and the floor counts INPUT characters, not the lexeme(s) they end up producing: `..a` is three input characters, clears the floor, and reaches the tsvector branch, but `to_tsquery` re-lexes the quoted `..a` under the `simple` parser into the single one-character lexeme `a` (the leading punctuation is discarded as a blank, the same mechanism that drops a leading `-`). So the floor is not "lexemes under 3 characters stay on trigram" — it decides how short a term the DJ has typed SO FAR must be before trigram's substring semantics (`tv` keeps matching `mtv`) give way to tsvector's word semantics (which stops matching `mtv` and only matches a word STARTING WITH `tv`). A single-lexeme prefix of any length is never meaningfully more expensive than its exact form once the capped count (`COUNT_CAP`) and the `add_time` walk bound the cost, so the floor is this semantics choice alone, not a cost guard. Moving 1-2 character inputs to word-prefix semantics is a separate recall change, out of scope here.

**Production measurements (2026-10-01 PDT, PG 14.22, db.t4g.small, 2.65M rows, read-only, warm second run, exact service SQL with the predicate swapped).** Data = first page `ORDER BY add_time DESC, id DESC LIMIT 50` with the two joins; count = capped `LIMIT 10001`.

| Predicate                                                                                              | Data     | Count    | Notes                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| exact `autechre`                                                                                       | 6.2 ms   | 1.1 ms   | 691 candidates                                                                                                                                    |
| prefix `'autec':*`                                                                                     | 6.2 ms   | 1.3 ms   | 694 candidates                                                                                                                                    |
| prefix `'aut':*`                                                                                       | 33.7 ms  | 17.1 ms  | 8,355 candidates                                                                                                                                  |
| prefix `'jane':*`                                                                                      | 10.7 ms  | 18.5 ms  | 15,906 candidates (exact `jane`: 43 / 15.5 ms)                                                                                                    |
| prefix `'lov':*`                                                                                       | 3.9 ms   | 84.9 ms  | 82,037 candidates                                                                                                                                 |
| prefix `'ste':*`                                                                                       | 4.4 ms   | 167.1 ms | 48,123 candidates                                                                                                                                 |
| prefix `'the':*`                                                                                       | 1.5 ms   | 100.2 ms | seq scan, stops at cap (exact `the`: 1.8 / 133 ms)                                                                                                |
| prefix `'a':*`                                                                                         | 1.3 ms   | 79.0 ms  | seq scan, stops at cap (exact `a`: 1.8 / 458 ms)                                                                                                  |
| prefix-tier CASE, `autec`                                                                              | 16.1 ms  | 2.5 ms   | plan shows `search_doc @@ '''autec'':*'::tsquery`, CASE folded to the THEN arm                                                                    |
| prefix-tier CASE, `i'm`                                                                                | 475 ms   | 187 ms   | folded to the ELSE arm: exact `'i' <-> 'm'` plus gapped guard, same as the `'word'` tier                                                          |
| prefix-tier CASE, `o'rou`                                                                              | 0.2 ms   | 0.1 ms   | folded to the ELSE arm, 0 rows (recovery is the `'substring'` tier — see its own measurement table below)                                         |
| `tv girl` (word tier; reference point, not a prefix-tier measurement)                                  | 73.2 ms  | 69.7 ms  | `tv` and `girl` both have whole-word hits in production, so this is what the query actually costs today and under the shipped cascade — see below |
| cost of the prefix tier's shape, `tv gir` (ILIKE `tv` AND `'gir':*`, IF the word tier found nothing)   | 121.1 ms | 132.0 ms | within the 43 ms to 513 ms range other shipped shapes occupy                                                                                      |
| cost of the prefix tier's shape, `tv girl` (ILIKE `tv` AND `'girl':*`, IF the word tier found nothing) | 128.6 ms | 128.8 ms | about 1.8x the word-tier reference row above; within the same range                                                                               |

**`jane` and `tv girl` never reach the prefix tier in production.** Both have whole-word hits (an artist/dj named `jane`, a track containing the words `tv` and `girl`), so the `'word'` tier already returns rows and the cascade stops there — the prefix-tier rows in the table above are cost data for the hypothetical "this query's word tier is empty" case, not a live measurement of what `jane` or `tv girl` actually do. That hypothetical was the point of measuring `jane`'s prefix cost at all (10.7 / 18.5 ms, cheaper than the exact form's 43 / 15.5 ms): if a _different_ query's word tier legitimately found nothing — a DJ genuinely typing a partial — the prefix tier that serves it is not expensive.

A `o'rourke`/`o'rou`-shaped partial typing term — phrase-forming, so the `'prefix'` tier's ELSE arm applies and it stays a whole-phrase match — returns zero rows through the `'word'` and `'prefix'` tiers; the ILIKE-contains `'substring'` tier recovers it (measured below), though cold its pg_trgm GIN indexes cost more than the warm figures in this section suggest — see the PR 2 measurement table.

**Production measurements, the common case: a zero-hit or few-hit typing term (2026-10-01 PDT, warm second run, same statement shapes as the table above).** A misspelled or not-yet-matching partial is the common keystroke the prefix tier exists to serve, not the worst case — the rows above already cover an expensive one (`'aut':*`).

| Prefix         | Data   | Count  | Candidates |
| -------------- | ------ | ------ | ---------- |
| `'autecher':*` | 6.7 ms | 0.1 ms | 0          |
| `'zzzq':*`     | 6.4 ms | 0.1 ms | 0          |
| `'qwertyui':*` | 6.2 ms | 0.1 ms | 1          |
| `'sterolab':*` | 6.7 ms | 0.2 ms | 28         |
| `'xq':*`       | 6.4 ms | 0.1 ms | 30         |
| `'zzz':*`      | 6.1 ms | 0.3 ms | 194        |
| `'chuq':*`     | 6.4 ms | 0.8 ms | 519        |
| `'autechr':*`  | 6.3 ms | 1.3 ms | 691        |
| `'stereol':*`  | 8.1 ms | 3.0 ms | 1,656      |

In every one of these production plans the planner estimated 1,535 rows for the prefix and chose a Bitmap Index Scan on `flowsheet_search_doc_idx`, not the `add_time` index walk; a 200k-row scratch table with synthetic vocabulary planned the zero-hit prefix as a full `add_time` walk instead, so scratch-database plans for this shape do not predict production's.

**The `'substring'` tier's fallback is substring matching, not fuzzy matching.** It recovers a mid-word fragment, a phrase-shaped partial, or a partial in an earlier (non-typing) term, by falling through to the same four-column ILIKE-contains predicate the trigram path has always used — not pg_trgm similarity. pg_trgm `%` similarity was measured on production at 2.2 to 2.9 s (see the `'word'`-tier measurement table above) and rejected for that cost. So a true misspelling (`sterolab` for `Stereolab`) only matches where that literal substring actually occurs somewhere in the row — the `'substring'` tier does not correct a transposed or dropped letter it cannot find as-typed.

**Production measurements, the `'substring'` tier (2026-10-01 PDT, warm second run, same statement shapes as the tables above).** Each positive bare term is `(<word-tier predicate> OR <four-column ILIKE-contains>)`.

| Query (substring tier) | Data     | Count  | Rows on page | Notes                                                                                                             |
| ---------------------- | -------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `utechre`              | 9.0 ms   | 5.0 ms | 50           | BitmapOr over `flowsheet_search_doc_idx` and the four trigram indexes                                             |
| `autecher`             | 8.1 ms   | 5.3 ms | 0            | same plan, no match                                                                                               |
| `sterolab`             | 10.8 ms  | 8.2 ms | 27           |                                                                                                                   |
| `o'rou`                | 1,400 ms | 162 ms | 50           | cold first run exceeded an 8 s timeout; pg_trgm ignores the apostrophe, so the pattern's trigrams are unselective |
| `autec power`          | 6.7 ms   | 8.5 ms | 1            |                                                                                                                   |
| `utechre the`          | 21.5 ms  | 6.2 ms | 32           |                                                                                                                   |
| `zzzq love`            | 0.4 ms   | 0.5 ms | 0            |                                                                                                                   |
| `ove`                  | 5.4 ms   | 879 ms | 50           | data walks `flowsheet_track_add_time_idx`; count is a capped seq scan                                             |

**The actual user-visible change on the flowsheet surface, from switching off `websearch_to_tsquery`.** It is narrower than the catalog's own operator retirement (docs/adr/0015-catalog-search-query-operators.md), because the flowsheet parser (`search-parser.service.ts`) already routes a `"…"` value to exact ILIKE and sends a bare `or` (under 3 characters) to the trigram fallback via `shouldUseTsvector`'s length floor. It is **not** true that quoting and `OR` were never live tsquery operators on this surface at all, though — the parser's own tokenizer splits `q` only on the literal space character (`' '`, U+0020), not on whitespace generally, so a query joined by a different whitespace byte (a tab) reached `websearch_to_tsquery` as one whole, unsplit value, and websearch's own tokenizer DOES read generic whitespace and DOES treat a tab-separated `or` as disjunction. Checked on PG 18.6: `websearch_to_tsquery('simple', E'cat\tor\tpower')` → `'cat' | 'power'` (`or` consumed as the operator, not a token). `buildPrefixTsquery` splits on `/\s+/` — any whitespace, tabs included — so the same tab-joined query is now three AND'd tokens: `'cat' & 'or' & 'power'`. Checked on PG 18.6, `a(b`, `a|b`, `a:b`, `cat"power` and `a<b` already built an AND under `websearch_to_tsquery` and still do under the builder. What actually changes:

- a leading `-` stops excluding (`-jane`: `!'jane'` → `'jane'` — quoting retires the operator, and `to_tsquery` discards a leading `-` as a blank when it re-lexes the quoted token, same mechanism as ADR 0015). This is not only the bare leading-hyphen case: `(-foo)`, `!-foo` and `|-foo` all build the identical exclusion `!'foo'` under `websearch_to_tsquery` (checked on PG 18.6 — the character immediately before the `-` does not change websearch's reading of it), and the builder's own metacharacter class already strips `(`, `!` and `|` to whitespace before the hyphen is ever seen, so all three now build the same non-excluding `'-foo'` the bare case does;
- `x*y`, `a\b` and `a>b` loosen from `<->` (an adjacency phrase) to `&` (an AND) — the builder's metacharacter class neutralizes `*`, `\` and `>` into token separators rather than preserving them inside a lexeme (checked on PG 18.6: `websearch_to_tsquery('simple', 'a>b')` → `'a' <-> 'b'`, distinct from `a<b`'s `&`, which the builder does not distinguish either way since both characters are in its metacharacter class);
- the flowsheet parser's own `AND` / `OR` / `NOT` operators and field prefixes (`artist:`, `song:`, `album:`, `label:`, `dj:`, `date:`, `dateRange:`) are untouched and remain the supported way to combine and exclude terms — `NOT` wraps the whole condition fragment, guard included (`search.service.ts`'s `buildConditionFragment`);
- a query with more than 16 whitespace-separated tokens now silently drops the EARLIEST ones past that cap (`apps/backend/utils/tsquery.ts`'s `MAX_OPERANDS`) rather than AND'ing all of them — `websearch_to_tsquery` has no such ceiling. This was already true of the catalog's own BS#670 builder; moving flowsheet onto the same builder applies it here for the first time. The flowsheet parser's own tokenizer only splits `q` on the literal space character, so this is reachable from a query the parser treats as a single `all`-field value joined by some OTHER whitespace byte (a tab-separated paste, say) that still reaches this branch unsplit — a bare-space query of 17+ words is unusual DJ input but not impossible either. Checked against the real builder: a 20-token input keeps tokens 5–20 and drops 1–4, and the last-typed token (20) is still the one eligible for `:*` on the catalog's prefix form (the flowsheet reader never uses that form, but the token list the cap operates on is shared).

For plain words this is a no-op: `to_tsquery('simple', '''jane''')` and `websearch_to_tsquery('simple', 'jane')` build the same tsquery (`'jane'`).

When this lands, the test suite should cover music titles with stylized punctuation that exercises tokenizer edge cases: `M.A.N.D.Y.`, `!!!`, `Godspeed You! Black Emperor`, dotted initialisms, ampersands (`Belle & Sebastian`), and non-ASCII titles (`Sigur Rós`, Japanese / Cyrillic artist names). The hybrid router must keep these reachable when `tsvector` tokenization drops them.

### Done: DJ name path (steps 5a + 5b)

Both DJ-name evolution steps shipped. Migration history below has the full chain; the short version: `dj_name` is now a column on `flowsheet`, populated on every insert, indexed for trigram, and folded into the `search_doc` tsvector. The `shows -> auth_user` join is gone from the search hot path, and the auth_user/shows trigram indexes from 5a were dropped.

## Alternatives Considered

| Option                                                              | When it fits                                                             | Why we are not taking it                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status quo: trigram only**                                        | Substring matching matters more than word-level; small data              | Slow for common terms; no relevance; counts always expensive                                                                                                                                         |
| **`tsvector` only**                                                 | Users always search whole words                                          | Loses the substring intent (`tron` does not match `Autechre`); music titles tokenize unpredictably under any stemmer                                                                                 |
| **Denormalized search table / materialized view**                   | Joins to `shows`/`user` dominate query cost                              | Refresh management; the join can be eliminated more cheaply by denormalizing `dj_name` onto `flowsheet`                                                                                              |
| **SQLite FTS5 ETL** (matches the `library-metadata-lookup` pattern) | Already in the stack; BM25 ranking is desired                            | Sync lag would block DJs from finding tracks they played within the last few minutes; doubles storage; loses transactional consistency with writes that the legacy flowsheet ETL already complicates |
| **Meilisearch / Typesense**                                         | Need typo tolerance, faceting, sub-100ms typeahead, public-facing search | Operational burden, RAM-hungry; overkill for an internal DJ tool at our scale                                                                                                                        |
| **Elasticsearch / OpenSearch**                                      | Multi-tenant, large-scale, complex relevance tuning                      | Ops cost dominates value; nothing in the use case justifies it                                                                                                                                       |

## Why Postgres

The flowsheet is bounded by station history (decades of operation × on the order of a hundred plays per day) and append-mostly. The audience is a small DJ population, not millions of public users. Postgres `tsvector` was designed for exactly this regime and it composes naturally with the existing schema, joins, and CDC infrastructure introduced in `0046`. The pragmatic ceiling for this approach is well above the data we will ever hold; outgrowing it is not the bottleneck this team is realistically going to hit.

The library service (`apps/backend/services/library.service.ts`) already uses `pg_trgm` similarity scoring as a precedent for in-Postgres search, so the operational and review knowledge is in the team.

## Migration History

| Migration                                    | Purpose                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0024_flowsheet_entry_type.sql`              | Added `entry_type` column and its btree index                                                                                                                                                                                                                      |
| `0042_flowsheet-suggest-indexes.sql`         | Added GIN trigram indexes on `artist_name` and `track_title` for ghost-text autocomplete                                                                                                                                                                           |
| `0049_flowsheet-search-indexes.sql`          | Added GIN trigram indexes on `album_title` and `record_label`; combined the data and count queries into a single window-function query (which subsequently regressed performance — see "Current Performance Behavior")                                             |
| `0050_flowsheet-track-add-time-idx.sql`      | Partial b-tree index on `(add_time DESC) WHERE entry_type = 'track'` so date-sort and cursor pagination short-circuit through the index instead of sequential scanning                                                                                             |
| `0051_dj-name-search-indexes.sql`            | Step 5a: GIN trigram indexes on `auth_user.dj_name`, `auth_user.name`, `shows.legacy_dj_name` paired with an OR-decomposition of the dj-name WHERE filter. Indexes dropped by `0054`; the OR-decomposition was replaced when 5b shipped.                           |
| `0052_flowsheet-tsvector-search.sql`         | Generated `search_doc` tsvector covering artist/track/album/label with weight bands `A/B/C/D`; routed bare-term `all` queries to the GIN index via `websearch_to_tsquery`.                                                                                         |
| `0053_flowsheet-dj-name-column.sql`          | Step 5b.1: added nullable `flowsheet.dj_name` column and backfilled from `shows`/`auth_user` using the same COALESCE the search service used as a display expression.                                                                                              |
| `0054_flowsheet-search-doc-with-dj-name.sql` | Step 5b.3: rewrote `search_doc` to include `dj_name` (weight `B`), added a trigram index on `flowsheet.dj_name`, and dropped the now-unused per-column trigram indexes on `auth_user`/`shows`. The search service stopped joining through `shows` and `auth_user`. |

## Related

- `apps/backend/services/library.service.ts` — card catalog search with `pg_trgm` similarity ranking
- `apps/backend/services/labels.service.ts` — label autocomplete with prefix ILIKE
- `docs/metadata-service/README.md` — sibling document describing flowsheet metadata enrichment
