-- 0107 album_popularity (BS#1486 / catalog-popularity Phase-2 Track 2 / #1492)
--
-- Attribution-corrected, master-collapsed catalog popularity. One row per
-- logical album keyed by logical_album_key (master:<id> | release:<id> |
-- library:<id>); plays = linked_plays + freetext_plays. Created EMPTY here and
-- rebuilt on a cadence by apps/backend/services/album-popularity-refresh.service.ts
-- (the free-text leg needs TS-side normalization an MV cannot express, hence a
-- plain table). Full design in the schema.ts doc comment on `album_popularity`.
-- Track 3 (#1493) joins it by logical_album_key (the PK), so no extra index.
--
-- @no-precondition-needed: fresh empty table — the PRIMARY KEY / NOT NULL
-- constraints apply over zero existing rows, so no data invariant can be
-- violated at apply time. The refresh service populates the table post-deploy;
-- it reads flowsheet_freetext_resolution (Track 1 / 0106) at runtime but builds
-- no rows in this migration, so there is nothing to gate on Track 1's backfill
-- here.
--
-- DDL-only; CREATE TABLE takes a brief AccessExclusiveLock on a table that does
-- not yet exist, so there is no live-traffic impact.

CREATE TABLE "wxyc_schema"."album_popularity" (
	"logical_album_key" text PRIMARY KEY NOT NULL,
	"plays" integer NOT NULL,
	"linked_plays" integer DEFAULT 0 NOT NULL,
	"freetext_plays" integer DEFAULT 0 NOT NULL,
	"representative_library_id" integer
);
