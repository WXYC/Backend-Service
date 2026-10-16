-- 0196 re-key `listener_requests_channel_created_idx` to `created_at DESC NULLS FIRST` (BS#2679).
--
-- @intentional-create-revert: 0175 (BS#2661) shipped this index as `created_at
-- DESC NULLS LAST`, which is what drizzle emits for a bare `.desc()`. It is
-- applied and hash-frozen, so the correction is a new migration rather than an
-- edit to 0175 (same precedent as 0153).
--
-- `ORDER BY created_at DESC` means `DESC NULLS FIRST` in Postgres (NULLS FIRST
-- is the DESC default), and a B-tree whose null ordering disagrees with the
-- query's pathkeys is not matched by the planner even when the column is NOT
-- NULL. `GET /internal/listener-requests` (BS#2662, not yet built) will order
-- newest-first, which the NULLS LAST index cannot serve without a sort. See 0153
-- for the measured cost of the same mistake.
--
-- @no-precondition-needed: an index rebuild on `listener_requests`, a table
-- 0175 created that has no rows in any environment yet, so the plain
-- (non-CONCURRENTLY) DROP + CREATE holds its lock for no measurable time and
-- the out-of-band runbook described in 0153's header does not apply.
DROP INDEX "wxyc_schema"."listener_requests_channel_created_idx";--> statement-breakpoint
CREATE INDEX "listener_requests_channel_created_idx" ON "wxyc_schema"."listener_requests" USING btree ("slack_channel_id","created_at" DESC NULLS FIRST);