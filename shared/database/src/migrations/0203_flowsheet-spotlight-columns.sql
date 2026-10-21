-- BS#3458 (specialty shows in the flowsheet, epic BS#3445, leaf L16): the role and name a `spotlight` flowsheet row carries, and the CHECK that ties them to the entry type.
--
-- `spotlight_role` reuses the enum 0201 created for `specialty_shows.default_spotlight_role`; `spotlight_name` is free text. Both are nullable, so the ADD COLUMNs rewrite nothing.
--
-- The CHECK compares `entry_type::text`, never the enum value, so it is safe in the same transaction as 0202's `ADD VALUE` (see `single-transaction-migrate` in docs/migrations.md).
--
-- The CHECK is added NOT VALID and this migration does not validate it: validating scans `flowsheet` under a lock that would stall live DJs. A NOT VALID constraint still enforces every new INSERT and UPDATE. It is validated out of band (BS#3478) with:
--
--   ALTER TABLE wxyc_schema.flowsheet VALIDATE CONSTRAINT flowsheet_spotlight_columns_check;
--
-- @no-precondition-needed: both columns are new and no row carries entry_type 'spotlight', so no row can violate.
-- @no-analyze-needed: no rows are updated; the new columns are all NULL.

ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "spotlight_role" "wxyc_schema"."spotlight_role";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD COLUMN "spotlight_name" varchar(128);--> statement-breakpoint
ALTER TABLE "wxyc_schema"."flowsheet" ADD CONSTRAINT "flowsheet_spotlight_columns_check" CHECK ((entry_type::text = 'spotlight') = (spotlight_role IS NOT NULL AND spotlight_name IS NOT NULL)) NOT VALID;
