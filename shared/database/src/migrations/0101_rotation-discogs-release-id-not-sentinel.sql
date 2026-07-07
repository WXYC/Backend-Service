-- BS#1429. Add a CHECK constraint on `wxyc_schema.rotation.discogs_release_id`
-- that rejects the `0` sentinel (and any non-positive value).
--
-- Background: Discogs uses `0` nowhere in its real ID space, and LML's
-- caller-side defense (LML#518) 422s on `id <= 0`. Operational
-- verification of BS#1380's backfill on 2026-06-15 surfaced 6 active
-- rotation rows pinned to `discogs_release_id = 0` — all written by
-- the 2026-05-29 bypass-LML operator rescue (the rescue script lived
-- at `/tmp/apply-rotation-backfill.sh` on the EC2 host and is gone;
-- `scripts/relabel-rotation-direct-backfill.sql` documents the lineage
-- in its preamble). Those rows are permanently unresolvable via the
-- BS#1380 daily backfill — they're the entire gap between today's
-- 97.55% resolvable coverage and the >=99% BS#1381 unblock gate.
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
-- pre-date the prod remediation). The UPDATE predicate is `<= 0` to
-- match the CHECK's full rejection set, not just the `= 0` sentinel —
-- any negative-id drift in an older snapshot is cleared rather than
-- left to wedge ALTER TABLE with an opaque check_violation.
--
-- Post-UPDATE state for the 6 sentinel rows: `(discogs_release_id IS
-- NULL, discogs_release_id_source = 'discogs_direct_backfill')`. This
-- inconsistency (source attests a backfill that ended with no id) is
-- preserved as a forensic breadcrumb of the operator rescue. Repaint
-- paths:
--   - rotation-etl UPSERT: only flips the source when tubafrenzy
--     contributes a non-NULL id, and fetch-legacy.ts normalizes
--     tubafrenzy's `<= 0` to NULL, so this path requires a future
--     paste-correction landing a real id.
--   - rotation-release-id-backfill daily cron: SELECTs rows where
--     `discogs_release_id IS NULL` and on a successful LML resolve
--     sets `discogs_release_id_source = 'lml_offline_backfill'`. The
--     6 rows are eligible candidates — so the source CAN flip from
--     `discogs_direct_backfill` to `lml_offline_backfill` whenever
--     LML starts returning a hit. Any follow-up CHECK that pins
--     source-enum to id-NULL semantics must accommodate both states.
--
-- CDC ripple: the UPDATE fires the cdc_rotation trigger (migration 0046)
-- and emits one pg_notify('cdc', ...) event per remediated row. Today's
-- prod count is 6; older RDS snapshots (migrate-dryrun replays) may
-- touch a different count if they predate the manual remediation or
-- contain negative-id drift. The trigger payload is the standard
-- `{table, schema, action: 'UPDATE', data: to_jsonb(NEW), timestamp}`
-- shape from cdc_notify() — no id_old/id_new diff fields; consumers
-- see the post-UPDATE row with `data.discogs_release_id = null`.
--
-- Regression coverage: negative IDs and the `0` sentinel are both
-- exercised in tests/integration/rotation-discogs-release-id-not-sentinel.spec.js.

-- Bound the worst-case lock wait. Without this, the ALTER TABLE below
-- can queue behind any in-flight rotation transaction (rotation-etl
-- cron, addToRotation, picker cache-warm) and block every new reader
-- behind its pending AccessExclusiveLock. 5s gives a fast tick room to
-- finish while preventing a slow tubafrenzy fetch from wedging the
-- deploy on the rotation table for tens of seconds.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- @no-analyze-needed: clears the sentinel set (expected count == 6 on
-- current prod) from a single nullable column with no covering index on
-- its values. Planner stats on discogs_release_id are not load-bearing
-- for any query (reads filter on rotation.id or album_id). Stats drift
-- is immaterial. Predicate matches every non-positive value so an older
-- snapshot with negative-id drift is normalized too.
UPDATE wxyc_schema.rotation
   SET discogs_release_id = NULL
 WHERE discogs_release_id <= 0;
--> statement-breakpoint

-- Precondition guard (issue #705). After the UPDATE above, no row
-- should have `discogs_release_id <= 0`. If any survive, a concurrent
-- writer (operator script, trigger) landed the sentinel between our
-- UPDATE and this check — under PG's default READ COMMITTED isolation
-- the COUNT sees committed concurrent inserts — fail fast with a
-- readable message instead of wedging mid-ALTER.

DO $$
DECLARE sentinel_count int;
BEGIN
  SELECT COUNT(*) INTO sentinel_count
    FROM wxyc_schema.rotation
   WHERE discogs_release_id <= 0;
  IF sentinel_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply rotation_discogs_release_id_not_sentinel: % rotation rows have discogs_release_id <= 0 after the preceding UPDATE. A concurrent writer raced this migration; investigate before retrying.', sentinel_count;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "wxyc_schema"."rotation" ADD CONSTRAINT "rotation_discogs_release_id_not_sentinel" CHECK ("wxyc_schema"."rotation"."discogs_release_id" IS NULL OR "wxyc_schema"."rotation"."discogs_release_id" > 0);
