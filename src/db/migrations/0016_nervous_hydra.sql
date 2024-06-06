ALTER TABLE "wxyc_schema"."artists" DROP CONSTRAINT "artists_genre_id_genres_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."bins" DROP CONSTRAINT "bins_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" DROP CONSTRAINT "flowsheet_show_id_shows_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" DROP CONSTRAINT "library_artist_id_artists_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."reviews" DROP CONSTRAINT "reviews_album_id_library_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" DROP CONSTRAINT "rotation_album_id_library_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."schedule" DROP CONSTRAINT "schedule_specialty_id_specialty_shows_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shift_covers" DROP CONSTRAINT "shift_covers_schedule_id_schedule_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."show_djs" DROP CONSTRAINT "show_djs_show_id_shows_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" DROP CONSTRAINT "shows_primary_dj_id_djs_id_fk";
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ALTER COLUMN "message" SET DATA TYPE varchar(250);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."artists" ADD CONSTRAINT "artists_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."bins" ADD CONSTRAINT "bins_dj_id_djs_id_fk" FOREIGN KEY ("dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."library" ADD CONSTRAINT "library_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."reviews" ADD CONSTRAINT "reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."schedule" ADD CONSTRAINT "schedule_specialty_id_specialty_shows_id_fk" FOREIGN KEY ("specialty_id") REFERENCES "wxyc_schema"."specialty_shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shift_covers" ADD CONSTRAINT "shift_covers_schedule_id_schedule_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "wxyc_schema"."schedule"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."show_djs" ADD CONSTRAINT "show_djs_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "wxyc_schema"."shows"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."shows" ADD CONSTRAINT "shows_primary_dj_id_djs_id_fk" FOREIGN KEY ("primary_dj_id") REFERENCES "wxyc_schema"."djs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
