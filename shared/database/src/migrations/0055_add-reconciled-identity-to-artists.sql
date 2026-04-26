ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "discogs_artist_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "musicbrainz_artist_id" varchar(64);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "wikidata_qid" varchar(32);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "spotify_artist_id" varchar(64);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "apple_music_artist_id" varchar(64);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "bandcamp_id" varchar(255);
