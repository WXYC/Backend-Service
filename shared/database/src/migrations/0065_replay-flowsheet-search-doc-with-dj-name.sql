-- 0065: Replay 0054's flowsheet.search_doc rewrite (the dj_name version).
--
-- 0054 was one of five migrations drizzle silently skipped over in
-- production after 0061 was originally committed with a far-future `when`
-- and jumped the migrator's "latest applied created_at" cursor. Four of
-- the five (0055/0056/0062/0063) have since been reapplied: their SQL
-- was hand-applied to prod and matching hashes inserted into
-- drizzle.__drizzle_migrations, then commit 82a0263 re-timestamped the
-- journal so 0061-0063 are properly monotonic again.
--
-- 0054 was deliberately left for a real migration to handle because it is
-- the one expensive change in the set: redefining the search_doc generated
-- column requires DROP COLUMN + ADD COLUMN, which evaluates the new
-- expression for every flowsheet row (~2.6M live rows on prod). The
-- AccessExclusiveLock that ALTER TABLE holds for the duration of that
-- rewrite is the rule CLAUDE.md spells out as "migrations are DDL-only,
-- no bulk DML"; we are knowingly making an exception because Postgres
-- has no way to redefine a generated column's expression in place. Apply
-- during a low-traffic window.
--
-- Idempotent against any partial-apply state:
--   - DROP COLUMN IF EXISTS handles search_doc never having been created
--     (or having been created with a different definition).
--   - ADD COLUMN can be unconditional because the previous statement
--     guarantees the column does not exist at this point.
--   - CREATE INDEX IF NOT EXISTS handles the case where the index was
--     already built by a successful local apply of 0054.
--   - DROP INDEX IF EXISTS handles the case where 0051's per-table
--     trigram indexes were already cleaned up.
--
-- statement_timeout=10min puts a hard cap on the rewrite. If it fails
-- under contention it surfaces a clear error in CI/migrate logs (the
-- behaviour we built into 0056 in #524) instead of timing out the
-- GitHub Actions runner silently.

SET LOCAL lock_timeout = '30s';--> statement-breakpoint
SET LOCAL statement_timeout = '10min';--> statement-breakpoint

ALTER TABLE "wxyc_schema"."flowsheet" DROP COLUMN IF EXISTS "search_doc";--> statement-breakpoint

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "search_doc" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("artist_name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("track_title", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("dj_name", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("album_title", '')), 'C') ||
    setweight(to_tsvector('simple', coalesce("record_label", '')), 'D')
  ) STORED;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "flowsheet_search_doc_idx"
  ON "wxyc_schema"."flowsheet" USING gin ("search_doc");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "flowsheet_dj_name_trgm_idx"
  ON "wxyc_schema"."flowsheet" USING gin ("dj_name" gin_trgm_ops);--> statement-breakpoint

DROP INDEX IF EXISTS "auth_user_dj_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "auth_user_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "wxyc_schema"."shows_legacy_dj_name_trgm_idx";
