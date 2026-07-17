-- 0120 per-table autovacuum tuning for large / hot tables (BS#1684)
--
-- Background: while diagnosing the /flowsheet/search 500 outage (#1681) we found
-- the planner's cumulative activity stats for `flowsheet` reading garbage after a
-- 2026-07-15 RDS stats-collector reset (n_live_tup=820 against a ~2.6M-row table).
-- The immediate fix — a manual `ANALYZE wxyc_schema.flowsheet` — was run in prod
-- on 2026-07-17 and cannot live here: ANALYZE cannot run inside a transaction and
-- Drizzle wraps every migration in one. This migration is the *durable* half: it
-- pins per-table autovacuum storage parameters so a large hot table re-analyzes
-- on a size-independent cadence instead of a fixed 10% of an ever-growing row
-- count (the default `autovacuum_analyze_scale_factor = 0.1` would need ~260k
-- modifications to fire on `flowsheet`).
--
-- Drift note: prod already carries most of these parameters, applied ad hoc and
-- never captured in a migration — so fresh dev/CI databases never got them. This
-- migration makes the schema the reproducible source of truth. Current prod state:
--   flowsheet: {analyze=0.05, vacuum=0.05, cost_delay=0}  -> analyze lowered to 0.01
--   library:   {analyze=0.05, vacuum=0.05}                -> codified as-is
--   artists:   {analyze=0.05, vacuum=0.05}                -> codified as-is
--   rotation:  {analyze=0.05, vacuum=0.05}                -> codified as-is
-- `flowsheet` is the only table over ~1M rows (3.3 GB); the other three are small
-- but already tuned, so we codify their existing values rather than leave drift.
--
-- Lock behavior: `ALTER TABLE ... SET (storage_param)` takes only a brief
-- SHARE UPDATE EXCLUSIVE lock (it conflicts with VACUUM/ANALYZE/other DDL, never
-- with reads or writes) and rewrites no data — instant and safe to apply live.
-- `SET` merges with existing reloptions, so re-affirming already-present values is
-- a no-op; only `flowsheet.autovacuum_analyze_scale_factor` (0.05 -> 0.01) changes
-- against prod. DDL-only, no backfill, no precondition guard.
--
-- flowsheet: ~2.6M rows, append-heavy. At 0.01 analyze fires ~every 26k mods
-- (~3-4 days at current ~7k mods/day churn) instead of ~131k at 0.05; vacuum at
-- 0.05 (~131k dead tuples) and cost_delay=0 (no throttle) keep the large table's
-- maintenance from lagging behind growth.
ALTER TABLE "wxyc_schema"."flowsheet" SET (
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_scale_factor  = 0.05,
  autovacuum_vacuum_cost_delay    = 0
);

ALTER TABLE "wxyc_schema"."library" SET (
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_scale_factor  = 0.05
);

ALTER TABLE "wxyc_schema"."artists" SET (
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_scale_factor  = 0.05
);

ALTER TABLE "wxyc_schema"."rotation" SET (
  autovacuum_analyze_scale_factor = 0.05,
  autovacuum_vacuum_scale_factor  = 0.05
);
