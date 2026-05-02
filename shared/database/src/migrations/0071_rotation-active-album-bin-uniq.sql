-- #694 unique partial index pinning at most one active rotation row per
-- (album_id, rotation_bin).
--
-- Companion to the rotation-dedupe one-shot job (jobs/rotation-dedupe/),
-- which collapses the historical duplicates that this index would
-- otherwise reject. Tubafrenzy historically allowed multiple rotation
-- entries for the same album over time, and dj-site renders every active
-- row in a bucket — so a single album with 9 active rows surfaces 9
-- times. The dedupe job is the one-time cleanup; this index prevents
-- recurrence.
--
-- The partial WHERE is `kill_date IS NULL` only. The semantically richer
-- predicate `kill_date IS NULL OR kill_date > CURRENT_DATE` is rejected
-- by Postgres because `CURRENT_DATE` is STABLE (not IMMUTABLE) and PG
-- requires index predicates to be IMMUTABLE — the planner needs the
-- predicate to evaluate identically forever for a given row, regardless
-- of when the query runs. Today's product semantics make this a
-- distinction without a difference: every code path that sets kill_date
-- uses `CURRENT_DATE` immediately, so future-dated kills don't occur in
-- practice. If we ever introduce future-dated retirement of rotation
-- rows, the right move is a CHECK constraint that bans them
-- (`kill_date <= CURRENT_DATE`) which keeps `kill_date IS NULL`
-- equivalent to the original intent.
--
-- Production ops:
--   - Run the rotation-dedupe job FIRST. If duplicate active rows still
--     exist, the index build fails with `could not create unique index`.
--   - This is NOT `CREATE UNIQUE INDEX CONCURRENTLY` because Drizzle
--     wraps each migration file in a transaction and `CREATE INDEX
--     CONCURRENTLY cannot run inside a transaction block` — same
--     constraint as 0057, 0061, 0068, 0070.
--   - Build the index out-of-band on prod first via:
--       CREATE UNIQUE INDEX CONCURRENTLY "rotation_active_album_bin_uniq"
--         ON "wxyc_schema"."rotation" ("album_id", "rotation_bin")
--         WHERE kill_date IS NULL;
--     Expected build window on prod: sub-second — the rotation table is
--     small (a few hundred active rows). No AccessExclusiveLock, no
--     INSERT pause. CONCURRENTLY still requires the duplicates to be
--     gone; if the build fails, drop the invalid index and re-run the
--     dedupe.
--   - Then merge this PR. `IF NOT EXISTS` makes the migration apply a
--     no-op against the prod DB where the index is already present, while
--     fresh dev databases pick it up on first migrate. Same shape as 0068
--     and 0070.
--   - If this migration runs against prod *without* the manual
--     CONCURRENTLY pre-build, it would acquire a ShareLock on rotation
--     for the (sub-second) build duration and queue any concurrent
--     INSERT briefly. On the small rotation table that's tolerable, but
--     CONCURRENTLY is still the preferred path.

-- Precondition guard (issue #705). The unique partial index can't apply
-- if duplicate active rows remain. On 2026-05-01 prod had 39 duplicate
-- groups / 237 conflict rows; without this guard the deploy aborts
-- mid-migration and leaves the DB partially modified — exactly the wedge
-- mode #511 codified the recovery pattern for. The guard fails fast with
-- a readable message inside the migration's transaction, so a clean
-- rollback is the only outcome.

DO $$
DECLARE dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT album_id, rotation_bin
    FROM wxyc_schema.rotation
    WHERE kill_date IS NULL
    GROUP BY album_id, rotation_bin
    HAVING COUNT(*) > 1
  ) g;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply rotation_active_album_bin_uniq: % duplicate groups remain. Run rotation-dedupe job first or pre-clean manually.', dup_count;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "rotation_active_album_bin_uniq" ON "wxyc_schema"."rotation" USING btree ("album_id","rotation_bin") WHERE kill_date IS NULL;
