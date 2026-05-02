-- Add legacy ID columns for ETL deduplication between Backend-Service and tubafrenzy.
-- These map tubafrenzy primary keys to Backend-Service records for idempotent imports.

-- @no-precondition-needed: each UNIQUE INDEX is built against a column
-- that is freshly added as nullable in the immediately preceding ALTER
-- TABLE. Every existing row holds NULL for the new column at index-build
-- time, and Postgres's btree UNIQUE treats NULLs as distinct, so duplicate
-- violations are impossible. The ETL backfills these columns post-deploy.

-- library.legacy_release_id — maps tubafrenzy LIBRARY_RELEASE.ID
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "legacy_release_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_legacy_release_id_idx" ON "wxyc_schema"."library" USING btree ("legacy_release_id");--> statement-breakpoint

-- flowsheet.legacy_entry_id — deduplication key for flowsheet entries
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "legacy_entry_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flowsheet_legacy_entry_id_idx" ON "wxyc_schema"."flowsheet" USING btree ("legacy_entry_id");--> statement-breakpoint

-- shows.legacy_show_id — deduplication key for shows
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "legacy_show_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shows_legacy_show_id_idx" ON "wxyc_schema"."shows" USING btree ("legacy_show_id");
