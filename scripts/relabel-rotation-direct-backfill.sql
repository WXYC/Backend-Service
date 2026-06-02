-- One-shot relabel: flip `rotation.discogs_release_id_source` rows that
-- were written by the 2026-05-29 operator-run bypass-LML rescue from
-- `lml_offline_backfill` (a placeholder, picked before migration 0086
-- shipped the correct value) to `discogs_direct_backfill`.
--
-- Why this exists:
--   The bypass-LML rescue (see `/tmp/apply-rotation-backfill.sh` lineage)
--   was applied after the 2026-05-28 picker-coverage regression but
--   before the enum had a value matching its provenance. The rescue
--   script wrote `lml_offline_backfill` because that was the only non-
--   default value the enum carried. Migration 0086 adds the correct
--   `discogs_direct_backfill` value; this script relabels the rescue's
--   rows so a future LML-based re-run of `jobs/rotation-release-id-backfill/`
--   can scope its UPDATEs by source without conflating provenance.
--
-- Scope (verified pre-relabel):
--   At rescue time the original `jobs/rotation-release-id-backfill/`
--   LML-based job had not yet run in prod, so every row currently
--   carrying `lml_offline_backfill` is from the bypass-LML rescue.
--   If that ever changes (LML job runs and tags rows before this
--   relabel deploys), the SELECT-before-UPDATE step below catches it.
--
-- Idempotent: the WHERE clause only matches rows still on
-- `lml_offline_backfill`, so re-running is a no-op.
--
-- Run as operator post-deploy (migration 0086 must be applied first so
-- the enum value exists):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/relabel-rotation-direct-backfill.sql
--
-- Or via the ssh + docker exec pattern used by the rescue script:
--
--   ssh wxyc-ec2 'docker exec -i backend \
--     node -e "const{db}=require(\"@wxyc/database\");const{sql}=require(\"drizzle-orm\");(async()=>{const r=await db.execute(sql\`<paste body here>\`);console.log(r.rows||r);})()"'
--
-- Reversible (if needed before tubafrenzy_paste flips override anything):
--   UPDATE wxyc_schema.rotation
--   SET discogs_release_id_source = 'lml_offline_backfill'
--   WHERE discogs_release_id_source = 'discogs_direct_backfill';
--
-- Per WXYC data-safety rule: SELECT scope first, then UPDATE.

\echo '-- pre-relabel scope (expect non-zero, matches rescue output):'
SELECT
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS to_relabel,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'discogs_direct_backfill') AS already_relabeled,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'tubafrenzy_paste') AS md_verified,
  COUNT(*) AS total
FROM wxyc_schema.rotation
WHERE kill_date IS NULL;

BEGIN;

UPDATE wxyc_schema.rotation
SET discogs_release_id_source = 'discogs_direct_backfill'
WHERE discogs_release_id_source = 'lml_offline_backfill';

\echo '-- post-relabel scope (to_relabel should be 0):'
SELECT
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS to_relabel,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'discogs_direct_backfill') AS relabeled,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'tubafrenzy_paste') AS md_verified,
  COUNT(*) AS total
FROM wxyc_schema.rotation
WHERE kill_date IS NULL;

COMMIT;

-- @no-analyze-needed: enum-only column update on a small unindexed column
-- (no GIN/trigram/partial index involves discogs_release_id_source).
-- Planner stats on the source distribution are not consulted by any
-- query in the read path; getDiscogsReleaseIdByRotationId selects on
-- rotation.id (PK).
