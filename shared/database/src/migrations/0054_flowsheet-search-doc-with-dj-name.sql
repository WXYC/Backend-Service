-- Precondition: backfill must have populated dj_name on every track row.
--
-- 0054's DROP+ADD of search_doc rebuilds the tsvector for every flowsheet row.
-- If dj_name is NULL on any track row (because the backfill hasn't run yet),
-- the new search_doc has no dj-name terms for those rows — search would
-- silently lose dj-name matching for legacy entries until the next full row
-- rewrite. Block the migration loudly so the operator runs the backfill
-- (jobs/backfills/flowsheet-dj-name-backfill) first. See issue #511.
DO $$
BEGIN
  IF (
    SELECT count(*) FROM "wxyc_schema"."flowsheet"
    WHERE entry_type = 'track' AND dj_name IS NULL
  ) > 0 THEN
    RAISE EXCEPTION 'flowsheet.dj_name backfill incomplete; run jobs/backfills/flowsheet-dj-name-backfill before applying 0054';
  END IF;
END $$;--> statement-breakpoint

-- Switch search reads to flowsheet.dj_name (step 5b.3).
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
