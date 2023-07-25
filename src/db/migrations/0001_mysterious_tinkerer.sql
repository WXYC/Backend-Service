-- Custom SQL migration file, put you code below! --
CREATE OR REPLACE VIEW "wxyc_schema"."library_artist_view" AS
SELECT "library"."id", "album_title", "artist_name", "code_letters", "code_artist_number", "code_number", "format_name", "genre_name"
FROM "wxyc_schema"."library"
INNER JOIN "wxyc_schema"."artists"
ON "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id"
INNER JOIN "wxyc_schema"."genres"
ON "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id"
INNER JOIN "wxyc_schema"."format"
ON "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id"
