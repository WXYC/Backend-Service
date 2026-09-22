-- BS#2639: expose `library.genre_id` on `library_artist_view`.
--
-- The view already INNER JOINs `genres` on `library.genre_id` and keys its
-- `genre_artist_crossreference` join on the same column, so the id is what
-- makes the view's `artist_genre_code` the artist's code IN that genre. It
-- was never projected, which left `GET /library` emitting `genre_name` and no
-- id -- and a catalog search row that cannot name a shelf has to fall back to
-- the lowest-`genre_id` collapse on the artist card (BS#2637): both Isises,
-- the hip-hop act filed `IS 1` and the rock band filed `IS 13`, land on one
-- page.
--
-- DDL-only and additive: one column onto a view, no table touched, no data
-- read or written. DROP + CREATE rather than CREATE OR REPLACE because the
-- new column is not appended last (it sits beside `genre_name`, where it
-- reads), and CREATE OR REPLACE VIEW cannot reorder an existing column list.
-- Nothing depends on this view in the database -- no dependent views, no
-- materialized views, no rules -- so the DROP needs no CASCADE, matching the
-- shape of 0166, 0133, and 0056 before it. The window between DROP and CREATE
-- is inside the migration's transaction, so no concurrent reader ever sees
-- the view missing.

DROP VIEW "wxyc_schema"."library_artist_view";--> statement-breakpoint
CREATE VIEW "wxyc_schema"."library_artist_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."artists"."code_letters", "wxyc_schema"."genre_artist_crossreference"."artist_genre_code", "wxyc_schema"."library"."code_number", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."artists"."alphabetical_name", "wxyc_schema"."library"."album_title", "wxyc_schema"."format"."format_name", "wxyc_schema"."genres"."genre_name", "wxyc_schema"."library"."genre_id", "wxyc_schema"."rotation"."rotation_bin", "wxyc_schema"."library"."add_date", "wxyc_schema"."library"."label", "wxyc_schema"."library"."label_id", "wxyc_schema"."library"."on_streaming", "wxyc_schema"."library"."album_artist", "wxyc_schema"."library"."plays", "wxyc_schema"."library"."artwork_url", "wxyc_schema"."artists"."discogs_artist_id", "wxyc_schema"."artists"."musicbrainz_artist_id", "wxyc_schema"."artists"."wikidata_qid", "wxyc_schema"."artists"."spotify_artist_id", "wxyc_schema"."artists"."apple_music_artist_id", "wxyc_schema"."artists"."bandcamp_id", "wxyc_schema"."library"."artist_id", "wxyc_schema"."library"."discogs_unavailable", "wxyc_schema"."library"."discogs_unavailable_note", "wxyc_schema"."library"."last_discogs_recheck_at", "wxyc_schema"."rotation_cards"."id" as "rotation_card_id", "wxyc_schema"."rotation_cards"."bin", "wxyc_schema"."rotation_cards"."number", "wxyc_schema"."rotation_cards"."name" from "wxyc_schema"."library" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id" inner join "wxyc_schema"."format" on "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id" inner join "wxyc_schema"."genres" on "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id" inner join "wxyc_schema"."genre_artist_crossreference" on ("wxyc_schema"."genre_artist_crossreference"."artist_id" = "wxyc_schema"."library"."artist_id" and "wxyc_schema"."genre_artist_crossreference"."genre_id" = "wxyc_schema"."library"."genre_id") left join "wxyc_schema"."rotation" on "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id" AND ("wxyc_schema"."rotation"."kill_date" > CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL) left join "wxyc_schema"."rotation_cards" on "wxyc_schema"."rotation_cards"."id" = "wxyc_schema"."rotation"."card_id");