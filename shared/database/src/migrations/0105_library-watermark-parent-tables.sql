-- BS#1468 (Epic F pattern, parent #1466) — fan the catalog freshness watermark
-- out beyond `library` to every table whose columns the bulk-export endpoint
-- (`GET /library/catalog`) projects for display.
--
-- Migration 0104 (#1467) created `library_watermark` + `touch_library_watermark()`
-- and attached the AFTER STATEMENT trigger to `library` only. But the export's
-- flat row is a 5-table join (`library_artist_view`): most display fields are
-- NOT physical `library` columns —
--
--   code_letters            <- artists.code_letters
--   code_artist_number      <- genre_artist_crossreference.artist_genre_code
--   genre_name              <- genres.genre_name
--   format_name             <- format.format_name
--   rotation_bin/kill_date  <- rotation.* (raw, client evaluates expiry)
--
-- A rename/curation write on any of those parent tables touches no `library`
-- row, so a `library`-only trigger would leave the watermark stale and a polling
-- client would `304` against an out-of-date name until some unrelated `library`
-- write happened to move it. This is the "coverage invariant" in #1468: every
-- exported display field's source table must advance the watermark. So we attach
-- the SAME trigger function to the four join parents + `rotation`.
--
-- `artist_name` is already covered two ways and needs no new trigger here: it is
-- denormalized onto `library.artist_name` (physical column, direct `library`
-- trigger) and the 0060 cascade rewrites those `library` rows on an `artists`
-- rename. But `artists.code_letters` is NOT cascaded, so `artists` still needs
-- its own trigger for that field — accepting that an `artists` write now both
-- fires this trigger AND (on a rename) the 0060 cascade's `UPDATE library`. Both
-- land on the idempotent `GREATEST(now(), last_modified_at)` advance, so the
-- double-fire is harmless.
--
-- rotation is the sharp case: it is curated continuously (writes land on
-- `rotation`, not `library`), so this trigger raises the catalog's 200/304 ratio
-- above the "~daily ETL" cadence — by design, since `rotation_bin` is exported.
-- The membership-EXPIRY half (a `kill_date` passing) is a pure clock event with
-- no row mutation that no statement trigger can observe; #1468 delegates that to
-- the client clock (it ships raw `rotation_bin` + `rotation_kill_date` and
-- evaluates "in rotation" locally), so this trigger only needs to catch the
-- add/kill *writes*, which it does.
--
-- Reuses `touch_library_watermark()` verbatim (defined in 0104) — same one-row
-- UPDATE, same monotonic no-+1s formula, same per-statement O(1) cost. No schema
-- objects change, so `drizzle:generate` produces no diff and the 0105 snapshot
-- is byte-identical to 0104's apart from the id/prevId chain link (this is a
-- `--custom` migration). TRUNCATE is included for symmetry with 0104 (a
-- re-seed-via-TRUNCATE of any parent still advances the watermark).
--
-- @no-analyze-needed: no UPDATE on a stats-bearing table — the only write is the
-- one-row `library_watermark` UPDATE inside the reused trigger function.
-- @no-precondition-needed: trigger DDL only; no constraint, no data invariant.

CREATE TRIGGER touch_library_watermark_from_artists
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.artists
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
--> statement-breakpoint
CREATE TRIGGER touch_library_watermark_from_genres
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.genres
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
--> statement-breakpoint
CREATE TRIGGER touch_library_watermark_from_format
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.format
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
--> statement-breakpoint
CREATE TRIGGER touch_library_watermark_from_gac
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.genre_artist_crossreference
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
--> statement-breakpoint
CREATE TRIGGER touch_library_watermark_from_rotation
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON wxyc_schema.rotation
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_library_watermark();
