DROP INDEX IF EXISTS "artist_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "title_trgm_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artist_name_trgm_idx" ON "wxyc_schema"."artists" USING gin ("artist_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "title_trgm_idx" ON "wxyc_schema"."library" USING gin ("album_title" gin_trgm_ops);