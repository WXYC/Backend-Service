ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_flowsheet_start_index_flowsheet_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_flowsheet_end_index_flowsheet_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "track_title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "album_title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "artist_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "show_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" ADD COLUMN "time_joined" timestamp;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" ADD COLUMN "time_left" timestamp;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "primary_dj_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_djs_id_fk" FOREIGN KEY ("primary_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" DROP COLUMN IF EXISTS "active";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "flowsheet_start_index";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "flowsheet_end_index";