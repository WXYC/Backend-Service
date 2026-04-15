CREATE TABLE "wxyc_schema"."compilation_track_artist" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"artist_name" varchar(255) NOT NULL,
	"track_title" varchar(255),
	"track_position" varchar(20)
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "date_lost" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "date_found" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."compilation_track_artist" ADD CONSTRAINT "compilation_track_artist_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cta_library_id_idx" ON "wxyc_schema"."compilation_track_artist" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "cta_artist_name_idx" ON "wxyc_schema"."compilation_track_artist" USING btree ("artist_name");--> statement-breakpoint
CREATE UNIQUE INDEX "cta_unique_idx" ON "wxyc_schema"."compilation_track_artist" USING btree ("library_id","artist_name","track_title");