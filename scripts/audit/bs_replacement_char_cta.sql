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
-- OPERATOR-ERROR GUARDS (PR #2154 review)
-- ============================================================================
-- Seven DO-block guards (five from round 1, two added in round 2's review)
-- run before the corresponding mistake can do damage, each aborting loudly
-- (`\set ON_ERROR_STOP on`, so a RAISE EXCEPTION here stops the whole psql
-- run with a nonzero exit and no partial write). Listed in the order they
-- actually run:
--
--   guard-placeholder-scrub      -- a captured row with a blank
--                                    legacy_release_id survived the
--                                    exact-placeholder scrub -- a paste
--                                    error, not the shipped row.
--   guard-replacement-specified  -- a declared row fixes nothing (both
--                                    true_* columns NULL).
--   guard-capture-sanity         -- a declared row's current_*/true_* pair
--                                    looks transposed: current_* lacks
--                                    U+FFFD, or true_* contains it. The
--                                    capture procedure's clipboard step puts
--                                    BOTH strings on the clipboard at once
--                                    for each of the 14 hand-pasted rows, so
--                                    a swap on any one of them is one slip
--                                    away. Unguarded, a transposed row would
--                                    match the CLEAN live row (its
--                                    current_* equals the clean value),
--                                    compute the CORRUPT string as its
--                                    post-fix tuple, find the genuinely
--                                    corrupt row as its twin, and DELETE the
--                                    clean row -- exit 0, no error, and the
--                                    postlude's residual counts go UP (reads
--                                    like a capture mismatch, not data
--                                    loss). Also structurally catches the
--                                    wrong-client_encoding scenario the
--                                    session guards below worry about -- a
--                                    misdecoded session turns every U+FFFD
--                                    predicate into a false negative the
--                                    same way a transposed pair does.
--   guard-nfc-form                -- a declared true_* replacement is not in
--                                    NFC Unicode normalization form (round 2
--                                    MEDIUM finding). Twin detection below
--                                    joins on exact byte equality, so a
--                                    true_* value pasted out of a source that
--                                    yields a different normalization form
--                                    (e.g. NFD) can silently miss a live twin
--                                    already stored in NFC -- the row
--                                    classifies no-twin, the UPDATE writes a
--                                    byte-distinct duplicate, and
--                                    cta_unique_idx does not fire because the
--                                    two rows are not byte-identical. A
--                                    capture-time rejection, not a write-time
--                                    normalization -- preserves the byte-exact
--                                    write posture documented under
--                                    "Unicode normalization" below.
--   guard-post-fix-fffd           -- (runs after build-targets, inside the
--                                    transaction) a row's post-fix tuple
--                                    (new_artist_name / new_track_title)
--                                    still contains U+FFFD (round 2 HIGH
--                                    finding). new_* is
--                                    COALESCE(true_*, cta.*), so a row
--                                    corrupt in BOTH columns but captured
--                                    with only one true_* replacement leaves
--                                    the untouched column's U+FFFD in the
--                                    write -- silently destroying data if a
--                                    twin happens to match on the fixed
--                                    column alone, or silently leaving a
--                                    corrupt column behind if not. See step 4
--                                    of the capture procedure below for the
--                                    correct one-row-carries-both-values
--                                    shape this guard enforces.
--   guard-ambiguous-match         -- a pending row resolves to more than one
--                                    LIVE row (structurally impossible under
--                                    cta_unique_idx / cta_unique_null_track_idx,
--                                    asserted defensively; also catches an
--                                    accidental duplicate pending entry that
--                                    both resolve to the SAME live row).
--   guard-converging-pending      -- two (or more) pending rows resolve to
--                                    the SAME post-fix (library_id,
--                                    artist_name, track_title) tuple as EACH
--                                    OTHER, live twin or not. #2114
--                                    established the damage is per-row
--                                    (`La Forêt` survived the same 0xEA
--                                    byte that killed `La Bête`), and #1996
--                                    measured the double-ingest shape (two
--                                    differently-corrupted copies of one
--                                    credit) at 98.5% of this table's
--                                    damaged rows -- so two convergent
--                                    pending rows is the EXPECTED shape, not
--                                    an exotic one. `guard-ambiguous-match`
--                                    cannot catch this -- it groups on the
--                                    OLD (corrupt) tuple, which differs
--                                    between the two rows; this groups on
--                                    the resolved NEW (post-fix) tuple
--                                    instead. Without it, both rows classify
--                                    independently as no-twin and both land
--                                    in the single set-based
--                                    update-no-twins UPDATE, which raises a
--                                    raw 23505 instead of a named guard
--                                    message identifying which rows
--                                    collided. Deliberately over-broad: it
--                                    aborts even when both converging rows
--                                    classify has_twin=true, where the two
--                                    DELETEs would actually be collision-free
--                                    -- see the guard's own comment below for
--                                    why that's left alone in this PR.
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
--    Known gap, deliberately deferred (PR #2154 review): Phase 4's
--    strongest guard against exactly this mistake was an automated
--    byte-assertion that the SCRIPT TEXT itself uses the correct codepoints
--    (the `µ` U+00B5 vs `μ` U+03BC trap, exercised in
--    bs-replacement-char-phase4.spec.js). That guard can't be written here
--    yet -- there is no script text to assert against until an operator has
--    actually captured and pasted the 14 real values (see "WHY THIS SCRIPT
--    IS DATA-DRIVEN" above). Whoever fills in the PENDING CAPTURE block
--    should add that same byte-assertion test as part of that follow-up --
--    this is a known, named gap, not a silent omission. The INVERSE is
--    enforced today (PR #2154 review round 2): the paired integration
--    spec's "still just the all-NULL placeholder" test asserts the shipped
--    `insert-pending-rows` block carries no quoted string literals, so it
--    goes red the moment real rows land -- whoever fills in this block
--    cannot do so without also updating that test, which is exactly where
--    the deferred byte-assertion belongs.
--
-- 4. Fill in the PENDING CAPTURE block below: ONE ROW PER CORRUPT LIVE ROW
--    (not one row per corrupt VALUE), using the enumeration query's own
--    columns for `legacy_release_id` / `track_position` /
--    `current_artist_name` / `current_track_title`. If the row is corrupt in
--    only ONE column, put the resolved true string in that column's
--    `true_*` slot and leave the OTHER `true_*` column NULL -- it means
--    "this column is not being touched". If the row is corrupt in BOTH
--    columns (the enumeration query's own `artist_name` AND `track_title`
--    both match the U+FFFD pattern), that SAME single row must carry BOTH
--    `true_artist_name` AND `true_track_title` -- do NOT split one corrupt
--    row into two separate pending rows, one per column. A split capture
--    leaves each row's untouched column still corrupt in its computed
--    post-fix tuple; `guard-post-fix-fffd` now catches that directly (round
--    2 HIGH finding -- see the guard list above), and in the twin-existing
--    case a split capture can also converge onto `guard-ambiguous-match`
--    with a message that, for this specific cause, misleadingly blames
--    `cta_unique_idx` rather than the split itself.
--
-- 5. Human-review the filled-in block, then run this whole script.
--
-- Read-only prelude, stop before any write:
--
--   awk '/^BEGIN;/{exit} {print}' scripts/audit/bs_replacement_char_cta.sql \
--     | psql "$DATABASE_URL"
--
-- This shows the declared-row count (plus the matched/unmatched split, PR
-- #2154 review round 2) and the two full-table informational checks
-- (unmatched pending rows, overall residual count) -- it does NOT show the
-- twin/no-twin classification, because that classification (`build-targets`)
-- now runs INSIDE the transaction (see "Mechanism" below, PR #2154 review
-- round 1). To preview the FULL classification and writes without persisting
-- anything, run the script with its `COMMIT;` swapped for `ROLLBACK;` --
-- this executes the real guards and the real DELETE/UPDATE inside a real
-- transaction (so a would-be `cta_unique_idx` violation surfaces exactly as
-- it would for real), including the post-amble's residual counts (moved to
-- run BEFORE `COMMIT;`/`ROLLBACK;` in round 2 -- see the comment above the
-- post-amble further down for why that move was necessary, not optional),
-- then discards everything:
--
--   sed 's/^COMMIT;$/ROLLBACK;/' scripts/audit/bs_replacement_char_cta.sql \
--     | psql "$DATABASE_URL"
--
-- `ANALYZE` still runs after the ROLLBACK -- harmless, it only refreshes
-- planner stats, never data. It also runs perfectly well INSIDE a
-- transaction (see the `analyze` STMT block's own comment near the bottom
-- for why it stays outside this one anyway).
--
-- ============================================================================
-- Mechanism
-- ============================================================================
-- `pending_cta_repair` is a session-local scratch table holding the
-- captured rows, sanity-checked (`guard-capture-sanity`) before it is ever
-- joined against the live table. `cta_repair_targets` resolves each pending
-- row against the LIVE table (matched on `library_id` + the row's exact
-- captured `artist_name`/`track_title` -- a combination `cta_unique_idx` /
-- `cta_unique_null_track_idx` already guarantee is unique, so a pending row
-- can structurally match at most one live row) and classifies twin/no-twin
-- by resolving the twin's OWN row id (`twin_id`), not just its existence --
-- this also carries over the twin's `track_artist_id` /
-- `track_artist_link_confidence` / `track_artist_link_method` /
-- `track_position` so the DELETE branch can preserve the corrupt row's
-- identity link onto the twin (see `delete-twins` below) and the BEFORE
-- print can show both sides.
--
-- Classification now runs INSIDE the transaction -- `BEGIN` precedes
-- `build-targets`, not the reverse (PR #2154 review round 1). `library-etl`'s
-- `importCompilationTracks` writes this table every 30 minutes; classifying
-- before `BEGIN` left a window where a concurrent insert of a clean twin
-- between classification and the write could flip a no-twin row's UPDATE
-- into a live 23505 mid-run. The audit prelude's "matched rows" SELECT and
-- the two write statements now all read the SAME `cta_repair_targets`,
-- materialized inside the SAME transaction -- so they are the *same*
-- predicate by construction (org data-safety convention), not independently
-- typed-out copies that could drift apart.
--
-- What this buys is atomicity, NOT elimination of the race window (round 2
-- correction -- the round 1 text overclaimed "no window between classifying
-- a row and acting on that classification"). `CREATE TEMP TABLE ... AS
-- SELECT` under READ COMMITTED takes no row lock, and every later statement
-- in this script takes its own fresh snapshot, so `library-etl` can still
-- commit a clean twin (or a librarian can still hand-edit the row) between
-- `build-targets` and `update-no-twins`/`delete-twins`/`repoint-twin-identity`
-- -- and the re-check re-checks each of those three statements carry (see
-- their own comments; `repoint-twin-identity`'s was added in round 2) exist
-- precisely because that window is real. The narrowing is real too: what
-- used to be a live, unguarded write racing a live table is now a
-- transaction that either commits a fully self-consistent set of writes or
-- rolls back the whole thing cleanly on any surprise -- narrowed and made
-- fail-safe, not race-free.
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
-- failure impossible instead of silent. `guard-capture-sanity` below is a
-- second, independent line of defense against the same failure mode.
--
-- ON_ERROR_STOP: without it, an error inside the transaction leaves psql
-- issuing the remaining commands into an aborted transaction, COMMIT
-- degrades to ROLLBACK, and psql still exits 0.
-- ============================================================================
\set ON_ERROR_STOP on
SET client_encoding TO 'UTF8';

-- === STMT: create-pending-table ===
DROP TABLE IF EXISTS pg_temp.pending_cta_repair;
CREATE TEMP TABLE pending_cta_repair (
  legacy_release_id integer,
  track_position varchar(20),
  current_artist_name varchar(255),
  current_track_title varchar(255),
  true_artist_name varchar(255),
  true_track_title varchar(255)
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
-- Example shape (NOT REAL DATA -- do not copy verbatim; corrected in PR
-- #2154 review round 2 -- the prior example modeled the exact accent-
-- stripping approximation step 3 above forbids, `?` -> `e`, not a genuine
-- U+FFFD substitution, and would have been rejected by guard-capture-sanity
-- outright). This shows the track_title-only-corrupt case: current_*
-- carries the real U+FFFD REPLACEMENT CHARACTER (not a `?`), true_track_title
-- carries the resolved accented string read from ground truth, and
-- true_artist_name is left NULL because artist_name on this row was never
-- corrupted:
--   (50340, '3', 'Csillagrablók', 'Rem�nytelen T�nc', NULL, 'Reménytelen Tánc'),
-- ############################################################################
INSERT INTO pending_cta_repair
  (legacy_release_id, track_position, current_artist_name, current_track_title, true_artist_name, true_track_title)
VALUES
  (NULL, NULL, NULL, NULL, NULL, NULL); -- placeholder; keeps VALUES syntactically valid with 0 rows captured so far

-- Scrub ONLY the exact placeholder shape (every column NULL) -- MEDIUM
-- finding (PR #2154 review). A genuinely captured row that happens to carry
-- a blank legacy_release_id (a paste slip, NOT the placeholder) still has
-- non-NULL data in at least one other column, so it survives this DELETE
-- and is caught by the dedicated guard-placeholder-scrub block below
-- instead of being silently swept away alongside the real placeholder.
DELETE FROM pending_cta_repair
 WHERE legacy_release_id IS NULL
   AND track_position IS NULL
   AND current_artist_name IS NULL
   AND current_track_title IS NULL
   AND true_artist_name IS NULL
   AND true_track_title IS NULL;
-- === END STMT ===

-- === STMT: guard-placeholder-scrub ===
-- Anything still holding a NULL legacy_release_id after the exact-placeholder
-- scrub above is not the shipped placeholder (already removed) -- it is a
-- capture paste error: a real row missing the one column the whole repair
-- joins on. Previously `pending_declared` was counted AFTER an unconditional
-- `WHERE legacy_release_id IS NULL` delete, so nothing distinguished "14
-- captured" from "13 captured + 1 silently dropped" (PR #2154 review
-- reproduction: 2 captured rows, one with a blank legacy_release_id ->
-- INSERT 0 2, DELETE 1, pending_declared = 1, no warning).
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM pending_cta_repair WHERE legacy_release_id IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'BS#2152 guard: % declared pending row(s) have a NULL legacy_release_id -- the exact all-NULL placeholder has already been scrubbed, so this is a capture paste error, not the shipped row; every real captured row must carry its legacy_release_id from the enumeration query', n;
  END IF;
END $$;
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

-- === STMT: guard-capture-sanity ===
-- HIGH finding (PR #2154 review): nothing upstream of this guard verifies
-- that current_* actually holds the U+FFFD-corrupted value and true_* holds
-- the clean replacement. The capture procedure's clipboard step puts BOTH
-- strings on the clipboard for each of the 14 hand-pasted rows, so a
-- transposed paste on any one row is one slip away. Unguarded, a transposed
-- row would match the CLEAN live row (its current_* equals the clean live
-- value), compute the CORRUPT string as its post-fix tuple, find the
-- genuinely corrupt row as its twin, and DELETE the clean row -- exit 0, no
-- error, and the postlude's residual counts go UP (reads like a capture
-- mismatch, not data loss). This also structurally catches the
-- wrong-client_encoding scenario the session guards above worry about: a
-- misdecoded session turns every U+FFFD predicate into a false negative the
-- same way a transposed pair does.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT legacy_release_id, track_position, current_artist_name, current_track_title,
           true_artist_name, true_track_title
      FROM pending_cta_repair
     WHERE (true_artist_name IS NOT NULL AND (
             current_artist_name IS NULL
             OR current_artist_name NOT LIKE '%' || chr(65533) || '%'
             OR true_artist_name LIKE '%' || chr(65533) || '%'
           ))
        OR (true_track_title IS NOT NULL AND (
             current_track_title IS NULL
             OR current_track_title NOT LIKE '%' || chr(65533) || '%'
             OR true_track_title LIKE '%' || chr(65533) || '%'
           ))
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% track_position=% looks transposed or uncorrupted (current_artist_name=% current_track_title=% true_artist_name=% true_track_title=%) -- every current_* column being fixed must contain U+FFFD and every true_* replacement must not; verify the capture was not pasted backwards (or check client_encoding)', bad.legacy_release_id, bad.track_position, bad.current_artist_name, bad.current_track_title, bad.true_artist_name, bad.true_track_title;
  END LOOP;
END $$;
-- === END STMT ===

-- === STMT: guard-nfc-form ===
-- MEDIUM finding (PR #2154 review round 2): twin detection below joins on
-- exact byte equality (`IS NOT DISTINCT FROM` over `varchar`), so a true_*
-- value captured in a non-NFC Unicode normalization form (e.g. pasted out of
-- a MySQL client that yields NFD) can silently miss a genuinely clean live
-- twin already stored in NFC -- the row classifies no-twin, the UPDATE
-- writes a byte-distinct duplicate, and cta_unique_idx does not fire because
-- the two rows are not byte-identical, leaving TWO rows for one credit while
-- the postlude still reports the desired 0 / 0. This is exactly the
-- normalization-mismatch failure mode `fold_artist_name` (migration 0134)
-- and `jobs/artist-unicode-dedup` exist to correct on `artists`; this table
-- has neither.
--
-- Capture-time rejection, not write-time normalization: this guard REJECTS
-- a non-NFC true_* value rather than silently normalizing it, preserving the
-- deliberate byte-exact write posture documented under "Unicode
-- normalization" further down. If this guard fires, re-copy the true value
-- from a source that yields NFC -- do not hand-normalize it, per the same
-- "READ it, never reconstruct it" rule the capture procedure already states
-- for accents above.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT legacy_release_id, track_position, true_artist_name, true_track_title
      FROM pending_cta_repair
     WHERE (true_artist_name IS NOT NULL AND true_artist_name IS NOT NFC NORMALIZED)
        OR (true_track_title IS NOT NULL AND true_track_title IS NOT NFC NORMALIZED)
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% track_position=% has a true_* replacement that is not NFC-normalized (true_artist_name=% true_track_title=%) -- twin detection is byte-exact, so a non-NFC paste can miss a live NFC twin and leave a duplicate row behind instead of repairing in place; re-copy the true value from a source that yields NFC rather than hand-normalizing it', bad.legacy_release_id, bad.track_position, bad.true_artist_name, bad.true_track_title;
  END LOOP;
END $$;
-- === END STMT ===

-- INFO: one shared join, read by both the count below and the unmatched-row
-- listing below it, so the two cannot drift the way two hand-duplicated
-- copies of the same predicate could (LOW finding, PR #2154 review round 2
-- -- this predicate is still a separate hand-typed copy of build-targets'
-- own join further down, which is unavoidable: this runs before BEGIN and
-- build-targets deliberately runs inside the transaction, so they cannot
-- physically share one temp table -- but the two reads THIS side of that
-- boundary no longer duplicate each other).
DROP TABLE IF EXISTS pg_temp.pending_match_preview;
CREATE TEMP TABLE pending_match_preview AS
SELECT p.legacy_release_id, p.track_position, p.current_artist_name, p.current_track_title,
       cta.id AS matched_cta_id
  FROM pending_cta_repair p
  LEFT JOIN wxyc_schema.library l ON l.legacy_release_id = p.legacy_release_id
  LEFT JOIN wxyc_schema.compilation_track_artist cta
    ON cta.library_id = l.id
   AND cta.artist_name = p.current_artist_name
   AND cta.track_title IS NOT DISTINCT FROM p.current_track_title;

SELECT '=== V_BS_FFFD_CTA pre-amble: declared pending rows (0 = capture step not yet run) ===' AS section;
-- `pending_matched` alongside `pending_declared` (LOW finding, PR #2154
-- review round 2): a pending row matching no live row cannot be a hard
-- error (an idempotent re-run legitimately matches nothing once a prior run
-- already fixed it), so this stays informational -- but previously it was
-- visible only via the unmatched-row SELECT below, and every OTHER operator
-- slip in this script aborts loudly. This surfaces the count at a glance.
SELECT COUNT(*) AS pending_declared,
       COUNT(*) FILTER (WHERE matched_cta_id IS NOT NULL) AS pending_matched,
       COUNT(*) FILTER (WHERE matched_cta_id IS NULL) AS pending_unmatched
  FROM pending_match_preview;

SELECT 'INFO — declared pending rows that did NOT match a live row (already-fixed re-run, or a capture mismatch)' AS section;
SELECT legacy_release_id, track_position, current_artist_name, current_track_title
  FROM pending_match_preview
 WHERE matched_cta_id IS NULL;

SELECT 'BEFORE — overall residual U+FFFD, wxyc_schema.compilation_track_artist (desired end state: 0 / 0)' AS section;
SELECT (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE artist_name LIKE E'%�%') AS artist_name_residual,
       (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE track_title LIKE E'%�%') AS track_title_residual;

-- ===========================================================
-- Transactional block. Classification (`build-targets`) runs INSIDE this
-- transaction (PR #2154 review) -- see "Mechanism" above for why.
-- ===========================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

-- === STMT: build-targets ===
-- Resolve every pending row against the live table and classify twin/no-twin
-- by resolving the twin's own row id (not just its existence), carrying over
-- its identity-link columns for the DELETE branch and the BEFORE print.
DROP TABLE IF EXISTS pg_temp.cta_repair_targets;
CREATE TEMP TABLE cta_repair_targets AS
SELECT
  p.legacy_release_id,
  p.track_position,
  cta.id,
  cta.library_id,
  cta.artist_name AS old_artist_name,
  cta.track_title AS old_track_title,
  cta.track_position AS old_track_position,
  cta.track_artist_id AS old_track_artist_id,
  cta.track_artist_link_confidence AS old_track_artist_link_confidence,
  cta.track_artist_link_method AS old_track_artist_link_method,
  COALESCE(p.true_artist_name, cta.artist_name) AS new_artist_name,
  COALESCE(p.true_track_title, cta.track_title) AS new_track_title,
  twin.id AS twin_id,
  twin.track_position AS twin_track_position,
  twin.track_artist_id AS twin_track_artist_id,
  twin.track_artist_link_confidence AS twin_track_artist_link_confidence,
  twin.track_artist_link_method AS twin_track_artist_link_method,
  (twin.id IS NOT NULL) AS has_twin
FROM pending_cta_repair p
JOIN wxyc_schema.library l ON l.legacy_release_id = p.legacy_release_id
JOIN wxyc_schema.compilation_track_artist cta
  ON cta.library_id = l.id
 AND cta.artist_name = p.current_artist_name
 AND cta.track_title IS NOT DISTINCT FROM p.current_track_title
LEFT JOIN wxyc_schema.compilation_track_artist twin
  ON twin.library_id = cta.library_id
 AND twin.id <> cta.id
 AND twin.artist_name = COALESCE(p.true_artist_name, cta.artist_name)
 AND twin.track_title IS NOT DISTINCT FROM COALESCE(p.true_track_title, cta.track_title);
-- === END STMT ===

-- === STMT: guard-post-fix-fffd ===
-- HIGH finding (PR #2154 review round 2): nothing upstream of this guard
-- asserts that the POST-FIX tuple is actually U+FFFD-free. new_artist_name /
-- new_track_title above are COALESCE(true_*, cta.*), so a row corrupt in
-- BOTH columns but captured with only one true_* replacement leaves the
-- untouched column's U+FFFD sitting in the write. Two reproduced
-- consequences this guard closes:
--   * Silent row destruction: a genuinely clean twin exists for the FIXED
--     column alone (e.g. two rows share the same still-corrupt
--     artist_name, and only one of them also has a corrupt track_title,
--     fixed without also fixing the artist_name) -- the post-fix tuple
--     still carries the corrupt artist_name, matches the OTHER
--     still-corrupt row as its twin, and DELETEs the row that was actually
--     being repaired while the corruption survives on the "twin" left
--     behind.
--   * Silent partial repair: no twin exists, so the UPDATE runs and writes
--     the one column that was fixed, leaving the other silently corrupt --
--     exit 0, per-row residual 0 for this row's OLD tuple, but the U+FFFD
--     is still live under its NEW tuple, and the overall residual counter
--     stays non-zero with no row-level indication of which row is still
--     wrong.
-- See step 4 of the capture procedure above: a row corrupt in both columns
-- needs ONE pending row carrying BOTH true_artist_name and true_track_title,
-- never two separate pending rows.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT legacy_release_id, track_position, old_artist_name, old_track_title,
           new_artist_name, new_track_title
      FROM cta_repair_targets
     WHERE new_artist_name LIKE '%' || chr(65533) || '%'
        OR new_track_title LIKE '%' || chr(65533) || '%'
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% track_position=% still carries U+FFFD in its post-fix tuple (new_artist_name=% new_track_title=%) -- this row is corrupt in a column the pending capture did not supply a true_* replacement for; a row corrupt in BOTH artist_name and track_title needs ONE pending row with BOTH true_artist_name and true_track_title filled in (see the header capture procedure, step 4), not a row that only fixes one column', bad.legacy_release_id, bad.track_position, bad.new_artist_name, bad.new_track_title;
  END LOOP;
END $$;
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

-- === STMT: guard-converging-pending ===
-- HIGH/MEDIUM finding (PR #2154 review): `has_twin` above only asks whether
-- the LIVE table already holds the post-fix tuple -- it never asks whether
-- another PENDING row resolves to the SAME post-fix tuple. Two differently-
-- corrupted copies of one compilation credit (#2114's damage is per-row --
-- `La Forêt` survived the same 0xEA byte that killed `La Bête`; #1996
-- measured this double-ingest shape at 98.5% of this table's damaged rows)
-- can both independently classify no-twin and then both land in the single
-- set-based update-no-twins UPDATE, which raises cta_unique_idx /
-- cta_unique_null_track_idx instead of failing with a named message.
-- guard-ambiguous-match cannot catch this -- it groups on the OLD (corrupt)
-- tuple, which differs between the two rows; this groups on the resolved
-- NEW (post-fix) tuple instead.
--
-- Deliberately over-broad (LOW finding, PR #2154 review round 2): this
-- aborts regardless of `has_twin`, including the case where BOTH converging
-- rows classify has_twin=true -- two corrupt copies converging on a THIRD,
-- already-clean live row (the 98.5% double-ingest shape this comment's own
-- measurement cites, just with a clean twin also present). There, DELETE +
-- DELETE would actually be collision-free and correct, and this guard's
-- "resolve which capture is correct" message is wrong for that specific
-- shape -- both captures are correct, they just both point at the same
-- surviving twin. It is left broad on purpose: neutering it for that one
-- case exposes a second, coupled bug in `repoint-twin-identity` below --
-- `UPDATE ... FROM` with two matching source rows is non-deterministic in
-- PostgreSQL, so `repoint-twin-identity` would report `UPDATE 1` and
-- arbitrarily keep only one of the two source rows' identity links,
-- silently discarding the other. Narrowing this guard without also making
-- that repoint deterministic (`DISTINCT ON`, or an aggregated,
-- documented-precedence merge of the two links) would trade a loud guard
-- abort for a silent identity-link loss -- worse, not better. Narrow this
-- guard and fix the repoint together, or leave both as they are.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT library_id, new_artist_name, new_track_title, COUNT(*) AS n,
           array_agg(legacy_release_id ORDER BY legacy_release_id) AS release_ids,
           array_agg(track_position ORDER BY legacy_release_id) AS track_positions
      FROM cta_repair_targets
     GROUP BY library_id, new_artist_name, new_track_title
    HAVING COUNT(*) > 1
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: % pending row(s) converge on the same post-fix library_id=% artist_name=% track_title=% (legacy_release_id/track_position pairs: %/%) -- two differently-corrupted copies of one credit would collide under cta_unique_idx on a single UPDATE; resolve which capture is correct (or whether one is a distinct real credit) before re-running', bad.n, bad.library_id, bad.new_artist_name, bad.new_track_title, bad.release_ids, bad.track_positions;
  END LOOP;
END $$;
-- === END STMT ===

SELECT 'BEFORE — matched rows + twin classification' AS section;
SELECT legacy_release_id, track_position, id AS cta_id, old_artist_name, old_track_title,
       new_artist_name, new_track_title,
       CASE WHEN has_twin THEN 'DELETE (twin exists)' ELSE 'UPDATE (no twin)' END AS action,
       old_track_position, old_track_artist_id, old_track_artist_link_confidence, old_track_artist_link_method,
       twin_id, twin_track_position, twin_track_artist_id, twin_track_artist_link_confidence, twin_track_artist_link_method
  FROM cta_repair_targets
 ORDER BY legacy_release_id, track_position;

-- === STMT: repoint-twin-identity ===
-- MEDIUM finding (PR #2154 review round 1): before dropping the corrupt row,
-- repoint its per-track identity link (BS#1990 / #801 S1 -- track_artist_id
-- + track_artist_link_confidence + track_artist_link_method) and
-- track_position onto the surviving twin, COALESCE-preserving the twin's own
-- non-NULL values -- the corrupt row is the OLDER of the pair (the ETL's
-- insert-only writer kept both when the strings diverged), so it is the more
-- likely of the two to already carry an `lml_backfill` link the clean twin
-- lacks. Same COALESCE-preserve-then-delete shape as
-- `jobs/artist-unicode-dedup/merge.ts`'s survivor repoint. The BEFORE print
-- above projects all four columns for both rows so an operator reviewing the
-- output can see exactly what this carries over before it runs.
--
-- Kept as a separate statement from delete-twins below -- NOT because the
-- integration spec's extractor requires one-statement-per-block (LOW finding
-- correction, PR #2154 review round 2: it doesn't -- create-pending-table,
-- insert-pending-rows, and build-targets each already carry 2-3 statements
-- and `sql.unsafe()` runs a multi-statement block fine). The real reason is
-- operator legibility: `psql -f` echoes each statement's own row count
-- (`UPDATE N` / `DELETE N`) as it runs, so keeping the identity-link repoint
-- and the corrupt-row removal as two statements lets an operator watching
-- the run confirm both counts independently instead of reading one opaque
-- combined number.
--
-- Re-checks that the SOURCE (corrupt) row is still in its captured state
-- before repointing (LOW finding, PR #2154 review round 2) -- mirrors
-- delete-twins' own re-check below, which this statement previously lacked.
-- Without it, a concurrent edit to the corrupt row landing between
-- build-targets and here (real: see "Mechanism" above on why classifying
-- inside the transaction narrows, but does not close, that window) would
-- still repoint the twin's identity link even though delete-twins' own
-- re-check would then correctly skip deleting the now-changed corrupt row --
-- repointing without deleting, silently duplicating the identity link across
-- two live rows.
UPDATE wxyc_schema.compilation_track_artist twin
   SET track_artist_id = COALESCE(twin.track_artist_id, t.old_track_artist_id),
       track_artist_link_confidence = COALESCE(twin.track_artist_link_confidence, t.old_track_artist_link_confidence),
       track_artist_link_method = COALESCE(twin.track_artist_link_method, t.old_track_artist_link_method),
       track_position = COALESCE(twin.track_position, t.old_track_position)
  FROM cta_repair_targets t
 WHERE t.has_twin
   AND twin.id = t.twin_id
   AND EXISTS (
     SELECT 1 FROM wxyc_schema.compilation_track_artist cta
      WHERE cta.id = t.id
        AND cta.artist_name = t.old_artist_name
        AND cta.track_title IS NOT DISTINCT FROM t.old_track_title
   );
-- === END STMT ===

-- === STMT: delete-twins ===
-- The clean twin now carries the truth (plus whatever identity link the
-- corrupt row had, repointed above); the corrupt row is redundant.
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

-- ===========================================================
-- Post-amble verify: every targeted row should show residual=0, and the
-- overall predicate should return 0/0 -- the desired end state per #2152.
--
-- Runs INSIDE the transaction, BEFORE `COMMIT;` (MEDIUM finding, PR #2154
-- review round 2 -- this used to run after COMMIT). `cta_repair_targets` and
-- the write statements' effects are visible here via ordinary
-- read-your-own-writes regardless of whether this run goes on to COMMIT or
-- (dry-run) ROLLBACK. Running it after COMMIT broke the documented dry-run
-- "swap COMMIT; for ROLLBACK;" preview outright: once build-targets moved
-- inside the transaction (round 1), a ROLLBACK undoes the
-- `CREATE TEMP TABLE cta_repair_targets AS SELECT` along with everything
-- else in the transaction, so a post-COMMIT-position read against a table
-- that no longer exists aborted the whole script
-- (`ERROR: relation "cta_repair_targets" does not exist`, psql exit 3)
-- before ever reaching ANALYZE. Moving these reads to before the
-- `COMMIT;`/`ROLLBACK;` line makes them visible on both the real run and the
-- dry-run preview alike.
-- ===========================================================
SELECT '=== V_BS_FFFD_CTA post-amble: residual count per targeted row (expect 0) ===' AS section;
-- Prints the LIVE `track_position` (NIT, PR #2154 review round 2 -- this
-- used to print the CAPTURED value from cta_repair_targets, which is not
-- what #2152's acceptance criteria mean by "the permanent record" once this
-- output gets pasted onto the issue). `track_position` participates in no
-- matching predicate anywhere in this script, so the captured value can
-- differ from the live one; joins to the row that actually survived the run
-- -- the twin for a DELETE branch (post-repoint), or the same row for an
-- UPDATE branch.
SELECT t.legacy_release_id,
       live.track_position AS live_track_position,
       (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist cta
         WHERE cta.library_id = t.library_id
           AND cta.artist_name = t.old_artist_name
           AND cta.track_title IS NOT DISTINCT FROM t.old_track_title) AS residual
  FROM cta_repair_targets t
  LEFT JOIN wxyc_schema.compilation_track_artist live
    ON live.id = COALESCE(t.twin_id, t.id)
 ORDER BY t.legacy_release_id, live.track_position;

SELECT 'AFTER — overall residual U+FFFD, wxyc_schema.compilation_track_artist (desired end state: 0 / 0)' AS section;
SELECT (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE artist_name LIKE E'%�%') AS artist_name_residual,
       (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE track_title LIKE E'%�%') AS track_title_residual;

-- Broader-table informational sweep (rotation/flowsheet/artists/library)
-- already lives in bs_replacement_char_phase4.sql's postlude -- not repeated
-- here, this script is scoped to compilation_track_artist only.

COMMIT;

-- === STMT: analyze ===
-- Refresh planner stats (BS#934 -- omitting this after #863's migration
-- regressed /flowsheet/suggest/* to 5s timeouts). ANALYZE CAN run inside a
-- transaction (LOW finding, PR #2154 review round 2 -- verified:
-- `BEGIN; ANALYZE ...; COMMIT;` succeeds; it is VACUUM, not ANALYZE, that
-- Postgres refuses inside a transaction block. This corrected claim was
-- inherited from bs_replacement_char_phase4.sql's own analyze comment;
-- fixed here only -- that file is out of scope for this PR). It stays
-- outside this script's BEGIN/COMMIT anyway, matching the bulk-update
-- playbook's "paired post-script step" convention
-- (docs/bulk-update-playbook.md checklist item 4): a stats refresh isn't
-- part of the data change being committed or rolled back, and running it
-- unconditionally here means it still executes after the dry-run preview's
-- ROLLBACK too -- itself harmless, since ANALYZE only touches planner
-- statistics, never table data.
ANALYZE wxyc_schema.compilation_track_artist;
-- === END STMT ===
