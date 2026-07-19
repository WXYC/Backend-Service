-- 0124 discogs-keyed affinity-neighbor cache: discogs_artist_similar_artists
-- (BS#1701, On Tour For You — extend similar-artists beyond the WXYC library).
--
-- The DISCOGS lane sibling of `artist_similar_artists` (0122): same
-- `{artist_id, weight}` jsonb neighbor array, but keyed on a BARE external
-- Discogs artist id (PRIMARY KEY, no FK — same modelling choice as
-- `artist_metadata` (0121) and `concerts.headlining_discogs_artist_id`), because
-- the touring artists this lane covers are largely absent from the WXYC
-- `artists` table and so have no `artists.id` to key the library lane on. A
-- single Discogs-keyed table can't replace the library lane: 23 of 38
-- currently-covered in-library headliners carry a NULL `artists.discogs_artist_id`
-- and would be dropped. Hence two lanes, partitioned by cohort.
--
-- `neighbors` holds WXYC catalog artist ids in BOTH lanes (semantic-index
-- returns library-code neighbors regardless of the lookup key), so `GET /concerts`
-- COALESCEs `artist_similar_artists.neighbors` (library lane) over this table's
-- via a null-safe LEFT JOIN on `COALESCE(headlining_discogs_artist_id,
-- artists.discogs_artist_id)`.
--
-- Population: `jobs/concerts-similar-artists-enrichment/` discogs lane (nightly).
-- Same OVERWRITE (`ON CONFLICT (discogs_artist_id) DO UPDATE`) refresh policy as
-- the library lane — affinity neighbors are recomputed on every semantic-index
-- graph rebuild — with the same null-wipe guard against clearing collected rows.
--
-- Lock behavior: single fresh CREATE TABLE, no FK — no lock on any existing
-- table, no rows rewritten (DDL-only).
-- @no-precondition-needed: a bare-PK CREATE TABLE on a brand-new empty table references nothing and rewrites no rows.
CREATE TABLE "wxyc_schema"."discogs_artist_similar_artists" (
	"discogs_artist_id" integer PRIMARY KEY NOT NULL,
	"neighbors" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
