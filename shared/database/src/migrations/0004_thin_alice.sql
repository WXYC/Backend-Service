ALTER TABLE "wxyc_schema"."artists" ADD COLUMN "genre_id" integer NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wxyc_schema"."artists" ADD CONSTRAINT "artists_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
