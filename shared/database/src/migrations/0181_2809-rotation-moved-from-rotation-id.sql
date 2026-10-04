-- BS#2809 (slice 16a of BS#2791) -- `rotation.moved_from_rotation_id`, the link from a moved record's new rotation row back to the row it replaced, so a pre-cutover typed-text record moved between bins keeps its standing. Nullable, no default: a metadata-only change on `rotation`. No reader or writer in this migration.
--
-- @no-precondition-needed: the new column is NULL for every existing row, so the self-referencing FK cannot be violated.
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "moved_from_rotation_id" integer;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_moved_from_rotation_id_rotation_id_fk" FOREIGN KEY ("moved_from_rotation_id") REFERENCES "wxyc_schema"."rotation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rotation_moved_from_rotation_id_idx" ON "wxyc_schema"."rotation" USING btree ("moved_from_rotation_id");
