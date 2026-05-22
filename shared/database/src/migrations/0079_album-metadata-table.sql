-- 0079 — Epic D / WXYC/Backend-Service#897: extract the 10 per-album
-- metadata columns currently inlined on `flowsheet` into their own table,
-- keyed by `album_id` (PK + FK to library.id). The flowsheet inline
-- columns stay until D4; the V2 read path joins this table and projects
-- COALESCE(album_metadata.col, flowsheet.col) so writers and readers
-- cut over independently. Children:
--   - D2 (WXYC/Backend-Service#898) — historical data move via the
--     bulk-update playbook recipe.
--   - D3 (WXYC/Backend-Service#899) — enrichment consumer upserts into
--     `album_metadata`; the inline columns continue to receive writes.
--   - D4 (WXYC/Backend-Service#900) — after ≥1 month of D3 with zero
--     divergence, drop the 10 inline columns and collapse the COALESCE
--     projection.
--
-- Operationally: CREATE TABLE on a previously-nonexistent name takes a
-- brief AccessExclusiveLock on the new relation only (no contention with
-- the live flowsheet write path). ADD CONSTRAINT for the FK validates
-- against zero rows since the table is freshly created in this same
-- transaction.
--
-- @no-precondition-needed: fresh CREATE TABLE — the FK constraint
-- validates against the zero rows present at apply time. No data
-- invariant on existing rows exists to violate. See WXYC/Backend-Service#705.

CREATE TABLE "wxyc_schema"."album_metadata" (
	"album_id" integer PRIMARY KEY NOT NULL,
	"artwork_url" varchar(512),
	"discogs_url" varchar(512),
	"release_year" smallint,
	"spotify_url" varchar(512),
	"apple_music_url" varchar(512),
	"youtube_music_url" varchar(512),
	"bandcamp_url" varchar(512),
	"soundcloud_url" varchar(512),
	"artist_bio" text,
	"artist_wikipedia_url" varchar(512),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD CONSTRAINT "album_metadata_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;