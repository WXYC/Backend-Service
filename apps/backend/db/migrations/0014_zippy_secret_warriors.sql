CREATE TABLE IF NOT EXISTS "wxyc_schema"."show_djs" (
	"show_id" integer NOT NULL,
	"dj_id" integer NOT NULL,
	"time_joined" timestamp,
	"time_left" timestamp
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_dj_id2_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_dj_id3_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "show_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "track_title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "album_title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "artist_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."djs" ADD COLUMN "dj_name" varchar;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "primary_dj_id" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_djs_id_fk" FOREIGN KEY ("primary_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
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
