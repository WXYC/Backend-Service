CREATE TABLE "wxyc_schema"."artist_library_crossreference" (
	"artist_id" integer,
	"library_id" integer
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."genre_artist_crossreference" (
	"artist_id" integer NOT NULL,
	"genre_id" integer NOT NULL,
	"artist_genre_code" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ADD CONSTRAINT "artist_library_crossreference_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ADD CONSTRAINT "artist_library_crossreference_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."genre_artist_crossreference" ADD CONSTRAINT "genre_artist_crossreference_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."genre_artist_crossreference" ADD CONSTRAINT "genre_artist_crossreference_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "wxyc_schema"."genres"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_id_artist_id" ON "wxyc_schema"."artist_library_crossreference" USING btree ("artist_id","library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artist_genre_key" ON "wxyc_schema"."genre_artist_crossreference" USING btree ("artist_id","genre_id");