ALTER TABLE "wxyc_schema"."schedule" RENAME COLUMN "assiged_dj_id2" TO "assigned_dj_id2";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT "schedule_assiged_dj_id2_djs_id_fk";
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id2_djs_id_fk" FOREIGN KEY ("assigned_dj_id2") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
