-- BS#2569 — unique partial index pinning at most one hourly breakpoint per
-- (show_id, radio_hour).
--
-- `radio_hour` is the top-of-hour marker a breakpoint announces. Two
-- breakpoints claiming the same hour of the same show are never meaningful:
-- the flowsheet renders both, and the mobile clients' hour windows
-- (`computeHourMs`, apps/backend/services/playlist-proxy.service.ts) key on
-- the value, so a duplicate pins the same window twice.
--
-- Cause (measured, not inferred). These are a concurrent-fill race, not
-- pre-#2516 residue. `fillMissingHourlyBreakpoints` re-derives its watermark
-- on every POST /flowsheet, so a *stale* watermark is impossible — but two
-- requests on one show can both read the last breakpoint before either has
-- inserted, and both then generate the same hour. On prod that ran ~1-2% of
-- fills, ~3/month, with one observed pair 706 ms apart.
--
-- WRITER COVERAGE — read this before assuming the constraint is invisible.
-- Four code paths can put a `radio_hour` on a breakpoint row. They do NOT all
-- tolerate this index, and an earlier draft of this header wrongly claimed
-- they did:
--
--   1. TOLERATES — `fillMissingHourlyBreakpoints` (flowsheet.service.ts).
--      a269b724 gave it ON CONFLICT DO NOTHING and made it count what
--      RETURNING hands back rather than `missing.length`, so the losing
--      request drops only the colliding marker and the caller's refetch
--      broadcast still describes what was committed (BS#2621).
--
--   2. DOES NOT TOLERATE — the manual DJ breakpoint. `addEntry`
--      (flowsheet.controller.ts) stamps `nearestStationHour(now)` and calls
--      `addTrack`, a plain insert with no conflict clause. The two clocks
--      disagree by design: the fill FLOORS, `nearestStationHour` ROUNDS. So a
--      track logged at 2:05 PM makes the fill write the 2:00 PM marker, and a
--      DJ pressing Breakpoint any time before 2:30 PM rounds to 2:00 PM and
--      hits 23505. A raw postgres error carries no `status`, so `errorHandler`
--      answers a bare 500. dj-site's one-per-hour guard keys on `message` and
--      is documented unreliable across the :30 boundary. Tracked as a
--      follow-up; the marker the DJ wanted already exists when this fires, so
--      no flowsheet data is lost — the cost is a confusing error, not a gap.
--
--   3. PARTIALLY TOLERATES — the tubafrenzy webhook (internal.route.ts) uses a
--      bare `onConflictDoNothing()`, which catches this index. But its
--      `created` check and follow-up refresh both key on `legacy_entry_id`, so
--      when the conflict is on THIS index (a different entry already owns the
--      hour) the refresh matches no row and the delivery is silently dropped
--      at 200. Not a wedge, but not a no-op either.
--
--   4. DOES NOT CATCH IT — `jobs/flowsheet-etl` and
--      `jobs/flowsheet-april-gap-import` both use TARGETED conflict clauses
--      (`target: flowsheet.legacy_entry_id`), which this index does not
--      satisfy. A tubafrenzy show holding two same-RADIO_HOUR breakpoints
--      raises 23505 and aborts the batch. flowsheet-etl is unscheduled and
--      env-gated; the gap import is dry-run-by-default.
--
-- Building the index before (1) shipped would have been strictly worse — that
-- path runs on EVERY POST /flowsheet, where (2) runs only on a button press.
--
-- Production state when this migration runs: the index ALREADY EXISTS. It was
-- built out-of-band on 2026-09-23 at 15:38 PDT via the command below, after
-- the 25 accumulated duplicate groups were remediated (UPDATE 15 mis-stamped
-- hours + DELETE 20 true duplicates, survivor rule
-- `ORDER BY (dj_name IS NULL), id` so an anonymous auto-generated row never
-- outranks the DJ's own). Build took 24.8 s over 1726 indexable rows on a
-- 1751 MB heap; a show was on air throughout and kept writing.
--
--   SET statement_timeout = 0;
--   CREATE UNIQUE INDEX CONCURRENTLY flowsheet_show_radio_hour_breakpoint_idx
--     ON wxyc_schema.flowsheet (show_id, radio_hour)
--     WHERE entry_type = 'breakpoint' AND radio_hour IS NOT NULL;
--
-- This migration is NOT `CONCURRENTLY` because Drizzle wraps the pending
-- migrations in a transaction and `CREATE INDEX CONCURRENTLY cannot run
-- inside a transaction block` — same constraint as 0057, 0068, 0070, 0071.
-- `IF NOT EXISTS` therefore makes it a no-op against prod, where the index is
-- already present, while fresh dev databases pick it up on first migrate. On
-- an empty dev database the non-concurrent build is instant.
--
-- Scope note for the #702 source-tagged review: this constraint DOES reach
-- tubafrenzy-originated rows — tubafrenzy has its own RADIO_HOUR column
-- (FLOWSHEET_ENTRY_PROD tuple[9], imported by jobs/flowsheet-etl), and 1607 of
-- the 1726 indexed rows carry a `legacy_entry_id`. It is confirmed compatible
-- because one station-ID break per hour is the upstream's semantics too, not
-- because the upstream can't reach these rows. Contrast migration 0071, which
-- constrained (album_id, rotation_bin) on a table where the music director
-- legitimately re-adds a pair, and had to be reverted by 0072.

-- Precondition guard (issue #705). A unique index cannot apply while duplicate
-- groups remain; without this the deploy aborts mid-migration, which is the
-- wedge mode #511 codified the recovery pattern for. The guard fails fast with
-- a readable message inside the migration's transaction, so a clean rollback
-- is the only outcome. Prod measured 0 groups immediately before the
-- out-of-band build.

DO $$
DECLARE dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT show_id, radio_hour
    FROM wxyc_schema.flowsheet
    WHERE entry_type = 'breakpoint' AND radio_hour IS NOT NULL
    GROUP BY show_id, radio_hour
    HAVING COUNT(*) > 1
  ) g;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply flowsheet_show_radio_hour_breakpoint_idx: % duplicate (show_id, radio_hour) breakpoint groups remain. De-duplicate first, keeping the DJ-attributed row (ORDER BY (dj_name IS NULL), id).', dup_count;
  END IF;
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "flowsheet_show_radio_hour_breakpoint_idx" ON "wxyc_schema"."flowsheet" USING btree ("show_id","radio_hour") WHERE "wxyc_schema"."flowsheet"."entry_type" = 'breakpoint' AND "wxyc_schema"."flowsheet"."radio_hour" IS NOT NULL;
