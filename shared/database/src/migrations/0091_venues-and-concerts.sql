-- precondition-guard: not-required (two fresh CREATE TABLE statements; the
--   only FK out of the new tables that targets an existing table is
--   concerts.headlining_artist_id → artists.id, and that column is
--   nullable AND the table is empty at ADD CONSTRAINT time, so no
--   existing-row invariant can be violated. The concerts.venue_id FK
--   targets the venues table created in this same migration. The cross-
--   cache-identity gate doesn't apply because this migration doesn't
--   touch library_identity in any form.)
-- @no-precondition-needed: every constraint added here (two PKs, two FKs,
--   one UNIQUE index, two non-unique indexes, NOT NULLs, DEFAULTs) is
--   evaluated against empty tables at ADD CONSTRAINT time. No existing
--   data can violate.
-- 0091 — venues + concerts substrate for the touring-events feature.
--
-- Adds two new tables and two enums for ingesting upcoming concerts at
-- partner Triangle-area venues into the BS data layer. First ingestion
-- source is the venue-events-scraper job (this PR), which scrapes
-- Rockhouse Partners venue sites (catscradle.com, local506.com) and
-- parses schema.org Event JSON-LD from each event page. Future sources
-- (Bandsintown live-fetch, editorial submissions) extend the
-- concert_source_enum without further DDL — bandsintown specifically is
-- kept OUT of this table because its Data Applications Terms forbid
-- persistent caching of API results (session-only).
--
-- Schema choices:
--   - `concerts` (not `events`) to avoid conceptual collision with the
--     /events SSE route in apps/backend.
--   - `headlining_artist_id` is nullable. LML's canonical-entity coverage
--     is ~24% (see project_lml_entity_identity_state memory), so most
--     rows ship with the raw name only; a future artist-resolver pass
--     backfills the id without changing the raw column.
--   - `(source, source_id)` is the per-source dedup key; re-scrapes
--     UPSERT in place. Cross-source dedup (collapse the same logical
--     concert reported by both rhp_scrape and a future submission) is
--     deferred to a read-time view, preserving the per-source audit.
--   - `raw_data jsonb` carries the source's original payload (the parsed
--     schema.org Event for rhp_scrape) so we can forensically diff when
--     a source's format changes.
--
-- Companion job: jobs/venue-events-scraper/ (this PR). Default schedule
-- in package.json is "0 5 * * *" UTC (01:00 ET overnight, before LML's
-- 06:00 UTC backfill window).

CREATE TYPE "wxyc_schema"."concert_source_enum" AS ENUM('rhp_scrape');--> statement-breakpoint
CREATE TYPE "wxyc_schema"."concert_status_enum" AS ENUM('on_sale', 'sold_out', 'cancelled', 'rescheduled');--> statement-breakpoint
CREATE TABLE "wxyc_schema"."concerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" "wxyc_schema"."concert_source_enum" NOT NULL,
	"source_id" varchar(256) NOT NULL,
	"venue_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"headlining_artist_raw" varchar(256) NOT NULL,
	"headlining_artist_id" integer,
	"supporting_artists_raw" text[] DEFAULT '{}'::text[] NOT NULL,
	"ticket_url" text,
	"image_url" text,
	"status" "wxyc_schema"."concert_status_enum" DEFAULT 'on_sale' NOT NULL,
	"raw_data" jsonb NOT NULL,
	"scraped_at" timestamp with time zone NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."venues" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"city" varchar(64) NOT NULL,
	"state" varchar(32) NOT NULL,
	"address" varchar(256),
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD CONSTRAINT "concerts_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "wxyc_schema"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD CONSTRAINT "concerts_headlining_artist_id_artists_id_fk" FOREIGN KEY ("headlining_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "concerts_source_source_id_idx" ON "wxyc_schema"."concerts" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "concerts_venue_starts_at_idx" ON "wxyc_schema"."concerts" USING btree ("venue_id","starts_at");--> statement-breakpoint
CREATE INDEX "concerts_headlining_artist_starts_at_idx" ON "wxyc_schema"."concerts" USING btree ("headlining_artist_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_slug_idx" ON "wxyc_schema"."venues" USING btree ("slug");