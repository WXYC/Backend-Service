-- Custom SQL migration file, put your code below! --

-- COMMENT ON COLUMN annotations for the DJ-name / real-name PII boundary.
--
-- DDL-only, no ALTER TABLE — five `COMMENT ON COLUMN` statements pinning
-- the distinction docs/pii.md documents in full: `auth_user.real_name` is
-- the sole legal-name (PII) carrier; `auth_user.name`, `flowsheet.dj_name`,
-- `shows.legacy_dj_name`, and `shows.dj_name_override` all hold the public
-- on-air handle and must never carry a legal name. See docs/pii.md for the
-- registry and enforcement pointers (the `wxyc/restricted-real-name` ESLint
-- rule, the dj-real-name-sentinel spec).
--
-- Generated via `drizzle-kit generate --custom` (no Drizzle-modeled schema
-- diff for a bare COMMENT ON) — see docs/migrations.md's "DDL-only
-- migrations via `drizzle-kit generate --custom`" section for the full
-- recipe (the applied-hashes.json move-aside workaround, the public vs.
-- wxyc_schema qualification trap, the journal `when` rule, freeze-hashes).

COMMENT ON COLUMN "public"."auth_user"."real_name" IS
  'PII: legal name, collected as a legal requirement; never on a public wire; see docs/pii.md';

COMMENT ON COLUMN "public"."auth_user"."name" IS
  'Display handle/username — NOT the legal name; real_name is. Backfill pending (jobs/auth-user-name-backfill); see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."flowsheet"."dj_name" IS
  'Public on-air handle; never a legal name; see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."shows"."legacy_dj_name" IS
  'Public on-air handle sourced from tubafrenzy DJ_HANDLE; never a legal name; see docs/pii.md';

COMMENT ON COLUMN "wxyc_schema"."shows"."dj_name_override" IS
  'Public on-air handle override, operator-supplied; never a legal name; see docs/pii.md';
