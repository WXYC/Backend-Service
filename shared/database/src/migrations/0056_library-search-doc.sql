-- Denormalize artist_name onto library + add search_doc tsvector (A.1).
--
-- The catalog search currently OR's a trigram predicate across artists.artist_name
-- and library.album_title. Because the OR spans two tables, the planner can't
-- use either trigram GIN index and the predicate is evaluated as a join filter
-- after a merge join, costing 100-200ms per query on the production-clone
-- dataset. Putting both searchable columns on a single table -- and indexing
-- them together as a STORED tsvector -- collapses the hot path to sub-1ms.
--
-- Order of operations across Epic A:
--   A.1 (this migration): add the columns nullable + add indexes.
--   A.2: backfill library.artist_name from the artists join.
--   A.3: live writes -- addAlbum writes artist_name; cascade on artists rename.
--   A.4: album_plays materialized view + scheduled refresh.
--   A.5: service rewrite -- Both mode reads search_doc + ts_rank * ln(plays+1).
--
-- Production note: ALTER TABLE ADD COLUMN of a nullable varchar is metadata-only
-- and instant. The STORED tsvector column also adds without a row rewrite
-- because every existing row has artist_name = NULL, so the generated value is
-- a constant empty tsvector. The column will only be populated for rows that
-- A.2 backfills (and rows the live write path in A.3 inserts). The two GIN
-- index builds scan the full table; on the 64K-row staging library that is
-- under a second, but apply during a low-traffic window if production has
-- grown materially.

ALTER TABLE "wxyc_schema"."library" ADD COLUMN "artist_name" varchar(128);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library" ADD COLUMN "search_doc" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') || setweight(to_tsvector('simple', coalesce("album_title", '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "library_artist_name_trgm_idx" ON "wxyc_schema"."library" USING gin ("artist_name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "library_search_doc_idx" ON "wxyc_schema"."library" USING gin ("search_doc");
