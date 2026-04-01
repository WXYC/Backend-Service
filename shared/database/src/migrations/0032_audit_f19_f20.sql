-- F19: flowsheet.play_order serial → integer
-- The play_order column is manually managed by reorder operations, not auto-incremented.
-- Drop the default (which references a sequence) and change the column type to integer.
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "play_order" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "play_order" SET DATA TYPE integer;--> statement-breakpoint
DROP SEQUENCE IF EXISTS "wxyc_schema"."flowsheet_play_order_seq";--> statement-breakpoint

-- F20: artist_library_crossreference FK columns should be NOT NULL
-- These are junction table FKs — a row without both IDs is meaningless.
-- Verify no NULL rows exist before applying: SELECT count(*) FROM wxyc_schema.artist_library_crossreference WHERE artist_id IS NULL OR library_id IS NULL;
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ALTER COLUMN "artist_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ALTER COLUMN "library_id" SET NOT NULL;
