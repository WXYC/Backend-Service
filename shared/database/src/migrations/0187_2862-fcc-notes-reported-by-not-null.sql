-- BS#2862 (slice 13c of BS#2791) -- `fcc_notes.reported_by` becomes NOT NULL. The contract's `FccNote.reported_by` is a required, non-nullable string, and `POST /fcc-notes` (the table's first writer) refuses a caller with no account name to snapshot, so no row it writes can hold NULL.
--
-- Locks: the SET NOT NULL takes an AccessExclusiveLock on `fcc_notes` and scans it once to validate, held until the shared migrate transaction commits. The table has had no writer until this slice, so the scan is of an empty table and finishes at once.
--
-- The guard below fails the migration with a count rather than Postgres's bare 23502 if a row with a NULL `reported_by` exists; the fix is to set each such row's `reported_by` to the reporter's display name before re-running.
DO $$
DECLARE
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO null_count FROM wxyc_schema.fcc_notes WHERE reported_by IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'Cannot set fcc_notes.reported_by NOT NULL: % rows have a NULL reported_by. Set each to its reporter''s display name first.', null_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."fcc_notes" ALTER COLUMN "reported_by" SET NOT NULL;
