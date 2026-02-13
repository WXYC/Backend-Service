CREATE TABLE "wxyc_schema"."cronjob_runs" (
	"job_name" varchar(64) PRIMARY KEY NOT NULL,
	"last_run" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

--> Drop view in order to alter the artists table
DROP VIEW IF EXISTS "wxyc_schema"."library_artist_view";
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."artists" ALTER COLUMN "code_letters" SET DATA TYPE varchar(4);
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library" ADD COLUMN "code_volume_letters" varchar(4);
--> statement-breakpoint

--> Recreate view with the altered column in the artists table
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
--> statement-breakpoint