-- precondition-guard: not-required (no constraint added; CREATE FUNCTION
--   and CREATE INDEX IF NOT EXISTS are evaluated against existing data
--   only insofar as the index build reads every row, and the index
--   expression is total — `normalize_artist_name(input text)` coerces
--   NULL to '' via coalesce, so a NULL artist_name cannot raise.
--   No existing-row invariant is added.)
-- @no-precondition-needed: no constraint is added. The function is
--   IMMUTABLE PARALLEL SAFE total over `text` and the indexes are
--   plain btree on the function's output — neither admits a data
--   invariant that current rows must satisfy.
-- @no-analyze-needed: no UPDATE in this migration. The CREATE INDEX
--   statements implicitly populate index stats during the build; the
--   underlying table row counts and column stats are unaffected.
--
-- 0092 — `normalize_artist_name(text)` SQL function + three functional
-- indexes supporting the concerts-artist-resolver job (BS#1372).
--
-- The resolver matches `concerts.headlining_artist_raw` against
-- `artists.artist_name` and `artist_search_alias.variant` after applying
-- a single canonical normalization: lowercase + strip a leading "The ".
-- That rule lives here as a SQL function (so the resolver's JOIN can
-- exploit a functional index instead of seq-scanning ~120k artists)
-- with a TypeScript twin at `shared/database/src/normalize-artist-name.ts`
-- (so iOS / dj-site / sibling resolvers normalize the same way).
--
-- The function is IMMUTABLE PARALLEL SAFE so Postgres can use it inside
-- functional indexes and parallelize index scans. `coalesce(input, '')`
-- makes the function total on NULL input — the indexes below depend on
-- this to avoid emitting NULL keys for rows whose `artist_name` is NULL.
--
-- Index choices:
--
--   - `artists_normalized_name_idx` supports the strict-match arm. ~120k
--     artist rows; without the index the resolver would seq-scan per
--     concert. The index is non-unique because `artists.artist_name`
--     itself has ~235 duplicate groups (memory: `project_canonical_artists`)
--     — the resolver's "exactly one canonical match" guard is how those
--     stay NULL safely.
--
--   - `artist_search_alias_normalized_variant_idx` supports the alias
--     fallback arm. The existing `artist_search_alias_variant_trgm_idx`
--     (migration 0089) is a GIN trigram index optimized for substring
--     similarity, not equality on the normalized form; the alias arm
--     here is an equality predicate, so it needs its own btree.
--
--   - `concerts_headlining_artist_id_null_idx` is a partial index on
--     `concerts.id WHERE headlining_artist_id IS NULL`. The recurring
--     drain (cron at "15 5 * * *") runs `SELECT ... WHERE
--     headlining_artist_id IS NULL` daily; once most rows are resolved,
--     the partial index keeps that read cheap.
--
-- Concurrency: per `docs/migrations.md`'s `if-not-exists-index` rule,
-- the runbook for prod is to first build the three indexes out-of-band
-- with `CREATE INDEX CONCURRENTLY` so the migration here is a no-op
-- against the running database. The IF NOT EXISTS clauses below allow
-- the migration to apply cleanly in either order. The function itself
-- (CREATE OR REPLACE FUNCTION) is metadata-only and acquires no row-
-- level lock; safe to ship in-band.
--
-- Production runbook for the indexes (each CREATE INDEX CONCURRENTLY
-- runs outside any transaction; the function ships in the migration):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "artists_normalized_name_idx"
--     ON "wxyc_schema"."artists" (wxyc_schema.normalize_artist_name("artist_name"));
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "artist_search_alias_normalized_variant_idx"
--     ON "wxyc_schema"."artist_search_alias" (wxyc_schema.normalize_artist_name("variant"));
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "concerts_headlining_artist_id_null_idx"
--     ON "wxyc_schema"."concerts" ("id") WHERE "headlining_artist_id" IS NULL;
--
-- Companion job: jobs/concerts-artist-resolver/ (this PR).

CREATE OR REPLACE FUNCTION wxyc_schema.normalize_artist_name(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT lower(regexp_replace(coalesce(input, ''), '^the\s+', '', 'i'));
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artists_normalized_name_idx" ON "wxyc_schema"."artists" USING btree (wxyc_schema.normalize_artist_name("artist_name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artist_search_alias_normalized_variant_idx" ON "wxyc_schema"."artist_search_alias" USING btree (wxyc_schema.normalize_artist_name("variant"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concerts_headlining_artist_id_null_idx" ON "wxyc_schema"."concerts" USING btree ("id") WHERE "headlining_artist_id" IS NULL;
