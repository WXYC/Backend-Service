CREATE TABLE IF NOT EXISTS "wxyc_schema"."show_djs" (
	"id" serial PRIMARY KEY NOT NULL,
	"show_id" integer NOT NULL,
	"dj_id" integer NOT NULL,
	"active" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_show_id_shows_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_dj_id2_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_dj_id3_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD COLUMN "dj_name" varchar;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "flowsheet_start_index" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "flowsheet_end_index" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_flowsheet_start_index_flowsheet_id_fk" FOREIGN KEY ("flowsheet_start_index") REFERENCES "wxyc_schema"."flowsheet"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_flowsheet_end_index_flowsheet_id_fk" FOREIGN KEY ("flowsheet_end_index") REFERENCES "wxyc_schema"."flowsheet"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" DROP COLUMN IF EXISTS "show_id";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "dj_id";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "dj_id2";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP COLUMN IF EXISTS "dj_id3";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_dj_id_djs_id_fk" FOREIGN KEY ("dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
