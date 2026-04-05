-- Add comment column to artist_library_crossreference (release cross-references)
ALTER TABLE "wxyc_schema"."artist_library_crossreference" ADD COLUMN "comment" varchar(255);--> statement-breakpoint

-- Create artist_crossreference table (artist-to-artist links: aliases, side projects, related artists)
CREATE TABLE IF NOT EXISTS "wxyc_schema"."artist_crossreference" (
  "source_artist_id" integer NOT NULL,
  "target_artist_id" integer NOT NULL,
  "comment" varchar(255),
  CONSTRAINT "artist_crossreference_source_artist_id_artists_id_fk" FOREIGN KEY ("source_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "artist_crossreference_target_artist_id_artists_id_fk" FOREIGN KEY ("target_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artist_crossref_source_target" ON "wxyc_schema"."artist_crossreference" USING btree ("source_artist_id","target_artist_id");
