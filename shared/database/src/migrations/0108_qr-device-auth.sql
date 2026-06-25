-- precondition-guard: not-required (single CREATE TABLE on a new table; FK
--   to auth_user(id) and three indexes evaluate against empty rows at
--   ADD CONSTRAINT time, so no existing-row invariant can be violated.
--   Cross-cache-identity gate doesn't apply — no library_identity columns
--   touched.)
-- @no-precondition-needed: every constraint added here (PK, FK with
--   ON DELETE cascade, two UNIQUE indexes, one btree index, NOT NULLs)
--   is evaluated against an empty table.
-- 0106 — auth_device_code substrate for the QR sign-in flow (ADR 0008).
--
-- Backs the better-auth `device-authorization` plugin (RFC 8628). Drizzle
-- adapter maps the plugin's `deviceCode` model name to this table via the
-- schema map in shared/authentication/src/auth.definition.ts. Column shape
-- matches node_modules/better-auth/dist/plugins/device-authorization/
-- schema.mjs verbatim (id PK, device_code + user_code unique, user_id
-- nullable until the iOS app approves).
--
-- Rows have at most 5-minute TTLs (expiresIn config), and the plugin
-- deletes them on token exchange, on denial, or when expired. expires_at
-- index supports a future janitor sweep without scanning the whole table.

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
ALTER TABLE "auth_device_code" ADD CONSTRAINT "auth_device_code_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_device_code_device_code_key" ON "auth_device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_device_code_user_code_key" ON "auth_device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "auth_device_code_expires_at_idx" ON "auth_device_code" USING btree ("expires_at");