-- BS#3139 (tracker BS#3137, decision 7): the one backup table for the album_metadata re-ask. The job writes a row here for every album_metadata, library and flowsheet row it overwrites, in the same statement as the write, and its restore mode writes a per-album 'restore' marker. row_id has no foreign key on purpose: a backup must outlive a delete of the row it saved.
-- The table stays until the owner signs off the run report and sets a retention window; dropping it is a later migration, tracked on BS#3137.
-- DDL-only: a new, empty table and two indexes on it. No existing table is locked or rewritten.
-- @no-precondition-needed: the table is new and empty, so the CHECK has no rows to violate it.
CREATE TABLE "wxyc_schema"."album_metadata_reask_backup" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"target_table" text NOT NULL,
	"row_id" integer NOT NULL,
	"album_id" integer NOT NULL,
	"before_image" jsonb NOT NULL,
	"after_image" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	CONSTRAINT "album_metadata_reask_backup_target_table_ck" CHECK ("wxyc_schema"."album_metadata_reask_backup"."target_table" IN ('album_metadata', 'library', 'flowsheet', 'restore'))
);
--> statement-breakpoint
CREATE INDEX "album_metadata_reask_backup_run_target_idx" ON "wxyc_schema"."album_metadata_reask_backup" USING btree ("run_id","target_table");--> statement-breakpoint
CREATE INDEX "album_metadata_reask_backup_album_id_idx" ON "wxyc_schema"."album_metadata_reask_backup" USING btree ("album_id");