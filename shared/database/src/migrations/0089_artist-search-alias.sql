-- @no-precondition-needed: fresh CREATE TABLE; no FK from existing data. The two
--   FKs (artist_id, related_artist_id) target wxyc_schema.artists but the table
--   is empty at ADD CONSTRAINT time. The view replacement is additive (a single
--   new column projection) and invisible to existing consumers.
-- 0089 — Artist Search Alias cache for alias-aware catalog search.
--
-- Source-of-truth: WXYC/Backend-Service/docs/adr/0001-source-agnostic-artist-search-alias.md
-- See WXYC/Backend-Service/CONTEXT.md for "Artist Search Alias" definition.
--
-- One polymorphic table; `source` column tags origin. Future sources
-- (musicbrainz_alias, wikidata_label, etc.) are additive — no schema migration.
-- Keyed on WXYC `artists.id`; mirrors the post-#800 `library_identity`
-- convention (BS owns its key-space; external IDs are audit columns, not
-- join columns).
--
-- Also extends `library_artist_view` to project `library.artist_id`. The
-- additive column is needed by PR 5's `LATERAL JOIN artist_search_alias asa
-- ON asa.artist_id = lav.artist_id` and is invisible to existing view
-- consumers (every one of them names columns explicitly; none use SELECT *).
CREATE TABLE "wxyc_schema"."artist_search_alias" (
	"artist_id" integer NOT NULL,
	"source" text NOT NULL,
	"variant" text NOT NULL,
	"related_artist_id" integer,
	"external_subject_id" text,
	"external_object_id" text,
	"active" boolean,
	"method" text NOT NULL,
	"confidence" real NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	CONSTRAINT "artist_search_alias_pkey" PRIMARY KEY("artist_id","source","variant"),
	CONSTRAINT "artist_search_alias_confidence_range" CHECK ("wxyc_schema"."artist_search_alias"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "artist_search_alias_variant_nonblank" CHECK (length(trim("wxyc_schema"."artist_search_alias"."variant")) > 0)
);
--> statement-breakpoint
DROP VIEW "wxyc_schema"."library_artist_view";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_search_alias" ADD CONSTRAINT "artist_search_alias_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_search_alias" ADD CONSTRAINT "artist_search_alias_related_artist_id_artists_id_fk" FOREIGN KEY ("related_artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artist_search_alias_variant_trgm_idx" ON "wxyc_schema"."artist_search_alias" USING gin ("variant" gin_trgm_ops);--> statement-breakpoint
CREATE VIEW "wxyc_schema"."library_artist_view" AS (select "wxyc_schema"."library"."id", "wxyc_schema"."artists"."code_letters", "wxyc_schema"."genre_artist_crossreference"."artist_genre_code", "wxyc_schema"."library"."code_number", "wxyc_schema"."artists"."artist_name", "wxyc_schema"."artists"."alphabetical_name", "wxyc_schema"."library"."album_title", "wxyc_schema"."format"."format_name", "wxyc_schema"."genres"."genre_name", "wxyc_schema"."rotation"."rotation_bin", "wxyc_schema"."library"."add_date", "wxyc_schema"."library"."label", "wxyc_schema"."library"."label_id", "wxyc_schema"."library"."on_streaming", "wxyc_schema"."library"."album_artist", "wxyc_schema"."library"."plays", "wxyc_schema"."library"."artwork_url", "wxyc_schema"."artists"."discogs_artist_id", "wxyc_schema"."artists"."musicbrainz_artist_id", "wxyc_schema"."artists"."wikidata_qid", "wxyc_schema"."artists"."spotify_artist_id", "wxyc_schema"."artists"."apple_music_artist_id", "wxyc_schema"."artists"."bandcamp_id", "wxyc_schema"."library"."artist_id" from "wxyc_schema"."library" inner join "wxyc_schema"."artists" on "wxyc_schema"."artists"."id" = "wxyc_schema"."library"."artist_id" inner join "wxyc_schema"."format" on "wxyc_schema"."format"."id" = "wxyc_schema"."library"."format_id" inner join "wxyc_schema"."genres" on "wxyc_schema"."genres"."id" = "wxyc_schema"."library"."genre_id" inner join "wxyc_schema"."genre_artist_crossreference" on ("wxyc_schema"."genre_artist_crossreference"."artist_id" = "wxyc_schema"."library"."artist_id" and "wxyc_schema"."genre_artist_crossreference"."genre_id" = "wxyc_schema"."library"."genre_id") left join "wxyc_schema"."rotation" on "wxyc_schema"."rotation"."album_id" = "wxyc_schema"."library"."id" AND ("wxyc_schema"."rotation"."kill_date" > CURRENT_DATE OR "wxyc_schema"."rotation"."kill_date" IS NULL));