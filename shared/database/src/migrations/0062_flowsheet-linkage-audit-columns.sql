-- Add linkage audit columns to flowsheet (B-1.4).
--
-- These three columns let us audit match quality on `album_id`, undo a class
-- of bad matches if a heuristic regresses, and weight links differently in
-- ranking down the road (e.g., trust ETL links more than LML-fuzzy links).
--
-- Setting the columns on new linkages is handled in B-2.1 / B-2.2 / B-3.1;
-- this migration only adds the columns nullable. The backfill for existing
-- linked rows is a separate one-shot job under
-- `jobs/flowsheet-linkage-audit-backfill/` — DDL inside this migration only.
--
-- Production note: ALTER TABLE ADD COLUMN of a nullable column is metadata-
-- only and instant on PostgreSQL 11+, regardless of table size. Bulk DML
-- does not belong here: ALTER TABLE acquires AccessExclusiveLock that is
-- held until the transaction commits, and a long DML can wedge the table
-- for hours. See migration 0053 + jobs/flowsheet-dj-name-backfill, and
-- issue #511 for the incident this rule was learned from.
--
-- linkage_source        — enum-like text: 'etl_legacy_id', 'dj_bin_pick',
--                         'lml_high_confidence', 'human_review',
--                         'tubafrenzy_mirror', etc.
-- linkage_confidence    — for LML-resolved cases, the confidence score at
--                         link time. NULL for sources where confidence is
--                         either implicit (ETL legacy ID match) or
--                         meaningless (human review).
-- linked_at             — when album_id was last set or confirmed.

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "linkage_source" text;--> statement-breakpoint

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "linkage_confidence" real;--> statement-breakpoint

ALTER TABLE "wxyc_schema"."flowsheet"
  ADD COLUMN "linked_at" timestamp with time zone;
