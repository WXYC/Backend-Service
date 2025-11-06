ALTER TABLE "wxyc_schema"."rotation" ALTER COLUMN "add_date" SET DEFAULT now();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "album_id_idx" ON "wxyc_schema"."rotation" ("album_id");