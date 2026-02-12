-- Rollback: 0020_sticky_alex_power
-- Original migration: 0020_sticky_alex_power.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0020_sticky_alex_power.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops table "auth_account" (DATA LOSS)
-- - Drops table "auth_invitation" (DATA LOSS)
-- - Drops table "auth_jwks" (DATA LOSS)
-- - Drops table "auth_member" (DATA LOSS)
-- - Drops table "auth_organization" (DATA LOSS)
-- - Drops table "auth_session" (DATA LOSS)
-- - Drops table "auth_user" (DATA LOSS)
-- - Drops table "auth_verification" (DATA LOSS)
-- - Drops index "auth_account_provider_account_key"
-- - Drops index "auth_invitation_email_idx"
-- - Drops index "auth_member_org_user_key"
-- - Drops index "auth_organization_slug_key"
-- - Drops index "auth_session_token_key"
-- - Drops index "auth_user_email_key"
-- - Drops index "auth_user_username_key"

-- BEGIN ROLLBACK

-- Drops table "auth_account" (DATA LOSS)
DROP TABLE IF EXISTS "auth_account" CASCADE;

-- Drops table "auth_invitation" (DATA LOSS)
DROP TABLE IF EXISTS "auth_invitation" CASCADE;

-- Drops table "auth_jwks" (DATA LOSS)
DROP TABLE IF EXISTS "auth_jwks" CASCADE;

-- Drops table "auth_member" (DATA LOSS)
DROP TABLE IF EXISTS "auth_member" CASCADE;

-- Drops table "auth_organization" (DATA LOSS)
DROP TABLE IF EXISTS "auth_organization" CASCADE;

-- Drops table "auth_session" (DATA LOSS)
DROP TABLE IF EXISTS "auth_session" CASCADE;

-- Drops table "auth_user" (DATA LOSS)
DROP TABLE IF EXISTS "auth_user" CASCADE;

-- Drops table "auth_verification" (DATA LOSS)
DROP TABLE IF EXISTS "auth_verification" CASCADE;

-- Drops index "auth_account_provider_account_key"
DROP INDEX IF EXISTS "auth_account_provider_account_key";

-- Drops index "auth_invitation_email_idx"
DROP INDEX IF EXISTS "auth_invitation_email_idx";

-- Drops index "auth_member_org_user_key"
DROP INDEX IF EXISTS "auth_member_org_user_key";

-- Drops index "auth_organization_slug_key"
DROP INDEX IF EXISTS "auth_organization_slug_key";

-- Drops index "auth_session_token_key"
DROP INDEX IF EXISTS "auth_session_token_key";

-- Drops index "auth_user_email_key"
DROP INDEX IF EXISTS "auth_user_email_key";

-- Drops index "auth_user_username_key"
DROP INDEX IF EXISTS "auth_user_username_key";

-- END ROLLBACK
