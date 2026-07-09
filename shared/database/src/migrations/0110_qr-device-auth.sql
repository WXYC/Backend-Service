-- @no-precondition-needed: new table with no pre-existing rows, so the FK
--   to auth_user and the two UNIQUE indexes have no data invariants to
--   violate at ADD CONSTRAINT / CREATE INDEX time. The `auth_session`
--   ADD COLUMN is nullable with no default — additive only, and only
--   populated by the /device/token after-hook for QR sign-in sessions.
-- 0110 (ADR 0008 / BS#1494): substrate for the better-auth
--   `device-authorization` plugin — RFC 8628 QR sign-in on the shared
--   control-room computer. Rows are minted by /auth/device/code (userId
--   NULL), claimed by GET /auth/device?user_code=… (sets userId), and
--   flipped to `approved`/`denied` by /auth/device/approve|deny. DDL-only.
--   The plugin's schema contract lives at
--   node_modules/better-auth/dist/plugins/device-authorization/schema.mjs;
--   column names, types, and required-ness match it field-for-field.
--
--   auth_session.device_flow_expires_at is the hard cap enforced by
--   databaseHooks.session.update.before against better-auth's rolling
--   refresh (getSession → updateSession expiresAt = now + 7d).

CREATE TABLE "auth_device_code" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"device_code" varchar(255) NOT NULL,
	"user_code" varchar(255) NOT NULL,
	"user_id" varchar(255),
	"expires_at" timestamp with time zone NOT NULL,
	"status" varchar(32) NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" varchar(255),
	"scope" text
);
--> statement-breakpoint
ALTER TABLE "auth_session" ADD COLUMN "device_flow_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_device_code" ADD CONSTRAINT "auth_device_code_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_device_code_device_code_key" ON "auth_device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_device_code_user_code_key" ON "auth_device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "auth_device_code_expires_at_idx" ON "auth_device_code" USING btree ("expires_at");