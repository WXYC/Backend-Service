-- Verification SQL for jobs/rotation-release-id-backfill (BS#1029).
--
-- Run after a `docker run ... rotation-release-id-backfill:latest` invocation
-- to confirm the job's counters match the database state:
--
--   backfill_attribution  ≈ resolved (from the job's `step: finished` log line)
--   active_resolved       ≈ backfill_attribution + paste_verified
--   active_rows           ≈ ticket-documented 310 (drifts as rotation pool changes)
--
-- The job's counters are the source of truth for what happened DURING the run;
-- this SQL is the post-condition check for what's in the database NOW.
--
-- Invocation (verified working on the BS EC2 host post-2026-05-29 deploy):
--
--   ssh wxyc-ec2 'docker run --rm -i --env-file .env --network host \
--     postgres:15-alpine sh -c "psql \"postgresql://\$DB_USERNAME:\$DB_PASSWORD@\$DB_HOST:\$DB_PORT/\$DB_NAME\""' \
--     < scripts/verify-rotation-release-id-backfill.sql
--
-- Why the docker indirection: `source .env; psql ...` on the host fails with
-- `password authentication failed` because shell quoting mangles the DB
-- password during `source`. Docker's `--env-file` parser injects the value
-- verbatim, matching what `docker run --env-file .env <backend>` already does
-- in the deploy path. postgres:15-alpine is just an ergonomic way to ship
-- `psql` to the host without installing it. `--network host` is required so
-- the container can reach the RDS endpoint from inside the VPC.
--
-- If you have prod PG creds locally:
--   psql "<prod-pg-url>" -f scripts/verify-rotation-release-id-backfill.sql
--
-- See WXYC/Backend-Service#1029 + jobs/rotation-release-id-backfill/README.md.

SELECT
  COUNT(*)
    FILTER (WHERE kill_date IS NULL OR kill_date > CURRENT_DATE)
    AS active_rows,
  COUNT(*)
    FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
            AND discogs_release_id IS NOT NULL)
    AS active_resolved,
  COUNT(*)
    FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill')
    AS backfill_attribution,
  COUNT(*)
    FILTER (WHERE discogs_release_id_source = 'tubafrenzy_paste'
            AND discogs_release_id IS NOT NULL)
    AS paste_verified
FROM wxyc_schema.rotation;
