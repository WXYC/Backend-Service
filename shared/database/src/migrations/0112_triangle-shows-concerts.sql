-- 0112 triangle-shows concerts substrate (BS#1589, Phase 1 of the BS#1570 decision record).
--
-- Prepares `concerts` for the triangle-shows pull ETL (jobs/triangle-shows-etl):
--   * new `concert_source_enum` value 'triangle_shows' — the documented extension path
--     (see jobs/venue-events-scraper/README.md: "extend the enum rather than replacing
--     this job"). Added but never USED in this transaction, so the PG12+ in-transaction
--     ALTER TYPE ... ADD VALUE restriction doesn't bite. CAUTION for later migrations:
--     drizzle's migrator runs ALL pending migrations of a deploy in ONE transaction, so
--     a later migration batched with this one must not reference 'triangle_shows' in
--     DML or index predicates either — on a DB where the enum type pre-exists (prod)
--     that raises 55P04 "unsafe use of new value", while fresh CI DBs never reproduce
--     it (0091 creates the type in the same batch). migrate-dryrun usually catches it.
--   * `source_id` varchar(256) -> text. Binary-coercible type change: no table rewrite,
--     no change to existing rhp_scrape values, and concerts_source_source_id_idx (plain
--     btree unique) needs no REINDEX. Needed because triangle-shows keying is
--     '<venue_slug>:' + source_key: theoretical max ~1201 chars (slug String(100) + ':'
--     + key String(1100)), ~1165 in practice under the ETL's slug<=64 assertion — and
--     PG varchar errors rather than truncates.
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
--   * `concerts_derive_starts_on` BEFORE trigger: the DB owns the invariant
--     "starts_on == starts_at's NY calendar date whenever starts_at is set" (0084/0060
--     trigger precedent). Also makes an app ROLLBACK to a pre-0112 image safe: the old
--     writer omits starts_on, and the trigger derives it before the NOT NULL check.
--
-- Lock behavior: each ALTER takes AccessExclusiveLock briefly; the table is small and
-- nothing user-facing reads it yet (read API is Phase 2). The paired writer change
-- (jobs/venue-events-scraper/writer.ts computing starts_on) ships in the SAME PR.
ALTER TYPE "wxyc_schema"."concert_source_enum" ADD VALUE 'triangle_shows';--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ALTER COLUMN "source_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ALTER COLUMN "starts_at" DROP NOT NULL;--> statement-breakpoint
-- Hand-split from the generated `ADD COLUMN "starts_on" date NOT NULL` (which cannot
-- apply to a non-empty table): add nullable -> backfill -> SET NOT NULL.
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "starts_on" date;--> statement-breakpoint
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
-- DB-side ownership of the starts_on <-> starts_at consistency invariant, in the
-- style of 0084's bump_flowsheet_updated_at (and 0060's rationale: a forgotten
-- call site would silently drift). Whenever a row carries an instant, starts_on
-- is derived from it — so an UPDATE that moves starts_at across midnight (Phase-2
-- mutation, manual psql remediation) can't leave a stale calendar date, and an
-- app rollback to a pre-0112 image (whose writer doesn't supply starts_on) still
-- inserts cleanly: BEFORE ROW triggers run before the NOT NULL check. Date-only
-- rows (starts_at IS NULL) pass through untouched — their starts_on is the
-- source's authoritative calendar date and must be supplied by the writer.
-- Remediation corollary: on a TIMED row, starts_on is trigger-owned — a manual
-- `UPDATE ... SET starts_on = X` reports UPDATE 1 but is silently re-derived; to
-- move a timed row's calendar date, move starts_at (or NULL it first).
CREATE OR REPLACE FUNCTION wxyc_schema.concerts_derive_starts_on() RETURNS trigger AS $$
BEGIN
  IF NEW.starts_at IS NOT NULL THEN
    NEW.starts_on := (NEW.starts_at AT TIME ZONE 'America/New_York')::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER concerts_derive_starts_on
BEFORE INSERT OR UPDATE ON wxyc_schema.concerts
FOR EACH ROW
EXECUTE FUNCTION wxyc_schema.concerts_derive_starts_on();--> statement-breakpoint
ANALYZE "wxyc_schema"."concerts";
