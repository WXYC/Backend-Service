-- BS#3390: the listen-first links on an intake item. `spotify_url` and `apple_music_url` are filled by a lookup; `bandcamp_url` is entered by a music director or filled by a lookup, and `bandcamp_url_entered` marks the entered one so a lookup never replaces it. `links_checked_at` is the lookup's own stamp.
-- DDL-only: nullable columns with no default rewrite nothing, and the NOT NULL boolean carries a constant default, which Postgres 11+ stores in the catalog rather than rewriting rows. No backfill: every existing item reads null links and `bandcamp_url_entered = false`.
-- @no-precondition-needed: the NOT NULL column has a default, so no existing row can violate it.
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "spotify_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "apple_music_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "bandcamp_url" varchar(512);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "bandcamp_url_entered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."intake_items" ADD COLUMN "links_checked_at" timestamp with time zone;