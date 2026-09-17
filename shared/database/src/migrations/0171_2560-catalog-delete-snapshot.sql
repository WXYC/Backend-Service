-- 0171 catalog_delete_snapshot (BS#2560, F1): before-state capture for a
-- catalog delete, written inside the same transaction as the delete it
-- protects. Numbered 0171 deliberately -- WXYC/Backend-Service#2563 takes
-- 0172 and is blocked on this issue landing first, so the two migrations
-- cannot race on meta/_journal.json.
--
-- New table, no data migration: DDL-only, well within docs/migrations.md's
-- ddl-only rule. CREATE TABLE + one CREATE INDEX on a brand new table take
-- no lock on any existing table and touch zero existing rows.
--
-- No FK on entity_id: the row it names (a `library.id` or, once
-- WXYC/Backend-Service#2562 lands, an `artists.id`) is deleted in the same
-- transaction that writes this row, so there is nothing left for a
-- constraint to reference by the time anything else reads it. See the
-- schema.ts comment on catalog_delete_snapshot for the full rationale.
--
-- Single composite index on (entity_kind, entity_id): the only read this
-- table needs to serve today is "find the snapshot(s) for this deleted
-- row," and retention is permanent (no prune job), so there is no
-- occurred_at-range query to index for yet.
CREATE TABLE "wxyc_schema"."catalog_delete_snapshot" (
	"id" serial PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" integer NOT NULL,
	"captured" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_email" text,
	"actor_role" text
);
--> statement-breakpoint
CREATE INDEX "catalog_delete_snapshot_entity_idx" ON "wxyc_schema"."catalog_delete_snapshot" USING btree ("entity_kind","entity_id");