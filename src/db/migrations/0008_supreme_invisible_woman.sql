-- Custom SQL migration file, put you code below! --
CREATE OR REPLACE VIEW "wxyc_schema"."rotation_library_view" AS
SELECT "library"."id" as "library_id", "rotation"."id" as "rotation_id", "library"."label", "rotation"."play_freq", "library"."album_title", "artists"."artist_name", "rotation"."kill_date"
FROM "wxyc_schema"."library"
INNER JOIN "wxyc_schema"."rotation"
ON "wxyc_schema"."library"."id" = "wxyc_schema"."rotation"."album_id"
INNER JOIN "wxyc_schema"."artists"
ON "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id";

CREATE OR REPLACE VIEW "wxyc_schema"."library_artist_view" AS
SELECT "library"."id", "artists"."code_letters", "artists"."code_artist_number", "library"."code_number", "artists"."artist_name", "library"."album_title", "format"."format_name", "genres"."genre_name", "rotation"."play_freq" as "rotation", "library"."add_date"
FROM "wxyc_schema"."library"
INNER JOIN "wxyc_schema"."artists"
ON "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id"
INNER JOIN "wxyc_schema"."genres"
ON "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id"
INNER JOIN "wxyc_schema"."format"
ON "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id"
LEFT JOIN "wxyc_schema"."rotation"
ON "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id"