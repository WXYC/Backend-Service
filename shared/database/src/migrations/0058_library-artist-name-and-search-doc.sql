-- Denormalize artist_name onto library and add a STORED tsvector search_doc
-- (Epic A.1). The cross-table OR predicate in the existing catalog search
-- path prevents the planner from using either trigram GIN index, leading to
-- 100-200ms median per query. With both searchable columns living on the
-- same table, the new search_doc index can power a sub-1ms tsvector path
-- (see Epic A #483 for the full plan).
--
-- Order of operations across Epic A:
--   A.1 (this migration): add artist_name + search_doc + indexes (nullable).
--   A.2 (backfill job):   populate library.artist_name from the artists join.
--   A.3 (live writes):    addAlbum writes artist_name; cascade on artists UPDATE.
--   A.4 (parallel):       album_plays materialized view + scheduled refresh.
--   A.5 (service):        route Both-mode search through tsvector + plays.
--
-- Production note: ALTER TABLE ADD COLUMN of a nullable column is
-- metadata-only and instant. The STORED generated column is computed for
-- every row when added (an ACCESS EXCLUSIVE lock is held for the duration
-- of the rewrite); on the 64K-row library this is fast — well under the
-- lock-budget that wedged migration 0053 (see issue #511). search_doc will
-- be NULL-equivalent (an empty tsvector with album_title weight) until A.2
-- populates artist_name; A.5 won't read this index until then.
--
-- The backfill (A.2) lives in jobs/<name>-backfill and runs as a separate
-- one-shot deploy. This migration is DDL-only — no in-migration UPDATE.

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "artist_name" varchar(128);--> statement-breakpoint

ALTER TABLE "wxyc_schema"."library"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("album_title", '')), 'B')
  ) STORED;--> statement-breakpoint

CREATE INDEX "library_search_doc_idx"
  ON "wxyc_schema"."library" USING gin ("search_doc");--> statement-breakpoint

CREATE INDEX "library_artist_name_trgm_idx"
  ON "wxyc_schema"."library" USING gin ("artist_name" gin_trgm_ops);
