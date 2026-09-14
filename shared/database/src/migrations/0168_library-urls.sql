-- BS#2491 (definitive-release-links epic #2490): the definitive
-- streaming/reference links a music director enters for a release, persisted
-- on the RELEASE rather than a rotation stint. `library_urls` is the
-- release-scoped successor to `rotation_urls`' display half (B3, migration
-- 0164) — same child-table shape (ordered, independently queryable) but keyed
-- to `library.id`, so the links stay visible on the release detail regardless
-- of rotation state.
--
-- Additive. `rotation_urls` is NOT touched by this migration; whether it is
-- migrated into `library_urls` or retired is a separate cleanup ticket.
--
-- library_urls: a child table rather than an array column, unique on
-- (library_id, position) — one URL per slot, so `ORDER BY position` is
-- deterministic and a stale-read `max(position)+1` writer collides instead of
-- silently landing a duplicate slot. The unique index's leading column also
-- serves the FK-lookup role, so there is no separate library_id index.
-- The FK is ON DELETE cascade: deleting a release takes its links with it.
--
-- Lock behavior: CREATE TABLE and the unique index are metadata-only and
-- build/validate against the freshly-created EMPTY table — zero rows, no
-- rewrite, no seq scan of anything with real rows. The one statement that
-- touches an existing table is the FK ADD CONSTRAINT, which takes a
-- ShareRowExclusiveLock on the referenced `library` (blocks writes to
-- `library`, allows reads) held to the COMMIT of the WHOLE pending-migration
-- batch per docs/migrations.md's `single-transaction-migrate` rule — not of
-- this file. Its validation scan is of the referencing `library_urls` (empty),
-- so the hold is a brief lock acquisition, not an O(library-rows) scan.
-- Expected duration: sub-second; longer only if other migrations are pending
-- in the same batch.
--
-- The unique index carries `IF NOT EXISTS` (the one sanctioned hand-edit on a
-- CREATE INDEX per docs/migrations.md) so a re-apply against a database that
-- already has it is a no-op. It is deliberately NOT the CONCURRENTLY
-- out-of-band form the large-table siblings (0164's rotation_card_id_idx,
-- 0139, 0154, 0163) use: this index builds against a fresh EMPTY table, so
-- there is no AccessExclusiveLock on a hot table to pre-empt and no
-- pre-build runbook to run.
--
-- @no-precondition-needed: library_urls_library_id_position_idx and the
-- library_urls.library_id FK both validate against a freshly-created empty
-- table, so no existing row can violate either (safe means an empty match
-- set — the constraints are evaluated against zero rows at apply time).

CREATE TABLE "wxyc_schema"."library_urls" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"url" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wxyc_schema"."library_urls" ADD CONSTRAINT "library_urls_library_id_library_id_fk" FOREIGN KEY ("library_id") REFERENCES "wxyc_schema"."library"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_urls_library_id_position_idx" ON "wxyc_schema"."library_urls" USING btree ("library_id","position");
