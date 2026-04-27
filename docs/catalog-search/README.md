# Catalog Search

Architecture and ranking notes for `GET /library`, the WXYC card-catalog search powering the dj-site library lookup.

## Overview

DJs and music directors search the WXYC catalog (~64K library rows × ~24K artists) to find an album by artist, title, or both. The search has to feel instantaneous: the dj-site issues a query on every keystroke and routes the same string into both the `artist_name` and `album_title` fields ("Both mode"), which is the single most common shape and the one this design optimizes for.

Implementation lives in `apps/backend/services/library.service.ts`. The HTTP entry point is `apps/backend/controllers/library.controller.ts` at `GET /library`.

## Why this changed

The previous implementation read from `library_artist_view` (a 5-way join) and ran an `OR` predicate that spanned `artists.artist_name` and `library.album_title`. Measured on staging (production clone), n=15 iterations, warm cache:

| Query shape                                      | Median          |
| ------------------------------------------------ | --------------- |
| `library_artist_view` + `OR` across tables (old) | 117–140 ms      |
| Bypass view (explicit JOIN, same `OR`)           | 153 ms          |
| `UNION` of two single-table predicates           | 3–33 ms         |
| Denormalized flat + trigram `BitmapOr`           | 6–41 ms         |
| **Denormalized flat + tsvector `ts_rank`**       | **0.07–3.6 ms** |

`EXPLAIN ANALYZE` showed the trigram GIN indexes were never touched: the `OR` predicate spanned two tables and was evaluated as a join filter after a merge join, so neither index was reachable. Putting both columns on one table makes the predicate single-table, lets the planner pick the right index, and unlocks the tsvector path.

Quality also improves on the regression set:

