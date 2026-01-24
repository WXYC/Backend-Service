CREATE TABLE "wxyc_schema"."tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer,
	"discogs_release_id" integer,
	"position" varchar(16),
	"title" varchar(256) NOT NULL,
	"duration" varchar(16),
	"artist_name" varchar(128),
	"album_title" varchar(128),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."tracks" ADD CONSTRAINT "tracks_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracks_title_trgm_idx" ON "wxyc_schema"."tracks" USING gin (title gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "tracks_album_id_idx" ON "wxyc_schema"."tracks" USING btree ("album_id");
