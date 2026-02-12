-- Rollback: 0024_flowsheet_entry_type
-- Original migration: 0024_flowsheet_entry_type.sql
-- Risk level: MEDIUM
-- Data loss: YES (entry_type values will be lost)
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the flowsheet entry_type enum addition. Drops the entry_type column
-- and the flowsheet_entry_type enum type.
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Application code updated to not use entry_type column

-- Operations:
-- - Drops index flowsheet_entry_type_idx
-- - Drops column entry_type from flowsheet table
-- - Drops enum type flowsheet_entry_type

-- BEGIN ROLLBACK

-- Drop the index first
DROP INDEX IF EXISTS "wxyc_schema"."flowsheet_entry_type_idx";

-- Drop the column (this loses all entry_type data)
ALTER TABLE "wxyc_schema"."flowsheet" DROP COLUMN IF EXISTS "entry_type";

-- Drop the enum type
DROP TYPE IF EXISTS "wxyc_schema"."flowsheet_entry_type";

-- END ROLLBACK