| Query                 | Old top-1                                           | New top-1                          |
| --------------------- | --------------------------------------------------- | ---------------------------------- |
| `stereolab transient` | 5 random Stereolab albums (right one at #1 by luck) | the matching album only            |
| `the velvet`          | The Velvet Teen                                     | The Velvet Underground / Loaded    |
| `love`                | Love-Spit-Love-style noise                          | Love / Forever Changes (canonical) |
| `pikn floyd` (typo)   | Pink Floyd via trigram                              | Pink Floyd via trigram fallback    |

## Schema

| Column / object                       | Type                                | Migration      | Purpose                                                                                                                                                                                               |
| ------------------------------------- | ----------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library.artist_name`                 | `varchar(128)`                      | `0058`         | Denormalized from `artists.artist_name`. Populated by the A.2 backfill job, kept in sync by `addAlbum` (live writes) and the cascade trigger from `0060`.                                             |
| `library.search_doc`                  | `tsvector` STORED generated         | `0058`         | `setweight(to_tsvector('simple', artist_name), 'A') \|\| setweight(to_tsvector('simple', album_title), 'B')`. The weight bands let `ts_rank` favor artist hits over title hits within the same query. |
| `library_search_doc_idx`              | GIN on `search_doc`                 | `0058`         | Powers the `@@ websearch_to_tsquery(...)` predicate in the Both-mode tsvector path.                                                                                                                   |
| `library_artist_name_trgm_idx`        | GIN `gin_trgm_ops` on `artist_name` | `0058`         | Powers `library.artist_name % $q` in the trigram fallback and the Artists-only path.                                                                                                                  |
| `library_album_title_trgm_idx`        | GIN `gin_trgm_ops` on `album_title` | (pre-existing) | Powers the Albums-only path and the title side of the trigram fallback.                                                                                                                               |
| `cascade_library_artist_name` trigger | AFTER UPDATE on `artists`           | `0060`         | Propagates artist renames into `library.artist_name` so `search_doc` (a STORED generated column) stays correct without an application-side rename path.                                               |
| `album_plays`                         | materialized view                   | `0059`         | `SELECT album_id, count(*) AS plays FROM flowsheet WHERE entry_type = 'track' GROUP BY album_id`. Unique index on `album_id` so `REFRESH MATERIALIZED VIEW CONCURRENTLY` is allowed.                  |
| `album_plays_album_id_idx`            | unique btree on `album_id`          | `0059`         | Required by `REFRESH ... CONCURRENTLY` and used as the LEFT JOIN key from `library` in the ranker.                                                                                                    |

`'simple'` (no stemming) is deliberate — music titles are full of proper nouns, foreign words, and stylized spellings that English stemming distorts ("Wilco" stems to "wilc"; "the" gets stripped; etc.). Stemming saves index space the catalog does not need at this size.

## Routing

```
fuzzySearchLibrary(artist_name, album_title, n, on_streaming)
  │
  ├── if `artist_name` and `album_title` are set AND identical:
  │     → BOTH MODE (tsvector + plays, with trigram fallback)
  │
  ├── if both are set but different:
  │     → trigram OR on `library.artist_name` and `library.album_title`,
  │       reading the table directly (BitmapOr across the two GIN indexes)
  │
  └── if only one is set:
        → trigram on the matching column (Artists-only or Albums-only)
```

Single-column modes intentionally keep the trigram path: they already use the right index, run sub-100ms, and have ranking semantics users understand. A tsvector predicate on a single column adds nothing over trigram similarity.

## Both-mode ranker

```sql
SELECT l.*, a.artist_name AS artist
FROM   wxyc_schema.library      l
LEFT   JOIN wxyc_schema.album_plays p ON p.album_id = l.id
INNER  JOIN wxyc_schema.artists     a ON a.id      = l.artist_id
WHERE  l.search_doc @@ websearch_to_tsquery('simple', $q)
   AND ($on_streaming IS NULL OR l.on_streaming = $on_streaming)
ORDER BY ts_rank(l.search_doc, websearch_to_tsquery('simple', $q))
       * (1 + ln(coalesce(p.plays, 0) + 1)) DESC
LIMIT  $n;
```

The ranking expression is `ts_rank * (1 + ln(plays + 1))`. The `1 +` matters: `ln(plays + 1)` is zero when `plays = 0` (most of the catalog), which would erase the text-rank signal entirely for unpopular-but-relevant matches. Adding the constant 1 keeps text rank as the dominant signal while letting play counts break ties on the popular long tail.

`websearch_to_tsquery('simple', ...)` is used for parsing because it is forgiving — it understands quoted phrases, `OR`, leading/trailing junk — and never raises on user input. Multi-token queries get AND-semantics by default, which is exactly the disambiguation `stereolab transient` needs.

### Trigram fallback decision boundary

When the tsvector path returns 0 rows, the service runs a second query against the same table using the trigram indexes:

```sql
WHERE library.artist_name % $q OR library.album_title % $q
ORDER BY GREATEST(similarity(library.artist_name, $q),
                  similarity(library.album_title, $q)) DESC
LIMIT $n;
```

The fallback fires only when:

1. Tsvector returned 0 rows (so we don't double-query the common case).
2. The trimmed query has at least one alphanumeric character — pure punctuation skips both paths and returns empty without a roundtrip.
3. The trimmed query is at least 2 characters long — single-character queries fall through to no-results because trigram on 1-char input is meaningless.

The fallback is single-table and uses `BitmapOr` across the two GIN trigram indexes on `library` — much faster than the cross-table OR the old path forced through the view.

### Pure punctuation and short queries

| Query                           | Path                       | Result                        |
| ------------------------------- | -------------------------- | ----------------------------- |
| `""` (empty) or whitespace-only | (skipped)                  | empty                         |
| `!!!` (no alphanumerics)        | (skipped)                  | empty                         |
| `a` (1 char)                    | tsvector only; no fallback | empty unless tsvector matches |
| `ab` (2+ chars, alphanumeric)   | tsvector → trigram on miss | full pipeline                 |

## `album_plays` refresh cadence

The MV is rebuilt by `apps/backend/services/album-plays-refresh.service.ts`, which runs at backend startup and self-reschedules with `setTimeout` (not `setInterval`, so a slow refresh cannot stack overlapping runs).

- Default cadence: **1 hour** (`ALBUM_PLAYS_REFRESH_INTERVAL_MS = 3600000`).
- Measured refresh on the staging clone (2.6M flowsheet rows): ~98 ms.
- Last-run timestamp is stored in `cronjob_runs` under `job_name = 'album-plays-refresh'`.

`REFRESH MATERIALIZED VIEW CONCURRENTLY` is used so reads keep hitting the previous snapshot while the new one builds. Search ranking is robust to a slightly stale signal: a 1-hour cadence means a freshly-played album is at most one hour late showing up as a tiebreaker, which never feels wrong in practice.

The cadence assumes the MV is cheap and the play signal evolves slowly. If the linkage gap from Epic B closes (more flowsheet rows resolve to library albums), refresh time scales linearly with row count but stays well under interactive thresholds at the catalog's bounded size.

## Code locations

- `apps/backend/services/library.service.ts`
  - `searchLibraryBothMode` — orchestrates tsvector → trigram fallback, gates short / punctuation-only inputs.
  - `searchLibraryByTsvector` — the ranker query above.
  - `searchLibraryByTrigramBoth` — the fallback query above.
  - `fuzzySearchLibrary` — entry point that picks per the routing table.
  - `searchAlbumsByTitle`, `searchByArtist` — single-column trigram paths (untouched by Epic A apart from reading `library` directly instead of the view).
- `apps/backend/services/album-plays-refresh.service.ts` — refresh scheduler.
- `apps/backend/controllers/library.controller.ts` — HTTP layer, response shape preserved.

`library_artist_view` is no longer read on the search hot path. It is kept around for non-search callers and flagged for cleanup once they migrate.

## Tests

| Layer       | Path                                                      | Covers                                                                                                                                                                         |
| ----------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `tests/unit/services/library.service.test.ts`             | Routing decisions: Both-mode picks the tsvector path, single-column modes stay on trigram, fallback fires only when tsvector returns 0 rows, single-char queries do not retry. |
| Unit        | `tests/unit/services/album-plays-refresh.service.test.ts` | Scheduler behavior, last-run recording, error recovery.                                                                                                                        |
| Integration | `tests/integration/library.search-ranking.spec.js`        | The `/library` HTTP boundary against seeded Stereolab fixtures: AND-semantics for multi-word queries, trigram fallback on typos, pure-punctuation returns empty.               |
| Integration | `tests/integration/library.spec.js`                       | Existing endpoint contract: response shape, error cases, single-column searches.                                                                                               |

Tests rely on the seed setting `library.artist_name` for fixture rows (mirroring the production A.2 backfill outcome). Without it, Both-mode and the trigram fallback both miss because the predicate column is NULL.

## Migration history

| Migration                                      | Purpose                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0058_library-artist-name-and-search-doc.sql`  | Added `library.artist_name` (nullable) + `library.search_doc` (STORED tsvector) + GIN indexes on both. DDL-only; the backfill is a separate job.                  |
| `0059_album-plays-materialized-view.sql`       | `album_plays` MV with unique index on `album_id`.                                                                                                                 |
| `0060_library-artist-name-cascade-trigger.sql` | Trigger on `artists` UPDATE that propagates artist_name into `library.artist_name`, so renames keep `search_doc` correct without an application-side rename path. |

Backfill / live-write deliveries (no migrations of their own):

- `jobs/library-artist-name-backfill/` — one-shot job that populates `library.artist_name` for legacy rows. Runs once per deploy environment. See the job's README for invocation.
- `apps/backend/controllers/library.controller.ts#addAlbum` — live writes set `artist_name` inline on every new INSERT, so the column is never NULL after this is deployed.

## Out of scope

- Switching to Elasticsearch (#229).
- `GET /library` `album_name` parameter bug (#233 — sibling work in this project).
- Closing the flowsheet ↔ library linkage gap that constrains the play-count signal — that is Epic B (independent epic; quality of the play-weight signal scales with B's coverage, but Epic A does not block on it).

## Related

- `docs/playlist-search/README.md` — sibling document on `GET /flowsheet/search`.
- `docs/metadata-service/README.md` — flowsheet metadata enrichment via LML.
- Epic A on GitHub: [WXYC/Backend-Service#483](https://github.com/WXYC/Backend-Service/issues/483).
