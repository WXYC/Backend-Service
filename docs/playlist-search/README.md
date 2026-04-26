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

### 3. Cursor-based pagination

The frontend already uses infinite scroll, so `OFFSET` is doing extra work for no benefit — its cost grows linearly with page depth because Postgres still has to scan and discard the skipped rows. Replacing it with a cursor (`WHERE (add_time, id) < (cursor_time, cursor_id)`) makes every page O(limit) regardless of depth and pairs cleanly with the new `add_time` index.

The cursor is **compound** `(add_time, id)` rather than `add_time` alone because the legacy ETL backfilled many rows with batch-import timestamps that share the same `add_time` value to the microsecond — a single-column cursor would silently drop those rows on page boundaries. The compound form orders by `(add_time, id)` and uses row-value comparison `(add_time, id) < (cursor_time, cursor_id)` to break ties on `id`.

**Sort coverage.** Cursor pagination only applies to `sort=date`. Other sorts (`artist`, `song`, `dj`) keep using offset because their sort columns are not unique and there is no compound index supporting a `(sort_col, id)` cursor. This matches usage: the default Previous Sets view and the empty-`q` recent-tracks path both use date sort.

**Compatibility plan.** The dj-site `useLazySearchPlaylistsQuery` is the only known consumer and currently reads `totalPages`. The response returns both `nextCursor` (when cursor mode is active) and `totalPages` (always) so dj-site can migrate when convenient. Once dj-site is migrated, `totalPages` and the `page` query parameter can be removed in a follow-up. New consumers should be guided to the cursor form from the start.

A malformed cursor returns `400`. Encoding format is `${ISO_timestamp}_${id}` — opaque to clients in spirit, debuggable in practice.

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

Use `'simple'` (no stemming) — music titles are full of proper nouns, foreign words, and stylized spellings that English stemming distorts. Use `websearch_to_tsquery('simple', $1)` to parse user input naturally; it understands quoted phrases and `OR` already.

Keep the trigram indexes. The router logic at the service layer chooses:

- Multi-character word with letters → `tsvector @@ websearch_to_tsquery(...)` (fast, supports relevance ranking via `ts_rank`)
- Short fragment, internal substring (e.g., `tron` matching `Strontium`), or explicit wildcard → ILIKE on the trigram-indexed columns

This hybrid covers both user intents that show up in music search: "I remember a word from the title" and "I remember a fragment of an unusual name."

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
