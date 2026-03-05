DROP VIEW IF EXISTS "wxyc_schema"."library_artist_view";
--> statement-breakpoint

DROP VIEW IF EXISTS "wxyc_schema"."rotation_library_view";
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "alphabetical_name" varchar(128) NOT NULL;
--> statement-breakpoint

CREATE VIEW "wxyc_schema"."library_artist_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."artists"."code_letters", "wxyc_schema"."genre_artist_crossreference"."artist_genre_code", "wxyc_schema"."library"."code_number", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."artists"."alphabetical_name", "wxyc_schema"."library"."album_title", "wxyc_schema"."format"."format_name", "wxyc_schema"."genres"."genre_name", "wxyc_schema"."rotation"."rotation_bin", "wxyc_schema"."library"."add_date", "wxyc_schema"."library"."label" from "wxyc_schema"."library" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id" inner join "wxyc_schema"."format" on "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id" inner join "wxyc_schema"."genres" on "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id" inner join "wxyc_schema"."genre_artist_crossreference" on ("wxyc_schema"."genre_artist_crossreference"."artist_id" = "wxyc_schema"."library"."artist_id" and "wxyc_schema"."genre_artist_crossreference"."genre_id" = "wxyc_schema"."library"."genre_id") left join "wxyc_schema"."rotation" on "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id" AND ("wxyc_schema"."rotation"."kill_date" > CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL));
--> statement-breakpoint

CREATE VIEW "wxyc_schema"."rotation_library_view" AS (select "wxyc_schema"."library"."id" AS "library_id", "wxyc_schema"."rotation"."id" AS "rotation_id", "wxyc_schema"."library"."label", "wxyc_schema"."rotation"."rotation_bin", "wxyc_schema"."library"."album_title", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."artists"."alphabetical_name", "wxyc_schema"."rotation"."kill_date" from "wxyc_schema"."library" inner join "wxyc_schema"."rotation" on "wxyc_schema"."library"."id" = "wxyc_schema"."rotation"."album_id" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id");
