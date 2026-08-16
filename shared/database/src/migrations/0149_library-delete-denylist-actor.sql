-- precondition-guard: not-required (three nullable columns added to a table this same PR creates in 0146; no constraint, no data invariant, and the table is empty on every environment that has not yet run a delete)
-- BS#2112. Record WHO issued a hard delete, alongside the what/when 0146
-- already captured.
--
-- `DELETE /library/:id` is the most destructive operation in the service and
-- `catalog:write` is held by two roles (musicDirector, stationManager), so a
-- denylist row naming only the release and the timestamp leaves incident
-- response unable to separate a legitimate deletion from an abusive one.
-- These three columns close that: the better-auth user id, the email claim
-- from the same token (kept so the row stays legible after the user row is
-- removed), and the normalized role that was in force.
--
-- All three are nullable, and that is deliberate rather than lazy. A delete
-- performed under `AUTH_BYPASS`, or by a token whose payload carried no `id`,
-- must still record the tombstone — refusing the delete because attribution
-- is unavailable would trade a durable audit gap for a broken endpoint. The
-- write records whatever the token carried and NULLs the rest.
--
-- Separate migration rather than an edit to 0146 because 0146's SQL and
-- snapshot are already generated artifacts with a frozen hash in
-- `meta/applied-hashes.json`; `docs/migrations.md` forbids hand-editing
-- either. Three ADD COLUMNs against a table with no rows on any environment
-- are effectively free — a catalog-only change, no rewrite, no long lock.
--
-- Nothing reads these programmatically. `jobs/library-etl`, the denylist's
-- only consumer, looks at `legacy_release_id` and nothing else.

ALTER TABLE "wxyc_schema"."library_delete_denylist" ADD COLUMN "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_delete_denylist" ADD COLUMN "deleted_by_email" text;--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_delete_denylist" ADD COLUMN "deleted_by_role" text;