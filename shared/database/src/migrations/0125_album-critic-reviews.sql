-- 0125 external critic-review snippets: album_critic_reviews
-- (album-critic-reviews slice, ADR 0012).
--
-- Short attributed excerpts from external music-critic reviews, keyed by
-- library.id (the same album key the /proxy/metadata/album serve path
-- already resolves). The 4th distinct "review" concept in the schema —
-- distinct from `reviews` (legacy), `album_review_submissions` (DJ-authored
-- archive, ADR 0011), and the `AlbumReview` DTO. `snippet` is capped at 512
-- chars (writer trims to <=300 for fair-use); `(album_id, source_url)` is the
-- UPSERT conflict target. Creates a fresh table + FK + UNIQUE index against
-- no existing table, no rows rewritten (DDL-only).
-- @no-precondition-needed: fresh empty table, no existing rows can violate the FK or UNIQUE index
CREATE TABLE "wxyc_schema"."album_critic_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"album_id" integer NOT NULL,
	"source" text NOT NULL,
	"source_url" varchar(1024) NOT NULL,
	"snippet" varchar(512) NOT NULL,
	"author" varchar(128),
	"published_at" date,
	"rating" varchar(32),
	"discogs_release_id" integer,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_modified" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."album_critic_reviews" ADD CONSTRAINT "album_critic_reviews_album_id_library_id_fk" FOREIGN KEY ("album_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "album_critic_reviews_album_id_source_url_uq" ON "wxyc_schema"."album_critic_reviews" USING btree ("album_id","source_url");