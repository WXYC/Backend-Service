ALTER TABLE "wxyc_schema"."bins" ADD COLUMN "track_title" varchar(128);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_letters_idx" ON "wxyc_schema"."artists" ("code_letters");