-- Rollback: 0028_anonymous_devices
-- Original migration: 0028_anonymous_devices.sql
-- Risk level: HIGH
-- Data loss: YES
-- Generated: 2026-02-02
--
-- Description:
-- Reverses the changes made by 0028_anonymous_devices.sql
--
-- Pre-rollback checklist:
-- [ ] Backup created: pg_dump -h $DB_HOST -U $DB_USERNAME -d $DB_NAME -F c -f backup.dump
-- [ ] Team notified
-- [ ] Application impact assessed
-- [ ] Maintenance window scheduled

-- Operations:
-- - Drops table "anonymous_devices" (DATA LOSS)
-- - Drops index "anonymous_devices_device_id_key"

-- BEGIN ROLLBACK

-- Drops table "anonymous_devices" (DATA LOSS)
DROP TABLE IF EXISTS "anonymous_devices" CASCADE;

-- Drops index "anonymous_devices_device_id_key"
DROP INDEX IF EXISTS "anonymous_devices_device_id_key";

-- END ROLLBACK
