-- precondition-guard: not-required (constraint is on rotation.discogs_release_id, not on library_identity*; the library_identity reference below is a precedent citation in a comment, not a column/table dependency)
-- BS#1429. Add a CHECK constraint on `wxyc_schema.rotation.discogs_release_id`
-- that rejects the `0` sentinel.
--
-- Background: Discogs uses `0` nowhere in its real ID space, and LML's
-- caller-side defense (LML#518) 422s on `id <= 0`. Operational
-- verification of BS#1380's backfill on 2026-06-15 surfaced 6 active
-- rotation rows pinned to `discogs_release_id = 0` — all written by
-- the 2026-05-29 bypass-LML operator rescue (see
-- `scripts/relabel-rotation-direct-backfill.sql` lines 7-14) as a
-- "we tried to look it up via direct Discogs search and failed"
-- placeholder. Those rows are permanently unresolvable via the BS#1380
-- daily backfill — they're the entire gap between today's 97.55%
-- resolvable coverage and the >=99% BS#1381 unblock gate.
--
-- The CHECK is a schema-level fence so any future operator rescue with
-- the same shape (or any writer drift that silently emits `0`) fails
-- loudly at the DB layer. Writers must supply either a real positive
-- Discogs release ID or NULL.
--
-- Remediation: the 6 zombie rows (ids 8207, 8255, 8256, 9192, 21433,
-- 21584) had `discogs_release_id` cleared to NULL in prod on 2026-06-15
-- ahead of this migration. The same UPDATE is inlined below so the
-- migration is self-contained for any older-snapshot replay (CI's
-- migrate-dryrun job restores the latest RDS snapshot, which may
-- pre-date the prod remediation). Idempotent: no-op against current
-- prod, clears the 6 rows in any older snapshot.
--
-- Mirrors the precedent set by `library_identity_confidence_range`
-- (migration 0075) and `artist_search_alias_variant_nonblank`
-- (migration 0089). Negative IDs are also rejected by the `> 0`
-- predicate; Discogs doesn't issue them in practice, but the broader
-- form costs nothing.

-- @no-analyze-needed: clears the sentinel from <= 6 known rotation
-- rows; touches a single nullable column with no index on its values.
-- Planner stats on discogs_release_id are not load-bearing for any
-- query (no covering index on it; reads filter on rotation.id or
-- album_id). Stats drift is immaterial.
UPDATE wxyc_schema.rotation
   SET discogs_release_id = NULL
 WHERE discogs_release_id = 0;
--> statement-breakpoint

-- Precondition guard (issue #705). After the UPDATE above, no row
-- should have `discogs_release_id = 0`. If any survive, a concurrent
-- writer (operator script, trigger, or race) landed the sentinel
-- between our UPDATE and this check — fail fast with a readable
-- message instead of wedging mid-ALTER.

DO $$
DECLARE sentinel_count int;
BEGIN
  SELECT COUNT(*) INTO sentinel_count
    FROM wxyc_schema.rotation
   WHERE discogs_release_id = 0;
  IF sentinel_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply rotation_discogs_release_id_not_sentinel: % rotation rows have discogs_release_id = 0 after the preceding UPDATE. A concurrent writer raced this migration; investigate before retrying.', sentinel_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_discogs_release_id_not_sentinel" CHECK ("wxyc_schema"."rotation"."discogs_release_id" IS NULL OR "wxyc_schema"."rotation"."discogs_release_id" > 0);
