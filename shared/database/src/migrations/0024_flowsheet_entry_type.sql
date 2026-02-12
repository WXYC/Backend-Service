-- Create flowsheet entry type enum
CREATE TYPE "wxyc_schema"."flowsheet_entry_type" AS ENUM (
  'track',
  'show_start',
  'show_end',
  'dj_join',
  'dj_leave',
  'talkset',
  'breakpoint',
  'message'
);

-- Add entry_type column (nullable initially for backfill)
ALTER TABLE "wxyc_schema"."flowsheet"
ADD COLUMN "entry_type" "wxyc_schema"."flowsheet_entry_type";

-- Backfill existing data based on message patterns
UPDATE "wxyc_schema"."flowsheet"
SET entry_type = CASE
  WHEN message IS NULL OR message = '' THEN 'track'::"wxyc_schema"."flowsheet_entry_type"
  WHEN message LIKE 'Start of Show:%' THEN 'show_start'::"wxyc_schema"."flowsheet_entry_type"
  WHEN message LIKE 'End of Show:%' THEN 'show_end'::"wxyc_schema"."flowsheet_entry_type"
  WHEN message LIKE '% joined the set!' THEN 'dj_join'::"wxyc_schema"."flowsheet_entry_type"
  WHEN message LIKE '% left the set!' THEN 'dj_leave'::"wxyc_schema"."flowsheet_entry_type"
  ELSE 'message'::"wxyc_schema"."flowsheet_entry_type"  -- Legacy messages default to 'message' type
END;

-- Make NOT NULL with default for new entries
ALTER TABLE "wxyc_schema"."flowsheet"
ALTER COLUMN "entry_type" SET NOT NULL,
ALTER COLUMN "entry_type" SET DEFAULT 'track';

-- Add index for filtering by entry type
CREATE INDEX "flowsheet_entry_type_idx" ON "wxyc_schema"."flowsheet" ("entry_type");
