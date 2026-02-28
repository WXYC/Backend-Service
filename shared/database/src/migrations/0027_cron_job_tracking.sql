CREATE TABLE IF NOT EXISTS "wxyc_schema"."cronjob_runs" (
	"job_name" varchar(64) PRIMARY KEY NOT NULL,
	"last_run" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DROP VIEW IF EXISTS "wxyc_schema"."library_artist_view";
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."artists" ALTER COLUMN "code_letters" SET DATA TYPE varchar(4);
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library" ADD COLUMN IF NOT EXISTS "code_volume_letters" varchar(4);
--> statement-breakpoint

CREATE VIEW "wxyc_schema"."library_artist_view" AS
SELECT "wxyc_schema"."library"."id",
    "wxyc_schema"."artists"."code_letters",
    "wxyc_schema"."artists"."code_artist_number",
    "wxyc_schema"."library"."code_number",
    "wxyc_schema"."artists"."artist_name",
    "wxyc_schema"."library"."album_title",
    "wxyc_schema"."format"."format_name",
    "wxyc_schema"."genres"."genre_name",
    "wxyc_schema"."rotation"."rotation_bin",
    "wxyc_schema"."library"."add_date",
    "wxyc_schema"."library"."label"
FROM "wxyc_schema"."library"
    INNER JOIN "wxyc_schema"."artists" ON "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id"
    INNER JOIN "wxyc_schema"."genres" ON "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id"
    INNER JOIN "wxyc_schema"."format" ON "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id"
    LEFT JOIN "wxyc_schema"."rotation"
        ON "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id"
        AND ("wxyc_schema"."rotation"."kill_date" > CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL);
