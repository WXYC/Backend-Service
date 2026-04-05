-- Inline metadata columns onto the flowsheet table.
-- The separate album_metadata and artist_metadata cache tables are removed
-- because LML already provides its own caching layer, and all cached data
-- in these tables is empty (LIBRARY_METADATA_URL was never configured).

ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "artwork_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "discogs_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "release_year" smallint;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "spotify_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "apple_music_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "youtube_music_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "bandcamp_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "soundcloud_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "artist_bio" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "artist_wikipedia_url" varchar(512);--> statement-breakpoint
DROP TABLE IF EXISTS "wxyc_schema"."album_metadata";--> statement-breakpoint
DROP TABLE IF EXISTS "wxyc_schema"."artist_metadata";
