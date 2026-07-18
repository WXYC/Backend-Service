-- 0122 artist-level affinity-neighbor cache: artist_similar_artists (BS#1626,
-- On Tour R3b).
--
-- The artist analog of `artist_metadata` (0121), but keyed on the LIBRARY
-- artist id (`artists.id`, a real FK with ON DELETE CASCADE) rather than a bare
-- external Discogs id: the semantic-index affinity graph is built from the WXYC
-- library, so only IN-LIBRARY headliners (`concerts.headlining_artist_id IS NOT
-- NULL`) have a neighbor list. `neighbors` is an ordered `jsonb` array of
-- `{artist_id, weight}` (weight desc) — the exact `Concert.similar_artists` wire
-- shape (wxyc-shared#222) that `GET /concerts` projects via a null-safe LEFT
-- JOIN on `headlining_artist_id`.
--
-- Population: `jobs/concerts-similar-artists-enrichment/` (nightly, chained
-- after the artist resolvers + 05:45 genre enrichment; schedule `55 5 * * *`
-- UTC). Unlike genres (static Discogs data), affinity neighbors are recomputed
-- on every semantic-index graph rebuild, so the job re-fetches the entire
-- upcoming curated in-library cohort every night and OVERWRITES
-- (`ON CONFLICT (artist_id) DO UPDATE`) — keeping neighbors current with the
-- graph. A null-wipe guard aborts the write when a whole sweep comes back empty
-- (mapping not yet rebuilt) rather than clearing collected rows.
--
-- Lock behavior: single fresh CREATE TABLE + one FK ADD CONSTRAINT — no lock on
-- any existing table, no rows rewritten (DDL-only).
-- @no-precondition-needed: the FK lands on a brand-new empty table with no rows to violate it, and `artists` is only referenced (never rewritten).
CREATE TABLE "wxyc_schema"."artist_similar_artists" (
	"artist_id" integer PRIMARY KEY NOT NULL,
	"neighbors" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."artist_similar_artists" ADD CONSTRAINT "artist_similar_artists_artist_id_artists_id_fk" FOREIGN KEY ("artist_id") REFERENCES "wxyc_schema"."artists"("id") ON DELETE cascade ON UPDATE no action;