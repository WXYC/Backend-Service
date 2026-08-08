-- 0141 BS#2045 — durable roster of Slack users authorized to ban request-line abusers.
--
-- Replaces request-o-matic's `SLACK_BAN_AUTHORIZED_USERS` env var, which could only be
-- edited by a Railway redeploy. Read and replaced through the X-Internal-Key-gated
-- `/internal/slack-ban-moderators` surface; edited from Slack via ROM's `/request-mods`
-- modal (WXYC/request-o-matic#240).
--
-- Bare CREATE TABLE against a table that does not yet exist: no lock contention, no
-- backfill job, no companion DML. Expected duration is milliseconds. PG14-compatible
-- syntax throughout (prod RDS is 14.22 while dev/CI run 18 — see docs/migrations.md).
--
-- `added_by_slack_user_id` is an audit column, deliberately NOT a foreign key: a Slack
-- user has no `auth_user` row, the same reason `banned_fingerprints.banned_by_user_id`
-- is NULL on every Slack-originated ban.
--
-- The two CHECK constraints pin the uppercase-alphanumeric Slack-ID shape the route's
-- differential replace DEPENDS on: it folds the live set to uppercase when comparing
-- against `expectedCurrent`, but deletes with plain varchar equality, so a row stored
-- in any other case would be folded into a match on read and then miss the DELETE's
-- exclusion list — deleted and reinserted, silently rewriting the audit columns the
-- differential replace exists to preserve, with the diff log reporting no removal.
-- Enforcing the shape here means no manual fix-up, import, or future second writer can
-- create that row.
--
-- No precondition guard: Check 8 (scripts/validate-migrations.mjs) scopes constraint
-- preconditions to constraints ADDED to an existing table. Both CHECKs and the PRIMARY
-- KEY here are evaluated against zero rows by construction.

CREATE TABLE "wxyc_schema"."slack_ban_moderators" (
	"slack_user_id" varchar(64) PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by_slack_user_id" varchar(64),
	CONSTRAINT "slack_ban_moderators_slack_user_id_upper_ck" CHECK ("wxyc_schema"."slack_ban_moderators"."slack_user_id" ~ '^[A-Z0-9]+$'),
	CONSTRAINT "slack_ban_moderators_added_by_upper_ck" CHECK ("wxyc_schema"."slack_ban_moderators"."added_by_slack_user_id" IS NULL OR "wxyc_schema"."slack_ban_moderators"."added_by_slack_user_id" ~ '^[A-Z0-9]+$')
);
