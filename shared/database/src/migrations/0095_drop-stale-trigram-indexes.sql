-- 0095 drop-stale-trigram-indexes
--
-- Catch-up migration that aligns the Drizzle journal with the real DB state.
-- These three GIN trigram indexes were already dropped in:
--   - 0054_flowsheet-search-doc-with-dj-name.sql (lines 64-66)
--   - 0065_replay-flowsheet-search-doc-with-dj-name.sql (lines 57-59, replay
--     path per PR #551 — 0054 was skipped on prod)
-- but schema.ts continued to declare them, so drizzle-kit's snapshot kept
-- carrying the entries forward. BS#1129 removed the schema.ts declarations;
-- this migration is the snapshot-aligning DDL no-op against any environment
-- that already applied 0054 or 0065. `IF EXISTS` makes it safe to replay on
-- a hypothetical fresh DB that somehow has them.
--
-- Search reads from `flowsheet.dj_name` + `flowsheet_dj_name_trgm_idx`; no
-- query path joins through `auth_user` or `shows` for dj-name trigram lookup.

DROP INDEX IF EXISTS "wxyc_schema"."shows_legacy_dj_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "auth_user_dj_name_trgm_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "auth_user_name_trgm_idx";
