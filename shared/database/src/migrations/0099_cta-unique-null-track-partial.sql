-- BS#1135. Add a partial unique index that closes the
-- `(library_id, artist_name, NULL track_title)` duplicate loophole in
-- `wxyc_schema.compilation_track_artist`.
--
-- Background: Postgres treats NULLs as distinct in unique B-tree
-- comparisons by default, so the existing 0037 `cta_unique_idx` on
-- `(library_id, artist_name, track_title)` never blocked the case where
-- two rows share `(library_id, artist_name)` and both have NULL
-- `track_title`. `track_title` is nullable in `schema.ts` and stays
-- nullable — ETL writes with no track title are legitimate domain state,
-- not a sentinel-empty.
--
-- PG-version constraint: prod RDS runs PostgreSQL 14.22 (verified via
-- the migrate-dryrun job's `aws rds describe-db-instances` output). The
-- `NULLS NOT DISTINCT` modifier on `CREATE UNIQUE INDEX` is PG15+, so
-- it's unavailable here. The dev docker-compose pin (`postgres:18.0-alpine`)
-- is unrelated to the prod runtime — prod parity bites at deploy time.
--
-- Fix shape: an additional partial unique index restricted to the NULL
-- slice. The existing `cta_unique_idx` continues to enforce uniqueness
-- across all three columns when `track_title` is non-NULL (Postgres
-- includes non-NULL rows in unique comparisons normally); the new
-- `cta_unique_null_track_idx` covers the complementary `track_title IS
-- NULL` slice on `(library_id, artist_name)` so duplicate-null pairs
-- are rejected too. The pair together enforces the full intended
-- semantics on PG 14, and is forward-compatible with PG 15+ should we
-- upgrade later — the partial index can be dropped and the base index
-- rebuilt with `NULLS NOT DISTINCT` in a follow-up migration if we want
-- to consolidate.
--
-- Why not the COALESCE-expression form: a functional unique index on
-- `(library_id, artist_name, COALESCE(track_title, ''))` would also work
-- on PG 14, but requires DROP+CREATE of the existing index, mixes
-- nullable + non-nullable semantics in one object, and is harder for
-- `pg_stat_user_indexes` / planner output to reason about. The partial
-- index is purely additive — it doesn't touch the 0037 index — which
-- minimises the apply blast radius.
--
-- Production ops:
--   - This migration is additive only. The 0037 `cta_unique_idx` stays
--     in place exactly as is; no DROP, no rebuild, no lock on existing
--     rows beyond the new partial index's catalog/build window.
--   - The partial index covers only `track_title IS NULL` rows. The
--     prod table size for that slice is small (low-thousands of rows
--     in total, of which the NULL slice is a fraction), so the build
--     window is sub-second on prod hardware.
--   - The precondition guard below counts duplicate
--     `(library_id, artist_name)` groups already present with NULL
--     `track_title`. A 2026-06-13 prod audit returned 0 duplicates, so
--     the index builds cleanly. If a future audit finds duplicates,
--     the guard fails fast with a readable message inside the
--     migration's transaction — same pattern as 0071.
--   - The `CREATE UNIQUE INDEX` is NOT `CONCURRENTLY` because Drizzle
--     wraps each migration file in a transaction (`CREATE INDEX
--     CONCURRENTLY cannot run inside a transaction block`). On the
--     small NULL-track slice the ShareLock window is acceptable; if
--     the slice ever grows materially, the runbook is to build the
--     index out-of-band with `CONCURRENTLY` first and then merge a
--     follow-up that adds `IF NOT EXISTS` to make this migration a
--     no-op against prod.

-- Precondition guard (issue #705). Refuse to apply if any
-- (library_id, artist_name) group already has >1 row with NULL
-- track_title — the new index would fail mid-build and wedge the deploy.

DO $$
DECLARE dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT library_id, artist_name
    FROM wxyc_schema.compilation_track_artist
    WHERE track_title IS NULL
    GROUP BY library_id, artist_name
    HAVING COUNT(*) > 1
  ) g;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply cta_unique_null_track_idx: % duplicate (library_id, artist_name) groups remain with NULL track_title. Dedupe required before retry.', dup_count;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX "cta_unique_null_track_idx" ON "wxyc_schema"."compilation_track_artist" USING btree ("library_id","artist_name") WHERE "wxyc_schema"."compilation_track_artist"."track_title" IS NULL;
