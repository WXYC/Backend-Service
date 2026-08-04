-- BS#1965 — extend the catalog freshness watermark to the two tables the
-- library.db-producer export reads that migration 0105 does not cover.
--
-- 0104 (#1467) created `library_watermark` + `touch_library_watermark()` and
-- attached the AFTER STATEMENT trigger to `library`. 0105 (#1468) fanned it out
-- to the five join parents whose columns `GET /library/catalog` projects
-- (artists, genres, format, genre_artist_crossreference, rotation). BS#1965 adds
-- two more source tables to that export surface, and the same coverage invariant
-- applies: every exported field's source table must advance the watermark.
--
--   artist_crossreference    -> CatalogExportRow.cross_reference_names
--   compilation_track_artist -> the whole GET /library/catalog/compilation-tracks body
--
-- Neither is a "lag" without this migration — both are SILENT AND UNBOUNDED.
-- The conditional-GET middleware short-circuits to 304 on an unchanged
-- watermark, and the per-watermark gzip cache is only rebuilt when the watermark
-- moves. So a write to either table lands in Postgres, changes nothing the
-- client can observe, and stays invisible until some UNRELATED write to one of
-- the seven already-covered tables happens to bump the watermark.
--
-- `compilation_track_artist` is the sharper of the two, because the intuitive
-- "it'll ride the library add" reasoning is backwards. The real sequence is:
--
--   1. POST /library                          -> library trigger bumps watermark to T
--   2. (first request after)                  -> gzip cache builds for T
--   3. POST /library/{id}/compilation-tracks  -> CTA rows land at T+delta, no trigger
--
-- The CTA POST always FOLLOWS the library add it would supposedly ride, so the
-- cached body for T never contains the tracks. Post-tubafrenzy-turndown the daily
-- library sync goes away too, so "the next daily write will pick it up" stops
-- holding and a CTA-only cataloging session can stay invisible indefinitely.
--
-- Reuses `touch_library_watermark()` verbatim (defined in 0104) — same one-row
-- UPDATE, same monotonic `GREATEST(now(), last_modified_at)` advance, same
-- per-statement O(1) cost regardless of how many rows the statement touched. No
-- schema objects change, so `drizzle:generate` produces no diff and this is a
-- `--custom` migration whose snapshot is byte-identical to 0137's apart from the
-- id/prevId chain link. TRUNCATE is included for symmetry with 0104/0105.
--
-- Write-rate note: both tables are curated, not hot. `artist_crossreference` is
-- librarian-edited at human cadence; `compilation_track_artist` is written by the
-- BS#1964 CTA path on V/A catalog adds. Neither approaches `rotation`, which 0105
-- already accepted as the continuously-curated case. The cost of a bumped
-- watermark is one full-catalog rebuild on the next request — the same cost the
-- `library` trigger already pays on every catalog add.
--
-- @no-analyze-needed: no UPDATE on a stats-bearing table — the only write is the
-- one-row `library_watermark` UPDATE inside the reused trigger function.
-- @no-precondition-needed: trigger DDL only; no constraint, no data invariant.

CREATE TRIGGER touch_library_watermark_from_artist_crossreference
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.artist_crossreference
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
--> statement-breakpoint
CREATE TRIGGER touch_library_watermark_from_compilation_track_artist
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.compilation_track_artist
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
