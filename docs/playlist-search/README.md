# Playlist Search

This document describes the architecture and evolution plan for `GET /flowsheet/search`, the historical playlist search powering the dj-site Previous Sets page.

## Overview

DJs and music directors search the flowsheet to find when a song was last played, who played a particular artist, what label put out an album, and similar lookups against the entire history of WXYC playlists. The flowsheet is append-mostly, bounded to a few million rows over the lifetime of the digital flowsheet, and is served to a small internal audience rather than a public-facing population.

The search is implemented in `apps/backend/services/search.service.ts`, parsed by `apps/backend/services/search-parser.service.ts`, and exposed by `apps/backend/controllers/search.controller.ts` at `GET /flowsheet/search`.

## Query Surface

The parser supports a small DSL on top of a single `q` string parameter:

| Form              | Example                                                                    | Behavior                                                                           |
| ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bare term         | `autechre`                                                                 | ILIKE-substring across `artist_name`, `track_title`, `album_title`, `record_label` |
| Field prefix      | `artist:autechre`, `song:poise`, `album:confield`, `label:warp`, `dj:jake` | Restricts to a single column (or DJ name expression)                               |
| Date              | `date:2024-06-15`                                                          | Equality on the calendar day                                                       |
| Date range        | `dateRange:2024-01-01..2024-12-31`                                         | Inclusive range on `add_time`                                                      |
| Boolean operators | `artist:juana AND label:sonamos`, `dj:jake OR dj:nora`, `NOT label:warp`   | Composes conditions with `AND`, `OR`, `NOT`                                        |
| Exact match       | `artist:"Cat Power"`                                                       | Equality instead of substring                                                      |

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

A malformed cursor returns `400`. Encoding format is `${ISO_timestamp}_${id}` — opaque to clients in spirit, debuggable in practice.

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

**The shipped router does not actually make that distinction.** `shouldUseTsvector` tests only `value.length >= 3` plus "contains an alphanumeric" — it cannot tell a complete word from a partially-typed one, so a 3+ character _prefix_ is routed to the tsvector branch the first bullet reserves for whole words. `buildPrefixTsquery(value).exactTsquery` matches whole lexemes only (`'autec'` does not match `autechre`), and `buildAllFieldMatch` returns that single predicate with no zero-row fallback, so such a query returns a hard zero instead of falling through to the trigram branch the second bullet describes. The routing above is the correct design; the gap is in the implementation, and it is tracked in [WXYC/Backend-Service#2712](https://github.com/WXYC/Backend-Service/issues/2712), which is unblocked by BS#2726 closing the four seams — #2712 will reuse the `strpos`-gated guard and `gappedSearchDocSql` verbatim once it ports `:*` prefixing here.

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
