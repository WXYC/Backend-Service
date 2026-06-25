-- 0106 flowsheet_freetext_resolution (BS#1491 / catalog-popularity Phase-2 Track 1)
--
-- Cache of free-text (artist, album) -> Discogs release+master resolutions for
-- the ~43% of music plays with flowsheet.album_id IS NULL. One row per
-- normalized (norm_artist, norm_album) pair (composite PK); many flowsheet
-- play rows map to one resolution row. Populated by the recurring cron
-- jobs/catalog-popularity-freetext-resolve/ via LML bulkLookupMetadata; read
-- by the Phase-2 popularity collapse (Track 2).
--
-- attempt_at is an attempt-at marker (docs/migrations.md "Attempt-at markers"):
-- stamped on a responded outcome (match OR explicit no-match), left NULL on
-- transient LML failure so the row stays retryable. discogs_master_id stays
-- NULL until LML Track 0 surfaces master_id; Track 1's release leg is
-- independent.
--
-- Fresh table, no constraint over existing data -> no precondition guard
-- needed. DDL-only; takes a brief AccessExclusiveLock on a table that does not
-- yet exist, so no live-traffic impact.

CREATE TABLE "wxyc_schema"."flowsheet_freetext_resolution" (
	"norm_artist" text NOT NULL,
	"norm_album" text NOT NULL,
	"discogs_release_id" integer,
	"discogs_master_id" integer,
	"match_confidence" real,
	"match_source" text,
	"attempt_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "flowsheet_freetext_resolution_norm_artist_norm_album_pk" PRIMARY KEY("norm_artist","norm_album")
);
