-- V_BS_FFFD_CTA: compilation_track_artist U+FFFD-substitution repair for #2152.
--
-- Hand-applied operator script, NOT a Drizzle-tracked migration -- same
-- posture as scripts/audit/bs_replacement_char_recovery.sql (Phase 1/2),
-- scripts/audit/bs_replacement_char_phase35.sql (Phase 3.5), and
-- scripts/audit/bs_replacement_char_phase4.sql (Phase 4, the closest
-- analogue -- read its header before touching this file). docs/migrations.md
-- keeps migrations DDL-only; this is DML, so it lives here and is run via
-- `psql -f` against prod RDS, the same as its three predecessors.
--
-- This is the `compilation_track_artist` half of the 2026-08-13 28-value
-- sweep (#2114 -> PR #2121 covers `library`/`artists`; #2124 covers the two
-- remaining `artists` rows). 14 values here: 11 `track_title`, 3
-- `artist_name`. Same corruption class as the rest of the family -- a
-- literal U+FFFD REPLACEMENT CHARACTER where tubafrenzy's MySQL holds the
-- real byte, frozen residue from the pre-#454 charset bug fixed 2026-04-24
-- (`MirrorSQL.makeSqlCommand` now passes `--default-character-set=utf8`).
-- NOT #1996 -- that ticket is double-encoded CP1252 in this same table,
-- mechanically reversible; this is substitution, the source byte is gone,
-- and the only fix is copying the true value back in from tubafrenzy.
--
-- ============================================================================
-- THE TRAP THIS SCRIPT EXISTS TO AVOID: cta_unique_idx
-- ============================================================================
-- `cta_unique_idx` is UNIQUE on (library_id, artist_name, track_title)
-- (shared/database/src/schema.ts:731) and is PERMANENT per #801 D7 -- this
-- script never touches it. If a corrupt row's correctly-spelled twin
-- already exists in the same compilation (the insert-only ETL writer kept
-- both copies whenever the strings differed -- #1996 measured this holds
-- for 98.5% of its damaged CTA rows), a blanket UPDATE onto the true value
-- raises a unique violation instead of repairing anything. So every row is
-- repaired individually:
--
--   twin already exists at the post-fix (artist_name, track_title) tuple -> DELETE the corrupt row
--   no twin                                                               -> UPDATE the corrupt row in place
--
-- `compilation_track_artist.artist_name` is free text, not an FK to
-- `artists` -- neither `fold_artist_name` (migration 0134) nor migration
-- 0060's `cascade_library_artist_name` trigger reaches these rows. There is
-- no cascade to lean on the way PR #2121 did for `library.artist_name`;
-- every row here is written directly.
--
-- Migration 0099 (`cta_unique_null_track_idx`) closes the NULL-`track_title`
-- duplicate loophole `cta_unique_idx` alone leaves open on PG 14 (prod
-- runtime -- `NULLS NOT DISTINCT` is PG15+). The twin-detection query below
-- uses `IS NOT DISTINCT FROM` for `track_title`, so a NULL-`track_title` twin
-- is caught the same way a non-NULL one is -- see the "NULL track_title" spec
-- cases in the paired integration test.
--
-- ============================================================================
-- WHY THIS SCRIPT IS DATA-DRIVEN, NOT LITERAL LIKE ITS PREDECESSORS
-- ============================================================================
-- Phase 1/2/3.5/4 all bake their exact corrupt/correct string literals
-- straight into the UPDATE statements, because the corrupt rows were
-- enumerable against a local clone. That path is closed here:
-- `dev_env/seed-clone.sql` contains NO `compilation_track_artist` data --
-- the table appears exactly once, in the TRUNCATE list (line 39), with no
-- `COPY ... FROM stdin` block. (This is also why Phase 4's own informational
-- postlude claiming "CTA 0 in the 2026-08-12 clone" was a false negative
-- against an empty table, not evidence the table was clean -- the live count
-- is 14.) Two local tubafrenzy-sourced `library.db` snapshots were checked
-- for a usable ground-truth extract (`lml-cutover-snapshots/prod-20260719`
-- and `.../staging-20260718`, both safely post-2026-04-24): neither is
-- useful here -- `library.db`'s only table is a flat per-RELEASE `library`
-- table (id/title/artist/call_letters/artist_call_number/
-- release_call_number/genre/format/alternate_artist_name/album_artist/label),
-- with no per-track or per-compilation-credit rows at all. There is nothing
-- in either snapshot shaped like `compilation_track_artist`, so this class
-- of ground truth has to come from a live prod Backend read plus either a
-- *newer* library.db snapshot (if one ever gains track-level data) or
-- tubafrenzy MySQL directly.
--
-- So the 14 `(library_id / legacy_release_id, track_position, column,
-- corrupt value, true value)` tuples are captured into the
-- "PENDING CAPTURE" block below as a separate, deadline-bound operator step
-- (see "Capture procedure"), not invented or fuzzy-matched. AS DELIVERED,
-- that block holds a single filtered-out placeholder row -- every statement
-- below is syntactically real and has been run end-to-end against synthetic
-- fixtures (see the paired integration spec), but with ZERO pending rows
-- declared, so running this script as-is against prod today is a genuine,
-- verified no-op. It becomes the actual repair only once an operator fills
-- in the 14 real rows and re-runs it.
--
-- ============================================================================
-- Capture procedure
-- ============================================================================
-- 1. Enumerate the corrupt rows against prod (read-only):
--
--      SELECT cta.library_id, l.legacy_release_id, cta.track_position, cta.artist_name, cta.track_title
--      FROM wxyc_schema.compilation_track_artist cta
--      JOIN wxyc_schema.library l ON l.id = cta.library_id
--      WHERE cta.artist_name LIKE E'%�%' OR cta.track_title LIKE E'%�%'
--      ORDER BY l.legacy_release_id, cta.track_position;
--
--    `cta.library_id` is a Backend `library.id`; tubafrenzy keys on
--    `LIBRARY_RELEASE.ID`, i.e. `legacy_release_id` -- every join to ground
--    truth routes through that column.
--
-- 2. Resolve each row's true string. READ it, never reconstruct it -- these
--    are exactly the diacritic-bearing names where a plausible guess is
--    wrong. In preference order:
--      a. A tubafrenzy-sourced `library.db` snapshot under
--         `lml-cutover-snapshots/`, IF a future snapshot ever gains
--         per-track/compilation-credit data (neither snapshot available
--         while writing this script does -- see above). Confirm the
--         snapshot postdates 2026-04-24 (the #454 charset fix) before
--         trusting it.
--      b. Kattare MySQL directly: `dc1-mysql-01.kattare.com`, database
--         `wxycmusic`. `--default-character-set=utf8` is MANDATORY (the
--         whole corruption class exists because a client once connected
--         without it). Use a MariaDB client, not Homebrew's MySQL 9.x --
--         it segfaults against the 5.1 server.
--
-- 3. Record the exact Unicode codepoint for every non-ASCII character in
--    the resolved string (e.g. PR #2121's `µ` MICRO SIGN, NOT `μ`
--    GREEK SMALL LETTER MU -- visually identical, semantically different,
--    and NFKC/NFKD would silently fold one onto the other). Byte-exact
--    equality is what the downstream catalog-parity harness checks
--    (discogs-etl#346), so an approximately-right glyph is a shipped bug.
--
-- 4. Fill in the PENDING CAPTURE block below: one row per corrupt value,
--    using the enumeration query's own columns for `legacy_release_id` /
--    `track_position` / `current_artist_name` / `current_track_title`, and
--    the resolved true string in whichever of `true_artist_name` /
--    `true_track_title` corresponds to the corrupt column. Leave the other
--    `true_*` column NULL -- it means "this column is not being touched".
--
-- 5. Human-review the filled-in block, then run this whole script.
--
-- Read-only prelude only, stop before any write (mirrors Phase 4's recipe):
--
--   awk '/^BEGIN;/{exit} {print}' scripts/audit/bs_replacement_char_cta.sql \
--     | psql "$DATABASE_URL"
--
-- ============================================================================
-- Mechanism
-- ============================================================================
-- `pending_cta_repair` is a session-local scratch table holding the
-- captured rows. `cta_repair_targets` resolves each pending row against the
-- LIVE table (matched on `library_id` + the row's exact captured
-- `artist_name`/`track_title` -- a combination `cta_unique_idx` /
-- `cta_unique_null_track_idx` already guarantee is unique, so a pending row
-- can structurally match at most one live row) and classifies it
-- twin/no-twin by checking whether another row already holds the post-fix
-- tuple. The classification is computed ONCE, before `BEGIN`, and both the
-- audit prelude and the two write statements read that same materialized
-- table -- so the prelude's SELECT and the writes are the *same* predicate
-- by construction (org data-safety convention), not two independently
-- typed-out copies that could drift apart.
--
-- Idempotency: `cta_repair_targets`'s join to the live table requires the
-- row's `artist_name`/`track_title` to still equal the captured (corrupt)
-- values. Once a row is fixed, that join finds nothing on a re-run --
-- verified in the paired integration spec.
--
-- Not round-trippable: same posture as Phase 1/2/3.5/4. `ef bf bd` is the
-- UTF-8 encoding of U+FFFD itself; the original byte was already destroyed
-- upstream. This script substitutes the tubafrenzy-verified exact original,
-- not a fuzzy/plausible reconstruction.
--
-- Unicode normalization: deliberately NOT applied, matching Phase 4's
-- posture (not Phase 2/3.5's). The true values here are copied byte-for-byte
-- out of tubafrenzy, and the catalog-parity harness that surfaced this issue
-- compares byte-exact with no accent/case folding -- normalizing on write is
-- the one thing that could reintroduce a parity mismatch.
--
-- Sequencing vs #1996: both rewrite CTA rows. #1996 is large and blocked on
-- `library-etl` stopping; this repair is small, frozen residue, and
-- unblocked. Land this first, per #2152's own note, so #1996's twin
-- analysis re-derives after this script's writes, not before.
--
-- Once run, the ETL stays clear of these rows going forward:
-- `importCompilationTracks` (jobs/library-etl/job.ts:765) inserts with
-- `.onConflictDoNothing()` on `cta_unique_idx`, and post-#454 the ETL derives
-- the correct string, so its next insert for a repaired row conflicts and
-- no-ops.
--
-- ============================================================================
-- Session guards. Both matter more here than in a typical script because
-- EVERY predicate below is exact-byte string equality.
--
-- client_encoding: if the operator's psql session resolves to a non-UTF8
-- client encoding, the server reinterprets this file's UTF-8 bytes, every
-- predicate matches zero rows, and the pre-amble reports 0 -- which reads as
-- "already repaired" rather than "matched nothing". Declaring it makes that
-- failure impossible instead of silent.
--
-- ON_ERROR_STOP: without it, an error inside the transaction leaves psql
-- issuing the remaining commands into an aborted transaction, COMMIT
-- degrades to ROLLBACK, and psql still exits 0.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_encoding TO 'UTF8';

-- === STMT: create-pending-table ===
DROP TABLE IF EXISTS pending_cta_repair;
CREATE TEMP TABLE pending_cta_repair (
  legacy_release_id integer,
  track_position text,
  current_artist_name text,
  current_track_title text,
  true_artist_name text,
  true_track_title text
);
-- === END STMT ===

-- === STMT: insert-pending-rows ===
-- ############################################################################
-- PENDING CAPTURE -- replace the placeholder row below with the 14 rows from
-- the capture step above. Columns map 1:1 onto the enumeration query's output
-- (legacy_release_id, track_position, artist_name, track_title) plus the two
-- true_* replacement columns. Leave true_artist_name OR true_track_title NULL
-- for whichever column on that row was NOT corrupt -- never fill in a value
-- you did not read from ground truth.
--
-- Example shape (NOT REAL DATA -- do not copy verbatim):
--   (50340, '3', 'Some Artist', 'La B?te', NULL, 'La Bete'),
-- ############################################################################
INSERT INTO pending_cta_repair
  (legacy_release_id, track_position, current_artist_name, current_track_title, true_artist_name, true_track_title)
VALUES
  (NULL, NULL, NULL, NULL, NULL, NULL); -- placeholder; keeps VALUES syntactically valid with 0 rows captured so far

DELETE FROM pending_cta_repair WHERE legacy_release_id IS NULL; -- drop the placeholder
-- === END STMT ===

-- === STMT: guard-replacement-specified ===
-- Every declared row must actually fix something.
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM pending_cta_repair
   WHERE true_artist_name IS NULL AND true_track_title IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'BS#2152 guard: % declared pending row(s) specify no replacement (both true_artist_name and true_track_title are NULL) -- every row must fix at least one column', n;
  END IF;
END $$;
-- === END STMT ===

-- === STMT: build-targets ===
-- Resolve every pending row against the live table and classify twin/no-twin.
-- Computed once; the prelude SELECTs below and the two write statements
-- further down all read this same table, so they see the identical row set.
DROP TABLE IF EXISTS cta_repair_targets;
CREATE TEMP TABLE cta_repair_targets AS
SELECT
  p.legacy_release_id,
  p.track_position,
  cta.id,
  cta.library_id,
  cta.artist_name AS old_artist_name,
  cta.track_title AS old_track_title,
  COALESCE(p.true_artist_name, cta.artist_name) AS new_artist_name,
  COALESCE(p.true_track_title, cta.track_title) AS new_track_title,
  EXISTS (
    SELECT 1
      FROM wxyc_schema.compilation_track_artist other
     WHERE other.library_id = cta.library_id
       AND other.id <> cta.id
       AND other.artist_name = COALESCE(p.true_artist_name, cta.artist_name)
       AND other.track_title IS NOT DISTINCT FROM COALESCE(p.true_track_title, cta.track_title)
  ) AS has_twin
FROM pending_cta_repair p
JOIN wxyc_schema.library l ON l.legacy_release_id = p.legacy_release_id
JOIN wxyc_schema.compilation_track_artist cta
  ON cta.library_id = l.id
 AND cta.artist_name = p.current_artist_name
 AND cta.track_title IS NOT DISTINCT FROM p.current_track_title;
-- === END STMT ===

-- === STMT: guard-ambiguous-match ===
-- A pending row resolving to more than one live row should be impossible --
-- (library_id, artist_name, track_title) is exactly cta_unique_idx's key
-- (cta_unique_null_track_idx for the NULL-track_title case) -- but this is
-- asserted defensively rather than assumed. Also catches an accidental
-- duplicate entry in the pending block itself (both pending copies would
-- resolve to the same live row, tripping this the same way).
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT legacy_release_id, old_artist_name, old_track_title, COUNT(*) AS n
      FROM cta_repair_targets
     GROUP BY legacy_release_id, old_artist_name, old_track_title
    HAVING COUNT(*) > 1
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% artist_name=% track_title=% matched % live compilation_track_artist rows (or the pending block has a duplicate entry) -- cta_unique_idx / cta_unique_null_track_idx should make this impossible; investigate before proceeding', bad.legacy_release_id, bad.old_artist_name, bad.old_track_title, bad.n;
  END LOOP;
END $$;
-- === END STMT ===

-- ===========================================================
-- Pre-amble: declared rows, BEFORE classification, BEFORE residual counts.
-- Same predicate the writes use, per the org data-safety convention --
-- literally the same materialized table, not a re-typed copy.
-- ===========================================================
SELECT '=== V_BS_FFFD_CTA pre-amble: declared pending rows (0 = capture step not yet run) ===' AS section;
SELECT COUNT(*) AS pending_declared FROM pending_cta_repair;

SELECT 'BEFORE — matched rows + twin classification' AS section;
SELECT legacy_release_id, track_position, id AS cta_id, old_artist_name, old_track_title,
       new_artist_name, new_track_title,
       CASE WHEN has_twin THEN 'DELETE (twin exists)' ELSE 'UPDATE (no twin)' END AS action
  FROM cta_repair_targets
 ORDER BY legacy_release_id, track_position;

SELECT 'INFO — declared pending rows that did NOT match a live row (already-fixed re-run, or a capture mismatch)' AS section;
SELECT p.legacy_release_id, p.track_position, p.current_artist_name, p.current_track_title
  FROM pending_cta_repair p
  LEFT JOIN wxyc_schema.library l ON l.legacy_release_id = p.legacy_release_id
  LEFT JOIN wxyc_schema.compilation_track_artist cta
    ON cta.library_id = l.id
   AND cta.artist_name = p.current_artist_name
   AND cta.track_title IS NOT DISTINCT FROM p.current_track_title
 WHERE cta.id IS NULL;

SELECT 'BEFORE — overall residual U+FFFD, wxyc_schema.compilation_track_artist (desired end state: 0 / 0)' AS section;
SELECT (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE artist_name LIKE E'%�%') AS artist_name_residual,
       (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE track_title LIKE E'%�%') AS track_title_residual;

-- ===========================================================
-- Transactional write block.
-- ===========================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

-- === STMT: delete-twins ===
-- The clean twin already carries the truth; the corrupt row is redundant.
-- Re-checks old_artist_name/old_track_title so a second run (where the row
-- no longer matches, having already been deleted) is a genuine no-op.
DELETE FROM wxyc_schema.compilation_track_artist cta
USING cta_repair_targets t
WHERE cta.id = t.id
  AND t.has_twin
  AND cta.artist_name = t.old_artist_name
  AND cta.track_title IS NOT DISTINCT FROM t.old_track_title;
-- === END STMT ===

-- === STMT: update-no-twins ===
-- No twin exists; safe to rewrite in place. Same re-check for idempotency.
UPDATE wxyc_schema.compilation_track_artist cta
   SET artist_name = t.new_artist_name,
       track_title = t.new_track_title
  FROM cta_repair_targets t
 WHERE cta.id = t.id
   AND NOT t.has_twin
   AND cta.artist_name = t.old_artist_name
   AND cta.track_title IS NOT DISTINCT FROM t.old_track_title;
-- === END STMT ===

COMMIT;

-- ===========================================================
-- Post-amble verify: every targeted row should show residual=0, and the
-- overall predicate should return 0/0 -- the desired end state per #2152.
-- ===========================================================
SELECT '=== V_BS_FFFD_CTA post-amble: residual count per targeted row (expect 0) ===' AS section;
SELECT t.legacy_release_id, t.track_position,
       (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist cta
         WHERE cta.library_id = t.library_id
           AND cta.artist_name = t.old_artist_name
           AND cta.track_title IS NOT DISTINCT FROM t.old_track_title) AS residual
  FROM cta_repair_targets t
 ORDER BY t.legacy_release_id, t.track_position;

SELECT 'AFTER — overall residual U+FFFD, wxyc_schema.compilation_track_artist (desired end state: 0 / 0)' AS section;
SELECT (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE artist_name LIKE E'%�%') AS artist_name_residual,
       (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE track_title LIKE E'%�%') AS track_title_residual;

-- Broader-table informational sweep (rotation/flowsheet/artists/library)
-- already lives in bs_replacement_char_phase4.sql's postlude -- not repeated
-- here, this script is scoped to compilation_track_artist only.

-- === STMT: analyze ===
-- Refresh planner stats (BS#934 -- omitting this after #863's migration
-- regressed /flowsheet/suggest/* to 5s timeouts). ANALYZE cannot run inside
-- a transaction, so it lives here, outside any BEGIN/COMMIT. See
-- docs/bulk-update-playbook.md for the full pattern.
ANALYZE wxyc_schema.compilation_track_artist;
-- === END STMT ===
