-- BS#1261 — banned_fingerprints table for request-line ban enforcement.
--
-- Ban-target is a stable iOS-generated UUIDv4 stored in iCloud Keychain
-- (separate item from AuthSession), sent on every `POST /request` to ROM
-- and on `/sign-in/anonymous`. Per-fingerprint rather than per-`user.id`
-- because better-auth anonymous re-sign-in mints a fresh `user.id`, so a
-- `user.banned`-only ban is one tap away from evasion.
--
-- `banned_by_user_id` references auth_user.id with ON DELETE SET NULL so
-- deleting an operator account doesn't cascade-delete ban history. NULL
-- when the actor is a Slack user (no corresponding better-auth user).
--
-- Partial index on `ban_expires_at` covers the temporary-ban tail; the
-- permanent rows (NULL `ban_expires_at`) are the common case and don't
-- need the index.
--
-- @no-precondition-needed: fresh CREATE TABLE; no existing rows to violate
-- the NOT NULL / FK constraints. CREATE INDEX is on an empty table so no
-- AccessExclusiveLock concern; CONCURRENTLY is unnecessary.

CREATE TABLE "wxyc_schema"."banned_fingerprints" (
  "fingerprint" uuid PRIMARY KEY NOT NULL,
  "banned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ban_reason" text NOT NULL,
  "ban_expires_at" timestamp with time zone,
  "banned_by_user_id" varchar(255),
  CONSTRAINT "banned_fingerprints_banned_by_user_id_auth_user_id_fk"
    FOREIGN KEY ("banned_by_user_id") REFERENCES "public"."auth_user"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION
);--> statement-breakpoint
CREATE INDEX "banned_fingerprints_ban_expires_at_idx"
  ON "wxyc_schema"."banned_fingerprints" USING btree ("ban_expires_at")
  WHERE "wxyc_schema"."banned_fingerprints"."ban_expires_at" IS NOT NULL;
