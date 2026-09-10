-- BS#2409: pre-catalog format_id + label_id on rotation.
--
-- Restores what tubafrenzy's ROTATION_RELEASE always normalized
-- (FORMAT_ID, COMPANY_ID) and Backend flattened away. Both columns are
-- nullable, written only while album_id IS NULL (the free-text trio's
-- rule); on a linked row, format/label authority is the library row.
-- Every existing row stays NULL — the legacy backfill from the tubafrenzy
-- final dump is BS#2412, deliberately deferred past Phase 6b.
--
-- Lock behavior: ADD COLUMN (nullable, no default) and ADD CONSTRAINT
-- against NULL-only data are metadata-only on PG14; brief
-- AccessExclusiveLock, no table rewrite, no validation scan cost beyond
-- the empty match set.
--
-- Wire note: addRotation and updateRotation return unprojected
-- .returning() rows, so POST /library/rotation and PATCH /library/rotation
-- responses gain these two keys (as NULLs) the moment this applies —
-- additive, accepted; spec updates ride BS#2410 / wxyc-shared#442.
--
-- @no-precondition-needed: nullable FK columns; all existing rows NULL, so the constraints validate against an empty match set, and the referenced tables (format, labels) pre-exist.
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "format_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "label_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_format_id_format_id_fk" FOREIGN KEY ("format_id") REFERENCES "wxyc_schema"."format"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_label_id_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "wxyc_schema"."labels"("id") ON DELETE no action ON UPDATE no action;