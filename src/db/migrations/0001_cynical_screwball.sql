CREATE TABLE IF NOT EXISTS "wxyc_schema"."schedule" (
	"day" smallint NOT NULL,
	"start_time" time NOT NULL,
	"show_duration" smallint NOT NULL,
	"specialty_id" integer NOT NULL,
	"assigned_dj_id" integer,
	"assiged_dj_id2" integer,
	"cover_dj_id" integer,
	"needs_cover" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD COLUMN "shows_covered" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id_djs_id_fk" FOREIGN KEY ("assigned_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assiged_dj_id2_djs_id_fk" FOREIGN KEY ("assiged_dj_id2") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_cover_dj_id_djs_id_fk" FOREIGN KEY ("cover_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
