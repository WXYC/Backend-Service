-- BS#2358 — schema foundation for station self-signup: a DJ without an
-- account can create one during a holiday-break show using a short passcode
-- posted in the control room, and the resulting account is flagged for
-- manager review.
--
-- Per-column rationale deliberately does NOT live here — it lives at each
-- column in shared/database/src/schema.ts. This file's SHA-256 is frozen in
-- meta/applied-hashes.json the moment it is applied, so any prose duplicated
-- into it could never be corrected once schema.ts moves on (the #705 wedge).
-- Only what is specific to this file stays below.
--
-- `station_passcode` and `station_signup_attempt` are unprefixed
-- deliberately — `auth_` marks better-auth-managed tables (auth_user,
-- auth_session, auth_verification, auth_jwks); these two are ours, alongside
-- the other hand-rolled auth-adjacent tables (`anonymous_devices` in 0024,
-- `user_activity` in 0025). An `auth_` prefix would misrepresent ownership.
--
-- @no-precondition-needed: all four FKs land on freshly-created tables or
-- freshly-added nullable columns, so no existing row can violate them.

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
	"passcode_id" varchar(255),
	"outcome" varchar(24) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "self_signup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "self_signup_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_user" ADD COLUMN "self_signup_reviewed_by" varchar(255);--> statement-breakpoint
ALTER TABLE "station_passcode" ADD CONSTRAINT "station_passcode_created_by_auth_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_signup_attempt" ADD CONSTRAINT "station_signup_attempt_actor_user_id_auth_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_signup_attempt" ADD CONSTRAINT "station_signup_attempt_passcode_id_station_passcode_id_fk" FOREIGN KEY ("passcode_id") REFERENCES "public"."station_passcode"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_passcode_created_by_idx" ON "station_passcode" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "station_signup_attempt_outcome_attempted_at_idx" ON "station_signup_attempt" USING btree ("outcome","attempted_at");--> statement-breakpoint
CREATE INDEX "station_signup_attempt_actor_user_id_idx" ON "station_signup_attempt" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "station_signup_attempt_passcode_id_idx" ON "station_signup_attempt" USING btree ("passcode_id");--> statement-breakpoint
ALTER TABLE "auth_user" ADD CONSTRAINT "auth_user_self_signup_reviewed_by_auth_user_id_fk" FOREIGN KEY ("self_signup_reviewed_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_user_self_signup_reviewed_by_idx" ON "auth_user" USING btree ("self_signup_reviewed_by");