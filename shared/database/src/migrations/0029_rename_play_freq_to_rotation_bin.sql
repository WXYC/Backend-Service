-- Rename play_freq column to rotation_bin on the rotation table.
-- The enum type (freq_enum) stays the same; only the column name changes.

-- Drop views that reference the column
DROP VIEW IF EXISTS "wxyc_schema"."library_artist_view";
--> statement-breakpoint
DROP VIEW IF EXISTS "wxyc_schema"."rotation_library_view";
--> statement-breakpoint

-- Rename the column
ALTER TABLE "wxyc_schema"."rotation" RENAME COLUMN "play_freq" TO "rotation_bin";
--> statement-breakpoint

-- Recreate library_artist_view with the new column name
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
    INNER JOIN "wxyc_schema"."format" ON "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id"
    INNER JOIN "wxyc_schema"."genres" ON "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id"
    LEFT JOIN "wxyc_schema"."rotation"
        ON "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id"
        AND ("wxyc_schema"."rotation"."kill_date" < CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL);
--> statement-breakpoint

-- Recreate rotation_library_view with the new column name
CREATE VIEW "wxyc_schema"."rotation_library_view" AS
SELECT "wxyc_schema"."library"."id",
    "wxyc_schema"."rotation"."id" AS "rotation_id",
    "wxyc_schema"."library"."label",
    "wxyc_schema"."rotation"."rotation_bin",
    "wxyc_schema"."library"."album_title",
    "wxyc_schema"."artists"."artist_name",
    "wxyc_schema"."rotation"."kill_date"
FROM "wxyc_schema"."library"
    INNER JOIN "wxyc_schema"."rotation" ON "wxyc_schema"."library"."id" = "wxyc_schema"."rotation"."album_id"
    INNER JOIN "wxyc_schema"."artists" ON "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id";
