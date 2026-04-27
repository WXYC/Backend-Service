-- B-tree index on flowsheet.show_id.
--
-- show_id is an FK reference to shows(id), but PostgreSQL does not auto-
-- index FK columns. Without this index, every query that filters by
-- show_id sequentially scans the 2.6M-row flowsheet table — including the
-- /flowsheet `?shows_limit=N` listing endpoint that the dj-site polls every
-- 60 seconds. During incident #511 those scans accumulated as orphan
-- queries against a bloated table, contributing to the cascade.
--
-- The index was created manually in production via
-- `CREATE INDEX CONCURRENTLY` on 2026-04-27 to unblock /flowsheet without
-- holding a ShareLock during the build. This migration declares the same
-- index so the schema source matches reality and fresh dev databases get
-- it on init. `IF NOT EXISTS` makes it idempotent against the production
-- DB where the index is already present.
--
-- This is NOT `CONCURRENTLY` because Drizzle wraps each migration file in
-- a transaction and `CREATE INDEX CONCURRENTLY cannot run inside a
-- transaction block`. On an empty/small dev database the regular build
-- finishes in milliseconds; the brief ShareLock that conflicts with
-- writers is acceptable. If a future fresh-load path needs to apply this
-- against a full-size table, run it as a one-shot job (CONCURRENTLY)
-- instead and then mark the migration applied — the same pattern used for
-- migration 0057 (`flowsheet_artwork_lookup_idx`).

CREATE INDEX IF NOT EXISTS "flowsheet_show_id_idx"
  ON "wxyc_schema"."flowsheet" ("show_id");
