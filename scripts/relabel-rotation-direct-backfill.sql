-- One-shot relabel — RETIRED lineage (WXYC/Backend-Service#1521, Option A).
--
-- Historical purpose: flip `rotation.discogs_release_id_source` rows written by
-- the 2026-05-29 operator-run bypass-LML rescue from the placeholder
-- `lml_offline_backfill` (the only non-default enum value at rescue time, picked
-- before migration 0086 shipped the correct one) to `discogs_direct_backfill`.
-- It ran once in prod on 2026-05-29.
--
-- Why the bypass-LML rescue existed:
--   Applied after the 2026-05-28 picker-coverage regression (BS#994 / #1207) but
--   before the enum carried a value matching its provenance. Migration 0086 adds
--   the correct `discogs_direct_backfill` value; this script relabeled the
--   rescue's rows so a future LML-based re-run of `jobs/rotation-release-id-backfill/`
--   can scope its UPDATEs by source without conflating provenance.
--
-- RETIREMENT (BS#1521, Option A, 2026-07-05):
--   The bypass-LML rescue writer is retired. The gated LML job
--   (`jobs/rotation-release-id-backfill`, `search_type` trust gate PR #1519) is
--   now the ONLY sanctioned offline writer of rotation release ids. Do NOT run a
--   bypass-LML rescue again. Any NEW `discogs_direct_backfill` row appearing
--   after 2026-07-05 is an anomaly for the #1517 audit / #1522 recurring check.
--   This script is kept, neutered, only so its one-shot effect stays
--   self-documenting and reversible.
--
-- Re-run safety (the fix — supersedes the former, FALSE "re-running is a no-op"
-- claim, which was false because the old UPDATE was unconditional and the
-- pre-UPDATE SELECT was `\echo`-only, catching nothing):
--   The UPDATE below carries a pure-SQL `AND NOT EXISTS (… discogs_direct_backfill
--   …)` guard. It fires ONLY on a pristine first run (zero `discogs_direct_backfill`
--   rows). Once the relabel has run — i.e. once ANY `discogs_direct_backfill` row
--   exists — a re-run matches zero rows and is a genuine no-op. This protects the
--   fresh `lml_offline_backfill` rows the now-gated LML job legitimately writes on
--   later runs: an un-guarded UPDATE would repaint them to `discogs_direct_backfill`
--   and corrupt the exact provenance signal #1517 / #1522 key on. The guard has NO
--   `kill_date` filter — a killed rescue row must still block the repaint, or
--   killing all 178 rescue rows would silently re-arm the script. The guard is a
--   WHERE predicate (not a psql `\if`) so it holds under BOTH documented
--   invocation paths below, including the `node -e "db.execute(...)"` path where
--   psql meta-commands do not exist. Verified by
--   tests/integration/relabel-rotation-direct-backfill.spec.js.
--
-- Run as operator post-deploy (migration 0086 must be applied first so the enum
-- value exists):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f scripts/relabel-rotation-direct-backfill.sql
--
-- Or via the ssh + docker exec pattern used by the rescue script:
--
--   ssh wxyc-ec2 'docker exec -i backend \
--     node -e "const{db}=require(\"@wxyc/database\");const{sql}=require(\"drizzle-orm\");(async()=>{const r=await db.execute(sql\`<paste guarded UPDATE here>\`);console.log(r.rows||r);})()"'
--
-- Reversible (if needed before tubafrenzy_paste flips override anything):
--   UPDATE wxyc_schema.rotation
--   SET discogs_release_id_source = 'lml_offline_backfill'
--   WHERE discogs_release_id_source = 'discogs_direct_backfill';
--   -- WARNING: this revert zeroes the `discogs_direct_backfill` sentinel the
--   -- guard keys on, so it RE-ARMS this script. Do NOT re-run the relabel after
--   -- reverting unless you have re-confirmed no LML-job `lml_offline_backfill`
--   -- rows are present — otherwise the re-run repaints them. More generally the
--   -- guard only holds while at least one `discogs_direct_backfill` row persists;
--   -- that population can shrink over time (MD-verification flips rows to
--   -- `tubafrenzy_paste`; the daily rotation-release-id-backfill cron can re-resolve
--   -- the handful of NULL-id rows and retag them `lml_offline_backfill`), though
--   -- today ~172 non-NULL-id rows keep it well above zero. The durable protection
--   -- is the retirement above, not the guard alone.
--
-- Per WXYC data-safety rule: SELECT scope first, then UPDATE.

-- These diagnostics count the WHOLE table (no `kill_date` filter) so they mirror
-- exactly what the guard and UPDATE below act on — both of which are also
-- kill_date-blind. That equivalence is load-bearing: `already_relabeled = 0` iff
-- the guard will fire, and `to_relabel` equals the rows the UPDATE will repaint.
-- A `kill_date IS NULL` filter here would let killed `discogs_direct_backfill`
-- rows read as `already_relabeled = 0` (looks like a first run) while the guard
-- is actually armed shut — misleading the operator into a manual unguarded run.
\echo '-- pre-relabel scope (first legitimate run: to_relabel > 0, already_relabeled = 0 => guard fires):'
SELECT
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS to_relabel,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'discogs_direct_backfill') AS already_relabeled,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'tubafrenzy_paste') AS md_verified,
  COUNT(*) AS total
FROM wxyc_schema.rotation;

BEGIN;

-- Guarded: fires only when NO `discogs_direct_backfill` row exists yet (a
-- pristine first run). On any re-run the NOT EXISTS is false for every row, so
-- zero rows match — a genuine no-op that leaves the LML job's fresh
-- `lml_offline_backfill` rows untouched. The subquery reads the statement-start
-- MVCC snapshot, so a first run still repaints every matching row in one pass.
UPDATE wxyc_schema.rotation
SET discogs_release_id_source = 'discogs_direct_backfill'
WHERE discogs_release_id_source = 'lml_offline_backfill'
  AND NOT EXISTS (
    SELECT 1
    FROM wxyc_schema.rotation
    WHERE discogs_release_id_source = 'discogs_direct_backfill'
  );

\echo '-- post-relabel scope (a re-run leaves any lml_offline_backfill rows in place — they belong to the LML job, not the rescue):'
SELECT
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS lml_offline_backfill_remaining,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'discogs_direct_backfill') AS direct_backfill,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'tubafrenzy_paste') AS md_verified,
  COUNT(*) AS total
FROM wxyc_schema.rotation;

COMMIT;

-- @no-analyze-needed: enum-only column update on a small unindexed column
-- (no GIN/trigram/partial index involves discogs_release_id_source).
-- Planner stats on the source distribution are not consulted by any
-- query in the read path; getDiscogsReleaseIdByRotationId selects on
-- rotation.id (PK).
