-- BS#902 (Epic F / F1) — row-level watermark for the conditional-GET path.
--
-- Replaces the process-local `lastModifiedAt: Date` in
-- `apps/backend/services/flowsheet.service.ts` with a DB-derived watermark.
-- The module-level variable broke as soon as more than one BS pod ran behind
-- a load balancer: each pod kept its own watermark, so iOS polls fanned
-- across pods either got a stale 304 against the wrong pod's watermark or
-- a redundant 200. The triggers below also fire on the enrichment-worker
-- UPDATE that surfaces per-row metadata — closing BS#628 by transitivity.
--
-- Two coupled pieces:
--
-- 1. `flowsheet.updated_at` — per-row TIMESTAMPTZ. Useful for row-level
--    cache invalidation, etag derivation downstream, and per-row staleness
--    queries. Bumped by a BEFORE INSERT OR UPDATE trigger on the row
--    itself. Historical rows take the apply instant (`DEFAULT now()`); no
--    consumer reads them today (the watermark is `flowsheet_watermark`,
--    not a `MAX(updated_at)` scan), so a 2.6M-row backfill UPDATE would be
--    pure cost — and would bend the DDL-only rule (`docs/migrations.md`)
--    for no semantic gain. Skipped intentionally; the dryrun against
--    prod-shaped data confirmed the UPDATE doesn't fit a transactional
--    migration window (CI run 26432743270 burned 1h28m before
--    CONNECTION_CLOSED). Any future caller that wants historical
--    `updated_at` to reflect `add_time` should ship a one-shot job under
--    `jobs/<name>-backfill/` per the DDL-only rule.
--
-- 2. `flowsheet_watermark` — single-row sibling table with one
--    `last_modified_at` column. Touched by an AFTER INSERT/UPDATE/DELETE
--    trigger on `flowsheet`. This is the source the conditional-GET
--    middleware reads. **DELETE matters**: with only `MAX(updated_at)
--    FROM flowsheet`, deleting the row that currently holds the MAX makes
--    the watermark *retreat* — a polling iOS client's prior
--    If-Modified-Since would 304 against the older surviving MAX and miss
--    the deletion until the next INSERT/UPDATE pushed the watermark above
--    it. The sibling row's `last_modified_at` advances monotonically
--    (always `now()` or strictly greater than its prior value on any
--    mutation), so the watermark never moves backward.
--
--    The trigger uses `GREATEST(now(), last_modified_at + interval '1
--    second')` so every mutation advances the watermark by at least one
--    whole second relative to its prior value. The conditional-GET
--    middleware (`apps/backend/middleware/conditionalGet.ts`) floors both
--    sides of the inequality to whole seconds because the HTTP Date
--    header is second-granularity. Without the +1s floor in the trigger,
--    two mutations within the same wall-clock second would leave the
--    second-granularity comparison unable to observe progress — a
--    polling client whose `If-Modified-Since` matches the prior second
--    would 304 against a stale baseline. This is the same +1s shape the
--    pre-PR process-local code carried (`updateLastModified()` in
--    `flowsheet.service.ts` on `main`); migrating it into the trigger
--    keeps the test contract intact (`tests/integration/metadata.spec.js`
--    GET-POST-GET sequences) and removes the per-process bookkeeping.
--
-- @no-analyze-needed: the only `UPDATE` in this migration lives inside
-- the `touch_flowsheet_watermark` trigger function and targets the
-- single-row `flowsheet_watermark` table. A one-row table has no
-- planner-stats surface area to drift. The trigger fires per statement
-- on `flowsheet`, but each invocation rewrites the same one row — no
-- bulk-UPDATE cost, no `ANALYZE` need.
--
-- @no-precondition-needed: the `flowsheet.updated_at` ADD COLUMN carries
-- a DEFAULT (now()) and NOT NULL together. On PG11+ a non-VOLATILE
-- DEFAULT ADD COLUMN is metadata-only (now() is STABLE, not VOLATILE) —
-- pg_attribute records the default and existing rows compute it
-- virtually on read until next UPDATE. No row rewrite, no
-- AccessExclusiveLock window beyond the catalog update.
-- `flowsheet_watermark` is a fresh CREATE TABLE; its NOT NULL constraint
-- is trivially satisfied by the seed row inserted in this migration.
--
-- Production ops for the index (same pattern as 0068, 0070, 0074, 0078):
--
--   CREATE INDEX CONCURRENTLY "flowsheet_updated_at_idx"
--     ON "wxyc_schema"."flowsheet" USING btree ("updated_at" DESC);
--
-- Then merge this PR. IF NOT EXISTS below makes the migration a no-op
-- against the prod DB where the index is already present; fresh dev
-- databases pick it up on first migrate. Drizzle wraps each migration in
-- a transaction so CREATE INDEX CONCURRENTLY can't run inside this file.

ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wxyc_schema.bump_flowsheet_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER bump_flowsheet_updated_at
BEFORE INSERT OR UPDATE ON wxyc_schema.flowsheet
FOR EACH ROW
EXECUTE FUNCTION wxyc_schema.bump_flowsheet_updated_at();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flowsheet_updated_at_idx" ON "wxyc_schema"."flowsheet" USING btree ("updated_at" DESC);--> statement-breakpoint
CREATE TABLE "wxyc_schema"."flowsheet_watermark" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "last_modified_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flowsheet_watermark_singleton" CHECK ("id" = true)
);--> statement-breakpoint
INSERT INTO "wxyc_schema"."flowsheet_watermark" ("id", "last_modified_at") VALUES (true, now()) ON CONFLICT DO NOTHING;--> statement-breakpoint
CREATE OR REPLACE FUNCTION wxyc_schema.touch_flowsheet_watermark() RETURNS trigger AS $$
BEGIN
  UPDATE wxyc_schema.flowsheet_watermark
  SET last_modified_at = GREATEST(now(), last_modified_at + interval '1 second')
  WHERE id = true;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER touch_flowsheet_watermark
AFTER INSERT OR UPDATE OR DELETE ON wxyc_schema.flowsheet
FOR EACH STATEMENT
EXECUTE FUNCTION wxyc_schema.touch_flowsheet_watermark();
