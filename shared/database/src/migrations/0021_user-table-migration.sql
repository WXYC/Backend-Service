CREATE TABLE "wxyc_schema"."dj_stats" (
	"user_id" varchar(255) PRIMARY KEY NOT NULL,
	"shows_covered" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "wxyc_schema"."bins" DROP CONSTRAINT "bins_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT "schedule_assigned_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT "schedule_assigned_dj_id2_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" DROP CONSTRAINT "shift_covers_cover_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" DROP CONSTRAINT "show_djs_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_primary_dj_id_djs_id_fk";
--> statement-breakpoint
DROP TABLE "wxyc_schema"."djs" CASCADE;--> statement-breakpoint

ALTER TABLE "wxyc_schema"."bins" ALTER COLUMN "dj_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ALTER COLUMN "assigned_dj_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ALTER COLUMN "assigned_dj_id2" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" ALTER COLUMN "cover_dj_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" ALTER COLUMN "dj_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ALTER COLUMN "primary_dj_id" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."dj_stats" ADD CONSTRAINT "dj_stats_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_dj_id_auth_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id_auth_user_id_fk" FOREIGN KEY ("assigned_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_assigned_dj_id2_auth_user_id_fk" FOREIGN KEY ("assigned_dj_id2") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_cover_dj_id_auth_user_id_fk" FOREIGN KEY ("cover_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_dj_id_auth_user_id_fk" FOREIGN KEY ("dj_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_auth_user_id_fk" FOREIGN KEY ("primary_dj_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;