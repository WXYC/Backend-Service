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
-- Nine DO-block guards (five from round 1, two from round 2, two from
-- round 3) run before the corresponding mistake can do damage -- or, for the
-- last one, before a damaged outcome can be COMMITted -- each aborting loudly
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
--                                    post-amble's residual counts UNCHANGED
--                                    (round 3 correction: the earlier text
--                                    here said they "go UP", which is wrong
--                                    for the DELETE path it narrates -- the
--                                    row destroyed is the CLEAN one, so the
--                                    U+FFFD population is exactly what it was
--                                    before the run. Flat counts are the more
--                                    insidious signal, not the milder one:
--                                    they read as "this row was already
--                                    repaired", the same output an idempotent
--                                    re-run produces). Also structurally
--                                    catches the wrong-client_encoding
--                                    scenario the session guards below worry
--                                    about -- a misdecoded session turns
--                                    every U+FFFD predicate into a false
--                                    negative the same way a transposed pair
--                                    does. Round 3 additionally hard-rejects
--                                    a NULL current_artist_name on ANY
--                                    pending row, gated on nothing: prod's
--                                    `compilation_track_artist.artist_name`
--                                    is NOT NULL and the enumeration query
--                                    cannot emit a NULL there, so a NULL is
--                                    always a paste slip -- and one that
--                                    silently matches zero live rows rather
--                                    than aborting, because the pre-round-3
--                                    NULL test sat inside the
--                                    `true_artist_name IS NOT NULL` branch
--                                    and so never applied to a
--                                    track_title-only repair.
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
--   guard-unknown-release         -- (round 3) a declared legacy_release_id
--                                    resolves to no `library` row at all.
--                                    Every captured id came out of the
--                                    enumeration query's own
--                                    `JOIN library l ON l.id = cta.library_id`
--                                    projection, so an id that matches
--                                    nothing is a transcription error, not a
--                                    legitimately-absent release -- and it is
--                                    the one unmatched shape that CANNOT be
--                                    an idempotent re-run, since a repaired
--                                    row's `library` parent does not
--                                    disappear when the CTA row is fixed.
--                                    Distinct from the merely-informational
--                                    "matched no live CTA row" listing right
--                                    below it, which stays informational for
--                                    exactly that reason.
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
--   guard-repair-complete         -- (round 3; runs AFTER the three write
--                                    statements, still inside the
--                                    transaction) a targeted row's ORIGINAL
--                                    corrupt tuple is still live. Every other
--                                    guard here is a pre-flight check on the
--                                    capture; this one is a post-condition on
--                                    the run, and it is what converts each
--                                    write statement's deliberately-silent
--                                    concurrency skip into a loud abort. A
--                                    skip is correct behavior (see the
--                                    re-checks on all three writes), but a
--                                    skip that leaves the corruption live is
--                                    a repair that did not happen, and
--                                    without this the script COMMITs and
--                                    exits 0 on it. Not reachable on a
--                                    legitimate idempotent re-run: an
--                                    already-repaired row does not appear in
--                                    `cta_repair_targets` at all, because
--                                    build-targets' join requires the live
--                                    row to still hold the captured CORRUPT
--                                    strings. `cta_unique_idx` guarantees at
--                                    most one live row can hold that tuple,
--                                    so this cannot be tripped by an
--                                    unrelated row.
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
-- "Every statement" is meant literally, and round 3 is what made it true.
-- Through round 2 the read-only pre-amble (`pending_match_preview` and its
-- three SELECTs) and the post-amble residual reads carried no
-- `-- === STMT: ... ===` tags, so the spec's extractor never saw them and
-- nothing executed them -- the spec only pinned their POSITION in the file
-- via `indexOf`. A typo or a column drift in the post-amble would therefore
-- pass the entire suite and then abort the real prod run under
-- ON_ERROR_STOP mid-transaction, AFTER the DELETE/UPDATE and BEFORE COMMIT,
-- rolling back a repair that had actually succeeded; the same typo in the
-- pre-amble would kill the documented read-only `awk` preview outright.
-- Both sections are tagged blocks now and the spec runs them.
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
--      a. This repo's OWN reader: `fetchLegacyCompilationTracks`
--         (jobs/library-etl/job.ts), which selects LIBRARY_RELEASE_ID /
--         ARTIST_NAME / TRACK_TITLE / TRACK_POSITION out of tubafrenzy's
--         `COMPILATION_TRACK_ARTIST` through `legacyDB.send`
--         (shared/database/src/legacy/sql.mirror.ts), which passes
--         `--default-character-set=utf8` unconditionally. Preferred over
--         (c) for three reasons: the mandatory charset flag is structural
--         rather than something the operator has to remember, its key is
--         already `LIBRARY_RELEASE_ID` -- i.e. exactly the
--         `legacy_release_id` keyspace the pending block wants, no
--         translation step -- and it is the SAME reader whose output the
--         post-#454 ETL writes into the live Backend column, so its values
--         land in the same trim/whitespace regime the byte-exact predicates
--         below compare against. Two transforms to know about, both benign
--         for the same reason: the query REPLACEs embedded tabs/newlines
--         with spaces (its output is tab-delimited), and the parser trims
--         each field and maps empty to NULL -- so a NULL TRACK_TITLE round-
--         trips to NULL correctly, which is the shape 3 of the 14 rows need.
--      b. A tubafrenzy-sourced `library.db` snapshot under
--         `lml-cutover-snapshots/`, IF a future snapshot ever gains
--         per-track/compilation-credit data (neither snapshot available
--         while writing this script does -- see above). Confirm the
--         snapshot postdates 2026-04-24 (the #454 charset fix) before
--         trusting it.
--      c. Kattare MySQL directly: `dc1-mysql-01.kattare.com`, database
--         `wxycmusic`. `--default-character-set=utf8` is MANDATORY (the
--         whole corruption class exists because a client once connected
--         without it). Use a MariaDB client, not Homebrew's MySQL 9.x --
--         it segfaults against the 5.1 server.
--
--    Whichever channel is used, NOTHING in this script verifies that a
--    pending row's true_* value actually corresponds to the tubafrenzy row
--    for that credit -- the guards check internal consistency (is current_*
--    corrupt, is true_* clean, is it NFC, does the release resolve), never
--    correspondence to ground truth. A true_* value that is clean, NFC, and
--    simply WRONG passes every one of them and commits. That is why step 2
--    is a read and step 5 is a human review, and it is the strongest
--    argument for channel (a): a programmatic read cannot transpose two rows
--    the way 14 hand-pastes can.
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
-- (unmatched pending rows, overall residual count). It also runs the first
-- five guards, so a transposed, NULL-keyed, non-NFC, nothing-to-fix, or
-- unknown-release capture aborts here -- in a read-only preview, before the
-- operator has committed to anything. It does NOT show the twin/no-twin
-- classification, because that classification (`build-targets`)
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
-- What the transaction alone buys is atomicity, NOT elimination of the race
-- window (round 2 correction -- the round 1 text overclaimed "no window
-- between classifying a row and acting on that classification").
-- `CREATE TEMP TABLE ... AS SELECT` under READ COMMITTED takes no row lock,
-- and every later statement in this script takes its own fresh snapshot, so
-- through round 2 `library-etl` could still commit a clean twin (or a
-- librarian could still hand-edit the row) between `build-targets` and any
-- of the three write statements.
--
-- Round 3 closes that window on existing rows with an explicit lock rather
-- than continuing to narrow it. `lock-targets` runs immediately after
-- `build-targets` and takes `SELECT ... FOR UPDATE` row locks on every
-- classified corrupt row AND every twin it resolved, in ascending `id` order
-- (ordered so two operators running overlapping repairs, or this script
-- against any other id-ordered writer, queue instead of deadlocking). Once
-- that statement returns, no other session can UPDATE or DELETE any row this
-- run intends to touch until this transaction ends. That leaves exactly ONE
-- window on existing rows -- `build-targets` to `lock-targets` -- and the
-- re-checks the three write statements carry are precisely what closes it:
-- each re-reads post-lock, so it sees any change that landed pre-lock, and
-- nothing can change after. Two consequences the earlier shape did not have:
--
--   * The write statements can no longer DISAGREE with each other. Through
--     round 2, `repoint-twin-identity` could fire, a concurrent edit could
--     land, and `delete-twins` could then correctly skip -- leaving the
--     corrupt row's identity link live on BOTH rows, committed, exit 0. The
--     re-check each statement carried made each one individually correct and
--     the pair jointly wrong. Under the lock they read identical state.
--   * Both statements now re-check the TWIN as well as the corrupt row (see
--     their own comments). Through round 2 neither did, so a twin deleted or
--     renamed in that window let `delete-twins` remove what had become the
--     ONLY remaining copy of the credit -- and unlike the UPDATE branch,
--     which fails safe into a 23505, the DELETE branch had no tripwire at
--     all.
--
-- What the lock canNOT do is prevent an INSERT: you cannot lock a row that
-- does not exist, so `library-etl` committing a BRAND-NEW clean twin for a
-- row this run classified as no-twin is still possible. That case stays
-- fail-safe rather than guarded -- `update-no-twins` raises 23505,
-- ON_ERROR_STOP aborts, and the whole transaction rolls back cleanly, which
-- is the correct outcome (re-run; `build-targets` then classifies it
-- has_twin and takes the DELETE branch). Lock waits are bounded by the
-- `SET LOCAL statement_timeout = '30s'` above: if a concurrent writer holds
-- a conflicting lock longer than that, this run aborts rather than hangs.
--
-- So: race-free with respect to concurrent modification and deletion of the
-- rows it classified, fail-safe with respect to concurrent insertion of new
-- ones. `guard-repair-complete` below is the backstop for both -- it refuses
-- to COMMIT a run in which any targeted row's corrupt tuple is still live.
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
-- `importCompilationTracks` (jobs/library-etl/job.ts) inserts with a bare,
-- UNTARGETED `.onConflictDoNothing()`, and post-#454 the ETL derives the
-- correct string, so its next insert for a repaired row conflicts and no-ops.
-- Untargeted is load-bearing and not an oversight (round 3 correction -- the
-- earlier text here said "on `cta_unique_idx`", which would be a narrower and
-- broken thing to write): a bare DO NOTHING suppresses a conflict on ANY
-- unique index on the table, so it covers `cta_unique_null_track_idx`
-- (migration 0099) too. An arbiter spelled `ON CONFLICT (library_id,
-- artist_name, track_title)` would not -- under a plain unique index NULLs
-- are distinct on PG 14, so a NULL-`track_title` re-insert would never
-- conflict against `cta_unique_idx`, would fall through to a real INSERT, and
-- would then fail against the partial index instead of no-opping. The
-- distinction matters here because 3 of this script's 14 rows are
-- `artist_name` repairs, which is where NULL `track_title` lives.
--
-- ============================================================================
-- Triggers that DO fire on these writes
-- ============================================================================
-- Two, both wanted, neither requiring anything of the operator -- listed
-- because "what else moves when I run this" is the question this section
-- exists to answer, and a reader should not have to go find out:
--
--   `touch_library_watermark_from_compilation_track_artist` (migration 0138,
--   narrowed by 0143) -- FOR EACH STATEMENT, and after 0143 its UPDATE leg is
--   `UPDATE OF id, library_id, artist_name, track_title`. `delete-twins`
--   fires it via the DELETE leg and `update-no-twins` via the UPDATE leg
--   (both of its SET columns are in that list), so the catalog-export
--   watermark advances and `GET /library/catalog/compilation-tracks` reflects
--   the repair on its next conditional GET. That is the desired outcome: the
--   export's projected `artist_name`/`track_title` are exactly what this
--   script rewrites. `repoint-twin-identity` deliberately does NOT advance it
--   -- all four columns it SETs (the three `track_artist_*` and
--   `track_position`) are on 0143's excluded list, which is the whole point
--   of that migration.
--
--   `cdc_compilation_track_artist` (migration 0046) -- FOR EACH ROW, on
--   INSERT/UPDATE/DELETE, structurally unqualified (Postgres does not narrow
--   ROW-level triggers with `OF <columns>`), so every row this script touches
--   emits a `pg_notify('cdc', ...)`, including the repoint's. `pg_notify`
--   payloads are queued and delivered at COMMIT, not at statement time, so
--   `/cdc` consumers see one burst after the repair lands and never a
--   half-applied intermediate state -- and the documented
--   "swap COMMIT; for ROLLBACK;" dry run emits nothing at all. Worth knowing
--   before running this during a live show: the DELETE events name rows that
--   no longer exist by design, which is the normal shape for this table's
--   twin-dedup writes, not an anomaly for a consumer to reconcile.
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
-- the capture step above. The four capture columns come from the enumeration
-- query in the same left-to-right order it prints them -- but NOT 1:1 (round 3
-- correction to the earlier wording here): that query projects FIVE columns and
-- leads with `cta.library_id`, which this block does not carry and must be
-- dropped from the paste. Take columns 2-5 (legacy_release_id, track_position,
-- artist_name, track_title), then append the two true_* replacement columns.
-- Pasting all five shifts every value one slot left, landing the numeric
-- library_id in legacy_release_id and the real legacy_release_id in
-- track_position. With both true_* values also supplied that is seven values
-- for six columns, so Postgres rejects the INSERT outright ("INSERT has more
-- expressions than target columns") and the slip is loud. It is only quiet on
-- a row that supplies ONE true_* value, where the counts happen to line up:
-- there, guard-unknown-release catches it if the shifted library_id resolves
-- to no `library` row, and the informational unmatched listing catches it if
-- it resolves to the wrong one. Neither is a substitute for checking the
-- paste -- drop `library_id` before you paste.
-- Leave true_artist_name OR true_track_title NULL
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
-- error, and the post-amble's residual counts UNCHANGED (round 3 correction:
-- this said "go UP", which is wrong for the DELETE path it describes -- the
-- row destroyed is the CLEAN one, so the U+FFFD population is exactly what it
-- was before the run. Flat counts are worse than rising ones here, not
-- milder: they are also what a successful idempotent re-run prints, so the
-- output actively reads as "already repaired"). This also structurally
-- catches the wrong-client_encoding scenario the session guards above worry
-- about: a misdecoded session turns every U+FFFD predicate into a false
-- negative the same way a transposed pair does.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT legacy_release_id, track_position, current_artist_name, current_track_title,
           true_artist_name, true_track_title,
           -- Name the actual fault rather than making the operator infer it
           -- from a message that ORs two unrelated diagnoses together. The
           -- two causes have different fixes: a NULL current_artist_name is a
           -- structurally short paste, a transposition is a
           -- right-values-wrong-slots paste.
           CASE
             WHEN current_artist_name IS NULL
               THEN 'current_artist_name is NULL -- the live column is NOT NULL and the enumeration query cannot emit a NULL there, so this row is short a column (did the paste drop one, or include the query''s leading library_id?)'
             ELSE 'looks transposed or uncorrupted -- every current_* column being fixed must contain U+FFFD and every true_* replacement must not; verify the capture was not pasted backwards (or check client_encoding)'
           END AS reason
      FROM pending_cta_repair
     -- UNCONDITIONAL, not gated on which column is being fixed (round 3
     -- finding): prod's compilation_track_artist.artist_name is NOT NULL and
     -- the enumeration query cannot emit a NULL there, so a NULL
     -- current_artist_name is ALWAYS a paste slip -- on a track_title-only
     -- repair just as much as on an artist_name one. Before round 3 the NULL
     -- test lived only inside the `true_artist_name IS NOT NULL` branch below,
     -- so on the 11 track_title-only rows a NULLed current_artist_name sailed
     -- through every guard, matched no live row in build-targets (the join
     -- requires `cta.artist_name = p.current_artist_name`), and committed as a
     -- silent no-op with the corruption intact. No equivalent test exists for
     -- current_track_title: NULL is a legitimate value there (migration 0099 /
     -- cta_unique_null_track_idx), which is exactly the shape 3 of the 14 rows
     -- have.
     WHERE current_artist_name IS NULL
        OR (true_artist_name IS NOT NULL AND (
             current_artist_name NOT LIKE '%' || chr(65533) || '%'
             OR true_artist_name LIKE '%' || chr(65533) || '%'
           ))
        OR (true_track_title IS NOT NULL AND (
             current_track_title IS NULL
             OR current_track_title NOT LIKE '%' || chr(65533) || '%'
             OR true_track_title LIKE '%' || chr(65533) || '%'
           ))
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% track_position=% %  (current_artist_name=% current_track_title=% true_artist_name=% true_track_title=%)', bad.legacy_release_id, bad.track_position, bad.reason, bad.current_artist_name, bad.current_track_title, bad.true_artist_name, bad.true_track_title;
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

-- === STMT: pending-match-preview ===
-- INFO: one shared join, read by the count below, the unmatched-row listing
-- below it, and `guard-unknown-release` after that, so the three cannot drift
-- the way hand-duplicated copies of the same predicate could (LOW finding, PR
-- #2154 review round 2 -- this predicate is still a separate hand-typed copy
-- of build-targets' own join further down, which is unavoidable: this runs
-- before BEGIN and build-targets deliberately runs inside the transaction, so
-- they cannot physically share one temp table -- but the reads THIS side of
-- that boundary no longer duplicate each other).
--
-- Tagged as a STMT block in round 3 so the paired integration spec actually
-- EXECUTES it; through round 2 the spec only pinned this section's position
-- in the file with `indexOf` and a typo here would have survived the whole
-- suite to kill the documented read-only `awk` preview in front of the
-- operator. Same for the residual reads below and in the post-amble.
DROP TABLE IF EXISTS pg_temp.pending_match_preview;
CREATE TEMP TABLE pending_match_preview AS
SELECT p.legacy_release_id, p.track_position, p.current_artist_name, p.current_track_title,
       l.id AS matched_library_id,
       cta.id AS matched_cta_id,
       -- Non-NFC diagnosis on the CURRENT (corrupt) side, informational only
       -- (round 3). guard-nfc-form hard-rejects a non-NFC true_* replacement;
       -- the same slip on a current_* value cannot be a hard rejection here,
       -- because this table has no normalization invariant and a genuinely
       -- NFD-stored live row is possible (it is the exact condition
       -- `jobs/artist-unicode-dedup` + migration 0134's fold exist to clean up
       -- on `artists`, which is a table that DOES have the invariant). So it
       -- is surfaced where it is actionable instead: on the unmatched listing,
       -- naming the reason a row that looks right matched nothing. Byte-exact
       -- equality is what build-targets joins on, so an NFD current_* misses
       -- an NFC live row silently.
       (current_artist_name IS NOT NULL AND current_artist_name IS NOT NFC NORMALIZED)
         OR (current_track_title IS NOT NULL AND current_track_title IS NOT NFC NORMALIZED)
         AS current_is_non_nfc
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
SELECT legacy_release_id, track_position, current_artist_name, current_track_title,
       matched_library_id IS NULL AS release_not_found,
       current_is_non_nfc
  FROM pending_match_preview
 WHERE matched_cta_id IS NULL;
-- === END STMT ===

-- === STMT: guard-unknown-release ===
-- Round 3 finding: an unmatched pending row is normally informational (an
-- idempotent re-run matches nothing, legitimately) -- but ONE unmatched shape
-- can never be that, and it was being swept into the same INFO listing as the
-- benign one. Every captured legacy_release_id came out of the enumeration
-- query's own `JOIN wxyc_schema.library l ON l.id = cta.library_id`
-- projection, so an id that resolves to no `library` row at all is a
-- transcription error in the paste. Repairing a CTA row does not delete or
-- re-key its `library` parent, so a re-run of a completed repair still
-- resolves every one of its releases -- which is what makes this safe to
-- abort on where "matched no CTA row" is not.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT legacy_release_id, track_position, current_artist_name, current_track_title
      FROM pending_match_preview
     WHERE matched_library_id IS NULL
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% (track_position=% current_artist_name=% current_track_title=%) matches no row in wxyc_schema.library -- every captured id came from the enumeration query''s own JOIN to library, so an id that resolves to nothing is a paste/transcription error, not an already-repaired row; re-check this row against the enumeration output (a common cause is pasting the query''s leading cta.library_id column, which is a DIFFERENT keyspace from legacy_release_id)', bad.legacy_release_id, bad.track_position, bad.current_artist_name, bad.current_track_title;
  END LOOP;
END $$;
-- === END STMT ===

-- === STMT: before-residual ===
-- One sequential scan, not two (round 3): both counts are 1-character
-- leading-wildcard LIKEs, which no index on this table can serve -- the
-- pg_trgm GIN indexes extract zero trigrams from a single character -- so
-- each is a guaranteed full-table scan. Two scalar subqueries scanned the
-- table twice for one line of output; COUNT(*) FILTER does it in one pass.
-- The same rewrite is applied to the post-amble's AFTER counterpart, where
-- it also runs inside the write transaction and so has a real cost (see the
-- statement_timeout note there).
SELECT 'BEFORE — overall residual U+FFFD, wxyc_schema.compilation_track_artist (desired end state: 0 / 0)' AS section;
SELECT COUNT(*) FILTER (WHERE artist_name LIKE E'%�%') AS artist_name_residual,
       COUNT(*) FILTER (WHERE track_title LIKE E'%�%') AS track_title_residual
  FROM wxyc_schema.compilation_track_artist;
-- === END STMT ===

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

-- === STMT: lock-targets ===
-- Round 3: take real row locks on everything this run intends to write,
-- immediately after classification, instead of continuing to narrow the
-- classify-then-write window with re-checks alone. Covers BOTH sides of each
-- repair -- the corrupt row (`t.id`) and the twin it resolved (`t.twin_id`) --
-- because the write statements read and mutate both, and through round 2 only
-- the corrupt row was ever re-checked. See "Mechanism" above for the full
-- account of what this closes and what it structurally cannot (a concurrent
-- INSERT of a brand-new twin, which stays fail-safe via 23505 + rollback).
--
-- ORDER BY cta.id is deadlock avoidance, not cosmetics: `LockRows` sits above
-- `Sort` in the plan, so rows are locked in ascending id order, and any other
-- id-ordered writer -- including a second operator running this same script
-- against an overlapping capture -- queues behind this one rather than
-- deadlocking against it.
--
-- `FOR UPDATE` rather than `FOR NO KEY UPDATE` costs nothing here: the
-- stronger mode's extra effect is blocking the `FOR KEY SHARE` an FK check
-- takes on a REFERENCED row, and nothing in the schema references
-- `compilation_track_artist` (checked against pg_constraint, not assumed --
-- `confrelid = 'wxyc_schema.compilation_track_artist'::regclass` returns no
-- rows). The DELETE branch needs the stronger mode anyway.
--
-- UNION (not UNION ALL) so a row that is both some target's corrupt row and
-- another target's twin is locked once. `SET LOCAL statement_timeout = '30s'`
-- above bounds the wait: a conflicting writer holding its lock longer aborts
-- this run cleanly instead of parking it behind `library-etl`'s 30-minute
-- cycle. Prints the locked ids, which is genuine operator signal -- the count
-- should be the matched-row count plus the number of twins.
SELECT cta.id AS locked_cta_id
  FROM wxyc_schema.compilation_track_artist cta
 WHERE cta.id IN (
         SELECT t.id FROM cta_repair_targets t
          UNION
         SELECT t.twin_id FROM cta_repair_targets t WHERE t.twin_id IS NOT NULL
       )
 ORDER BY cta.id
   FOR UPDATE;
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
-- build-targets and here would still repoint the twin's identity link even
-- though delete-twins' own re-check would then correctly skip deleting the
-- now-changed corrupt row -- repointing without deleting, silently
-- duplicating the identity link across two live rows.
--
-- That round 2 fix closed the build-targets -> here half of the window but
-- not the here -> delete-twins half (round 3 finding): an edit landing
-- BETWEEN these two statements produced the identical duplicated-link
-- outcome, because each statement's re-check made it individually correct
-- while the pair disagreed. `lock-targets` above is what actually closes it
-- -- both statements now read state that cannot change between them -- and
-- the re-checks remain as what catches an edit from the one surviving
-- window, build-targets -> lock-targets.
--
-- Round 3 also re-checks the TWIN, not just the corrupt row. `twin.id =
-- t.twin_id` alone matches on identity, which survives a rename: if the twin
-- was edited in that window it is no longer the row that holds the post-fix
-- tuple, and repointing the corrupt row's identity link onto it writes the
-- link to the wrong credit. Requiring the twin to still hold
-- `new_artist_name`/`new_track_title` makes this statement and delete-twins
-- fire on exactly the same condition, so they cannot disagree.
--
-- This particular clause is the INNER of two independent defenses, and is
-- deliberately not pinned by its own test because it currently has no
-- observable effect to pin: any run in which delete-twins skips leaves the
-- corrupt tuple live, and guard-repair-complete then rolls the whole
-- transaction back -- discarding a wrongly-repointed link along with
-- everything else. It is here so that the two statements stay coherent on
-- their own terms rather than relying on a downstream abort to clean up
-- after them, which is what would matter to whoever next changes either the
-- guard or the ordering.
UPDATE wxyc_schema.compilation_track_artist twin
   SET track_artist_id = COALESCE(twin.track_artist_id, t.old_track_artist_id),
       track_artist_link_confidence = COALESCE(twin.track_artist_link_confidence, t.old_track_artist_link_confidence),
       track_artist_link_method = COALESCE(twin.track_artist_link_method, t.old_track_artist_link_method),
       track_position = COALESCE(twin.track_position, t.old_track_position)
  FROM cta_repair_targets t
 WHERE t.has_twin
   AND twin.id = t.twin_id
   AND twin.artist_name = t.new_artist_name
   AND twin.track_title IS NOT DISTINCT FROM t.new_track_title
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
--
-- ALSO re-checks that the twin still EXISTS and still holds the post-fix
-- tuple (round 3 finding). This is the one statement in the script that can
-- destroy data outright, and through round 2 it verified only the row it was
-- about to delete -- never the row that was supposed to be carrying the
-- credit forward. `twin.id = t.twin_id` from build-targets is a snapshot: if
-- the twin was deleted or renamed between classification and here, the DELETE
-- still fired and removed what had by then become the ONLY remaining copy of
-- that compilation credit, committing at exit 0 with a per-row residual of 0
-- (the residual counts the OLD tuple, which the delete genuinely removed).
-- The UPDATE branch has never had this exposure -- writing onto a
-- concurrently-created twin raises 23505 and rolls the run back -- so the
-- DELETE branch was the only one without a tripwire. `lock-targets` above now
-- prevents the twin from being touched at all once this run has classified
-- it; this EXISTS covers the residual build-targets -> lock-targets window,
-- where the honest answer is to skip the delete and let
-- `guard-repair-complete` abort the whole transaction rather than guess.
DELETE FROM wxyc_schema.compilation_track_artist cta
USING cta_repair_targets t
WHERE cta.id = t.id
  AND t.has_twin
  AND cta.artist_name = t.old_artist_name
  AND cta.track_title IS NOT DISTINCT FROM t.old_track_title
  AND EXISTS (
    SELECT 1 FROM wxyc_schema.compilation_track_artist twin
     WHERE twin.id = t.twin_id
       AND twin.artist_name = t.new_artist_name
       AND twin.track_title IS NOT DISTINCT FROM t.new_track_title
  );
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

-- === STMT: guard-repair-complete ===
-- Round 3: the post-condition. Every other guard in this script checks the
-- CAPTURE before it can do damage; this one checks the RUN before it can be
-- committed, and it exists because all three write statements above skip
-- silently by design.
--
-- Skipping is the correct behavior for each of them individually -- it is
-- what makes a re-run idempotent, and what makes a concurrent edit
-- non-destructive. But "skipped" and "repaired" produce the same exit code,
-- and the case that matters is the one where the skip leaves the corruption
-- live: `delete-twins` declining because the twin vanished in the
-- build-targets -> lock-targets window. Without this guard the script COMMITs
-- that outcome at exit 0, and the operator's evidence is a residual count
-- that reads 1 -- indistinguishable at a glance from the pre-run state, in a
-- postlude whose whole framing is "desired end state: 0 / 0".
--
-- The predicate is deliberately the same one the post-amble prints per row.
-- Zero false positives on a legitimate re-run: build-targets' join requires
-- the live row to still hold the captured CORRUPT strings, so an
-- already-repaired row never enters `cta_repair_targets` in the first place.
-- Nor on a benign concurrent edit: a row someone else changed no longer holds
-- the old tuple either, so it passes here and this run simply wrote nothing
-- for it. And it cannot be tripped by an unrelated row, because
-- cta_unique_idx / cta_unique_null_track_idx make at most one live row able
-- to hold that tuple. What remains is exactly the failure it is for: the
-- repair did not happen.
--
-- Aborting rolls the transaction back whole, which is also the right recovery
-- shape -- a re-run reclassifies from live state (a vanished twin becomes a
-- no-twin row and takes the UPDATE branch) instead of retrying a
-- classification that is now stale.
DO $$
DECLARE bad RECORD;
BEGIN
  FOR bad IN
    SELECT t.legacy_release_id, t.track_position, t.id AS cta_id,
           t.old_artist_name, t.old_track_title, t.has_twin, t.twin_id
      FROM cta_repair_targets t
     WHERE EXISTS (
       SELECT 1 FROM wxyc_schema.compilation_track_artist cta
        WHERE cta.library_id = t.library_id
          AND cta.artist_name = t.old_artist_name
          AND cta.track_title IS NOT DISTINCT FROM t.old_track_title
     )
  LOOP
    RAISE EXCEPTION 'BS#2152 guard: legacy_release_id=% track_position=% (cta_id=% has_twin=% twin_id=%) still holds its corrupt tuple (artist_name=% track_title=%) after the write statements ran -- the repair for this row was SKIPPED, not applied; the usual cause is that its twin was deleted or renamed between build-targets and lock-targets, so delete-twins correctly declined rather than destroy the last copy of the credit. Rolling back; re-run the script to reclassify this row against current live state', bad.legacy_release_id, bad.track_position, bad.cta_id, bad.has_twin, bad.twin_id, bad.old_artist_name, bad.old_track_title;
  END LOOP;
END $$;
-- === END STMT ===

-- Raise the statement timeout for the read-only post-amble below (round 3
-- finding). `SET LOCAL` is last-write-wins within the transaction, so the 30s
-- cap stays in force over every statement that WRITES -- this only relaxes
-- the two full-table residual scans that follow, and only after the repair
-- has already succeeded.
--
-- Necessary because those scans are unindexable by construction (1-character
-- leading-wildcard LIKE; the pg_trgm GIN indexes extract zero trigrams from a
-- single character) and they run INSIDE the write transaction, where the
-- reason they are inside is the dry-run recipe, not correctness. Under the
-- flat 30s cap a cold cache or I/O contention from the concurrent 30-minute
-- library-etl cycle could time the scan out, and ON_ERROR_STOP would then
-- roll back a repair that had fully succeeded -- destroying a correct result
-- to fail a verification read. Kept finite rather than 0 so a genuinely
-- pathological scan still ends while holding this run's row locks.
SET LOCAL statement_timeout = '5min';

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
-- === STMT: post-amble-residual ===
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

-- One sequential scan, not two -- see the BEFORE counterpart's comment. It
-- matters more here: this pair runs inside the write transaction, holding
-- this run's row locks, after the repair has already succeeded.
SELECT 'AFTER — overall residual U+FFFD, wxyc_schema.compilation_track_artist (desired end state: 0 / 0)' AS section;
SELECT COUNT(*) FILTER (WHERE artist_name LIKE E'%�%') AS artist_name_residual,
       COUNT(*) FILTER (WHERE track_title LIKE E'%�%') AS track_title_residual
  FROM wxyc_schema.compilation_track_artist;
-- === END STMT ===

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
