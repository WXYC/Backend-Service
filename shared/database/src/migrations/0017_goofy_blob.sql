-- Custom SQL migration file, put you code below! --
DROP VIEW IF EXISTS "wxyc_schema"."library_artist_view";

CREATE VIEW "wxyc_schema"."library_artist_view" AS
SELECT "library"."id", 
    "artists"."code_letters",
    "artists"."code_artist_number", 
    "library"."code_number", 
    "artists"."artist_name", 
    "library"."album_title", 
    "library"."label",
    "format"."format_name", 
    "genres"."genre_name", 
    "rotation"."play_freq", 
    "library"."add_date"
FROM "wxyc_schema"."library"
    INNER JOIN "wxyc_schema"."artists" ON "artists"."id" = "library"."artist_id"
    INNER JOIN "wxyc_schema"."genres" ON "genres"."id" = "library"."genre_id"
    INNER JOIN "wxyc_schema"."format" ON "format"."id" = "library"."format_id"
    LEFT JOIN "wxyc_schema"."rotation"
        ON "rotation"."album_id" = "library"."id" AND ("rotation"."kill_date" > CURRENT_DATE OR "rotation"."kill_date" IS NULL);