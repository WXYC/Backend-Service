ALTER TABLE "wxyc_schema"."show_djs" ADD COLUMN "active" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" DROP COLUMN IF EXISTS "time_joined";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" DROP COLUMN IF EXISTS "time_left";