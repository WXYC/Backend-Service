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

| Query                 | Old top-1 (pre-Epic-A)                              | Current top-1 (re-measured 2026-09-28, see note)                                        |
| --------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `stereolab transient` | 5 random Stereolab albums (right one at #1 by luck) | the matching album only (Transient Random-Noise Bursts With Announcements)              |
| `the velvet`          | The Velvet Teen                                     | The Velvet Underground & Nico / The Velvet Underground (tied top `ts_rank`; Loaded 6th) |
| `love`                | Love-Spit-Love-style noise                          | Love Spit Love / Love Spit Love (Love / Forever Changes 88th — see note)                |
| `pikn floyd` (typo)   | Pink Floyd via trigram                              | Pink Floyd via trigram fallback (unaffected by this issue)                              |

**Re-measured note.** The "Current top-1" column was re-run 2026-09-28 against a production-shaped clone (`dev_env/seed_db.sql` + `dev_env/seed-clone.sql` in a standalone PostgreSQL 18.6, 64,193 `library` rows), comparing `main`'s `websearch_to_tsquery` ranker with this document's two-tsquery ranker. The top six for `the velvet` and `love` are identical, row for row, under both. What the table used to show (`Loaded`, `Forever Changes` on top) did not come back under either:

1. **This clone has no play data.** It is catalog-only, with 0 `flowsheet` rows, so `album_plays` is empty and the `plays` key never breaks a tie. Every ordering above is `match_tier`, then `ts_rank`, then `id`.
2. **The table's previous top-1s were not measured against the current ranker.** WXYC/Backend-Service#2725 replaced the `ts_rank * (1 + ln(plays + 1))` product with `match_tier` plus a plain `plays` tie-break, without a clone measurement. On this clone, `Love / Forever Changes` ranks 88th for `love`: it matches in the artist field only, and rows matching `love` in both fields (`Love Spit Love / Love Spit Love`) score higher. The two tied `the velvet` leaders match in both fields as well; `Loaded` matches only as artist and is 6th. Whether production play counts would lift either album is not something this clone can show.

A prefix-only scoring of the same rows is what this document's `exact_score` key exists to prevent: ranking on the prefixed `tsquery` alone put Gene Loves Jezebel, Loved Ones and Lyle Lovett at #1-3 for `love`, via `'love':*` matching `loves`, `loved` and `lovett`.

## Schema

| Column / object                       | Type                                | Migration      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library.artist_name`                 | `varchar(128)`                      | `0058`         | Denormalized from `artists.artist_name`. Populated by the A.2 backfill job, kept in sync by `addAlbum` (live writes) and the cascade trigger from `0060`.                                                                                                                                                                                                                                                                               |
| `library.search_doc`                  | `tsvector` STORED generated         | `0058`, `0178` | `ts_delete(setweight(to_tsvector('simple', artist_name), 'A') \|\| to_tsvector('simple', '<sentinel> <sentinel> <sentinel>') \|\| setweight(to_tsvector('simple', album_title), 'B'), '<sentinel>')`. The weight bands let `ts_rank` favor artist hits over title hits within the same query; the sentinel buys a position gap so a phrase cannot match across the artist/album boundary (see **Why the segments do not touch** below). |
| `library_search_doc_idx`              | GIN on `search_doc`                 | `0058`         | Serves the Both-mode tsvector path's WHERE predicate, `search_doc @@` the last-token-prefix `tsquery` (`buildPrefixTsquery`, WXYC/Backend-Service#670). The `match_tier` CASE and both `ts_rank` scores are evaluated per candidate row, not through the index.                                                                                                                                                                         |
| `library_artist_name_trgm_idx`        | GIN `gin_trgm_ops` on `artist_name` | `0058`         | Powers `library.artist_name % $q` in the trigram fallback and the Artists-only path.                                                                                                                                                                                                                                                                                                                                                    |
| `library_album_title_trgm_idx`        | GIN `gin_trgm_ops` on `album_title` | (pre-existing) | Powers the Albums-only path and the title side of the trigram fallback.                                                                                                                                                                                                                                                                                                                                                                 |
| `cascade_library_artist_name` trigger | AFTER UPDATE on `artists`           | `0060`, `0172` | Propagates artist renames into `library.artist_name` so `search_doc` (a STORED generated column) stays correct without an application-side rename path. Since `0172` (BS#2563) the same `UPDATE` also clears `library.artwork_lookup_attempted_at` on the cascaded rows, so a rename doesn't leave the artist's shelf suppressed for the rest of the 7-day artwork-lookup negative window.                                              |
| `album_plays`                         | materialized view                   | `0059`         | `SELECT album_id, count(*) AS plays FROM flowsheet WHERE entry_type = 'track' GROUP BY album_id`. Unique index on `album_id` so `REFRESH MATERIALIZED VIEW CONCURRENTLY` is allowed.                                                                                                                                                                                                                                                    |
| `album_plays_album_id_idx`            | unique btree on `album_id`          | `0059`         | Required by `REFRESH ... CONCURRENTLY` and used as the LEFT JOIN key from `library` in the ranker.                                                                                                                                                                                                                                                                                                                                      |

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
SELECT l.*, a.artist_name AS artist,
       CASE WHEN l.search_doc @@ to_tsquery('simple', $exact_tsq) THEN 2 ELSE 1 END AS match_tier
FROM   wxyc_schema.library      l
LEFT   JOIN wxyc_schema.album_plays p ON p.album_id = l.id
INNER  JOIN wxyc_schema.artists     a ON a.id      = l.artist_id
WHERE  l.search_doc @@ to_tsquery('simple', $tsq)
   AND ($on_streaming IS NULL OR l.on_streaming = $on_streaming)
ORDER BY match_tier DESC,
         ts_rank(l.search_doc, to_tsquery('simple', $exact_tsq)) DESC,  -- exact_score
         ts_rank(l.search_doc, to_tsquery('simple', $tsq)) DESC,        -- album_score
         coalesce(p.plays, 0) DESC
LIMIT  $n;
```

<!-- @rule id=catalog-match-tier-two-tsquery-wiring enforced-by=tests/unit/services/library.service.test.ts added=2026-09-28 incidents=#2736 -->

Ranking is an explicit `match_tier` (2 for an exact whole-lexeme hit, 1 for a prefix-only hit), not a `ts_rank * plays` product (BS#2725). Plays span roughly 10x on the real catalog — wider than the typical `ts_rank` gap between a good and a mediocre match — so multiplying let a popular near-miss outrank an exact hit, and `ts_rank` goes nearly constant under a prefix (`:*`) match, which collapses a product-based score to a pure popularity sort. `match_tier` guarantees the exact-over-prefix ordering structurally. Within a tier, `exact_score` (`ts_rank` on `$exact_tsq`) sorts first, then `album_score` (`ts_rank` on `$tsq`), then `plays`.

`$tsq` and `$exact_tsq` are the two halves `buildPrefixTsquery` (`apps/backend/utils/tsquery.ts`, WXYC/Backend-Service#670) derives from one tokenization of the raw query: every token except the last becomes an exact quoted lexeme, and the last token — the one the DJ is still typing — is suffixed `:*`. `stereolab transient` becomes `$tsq = 'stereolab' & 'transient':*` and `$exact_tsq = 'stereolab' & 'transient'`. `$tsq` drives WHERE and `album_score`; `$exact_tsq` drives `match_tier` and `exact_score`, so a row matching every token as a complete word outranks one that only matched the last token as a prefix, and within a tier a whole-word hit outranks prefix credit collected from another field. Before BS#670, `$exact_tsq` did not exist and the WHERE predicate doubled as the `match_tier` predicate, so every match was tier 2 — deliberately dormant scaffolding (BS#2725) until this builder activated the tier.

Only the LAST token is prefixed, not every token. An earlier attempt (WXYC/Backend-Service#2709, superseded) suffixed `:*` on every token. A prefix operand credits every word it prefixes, so `ts_rank` over-rewarded rows full of longer words starting with the query: `cat` scored `Catherine Catapult / Cats` 1.459 against `Cat Power`'s 0.608. Prefixing only the token still being typed keeps every earlier, already-completed token an exact match, so `ts_rank` stays meaningful within a tier.

**This replaced `websearch_to_tsquery` in BS#670.** `websearch_to_tsquery` was chosen originally because it is forgiving and never raises on user input, and it is still the right call for a query the user has finished typing. But dj-site issues a query on every keystroke, and `websearch_to_tsquery('simple','autec')` lexes to `autec`, which does not match Autechre's `autechre` — so every prefix of a name returned zero rows and fell through to the trigram path. Measured on production: 11-232 ms on the fallback (the spread tracks how common the letter combination is, so the typing path paid the worst case) against 3-5 ms for the prefix form through this same GIN index.

```sql-claim
websearch_to_tsquery('simple', 'autec')                                       ->  'autec'
to_tsvector('simple', 'Autechre') @@ websearch_to_tsquery('simple', 'autec')  ->  false
to_tsvector('simple', 'Autechre') @@ to_tsquery('simple', $$'autec':*$$)      ->  true
```

`to_tsquery` takes a tsquery expression rather than user text, so it is the one variant with no input forgiveness — `&`, `|`, `!`, `(`, `)`, `<`, `>`, `:`, `*`, `\` and `"` reach it as operators and an unbalanced one raises. `buildPrefixTsquery` is the sanitizing layer: metacharacters become token separators, each token is quoted so what survives is read as a literal lexeme, and a token with no letter or digit is dropped. Input that yields no token at all (`!!!`, `$$$`) returns `null` and the tsvector path is skipped entirely rather than spending a query on an empty tsquery. A leading `-` is deliberately left alone rather than stripped or treated as exclusion, and a bare `or` and a `"quoted"` term carry no special meaning either — see [ADR 0015](../adr/0015-catalog-search-query-operators.md) for why each of those three would-be operators is retired rather than reimplemented.

[ADR 0015](../adr/0015-catalog-search-query-operators.md)'s operator contract governs **this tsvector tier's `to_tsquery` construction only.** It says nothing about the trigram fallback below, which never sees a tsquery at all — it runs `%` similarity against the raw query string and interprets no operators, retired or otherwise. So a query that reads like it invokes one of the three retired operators can still surface fuzzy matches once the tsvector tier misses: `cat or power` is three required AND'd tokens under ADR 0015 (`or` narrows, it does not disjoin), and the tsvector tier correctly returns 0 rows for it on the real catalog — no artist or album contains the literal word "or" next to "cat" and "power" — but the Both-mode trigram fallback then runs on the same raw string and, measured on the production-shaped clone, returns `Cat Power` rows at similarity 0.77 (`GET /library?artist_name=cat+or+power&album_title=cat+or+power` does return Cat Power, through the fallback, not the tsvector tier). The endpoint-level behavior and the tier-level contract are two different things; ADR 0015 pins the latter.

Quoting does not suppress tokenization, which is the point: a quoted hyphenated token expands to the compound plus its parts, matching how the `simple` config actually lexed the name. Punctuation _inside_ a token is therefore preserved — `M.A.N.D.Y.` is the single lexeme `m.a.n.d.y`, and five one-letter tokens would match something else entirely.

```sql-claim
to_tsquery('simple', $$'chuquimamani-condori':*$$)  ->  'chuquimamani-condori':* <-> 'chuquimamani':* <-> 'condori':*
to_tsvector('simple', 'Chuquimamani-Condori')       ->  'chuquimamani':2 'chuquimamani-condori':1 'condori':3
to_tsquery('simple', $$'M.A.N.D.Y.':*$$)             ->  'm.a.n.d.y':*
```

Multi-token queries keep AND-semantics, which is the disambiguation `stereolab transient` needs.

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
3. The trimmed query is at least 2 characters long — single-character queries fall through to no-results because trigram on 1-char input is meaningless. (The _tsvector_ path has no such floor; see below for why it does not need one.)

The fallback is single-table and uses `BitmapOr` across the two GIN trigram indexes on `library` — much faster than the cross-table OR the old path forced through the view.

### Pure punctuation and short queries

| Query                             | Path                       | Result                                 |
| --------------------------------- | -------------------------- | -------------------------------------- |
| `""` (empty) or whitespace-only   | (skipped)                  | empty                                  |
| `!!!` (no alphanumerics)          | (skipped)                  | empty                                  |
| `$$$ ...` (no token has a lexeme) | (skipped)                  | empty — `buildPrefixTsquery` is `null` |
| `a` (1 char)                      | tsvector only; no fallback | broad prefix match, ~64 ms             |
| `ab` (2+ chars, alphanumeric)     | tsvector → trigram on miss | full pipeline                          |

### Why the prefix path has no minimum token length

A one-character prefix is the worst case the `:*` change introduces, and it was measured rather than guarded against. Timings below are the **whole** Both-mode call through the service (`fuzzySearchLibrary`, `n = 5`) under the two-tsquery ranker, not the `search_doc` scan alone — warm, five runs after one discarded warm-up, against a 64,193-row catalog, re-measured 2026-09-28:

| query      | matching rows (tsquery alone) | Both-mode call |
| ---------- | ----------------------------- | -------------- |
| `a`        | 21,084 (33% of the catalog)   | 63-69 ms       |
| `au`       | 383                           | 4-5 ms         |
| `aut`      | 131                           | 3 ms           |
| `autec`    | 14                            | 2-3 ms         |
| `stereola` | 32                            | 2-3 ms         |

The selectivity cliff is entirely at one character; two is already narrow, and from two characters up the prefix path costs 2-5 ms where the trigram fallback it displaces cost 11-232 ms (the fallback figures are the production measurements in WXYC/Backend-Service#670, not re-taken here). That is the win, and it covers every keystroke after the first.

**The 1-char case is a different trade, and not a latency win at all.** `searchLibraryBothMode` gates the trigram fallback on `trimmed.length >= 2`, so a single-character query never reached it. The old behavior was a fast page of rows holding a standalone `a` (`websearch_to_tsquery('simple','a')` matches 2,788 of 64,193 clone rows; about 10 ms at the SQL level). The prefix form widens that to every word starting with `a` (21,084 rows) for about 64 ms. So this buys prefix autocomplete on the first keystroke at a real latency cost; it does not replace something slower. 64 ms sits under the ~100 ms threshold where a keystroke still feels immediate.

A floor is therefore a live option rather than a rejected one: suffixing `:*` only on tokens of 2+ characters would restore the old 1-char behavior exactly, for one line in `buildPrefixTsquery`. It is absent because the 64 ms buys something real and stays inside the perceptual budget — not because the 1-char case was measured as cheap.

Two caveats on these numbers. They ran against an `album_plays` MV with **no rows** (the dev clone fixture is catalog-only — 0 `flowsheet` rows — so the MV cannot be populated from it), which makes every row's `coalesce(plays, 0)` tie-break constant at zero; a populated MV adds a unique-index probe per candidate row and a varying sort key, so treat the 1-char figure as a floor rather than a ceiling. And they include JS and driver overhead, which is why they exceed a bare `EXPLAIN` of the `search_doc` predicate — that predicate alone is ~12 ms for `'a':*`, which is a component of the 64 ms and not a substitute for it.

## `album_plays` refresh cadence

The MV is rebuilt by `apps/backend/services/album-plays-refresh.service.ts`, which runs at backend startup and self-reschedules with `setTimeout` (not `setInterval`, so a slow refresh cannot stack overlapping runs).

- Default cadence: **1 hour** (`ALBUM_PLAYS_REFRESH_INTERVAL_MS = 3600000`).
- Per-refresh statement timeout: **5 min** (`ALBUM_PLAYS_REFRESH_TIMEOUT_MS = 300000`). The refresh runs against a dedicated single-connection postgres-js client (`max: 1`, `application_name = wxyc-album-plays-refresh`) with the timeout baked into its connection params. The shared API pool keeps its 5 s `DB_STATEMENT_TIMEOUT_MS`. Measured at ~200–330 ms on the staging clone for `REFRESH ... CONCURRENTLY`; the 5 min ceiling matches the ETL containers and absorbs prod's slower instance plus concurrent flowsheet writes.
- Last-run timestamp is stored in `cronjob_runs` under `job_name = 'album-plays-refresh'` (written via the shared `db`, not the dedicated client).

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

| Migration                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0058_library-artist-name-and-search-doc.sql`   | Added `library.artist_name` (nullable) + `library.search_doc` (STORED tsvector) + GIN indexes on both. DDL-only; the backfill is a separate job.                                                                                                                                                                                                                                                                                      |
| `0059_album-plays-materialized-view.sql`        | `album_plays` MV with unique index on `album_id`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `0178_2714-library-search-doc-position-gap.sql` | BS#2714: rebuilt `library.search_doc` with a sentinel-bought position gap between the artist and album segments, removed via `ts_delete`, so a phrase query cannot match across the field boundary. Drop-and-re-add (Postgres cannot redefine a generation expression in place; `SET EXPRESSION AS` is PG17+ and prod is 14.22), rebuilding `library_search_doc_idx` and re-`ANALYZE`ing. ~1.71 s of statements on the 64K-row table. |
| `0060_library-artist-name-cascade-trigger.sql`  | Trigger on `artists` UPDATE that propagates artist_name into `library.artist_name`, so renames keep `search_doc` correct without an application-side rename path. Its function body was replaced by `0172` (BS#2563) to also clear `library.artwork_lookup_attempted_at` on the cascaded rows.                                                                                                                                        |

Backfill / live-write deliveries (no migrations of their own):

- `jobs/library-artist-name-backfill/` — one-shot job that populates `library.artist_name` for legacy rows. Runs once per deploy environment. See the job's README for invocation.
- `apps/backend/controllers/library.controller.ts#addAlbum` — live writes set `artist_name` inline on every new INSERT, so the column is never NULL after this is deployed.

## Why the segments do not touch

`tsvector || tsvector` does not just append — it **shifts the right operand's positions to continue from the left's, with no gap**. So before migration `0178`, `Todd Rundgren` / `Angel Hair` stored as follows (Postgres prints lexemes alphabetically; read the positions):

```sql-claim
setweight(to_tsvector('simple', 'Todd Rundgren'), 'A') || setweight(to_tsvector('simple', 'Angel Hair'), 'B')  ->  'angel':3B 'hair':4B 'rundgren':2A 'todd':1A
(setweight(to_tsvector('simple', 'Todd Rundgren'), 'A') || setweight(to_tsvector('simple', 'Angel Hair'), 'B')) @@ to_tsquery('simple', $$'rundgren' <-> 'angel'$$)  ->  true
```

`rundgren` at 2 and `angel` at 3 are adjacent, so the phrase query `'rundgren' <-> 'angel'` matched a row where those two words live in different fields and were never adjacent in any real text.

This stayed latent because today's reader emits a phrase query only for genuinely quoted input or for a token the parser splits internally, so reaching it meant typing both full lexemes, adjacent, spanning the seam. It stops being latent the moment a reader emits **prefix** phrases. Measured on a 64,193-row production clone, `'d':* <-> 'a':*` — what `to_tsquery` makes of a `d'a` prefix token — matched 760 rows, **184 of them straddling the seam** (`Amor Belhom Duo / Amor Belhom Duo`, `It's a Beautiful Day / At Carnegie Hall`, `PM Dawn / A Watcher's Point Of View 12"`). After `0178` the same query matches 576, none cross-boundary.

The gap is bought with a sentinel token and then removed with `ts_delete`, which deletes a lexeme's entry **without renumbering the survivors' positions** (this is `0178`'s generation expression with the columns filled in):

```sql-claim
ts_delete(setweight(to_tsvector('simple', 'Todd Rundgren'), 'A') || to_tsvector('simple', 'wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap') || setweight(to_tsvector('simple', 'Angel Hair'), 'B'), 'wxycsearchdocgap')  ->  'angel':6B 'hair':7B 'rundgren':2A 'todd':1A
ts_delete(setweight(to_tsvector('simple', 'Todd Rundgren'), 'A') || to_tsvector('simple', 'wxycsearchdocgap wxycsearchdocgap wxycsearchdocgap') || setweight(to_tsvector('simple', 'Angel Hair'), 'B'), 'wxycsearchdocgap') @@ to_tsquery('simple', $$'rundgren' <-> 'angel'$$)  ->  false
```

Deleting the sentinel rather than leaving it in place is load-bearing, not tidiness. A sentinel lexeme left in the vector is in the GIN index and is prefix-reachable, so `'w':*` would match **every row in the catalog**. `ts_delete` is IMMUTABLE on both PG14 and PG18, so it is legal inside a `STORED GENERATED` column, and the index grows only ~1% (position bytes, no new lexemes).

Two consequences worth knowing before touching this column:

- **Interior hyphens must survive sanitizing.** `Chuquimamani-Condori` lexes to the compound _plus_ its parts, so a prefix of it becomes a multi-operand phrase query anchored inside one field (`'chuquimamani-cond':* <-> 'chuquimamani':* <-> 'cond':*`). That is why any prefix builder necessarily emits phrase queries — and why the gap is a prerequisite for that work rather than defense in depth. Stripping `-` to dodge the phrase would break the name instead.
- **`flowsheet.search_doc` still has the defect**, across four seams rather than one. See `docs/playlist-search/README.md`; the reason it is not fixed here is lock budget, not disagreement.

## Out of scope

- Switching to Elasticsearch (#229).
- `GET /library` `album_name` parameter bug (#233 — sibling work in this project).
- Closing the flowsheet ↔ library linkage gap that constrains the play-count signal — that is Epic B (independent epic; quality of the play-weight signal scales with B's coverage, but Epic A does not block on it).

## Related

- `docs/playlist-search/README.md` — sibling document on `GET /flowsheet/search`.
- `docs/metadata-service/README.md` — flowsheet metadata enrichment via LML.
- [ADR 0015](../adr/0015-catalog-search-query-operators.md) — decides what the leading `-`, bare `or`, and quoted-phrase operators inherited from `websearch_to_tsquery` mean on this surface.
- `sql-claim` blocks — the fenced `expression -> expected` blocks in this document and in ADR 0015 are executed against Postgres by `tests/integration/doc-sql-claims.spec.js` (WXYC/Backend-Service#2737), so a claim about Postgres behaviour that stops being true fails a test by file:line. The grammar, the read-only guarantees and the note on Postgres-version sensitivity live in the header of `tests/utils/sql-claims.js`. A claim that needs table data (row counts on the clone) cannot be a `sql-claim` and stays prose.
- Epic A on GitHub: [WXYC/Backend-Service#483](https://github.com/WXYC/Backend-Service/issues/483).
