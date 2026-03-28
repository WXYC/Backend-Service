CREATE TABLE "wxyc_schema"."artist_crossreference" (
	"source_artist_id" integer NOT NULL,
	"target_artist_id" integer NOT NULL,
	"comment" varchar(255)
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ALTER COLUMN "artist_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ALTER COLUMN "library_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ADD COLUMN "comment" varchar(255);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_crossreference" ADD CONSTRAINT "artist_crossreference_source_artist_id_artists_id_fk" FOREIGN KEY ("source_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_crossreference" ADD CONSTRAINT "artist_crossreference_target_artist_id_artists_id_fk" FOREIGN KEY ("target_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artist_crossref_source_target" ON "wxyc_schema"."artist_crossreference" USING btree ("source_artist_id","target_artist_id");