-- Rotation ETL support: enable syncing rotation releases from tubafrenzy.
--
-- Adds deduplication key (legacy_rotation_id), deferred album resolution
-- (legacy_library_release_id), denormalized display fields for uncataloged
-- releases, and the 'N' (New) rotation type.

-- Add 'N' to freq_enum for tubafrenzy's "New" rotation type
ALTER TYPE "freq_enum" ADD VALUE IF NOT EXISTS 'N';--> statement-breakpoint

-- Make album_id nullable so uncataloged rotation releases can be imported.
-- Existing views (rotation_library_view, getRotationFromDB) use INNER JOIN
-- on album_id, so null rows are excluded automatically.
ALTER TABLE "wxyc_schema"."rotation" ALTER COLUMN "album_id" DROP NOT NULL;--> statement-breakpoint

-- Deduplication key mapping tubafrenzy ROTATION_RELEASE.ID
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "legacy_rotation_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rotation_legacy_rotation_id_idx" ON "wxyc_schema"."rotation" USING btree ("legacy_rotation_id");--> statement-breakpoint

-- Stores tubafrenzy LIBRARY_RELEASE_ID for deferred album_id resolution
-- (same pattern as flowsheet.legacy_release_id)
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "legacy_library_release_id" integer;--> statement-breakpoint

-- Denormalized display fields for uncataloged releases (album_id IS NULL).
-- Cleared when album_id is resolved via resolveAlbumIds().
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "artist_name" varchar(128);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "album_title" varchar(128);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "record_label" varchar(128);
