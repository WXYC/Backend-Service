-- 0087 add `rotation.tracklist_lookup_attempted_at`
-- Survives-restart marker for the tier-3 LML picker cascade's negative outcome.
-- Stamped by `resolveRotationDiscogsReleaseViaLml` when the cascade returns
-- nothing; read by `resolveRotationPickerSource` to skip the LML call within
-- ROTATION_TRACKLIST_LOOKUP_NEGATIVE_WINDOW_MS of the last attempt. Parallels
-- `flowsheet.metadata_attempt_at` (migration 0069 / #639) — same shape, same
-- ".catch leaves it NULL" retry contract. NULL on all existing rows; the
-- ADD COLUMN takes a brief AccessExclusiveLock (~ms on rotation's ~few-k rows)
-- with the PG11+ attmissingval virtual default, no rewrite. No precondition
-- guard: the column is nullable, no constraint added.

ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "tracklist_lookup_attempted_at" timestamp with time zone;
