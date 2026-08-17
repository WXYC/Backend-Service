-- BS#2173. Reclassifies the 15 rotation rows carrying `'N'`, then removes the
-- member from `freq_enum`. It was never a WXYC rotation bin.
--
-- Provenance. Migration 0000 created the type correctly as `('S','L','M','H')`
-- — Single, Light, Medium, Heavy, the four bins the music directors assign.
-- Migration 0041 added a fifth under the comment "for tubafrenzy's New
-- rotation type".
--
-- That was a category error, not an invention: tubafrenzy's "New" is flowsheet
-- entry-type code 5, "new vinyl, not yet in rotation" — adjacent to the four
-- bins in that enum but explicitly not one, and the OPPOSITE of a rotation
-- weight. Full account, with the tubafrenzy citations: `freqEnum` in
-- shared/database/src/schema.ts.
--
-- The rotation-release form itself is decisive: `rotationReleaseInsert.jsp`
-- offers exactly four radio buttons (Heavy / Medium / Light / Singles), so the
-- UI that created every one of these rows cannot emit an 'N' at all. And
-- `ROTATION_TYPE` has taken exactly those four values plus the empty string
-- across tubafrenzy's whole history; `'N'` has never appeared once. (Verified 2026-08-17.)
--
-- What the 15 rows are. Having no upstream meaning, `'N'` became the value
-- written whenever an inbound release carried no usable bin, because
-- `rotation.rotation_bin` is NOT NULL and the writers needed *something*. Two
-- writers did this, not one: `internal.route.ts`'s rotation webhook, and
-- `jobs/rotation-etl` (`mapRotationType`, plus a NULL->'N' default in
-- `fetch-legacy.ts`). Both are fixed in the same change as this migration, so
-- the set cannot grow; which of the two wrote these particular 15 is not
-- determined and does not matter, since both convert a blank identically.
--
-- How the replacement bins were derived. Format first, airplay second, and
-- only where airplay can carry the weight:
--
--   * FORMAT decides `S`. `S` is "Singles" (the JSP's own label) — a format
--     distinction, not a rotation weight. Seven of the 15 are singles or EPs:
--     five by explicit 7-inch/12-inch titles, and two (3721, 6344) catalogued
--     in `LIBRARY_RELEASE` with an `[EP]` marker. Format is also by far the
--     strongest predictor available: among contemporaneous releases, 7-inch is
--     100% S (n=205) and 12-inch 80.5% (n=174), against a 3.3% base rate for CD.
--
--   * AIRPLAY decides only H vs L, for the remaining eight. `WEEKLY_PLAY`
--     records real spins for all 15 (6 to 62 plays over 5-7 weeks — they
--     genuinely rotated), and mean plays-per-week for releases added in the
--     same 1999-2001 window separates those two cleanly: H 7.84 vs L 2.49
--     (ROC AUC 0.94). Two rows sit clearly above the H mean; the rest sit at or
--     below L's.
--
-- NO ROW IS ASSIGNED `M`, deliberately. Plays-per-week cannot distinguish M
-- from S at all on this data — AUC 0.52, i.e. a coin flip — and back-testing
-- the nearest-mean rule against the 3,988 contemporaneous releases whose bin
-- IS recorded recovers M only 14% of the time. Assigning a bin the data cannot
-- support is how `'N'` got here in the first place.
--
-- This still reconstructs a weight nobody recorded, and is labelled inference
-- rather than fact for that reason. It was chosen over deleting the rows
-- (which would destroy 15 genuine rotation periods — real add/kill dates, real
-- airplay, real library links — to fix a labelling artifact) and over NULLing
-- them (which needs `rotation_bin` to lose NOT NULL, and reads as "not in
-- rotation" for rows that plainly were).

-- `rotation_bin::text = 'N'` below is deliberate; do NOT simplify it to
-- `rotation_bin = 'N'`. drizzle's programmatic migrate() runs all pending
-- migrations in ONE transaction, so on a fresh database 0041 ADDs 'N' and this
-- file uses it in the same transaction — which Postgres rejects ("unsafe use of
-- new value"). The text cast never constructs the enum value. Production never
-- reproduces this (0041 committed years ago); only fresh databases do — CI, a
-- new clone, a local `db:start`.

-- Fail closed on an unexpected row. The mapping below is specific to 15 known
-- `legacy_rotation_id`s. If production holds an `'N'` row outside that set,
-- something wrote one after this analysis and its correct bin is unknown —
-- abort rather than sweep it into a reclassification it wasn't derived from.
DO $$
DECLARE
  unexpected bigint;
BEGIN
  SELECT count(*) INTO unexpected
    FROM wxyc_schema.rotation
   WHERE rotation_bin::text = 'N'
     AND (legacy_rotation_id IS NULL OR legacy_rotation_id NOT IN
          (3721, 4063, 4149, 4226, 4305, 5774, 5776, 5864, 5944, 6344, 6417, 7057, 7165, 7199, 7701));
  IF unexpected > 0 THEN
    RAISE EXCEPTION
      'Refusing to reclassify: % rotation row(s) carry ''N'' outside the 15 legacy_rotation_ids this migration derived bins for. Investigate before re-running.',
      unexpected;
  END IF;
END $$;--> statement-breakpoint

-- This UPDATE touches 15 rows and adds no distinct values, so it alone does not
-- shift planner stats. The ANALYZE at the bottom is for the TYPE SWAP, which is
-- a different problem. (Deliberately NOT marked `@no-analyze-needed` — that
-- pragma makes check-bulk-update-analyze skip the file wholesale, which would
-- stop it noticing if the ANALYZE were ever deleted.)
UPDATE wxyc_schema.rotation AS r
   SET rotation_bin = m.bin::"public"."freq_enum"
  FROM (VALUES
          -- Singles/EPs. Format, not weight: five state 7-inch/12-inch in the
          -- title; 3721 and 6344 are catalogued in LIBRARY_RELEASE as
          -- "February 4th-14th, 1998 [EP]" and "Danelectro [EP]".
          (6417, 'S'),  -- Kingsbury Manx, "Been Passed Over" 7-inch
          (7165, 'S'),  -- RJD2, "June" 12-inch
          (7701, 'S'),  -- Eyedea & Abilities, "Blindly Firing" 12-inch
          (5776, 'S'),  -- Mates of State / Fighter D, "Leave Me at the Tree" 7-inch
          (5774, 'S'),  -- DJ Honda featuring Jane Doe, "El Presidente" 12-inch
          (6344, 'S'),  -- Yo La Tengo, Danelectro EP
          (3721, 'S'),  -- Long Hind Legs, February 4th-14th, 1998 [EP]
          -- Albums. Airplay, H vs L only (plays/week; H mean 7.84, L mean 2.49).
          (7057, 'H'),  -- Eugene McDaniels, Headless Heroes of the Apocalypse -- 10.3
          (5944, 'H'),  -- Caitlin Cary, Waltzie                              --  9.8
          (4305, 'L'),  -- Will Simmons, Afternoon of a Faun                   --  5.6
          (4149, 'L'),  -- Zen Frisbee, 35,000,000 B.C. Good Enough            --  4.2
          (4226, 'L'),  -- Various Artists, From Mississippi to Chicago        --  3.3
          (4063, 'L'),  -- Various Artists / Kemistry & Storm, DJ Kicks        --  2.0
          (7199, 'L'),  -- Ron Spears & Within Tradition, Grandpa Loved...     --  1.4
          (5864, 'L')   -- Anders Norudde, Himself                             --  1.2
       ) AS m(legacy_rotation_id, bin)
 WHERE r.legacy_rotation_id = m.legacy_rotation_id
   AND r.rotation_bin::text = 'N';--> statement-breakpoint

-- Nothing may carry the value past this point; the type swap below would
-- destroy it via the USING cast.
DO $$
DECLARE
  stranded bigint;
BEGIN
  SELECT count(*) INTO stranded FROM wxyc_schema.rotation WHERE rotation_bin::text = 'N';
  IF stranded > 0 THEN
    RAISE EXCEPTION 'Reclassification left % row(s) still carrying ''N''.', stranded;
  END IF;
END $$;--> statement-breakpoint

-- Swap the type. Two views project `rotation.rotation_bin`
-- (`library_artist_view`, `rotation_library_view`), and Postgres refuses to
-- alter a column a view depends on, so both are dropped and recreated around
-- the swap. Their definitions are captured from the live catalog via
-- `pg_get_viewdef` rather than transcribed here: each is the accumulation of a
-- dozen prior migrations, and a hand-copied body that drifted by one column
-- would silently reshape `/library/search` and the rotation surfaces. Neither
-- drop is CASCADE, so a third dependent object that appears later fails this
-- migration loudly instead of being deleted without trace.
--
-- No index needs handling: nothing indexes `rotation_bin`. (0145's
-- "rotation-bin fallback" indexes are named for the *query* they serve — they
-- are on `flowsheet`, plus a normalized artist/album expression index on
-- `rotation`.) Verified against PG14: all four indexes on `rotation` and both
-- view definitions come out byte-identical across this migration.
--
-- `rotation` is ~21.6k rows, so the table rewrite and both view recreations
-- are near-instant.
DO $$
DECLARE
  library_artist_view_def text;
  rotation_library_view_def text;
BEGIN
  SELECT pg_get_viewdef('wxyc_schema.library_artist_view'::regclass, true)
    INTO STRICT library_artist_view_def;
  SELECT pg_get_viewdef('wxyc_schema.rotation_library_view'::regclass, true)
    INTO STRICT rotation_library_view_def;

  DROP VIEW wxyc_schema.rotation_library_view;
  DROP VIEW wxyc_schema.library_artist_view;

  CREATE TYPE public.freq_enum_without_n AS ENUM ('S', 'L', 'M', 'H');
  ALTER TABLE wxyc_schema.rotation
    ALTER COLUMN rotation_bin TYPE public.freq_enum_without_n
    USING rotation_bin::text::public.freq_enum_without_n;
  DROP TYPE public.freq_enum;
  ALTER TYPE public.freq_enum_without_n RENAME TO freq_enum;

  EXECUTE 'CREATE VIEW wxyc_schema.library_artist_view AS ' || library_artist_view_def;
  EXECUTE 'CREATE VIEW wxyc_schema.rotation_library_view AS ' || rotation_library_view_def;
END $$;

-- Restore planner statistics. `ALTER TABLE ... ALTER COLUMN ... TYPE` rewrites
-- the table and DROPS the column's `pg_stats` row — measured on a prod-shaped
-- table, `EXPLAIN` then estimates 108 rows for a bin that has 5,404. Autoanalyze
-- cannot repair it: a rewrite bumps no counters, so `n_mod_since_analyze` stays
-- 0 and the threshold is never crossed. The stale plan feeds
-- `library-search.service.ts`'s `rotation_bins` filter (the dj-site catalog bin
-- facet), which is the BS#934 failure shape. Do not delete this statement.
ANALYZE wxyc_schema.rotation;
