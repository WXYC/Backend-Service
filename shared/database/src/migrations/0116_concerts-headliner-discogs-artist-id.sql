-- 0116 concerts headliner Discogs-id resolution lane (BS#1614).
--
-- Adds the substrate for the offline LML verify-before-mint pass
-- (`jobs/concerts-artist-lml-resolver/`, LML#759) that resolves touring
-- artists absent from the WXYC library — names the pure-SQL strict/alias
-- resolver (`jobs/concerts-artist-resolver/`) can never FK:
--
--   - `headlining_discogs_artist_id` — bare Discogs artist id, no FK
--     (external id; `album_metadata.discogs_artist_id` precedent).
--   - `headlining_discogs_artist_id_source` — provenance, TEXT with a
--     documented vocabulary (NOT a pgEnum; the 0109 saga showed enum-value
--     additions cost a migration each). First value: 'lml_artist_resolve'.
--   - `artist_resolve_attempted_at` — attempt-at marker (docs/migrations.md
--     "Attempt-at markers"): stamped only on RESPONDED verdicts (resolved /
--     ambiguous / not_found), left NULL on `escalation_unavailable` and
--     transport errors so those rows stay retryable.
--
-- The curated partial index is DROPped and recreated with the widened
-- predicate `(headlining_artist_id IS NOT NULL OR headlining_discogs_artist_id
-- IS NOT NULL) AND removed_at IS NULL` so Discogs-id-only resolutions surface
-- in GET /concerts?curated=true — the feed this pass exists to lift. The
-- `buildWhere` curated branch in apps/backend/services/concerts.service.ts
-- changes in lockstep (the read predicate must exactly match the index
-- predicate or the planner falls back to concerts_active_starts_on_id_idx).
--
-- Lock behavior: the ADD COLUMNs are nullable with no default — metadata-only.
-- `concerts` is small (single-digit thousands of rows), so the in-transaction
-- DROP + CREATE INDEX window is trivial; no out-of-band CONCURRENTLY pre-build
-- is required. If the table ever grows enough to warrant it, the runbook is:
--
--   DROP INDEX CONCURRENTLY IF EXISTS "wxyc_schema"."concerts_curated_starts_on_idx";
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "concerts_curated_starts_on_idx"
--     ON "wxyc_schema"."concerts" USING btree ("starts_on")
--     WHERE ("wxyc_schema"."concerts"."headlining_artist_id" IS NOT NULL OR "wxyc_schema"."concerts"."headlining_discogs_artist_id" IS NOT NULL)
--       AND "wxyc_schema"."concerts"."removed_at" IS NULL;
--
-- (the in-migration form is not CONCURRENTLY because Drizzle wraps each
-- migration in a transaction). IF EXISTS / IF NOT EXISTS make the migration a
-- no-op against an environment where that pre-build already ran, per the
-- established index pattern.
--
-- No precondition guard: no UNIQUE / CHECK / NOT NULL / FK is added, and no
-- rows are rewritten (DDL-only).
DROP INDEX IF EXISTS "wxyc_schema"."concerts_curated_starts_on_idx";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "headlining_discogs_artist_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "headlining_discogs_artist_id_source" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."concerts" ADD COLUMN "artist_resolve_attempted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "concerts_curated_starts_on_idx" ON "wxyc_schema"."concerts" USING btree ("starts_on") WHERE ("wxyc_schema"."concerts"."headlining_artist_id" IS NOT NULL OR "wxyc_schema"."concerts"."headlining_discogs_artist_id" IS NOT NULL) AND "wxyc_schema"."concerts"."removed_at" IS NULL;
