-- 0121 artist-level metadata cache: artist_metadata (BS#1624, On Tour R2).
--
-- Creates the artist analog of `album_metadata`, keyed by a bare external
-- Discogs artist id (PRIMARY KEY, no FK — same modelling choice as
-- `album_metadata.discogs_artist_id` and `concerts.headlining_discogs_artist_id`,
-- because the touring artists the On Tour feature surfaces are largely absent
-- from the WXYC `artists` table). Seeded with Discogs `genres`/`styles`
-- (nullable `text[]`) that `GET /concerts` projects onto `Concert.genres`
-- (wxyc-shared#221) via a null-safe LEFT JOIN.
--
-- Population: `jobs/concerts-genre-enrichment/` (nightly, chained after the
-- artist resolvers) selects resolved headliners lacking an `artist_metadata`
-- row, calls LML's bulk artist-genres endpoint (LML#781), and UPSERTs
-- `ON CONFLICT DO NOTHING`. LML's `source` discriminator gates the write:
-- `unavailable` (couldn't reach Discogs — retry) is skipped so the artist
-- stays a candidate; `not_found`/`cache`/`discogs_api` persist a row (an empty
-- row for a genuine no-genre verdict is a real negative-cache). A one-time
-- deploy backfill (`--backfill`) front-fills existing resolved headliners;
-- re-runs are no-ops (candidate anti-join + DO NOTHING).
--
-- Lock behavior: single fresh CREATE TABLE — no lock on any existing table, no
-- rows rewritten (DDL-only). No precondition guard required: the PK lands on a
-- brand-new table with no rows to violate it (-- @no-precondition-needed).
CREATE TABLE "wxyc_schema"."artist_metadata" (
	"discogs_artist_id" integer PRIMARY KEY NOT NULL,
	"genres" text[],
	"styles" text[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
