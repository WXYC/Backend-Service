-- 0131 add `rotation.discogs_release_id_resolve_attempted_at` (BS#1813).
-- Nullable attempt-at marker for the now-recurring rotation release-id
-- resolver. Stamped when LML returns a definitive response (trusted direct
-- match, no match, trust-gated fallback, or rejected sentinel) and left NULL on
-- transient LML errors, so the cron can retry failures immediately while
-- suppressing the permanent no-match/trust-rejected tail inside the TTL window.
--
-- DDL-only, additive, nullable -> no table rewrite, no backfill. Rotation is a
-- small table; no index is needed for the active-row scan.
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "discogs_release_id_resolve_attempted_at" timestamp with time zone;
