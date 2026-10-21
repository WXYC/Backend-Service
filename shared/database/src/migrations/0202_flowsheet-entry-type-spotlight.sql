-- precondition-guard: not-required (ALTER TYPE ... ADD VALUE has no row-level invariants)
-- BS#3458 (specialty shows in the flowsheet, epic BS#3445, leaf L16): add `spotlight` to `flowsheet_entry_type`, the timestamped row that names who is on air inside a show.
--
-- Why its own migration: `migrate()` applies every pending migration in one transaction, and a value added by `ALTER TYPE ... ADD VALUE` cannot be used by a later statement in that transaction (see `single-transaction-migrate` in docs/migrations.md). The columns and CHECK that refer to it are in 0203, which compares through `::text` so it never constructs the value. Same shape as 0086, 0109 and 0117. Nothing writes `'spotlight'` in this deploy.
--
-- @no-analyze-needed: ALTER TYPE ADD VALUE is type-system metadata only. No rows are rewritten, no planner stats to refresh.

ALTER TYPE "wxyc_schema"."flowsheet_entry_type" ADD VALUE 'spotlight';
