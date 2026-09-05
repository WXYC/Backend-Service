-- BS#2358 — schema foundation for station self-signup: DJs without an
-- account can create one during holiday-break shows using a short passcode
-- posted in the control room, and the resulting account is flagged for
-- manager review.
--
-- `station_passcode` and `station_signup_attempt` are unprefixed
-- deliberately — `auth_` marks better-auth-managed tables (auth_user,
-- auth_session, auth_verification, auth_jwks); these are ours, alongside the
-- other hand-rolled auth-adjacent tables (`anonymous_devices` in 0024,
-- `user_activity` in 0025).
--
-- `station_signup_attempt`'s composite `(outcome, attempted_at)` index (not
-- `attempted_at` alone) is load-bearing: every cooldown read filters on
-- `outcome` first — the in-window failure count, the
-- `MAX(attempted_at) WHERE outcome = 'cooldown_cleared'` floor, and the
-- once-per-window `cooldown_refused` check.
--
-- `auth_user.self_signup_at` / `self_signup_reviewed_at` /
-- `self_signup_reviewed_by` track manager review of self-signed-up accounts.
-- Pending review = `self_signup_at IS NOT NULL AND self_signup_reviewed_at
-- IS NULL`; there is deliberately no separate `pending_review` boolean.
--
-- Every new `auth_user` FK is `ON DELETE SET NULL` and its column nullable,
-- per the fix in `0048_fix-fk-on-delete-set-null.sql`. This migration adds no
-- data, so no precondition guard is needed on these constraints.
-- @no-precondition-needed: all three FKs are on freshly-added nullable
-- columns / freshly-created tables with no existing rows.
--
-- This is a schema-only foundation migration — no application code reads or
-- writes these tables/columns yet. Every other issue in the station-signup
-- epic depends on it.

CREATE TABLE "station_passcode" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"code_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"max_uses" integer DEFAULT 25 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_signup_attempt" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" varchar(16),
	"actor_user_id" varchar(255),
	"outcome" varchar(24) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "self_signup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "self_signup_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "self_signup_reviewed_by" varchar(255);--> statement-breakpoint
ALTER TABLE "station_passcode" ADD CONSTRAINT "station_passcode_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_signup_attempt" ADD CONSTRAINT "station_signup_attempt_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_signup_attempt_outcome_attempted_at_idx" ON "station_signup_attempt" USING btree ("outcome","attempted_at");--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_self_signup_reviewed_by_auth_user_id_fk" FOREIGN KEY ("self_signup_reviewed_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;