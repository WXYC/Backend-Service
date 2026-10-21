-- BS#3471 (specialty shows in the flowsheet, epic BS#3445, leaf L46): what the listener request line is for. A show's DJs choose `requests`, `feedback` (messages only) or `closed` in `shows.request_mode`; NULL defers to the program's `specialty_shows.default_request_mode`, and NULL there means `requests`.
--
-- The enum is created and used in this one file, which is safe because every value is present in the original `CREATE TYPE` (see `single-transaction-migrate` in docs/migrations.md). Do not `ALTER TYPE ... ADD VALUE` it here.
--
-- Four programs default to messages because their formats cannot take song requests (decided 2026-10-17): Friday Night Story Hour (writers reading), HyperLocal (news), Backyard BBQ (a band playing live) and Inside Track (one album start to finish). The other five stay NULL. The seed UPDATE matches by slug and touches the existing `specialty_shows` triggers (watermark, `last_modified`) once, which is what a catalog edit does anyway.
--
-- @no-precondition-needed: both columns are new, nullable and unconstrained, so no row can violate them.
-- @no-analyze-needed: the UPDATE touches four rows of a nine-row catalog, so there are no planner stats to drift.
CREATE TYPE "wxyc_schema"."request_line_mode" AS ENUM('requests', 'feedback', 'closed');--> statement-breakpoint
ALTER TABLE "wxyc_schema"."shows" ADD COLUMN "request_mode" "wxyc_schema"."request_line_mode";--> statement-breakpoint
ALTER TABLE "wxyc_schema"."specialty_shows" ADD COLUMN "default_request_mode" "wxyc_schema"."request_line_mode";--> statement-breakpoint
UPDATE "wxyc_schema"."specialty_shows" SET "default_request_mode" = 'feedback' WHERE "slug" IN ('friday-night-story-hour', 'hyperlocal', 'backyard-bbq', 'inside-track');
