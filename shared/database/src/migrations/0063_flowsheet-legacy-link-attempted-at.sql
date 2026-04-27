-- B-0.5 marker column: stamp rows where the legacy_release_id → library.id
-- FK resolver ran but could not link.
--
-- Background: 292K of 1.18M unlinked flowsheet rows have a non-null
-- legacy_release_id whose value isn't present in library.legacy_release_id
-- (rows deleted or rewritten in tubafrenzy after the ETL ran). Re-running the
-- resolver picks up some on every cron tick — but the residual is permanent
-- and has to fall through to LML in B-2.2.
--
-- B-2.2's backfill needs a single predicate to grab both the 889K
-- never-had-legacy-id rows and the broken-FK residual. With this column the
-- query is:
--   WHERE album_id IS NULL
--     AND (legacy_release_id IS NULL OR legacy_link_attempted_at IS NOT NULL)
--
-- The B-0.5 recovery job (jobs/broken-fk-recovery) runs as a one-shot deploy
-- after this DDL ships. It re-runs the legacy-FK resolver, then UPDATEs
-- legacy_link_attempted_at = now() on the rows that still didn't link.
--
-- DDL-only — no in-migration UPDATE. ALTER TABLE ADD COLUMN of a nullable
-- column is metadata-only and instant on PostgreSQL 11+, regardless of
-- table size. Same hard-won pattern as 0053 (see issue #511).

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "legacy_link_attempted_at" timestamp with time zone;
