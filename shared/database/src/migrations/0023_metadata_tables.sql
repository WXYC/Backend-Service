CREATE TABLE "wxyc_schema"."album_metadata" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer,
	"cache_key" varchar(512),
	"discogs_release_id" integer,
	"discogs_url" varchar(512),
	"release_year" smallint,
	"artwork_url" varchar(512),
	"spotify_url" varchar(512),
	"apple_music_url" varchar(512),
	"youtube_music_url" varchar(512),
	"bandcamp_url" varchar(512),
	"soundcloud_url" varchar(512),
	"is_rotation" boolean DEFAULT false NOT NULL,
	"last_accessed" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "album_metadata_album_id_unique" UNIQUE("album_id"),
	CONSTRAINT "album_metadata_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
CREATE TABLE "wxyc_schema"."artist_metadata" (
	"id" serial PRIMARY KEY NOT NULL,
	"artist_id" integer,
	"cache_key" varchar(256),
	"discogs_artist_id" integer,
	"bio" text,
	"wikipedia_url" varchar(512),
	"last_accessed" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "artist_metadata_artist_id_unique" UNIQUE("artist_id"),
	CONSTRAINT "artist_metadata_cache_key_unique" UNIQUE("cache_key")
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_metadata" ADD CONSTRAINT "album_metadata_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_metadata" ADD CONSTRAINT "artist_metadata_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "album_metadata_album_id_idx" ON "wxyc_schema"."album_metadata" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "album_metadata_cache_key_idx" ON "wxyc_schema"."album_metadata" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "album_metadata_last_accessed_idx" ON "wxyc_schema"."album_metadata" USING btree ("last_accessed");--> statement-breakpoint
CREATE INDEX "artist_metadata_artist_id_idx" ON "wxyc_schema"."artist_metadata" USING btree ("artist_id");--> statement-breakpoint
CREATE INDEX "artist_metadata_cache_key_idx" ON "wxyc_schema"."artist_metadata" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "artist_metadata_last_accessed_idx" ON "wxyc_schema"."artist_metadata" USING btree ("last_accessed");