-- 0102 (BS#1336): persist the 8 LML-only enrichment fields on album_metadata
-- so the BS#1331 cache-first /proxy/metadata/album path emits the artist +
-- release subtree on a hit instead of shedding it (the cold LML-fallthrough
-- already returns these; a cache hit previously omitted them).
--
-- Additive, all nullable, no constraints/defaults/FKs — pure ADD COLUMN, so
-- no precondition guard is needed (see docs/migrations.md constraint-guard
-- rule, which scopes only UNIQUE/CHECK/NOT NULL/FK migrations). `discogs_artist_id`
-- is the external Discogs artist id, intentionally NOT an FK to `artists`.
-- DDL-only; lock is a brief AccessExclusiveLock on a metadata-only table (ADD
-- COLUMN with no default is a catalog-only change in PG, no table rewrite).
--
-- Writer: apps/enrichment-worker (enrich.ts finalizeRow, with extended:true in
-- handler.ts). Historical rows need an LML extended re-fetch (tracked as a
-- separate backfill; flowsheet never carried these columns so #898's
-- flowsheet-copy shape can't populate them).
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "discogs_artist_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "label" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "full_release_date" varchar(32);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "genres" text[];--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "styles" text[];--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "tracklist" jsonb;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "artist_image_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD COLUMN "bio_tokens" jsonb;