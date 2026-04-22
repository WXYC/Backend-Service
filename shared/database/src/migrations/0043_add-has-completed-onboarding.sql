-- Add has_completed_onboarding flag to auth_user.
-- New accounts default to false; backfill existing completed users to true.

ALTER TABLE "auth_user" ADD COLUMN "has_completed_onboarding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "auth_user" SET "has_completed_onboarding" = true WHERE "real_name" IS NOT NULL AND "real_name" != '' AND "dj_name" IS NOT NULL AND "dj_name" != '';
