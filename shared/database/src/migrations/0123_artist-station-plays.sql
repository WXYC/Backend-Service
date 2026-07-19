-- 0123 artist-level station-affinity play-count cache: artist_station_plays
-- (BS#1702, On Tour "For You" station-affinity tier).
--
-- The all-time WXYC flowsheet play count (`semantic-index artist.total_plays`)
-- of an IN-LIBRARY headliner, keyed on the LIBRARY artist id (`artists.id`, a
-- real FK with ON DELETE CASCADE) exactly like `artist_similar_artists`
-- (migration 0122). The absolute count is the cold-start station-affinity
-- signal the On Tour "For You" shelf ranks by; `GET /concerts` projects it as
-- `Concert.station_plays` via a null-safe LEFT JOIN on `headlining_artist_id`.
--
-- SIBLING table, not a column on `artist_similar_artists`, on purpose: that
-- table's DELETE-on-empty-neighbors lifecycle would drop the count for a
-- heavily-played artist with no affinity neighbors — precisely the card this
-- feature surfaces. Population: `jobs/concerts-similar-artists-enrichment/`
-- reads the `source_plays` map off the same nightly `neighbors/batch` call
-- (semantic-index#369) and UPSERTs here. UPSERT-only, no DELETE (unlike the
-- neighbors writer): a stale row for an artist no longer touring is harmless
-- (no upcoming concert joins it) and `total_plays` drifts slowly.
--
-- Lock behavior: single fresh CREATE TABLE + one FK ADD CONSTRAINT — no lock on
-- any existing table, no rows rewritten (DDL-only).
-- @no-precondition-needed: fresh empty table, no existing rows can violate the FK
CREATE TABLE "wxyc_schema"."artist_station_plays" (
	"artist_id" integer PRIMARY KEY NOT NULL,
	"plays" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_station_plays" ADD CONSTRAINT "artist_station_plays_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE cascade ON UPDATE no action;