-- 0108 (BS#1499): add per-playcut BMI composer capture to flowsheet so the
-- post-tubafrenzy export-successor (#1500) can emit the semiannual BMI list
-- without the retiring tubafrenzy/MySQL `BMI_COMPOSER` column. `composer` is
-- the BMI-ready string; `composer_source` is enum-like provenance text
-- ('discogs_track' | 'discogs_release' | 'artist_proxy'), left open as text
-- (not a pg enum) so a future source needs no enum migration.
--
-- Additive, all nullable, no constraints/defaults/FKs — pure ADD COLUMN, so
-- no precondition guard is needed (see docs/migrations.md constraint-guard
-- rule, which scopes only UNIQUE/CHECK/NOT NULL/FK migrations). DDL-only; lock
-- is a brief AccessExclusiveLock (ADD COLUMN with no default is a catalog-only
-- change in PG, no table rewrite). Inert on apply: nobody writes these columns
-- until the enrichment-worker write lands (BS#1499 PR-3).
--
-- Writer: apps/enrichment-worker (enrich.ts finalizeRow, extended:true in handler.ts).
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "composer" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "composer_source" text;