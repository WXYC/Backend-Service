-- Add capabilities column to auth_user table
-- Capabilities are cross-cutting permissions independent of role hierarchy (e.g., 'editor', 'webmaster')
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "capabilities" text[] DEFAULT '{}' NOT NULL;
