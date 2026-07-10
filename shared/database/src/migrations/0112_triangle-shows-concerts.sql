-- 0112 triangle-shows concerts substrate (BS#1589, Phase 1 of the BS#1570 decision record).
--
-- Prepares `concerts` for the triangle-shows pull ETL (jobs/triangle-shows-etl):
--   * new `concert_source_enum` value 'triangle_shows' — the documented extension path
--     (see jobs/venue-events-scraper/README.md: "extend the enum rather than replacing
--     this job"). Added but never USED in this transaction, so the PG12+ in-transaction
--     ALTER TYPE ... ADD VALUE restriction doesn't bite.
--   * `source_id` varchar(256) -> text. Binary-coercible type change: no table rewrite,
--     no change to existing rhp_scrape values, and concerts_source_source_id_idx (plain
--     btree unique) needs no REINDEX. Needed because triangle-shows keying is
--     '<venue_slug>:' + source_key with a theoretical max ~1165 chars, and PG varchar
--     errors rather than truncates.
--   * `starts_at` drops NOT NULL — many triangle-shows events are date-only and we never
--     fabricate times. `starts_on date NOT NULL` (venue-local America/New_York calendar
--     date) becomes the windowing column. Backfill-then-SET-NOT-NULL below; derivation
--     covers 100% of existing rows because starts_at is NOT NULL until this migration.
--     In-migration DML is within the DDL-only rule's ~10k threshold (concerts holds the
--     RHP scraper's 5 venues; O(hundreds) rows). No row drop — first_scraped_at anchors
--     BS#1373's stability clock (BS#1570 correction 1).
--   * promoted columns (all nullable; existing rhp_scrape rows untouched): title,
--     doors_at, price_min/price_max numeric(8,2) dollars, age_restriction, removed_at
--     (source-observed tombstone). Long-tail fields (genre/subgenre/description) stay in
--     raw_data per BS#1570 Decision 2.
--   * partial index for Phase 2's curated feed, starts_on-first because both existing
--     composite indexes key on the now-nullable starts_at (BS#1570 correction 4).
--
-- Lock behavior: each ALTER takes AccessExclusiveLock briefly; the table is small and
-- nothing user-facing reads it yet (read API is Phase 2). The paired writer change
-- (jobs/venue-events-scraper/writer.ts computing starts_on) ships in the SAME PR —
-- deploying this migration without it breaks the next 05:00 UTC scrape's inserts.
ALTER TYPE "wxyc_schema"."concert_source_enum" ADD VALUE 'triangle_shows';--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ALTER COLUMN "source_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ALTER COLUMN "starts_at" DROP NOT NULL;--> statement-breakpoint
-- Hand-split from the generated `ADD COLUMN "starts_on" date NOT NULL` (which cannot
-- apply to a non-empty table): add nullable -> backfill -> SET NOT NULL.
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "starts_on" date;--> statement-breakpoint
-- @no-analyze-needed: ANALYZE follows at the bottom of this migration.
UPDATE "wxyc_schema"."concerts" SET "starts_on" = ("starts_at" AT TIME ZONE 'America/New_York')::date WHERE "starts_on" IS NULL;--> statement-breakpoint
-- @no-precondition-needed: the backfill UPDATE in this same transaction covers every
-- row (starts_at is NOT NULL until this migration drops the constraint above), so the
-- SET NOT NULL is provably safe.
ALTER TABLE "wxyc_schema"."concerts" ALTER COLUMN "starts_on" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "doors_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "price_min" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "price_max" numeric(8, 2);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "age_restriction" varchar(50);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "concerts_curated_starts_on_idx" ON "wxyc_schema"."concerts" USING btree ("starts_on") WHERE "wxyc_schema"."concerts"."headlining_artist_id" IS NOT NULL AND "wxyc_schema"."concerts"."removed_at" IS NULL;--> statement-breakpoint
ANALYZE "wxyc_schema"."concerts";
