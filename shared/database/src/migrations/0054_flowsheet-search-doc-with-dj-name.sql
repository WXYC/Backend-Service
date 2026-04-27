-- Switch search reads to flowsheet.dj_name (step 5b.3).
--
-- The original version of this migration carried a precondition guard
-- (DO $$ ... RAISE EXCEPTION when any track row has dj_name IS NULL) so
-- it would refuse to run before the dj_name backfill completed. The guard
-- was correct in spirit but blocked the deploy chain when the backfill
-- itself ran into the bloated-table I/O problem from incident #511 — see
-- the back-and-forth in #511 for the operational dead-end.
--
-- Removing the guard makes 0054 apply unconditionally. Legacy track rows
-- that still have dj_name IS NULL get an empty dj-name term in the new
-- search_doc tsvector, so search just doesn't match dj-name queries for
-- those rows. The search service in apps/backend uses
-- COALESCE(flowsheet.dj_name, 'Unknown DJ') for display, so users see
-- "Unknown DJ" rather than a NULL or crash.
--
-- The backfill (jobs/flowsheet-dj-name-backfill) still needs to run; once
-- it does, the dj_name UPDATE recomputes the search_doc generated column
-- (dj_name is in the expression) and dj-name search becomes correct for
-- legacy rows. Run during a low-traffic window after this deploys.
--
-- Now that 5b.1 backfilled and 5b.2 keeps flowsheet.dj_name current on every
-- insert, the search service can read the column directly. This migration:
--
--   1. Recreates the search_doc tsvector to include dj_name with weight band
--      'B' (alongside track_title), so dj-name terms in bare 'all' queries
--      match through the existing tsvector path. Postgres does not allow
--      modifying the generation expression of an existing generated column,
--      so the column has to be dropped and re-added.
--
--   2. Adds a GIN trigram index on flowsheet.dj_name to support the dj:
--      ILIKE filter (and the dj: exact-match equality). This replaces the
--      three trigram indexes from 0051 that supported the OR-decomposition
--      across user.djName, user.name, and shows.legacy_dj_name.
--
--   3. Drops the now-unused trigram indexes from 0051. Search no longer
--      joins through shows or auth_user, so the per-column indexes on those
--      tables are dead weight.
--
-- Production note: the DROP COLUMN + ADD COLUMN sequence rewrites every
-- flowsheet row to recompute the tsvector under an ACCESS EXCLUSIVE lock.
-- This is the same lock window as the original migration 0052; apply during
-- a low-traffic window.

ALTER TABLE "wxyc_schema"."flowsheet"
  DROP COLUMN "search_doc";--> statement-breakpoint

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("track_title", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("dj_name", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("album_title", '')), 'C') ||
    setweight(to_tsvector('simple', coalesce("record_label", '')), 'D')
  ) STORED;--> statement-breakpoint

CREATE INDEX "flowsheet_search_doc_idx"
  ON "wxyc_schema"."flowsheet" USING gin ("search_doc");--> statement-breakpoint

CREATE INDEX "flowsheet_dj_name_trgm_idx"
  ON "wxyc_schema"."flowsheet" USING gin ("dj_name" gin_trgm_ops);--> statement-breakpoint

DROP INDEX IF EXISTS "auth_user_dj_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "auth_user_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "wxyc_schema"."shows_legacy_dj_name_trgm_idx";
