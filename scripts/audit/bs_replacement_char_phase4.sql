-- V_BS_FFFD_P4: Phase 4 lossy-recovery U+FFFD mojibake migration for #2114.
--
-- Hand-applied operator script, NOT a Drizzle-tracked migration -- same
-- posture as scripts/audit/bs_replacement_char_recovery.sql (Phase 1/2) and
-- scripts/audit/bs_replacement_char_phase35.sql (Phase 3.5). docs/migrations.md
-- calls migrations DDL-only; this is DML, so it lives here and is run via
-- `psql -f` against prod RDS, the same as its two predecessors.
--
-- This is RESIDUE from the #863 recovery, surfaced by the first full run of
-- the discogs-etl catalog-parity harness (discogs-etl#365) on 2026-08-12
-- (WXYC/wiki#89). #863 proposed repairs by fuzzy-matching against
-- LML/discogs-cache/mb-cache at >=0.80 confidence with human review; these
-- 11 rows never cleared that gate ("mu-Ziq [mu-Ziq]" is an awkward fuzzy
-- target). The parity harness instead reads the correct value straight out
-- of tubafrenzy MySQL (dc1-mysql-01.kattare.com, database wxycmusic), so
-- this is a direct substitution -- no matching step, no judgement call.
--
-- Only 2 distinct correct strings are involved, across 11 catalog rows
-- (`legacy_release_id`, i.e. the tubafrenzy `LIBRARY_RELEASE.ID`):
--
--   1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 63110, 69776
--     artist, corrupt:  <U+FFFD>-Ziq [mu-Ziq]
--     artist, correct:  µ-Ziq [mu-Ziq]              (U+00B5 MICRO SIGN)
--     tubafrenzy source: LIBRARY_CODE.ID=956 (CALL_LETTERS='Mu', CALL_NUMBERS=3)
--
--   50340
--     title,  corrupt:  La B<U+FFFD>te
--     title,  correct:  La Bête                     (U+00EA E WITH CIRCUMFLEX)
--     tubafrenzy source: LIBRARY_RELEASE.ID=50340 (The Cripple Lillies, CR/140)
--
-- All ten µ-Ziq releases share ONE tubafrenzy LIBRARY_CODE, i.e. one Backend
-- `artists` row. `artists.artist_name` is the source of truth for the
-- denormalized `library.artist_name` copy: migration 0060's
-- `cascade_library_artist_name` trigger fires `AFTER UPDATE OF artist_name
-- ON wxyc_schema.artists` and pushes the new value onto every
-- `library` row with a matching `artist_id`. So the first UPDATE below
-- targets `artists.artist_name` directly and lets the trigger do the
-- `library.artist_name` write for us. The second UPDATE re-targets
-- `library.artist_name` directly, scoped to exactly the 10 catalog ids named
-- in BS#2114, matched on (still-corrupt value AND legacy_release_id) -- a
-- self-correcting no-op once the trigger has already fixed a row, and a
-- safety net for any of the 10 rows whose `artist_id` linkage doesn't hold
-- for some unrelated reason. Neither UPDATE fights the trigger: the trigger
-- only fires on `artists` writes, and its own guard
-- (`artist_name IS DISTINCT FROM NEW.artist_name`) makes it inert once the
-- value already matches.
--
-- `artists.alphabetical_name` is deliberately NOT touched. Backend's
-- `alphabetical_name` is sourced 1:1 from tubafrenzy's
-- `LIBRARY_CODE.ALPHABETICAL_NAME` (see `toAlphabeticalName` in
-- jobs/library-etl/job.ts). For LIBRARY_CODE.ID=956 that value is the plain-
-- ASCII string `mu-Ziq` -- no non-ASCII byte to have been lossily replaced
-- in the first place, so it cannot carry this corruption class. It is still
-- included in the audit predicates below, per BS#2114's ask to check it, so
-- a future reader can see that it was looked at and came back clean rather
-- than simply omitted.
--
-- No live prod Backend database was available while writing this script, but
-- dev_env/seed-clone.sql (a pg_dump --data-only snapshot derived from
-- staging, which itself clones prod -- ~64,193 library rows) was loaded into
-- the local dev Postgres and gave a real, if possibly-stale, measurement.
-- Pre-amble counts measured against THAT CLONE on 2026-08-12, not live prod:
--   artists.artist_name = '<U+FFFD>-Ziq [mu-Ziq]'                    -> 1 row  (id 656)
--   library.artist_name = '<U+FFFD>-Ziq [mu-Ziq]' (10 named ids)     -> 10 rows
--   library.album_title = 'La B<U+FFFD>te' (id 50340)                -> 1 row
-- Running this script end-to-end against that clone (twice, to prove
-- idempotency) drove all three counts to 0 and left every one of the 11
-- targeted rows holding the tubafrenzy-verified correct value, with zero
-- change to any other row. BS#2114 acceptance criterion 1 asks for the row
-- count + affected ids to be recorded in the migration or its PR
-- description: **the operator running this against live prod should paste
-- the actual pre-amble output into the PR description**, since the clone can
-- be somewhat stale relative to live prod (e.g. a very recent librarian edit
-- wouldn't be reflected yet) -- treat the counts above as "true of the clone
-- on 2026-08-12", not as a guarantee of what prod holds today.
--
-- The same clone surfaced two count mismatches worth recording rather than
-- silently folding into this fix, both OUT OF SCOPE for BS#2114 (no
-- tubafrenzy ground truth was pulled for them, and the ticket names exactly
-- 11 rows):
--   - `artists.artist_name` LIKE E'%�%' returned 3 in the clone, not 1:
--     alongside the µ-Ziq row, `Beyonc<U+FFFD>` (id 22025) and
--     `Damian Nisenson / Jean F<U+FFFD>lix Mailloux / Pierre Tanguay` (id
--     23162) are also still corrupt -- and id 22025's `alphabetical_name` is
--     corrupt too (`Beyonc<U+FFFD>`), so it is 3 corrupt values across 2 rows,
--     not 2. The #863 recovery (bs_replacement_char_recovery.sql, lines
--     126-127) fixed both of those names on `library.artist_name` only -- it
--     never touched the `artists` source of truth, so those two rows are a
--     standing hazard: if `artists.artist_name` is ever written again for
--     either row for an unrelated reason, migration 0060's cascade trigger
--     will push the still-corrupt value back onto every linked `library` row
--     and silently UNDO the #863 fix. (`alphabetical_name` has no cascade --
--     0060 fires only on `artist_name` -- so that third value is inert, but
--     it is still what sorts and displays.)
--
--     Two further arming conditions, neither of which needs a write to
--     `artists` at all, because catalog-export.service.ts reads
--     `artists.artist_name` on two paths of its own: (a) its
--     `cross_reference_names` aggregate reads that column DIRECTLY with no
--     `library` fallback, so merely inserting an `artist_crossreference` row
--     touching 22025 or 23162 would publish the corrupt name into another
--     release's export; (b) its `artist_name` is
--     `COALESCE(library.artist_name, artists.artist_name)`, so any `library`
--     row that ever holds a NULL `artist_name` (the column is nullable --
--     schema.ts "Nullable until A.2") falls through to the corrupt value.
--     BOTH ARE UNARMED IN THE 2026-08-12 CLONE, measured not assumed:
--     `artist_crossreference` has 0 rows referencing either artist, and
--     `library.artist_name IS NULL` is 0 across the whole table. So the
--     export is clean TODAY and this stays a latent hazard rather than a
--     live parity failure -- but the surface is wider than "someone writes
--     to `artists`", and any of the three triggers fires it silently.
--     Worth its own follow-up ticket,
--     which INHERITS THIS TICKET'S 2026-08-31 DEADLINE: tubafrenzy is the
--     ground truth for those `artists` rows as much as for these, and #863's
--     values for them came from curated fuzzy matching, not from tubafrenzy.
--     They are deliberately not folded in here because BS#2114 names exactly
--     11 rows and this script's whole warrant is "direct substitution from
--     tubafrenzy, no judgement call" -- repairing them would need their own
--     ground-truth pull.
--   - The rotation/flowsheet re-check the next section runs (BS#2114
--     acceptance criterion 5) found 5 rows in the clone, all pre-existing
--     residue from #863 Phase 3.5's deliberately-unrecovered bucket (no
--     canonical was identifiable at the time): `rotation` ids 10789
--     (Justice, album_title mangled to 3 replacement chars), 13703
--     (`Acc<U+FFFD>sed`), 21149 (`N<U+FFFD>dia & Valentina`), 21335
--     (`Civilistj<U+FFFD>vel! & Mayssa Jallad`), and 16683 (artist_name
--     already fixed to "Amara Toure" by Phase 2, but album_title still reads
--     `Amare Tour<U+FFFD> 1973-1980`). All five appear in
--     audit/bs_replacement_char_phase35.csv with an EMPTY curated-canonical
--     column, which is what "deliberately unrecovered" means there: the two
--     rotation rows that DID get a curated value in that CSV (Midnight Zone,
--     GER<U+FFFD>USCHMANUFAKTUR) are the two Phase 3.5 actually repaired.
--     16683's album_title was not an oversight either -- it was curated and
--     dropped, its auto-proposal ("Used Songs (1973-1980)", confidence 0.38)
--     being plainly wrong. None of the 5 map to a `legacy_release_id` this
--     ticket names.
--
-- Design is self-correcting / idempotent by construction: every UPDATE's
-- WHERE clause matches on the corrupt value AND (for `library`) the specific
-- `legacy_release_id`, so a row already fixed no longer matches and a
-- re-run is a genuine no-op -- verified for real against the clone above,
-- not just asserted; the post-amble re-verifies it on every run.
--
-- Not round-trippable: same posture as Phase 1/2/3.5. `ef bf bd` is the
-- UTF-8 encoding of U+FFFD itself; the original byte was already destroyed
-- upstream. This script substitutes the tubafrenzy-verified exact original,
-- not a fuzzy/plausible reconstruction.
--
-- Unicode normalization: DELIBERATELY NOT APPLIED, unlike Phase 2/3.5, which
-- NFC-normalised and stripped zero-width chars before write. That step was
-- right there and wrong here, because the provenance is different. Phase 2/3.5
-- injected strings assembled by a matcher from LML/Discogs/MusicBrainz, which
-- can arrive in arbitrary Unicode form; NFC gave those a canonical shape for
-- Lucene/trgm tokenization. Phase 4's two strings are copied from tubafrenzy,
-- and BS#2114's acceptance criterion is that the catalog-parity harness
-- reports 0 mismatches -- and that harness compares BYTE-EXACT
-- (scripts/catalog_parity_diff.py::_normalize strips surrounding whitespace
-- and collapses NULL/''/'NULL', and explicitly applies "no case folding, no
-- accent folding"). Normalizing on write would therefore be the one thing
-- that could REINTRODUCE a parity mismatch, if tubafrenzy ever held a
-- non-NFC form. It is moot for these two values in any case -- both are
-- already NFC-stable and carry no zero-width characters:
--   µ-Ziq [mu-Ziq]  = c2 b5 2d 5a 69 71 20 5b 6d 75 2d 5a 69 71 5d
--   La Bête         = 4c 61 20 42 c3 aa 74 65
-- Both byte sequences were read back out of a tubafrenzy-sourced library.db
-- and match these literals exactly, for all 10 ids and for 50340.
--
-- The `µ` is U+00B5 MICRO SIGN (c2 b5), NOT U+03BC GREEK SMALL LETTER MU
-- (ce bc). This distinction is load-bearing and easy to lose in an editor.
-- NFC and NFD both leave U+00B5 alone (it has only a COMPATIBILITY
-- decomposition), so every normalization this codebase actually performs is
-- a no-op on it: `normalize(..., NFD)` inside migration 0134's
-- `fold_artist_name`, migration 0092's `normalize_artist_name`, and the
-- `.normalize('NFC')` on the artist create path all preserve it. NFKC/NFKD
-- WOULD fold it to U+03BC and break parity -- the two NFKC call sites in this
-- repo (jobs/flowsheet-metadata-backfill/lookup-cache.ts and
-- jobs/streaming-url-upgrade/orchestrate.ts) are in-memory lookup keys only
-- and never write a folded string back to any column, so no live write path
-- can convert this value. If one is ever added, this row breaks first.
--
-- BS#2114 also asks to re-check wxyc_schema.rotation and wxyc_schema.flowsheet
-- with the same U+FFFD predicate #863 used (this ticket only measured the
-- catalog export, i.e. wxyc_schema.library). That predicate is included
-- below as an INFORMATIONAL, non-fixing audit -- this script has no
-- tubafrenzy-verified correct values for whatever it might find there. A
-- non-zero count in that section needs either a follow-up ticket naming the
-- counts, or a future phase of this same script family once ground truth is
-- established.

-- ===========================================================
-- Session guards. Both matter more here than in a typical script because
-- EVERY predicate below is exact-byte string equality.
--
-- client_encoding: if the operator's psql session resolves to a non-UTF8
-- client encoding (it is locale-derived, so this is environmental, not a
-- typo), the server reinterprets this file's UTF-8 bytes, every predicate
-- matches zero rows, and the pre-amble reports 0 / 0 / 0 -- which reads as
-- "already repaired" rather than "matched nothing". Declaring it makes that
-- failure impossible instead of silent.
--
-- ON_ERROR_STOP: without it, an error inside the transaction leaves psql
-- issuing the remaining commands into an aborted transaction, COMMIT
-- degrades to ROLLBACK, and psql still exits 0 -- a repair that reports
-- success and changed nothing. (`\` lines are dropped by the test's
-- statement extractor, so this does not affect what the spec verifies.)
-- ===========================================================
\set ON_ERROR_STOP on
SET client_encoding TO 'UTF8';

-- ===========================================================
-- Pre-amble: targeted rows + their BEFORE counts (1 / 10 / 1 against the
-- 2026-08-12 dev clone, see header).
--
-- To eyeball prod's real counts before anything is written, run ONLY this
-- section first -- e.g. `sed -n '/Pre-amble/,/Transactional/p'` -- since the
-- whole file executes non-interactively under `psql -f` and offers no pause
-- between the pre-amble and COMMIT at which an operator could abort.
-- ===========================================================
SELECT '=== V_BS_FFFD_P4 pre-amble: rows targeted per (table, column) ===' AS section;

SELECT 'artists' AS tbl, 'artist_name' AS col, '�-Ziq [mu-Ziq]' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.artists WHERE artist_name = '�-Ziq [mu-Ziq]') AS rows
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, '�-Ziq [mu-Ziq]' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE legacy_release_id IN (1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 63110, 69776) AND artist_name = '�-Ziq [mu-Ziq]') AS rows
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'La B�te' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE legacy_release_id = 50340 AND album_title = 'La B�te') AS rows;

-- Per-id detail so the 10 catalog ids named in BS#2114's table are visible
-- individually, not just as an aggregate -- acceptance criterion 1.
SELECT 'BEFORE — targeted catalog ids and current values' AS section;
SELECT legacy_release_id, artist_name, album_title
  FROM wxyc_schema.library
 WHERE legacy_release_id IN (1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 50340, 63110, 69776)
 ORDER BY legacy_release_id;

-- ===========================================================
-- Transactional UPDATE block.
-- ===========================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

-- Blast-radius guard. The `artists` write below is bounded by the corrupt
-- string, not by `id = 656`, and its 0060 cascade then rewrites every
-- `library` row under whatever `artists` rows it hit. That is safe only while
-- the corrupt string identifies exactly one `artists` row -- true of the
-- 2026-08-12 clone, but a fact about the data, not a property of the
-- statement. If prod has since gained a second row carrying the identical
-- corrupt name (a duplicate from a DJ pasting the mojibake, say), the
-- unguarded form would rename it too and cascade across its library rows,
-- well outside the 11 BS#2114 names. Abort loudly instead.
--
-- The threshold is "> 1", not "<> 1", so a re-run -- where the count is
-- legitimately 0 -- stays the genuine no-op the header promises.
DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM wxyc_schema.artists WHERE artist_name = '�-Ziq [mu-Ziq]';
  IF n > 1 THEN
    RAISE EXCEPTION 'BS#2114 guard: expected at most 1 corrupt artists row, found %. Resolve the duplicates before proceeding.', n;
  END IF;
END $$;

-- Source-of-truth fix: cascades to `library.artist_name` for every row with
-- a matching `artist_id` via the 0060 trigger.
UPDATE wxyc_schema.artists
   SET artist_name = 'µ-Ziq [mu-Ziq]'
 WHERE artist_name = '�-Ziq [mu-Ziq]';

-- Self-correcting safety net for the 10 named catalog ids -- a no-op
-- wherever the trigger above already fixed the row.
UPDATE wxyc_schema.library
   SET artist_name = 'µ-Ziq [mu-Ziq]'
 WHERE legacy_release_id IN (1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 63110, 69776)
   AND artist_name = '�-Ziq [mu-Ziq]';

UPDATE wxyc_schema.library
   SET album_title = 'La Bête'
 WHERE legacy_release_id = 50340
   AND album_title = 'La B�te';

COMMIT;

-- ===========================================================
-- Post-amble verify: every targeted tuple should show residual=0.
-- ===========================================================
SELECT '=== V_BS_FFFD_P4 post-amble: residual count per row (expect 0) ===' AS section;

SELECT 'artists' AS tbl, 'artist_name' AS col, '�-Ziq [mu-Ziq]' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.artists WHERE artist_name = '�-Ziq [mu-Ziq]') AS residual
UNION ALL
SELECT 'library' AS tbl, 'artist_name' AS col, '�-Ziq [mu-Ziq]' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE legacy_release_id IN (1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 63110, 69776) AND artist_name = '�-Ziq [mu-Ziq]') AS residual
UNION ALL
SELECT 'library' AS tbl, 'album_title' AS col, 'La B�te' AS lossy, (SELECT COUNT(*) FROM wxyc_schema.library WHERE legacy_release_id = 50340 AND album_title = 'La B�te') AS residual
ORDER BY residual DESC, tbl, col;

SELECT 'AFTER — targeted catalog ids and current values' AS section;
SELECT legacy_release_id, artist_name, album_title
  FROM wxyc_schema.library
 WHERE legacy_release_id IN (1977, 1978, 1979, 1980, 1981, 1982, 1983, 37529, 50340, 63110, 69776)
 ORDER BY legacy_release_id;

-- Desired end state per BS#2114: this returns 0 for wxyc_schema.library.
SELECT 'AFTER — overall residual U+FFFD, wxyc_schema.library (desired end state: 0)' AS section;
SELECT (SELECT COUNT(*) FROM wxyc_schema.library WHERE artist_name LIKE E'%�%' OR album_title LIKE E'%�%') AS remaining;

-- BS#2114 acceptance criterion 5: re-check rotation + flowsheet with the
-- same predicate #863 used. INFORMATIONAL ONLY -- this script fixes nothing
-- here, it only reports. A non-zero count needs a follow-up ticket (name the
-- counts) or a future phase once ground truth for those rows is available.
-- `artists.alphabetical_name` is included per the "check it" ask above. Do NOT
-- expect 0 here: the µ-Ziq row's own `alphabetical_name` is the plain-ASCII
-- `mu-Ziq` and cannot carry this corruption class (see header), but the table
-- as a whole is not clean -- id 22025's `alphabetical_name` is `Beyonc<U+FFFD>`,
-- the third corrupt value in the out-of-scope group described in the header.
-- Expected against the 2026-08-12 clone: artist_name 2, alphabetical_name 1.
SELECT 'AFTER — informational residual U+FFFD, other tables/columns (not fixed by this script)' AS section;
SELECT 'artists' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.artists WHERE artist_name LIKE E'%�%') AS remaining
UNION ALL
SELECT 'artists' AS tbl, 'alphabetical_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.artists WHERE alphabetical_name LIKE E'%�%') AS remaining
UNION ALL
SELECT 'library' AS tbl, 'label' AS col, (SELECT COUNT(*) FROM wxyc_schema.library WHERE label LIKE E'%�%') AS remaining
UNION ALL
SELECT 'rotation' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE artist_name LIKE E'%�%') AS remaining
UNION ALL
SELECT 'rotation' AS tbl, 'album_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE album_title LIKE E'%�%') AS remaining
UNION ALL
SELECT 'rotation' AS tbl, 'record_label' AS col, (SELECT COUNT(*) FROM wxyc_schema.rotation WHERE record_label LIKE E'%�%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE artist_name LIKE E'%�%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'track_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE track_title LIKE E'%�%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'album_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE album_title LIKE E'%�%') AS remaining
UNION ALL
SELECT 'flowsheet' AS tbl, 'record_label' AS col, (SELECT COUNT(*) FROM wxyc_schema.flowsheet WHERE record_label LIKE E'%�%') AS remaining
UNION ALL
-- `compilation_track_artist` is NOT part of #863's scan set, but it belongs
-- in this sweep: the parity harness compares CTA as its own multiset
-- (catalog_parity_diff.py CTA_COLUMNS = library_release_id, artist_name,
-- track_title), and CTA is populated by jobs/library-etl and
-- jobs/library-identity-consumer -- the same lossy legacy path that produced
-- everything else here. Omitting it would let this script report "clean"
-- while the harness kept failing on rows it never looked at. 0 in the
-- 2026-08-12 clone; included so that stays true by measurement, not
-- assumption. (Distinct from BS#1996, which tracks a different corruption
-- class in this table: double-encoded CP1252, not U+FFFD.)
SELECT 'compilation_track_artist' AS tbl, 'artist_name' AS col, (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE artist_name LIKE E'%�%') AS remaining
UNION ALL
SELECT 'compilation_track_artist' AS tbl, 'track_title' AS col, (SELECT COUNT(*) FROM wxyc_schema.compilation_track_artist WHERE track_title LIKE E'%�%') AS remaining
ORDER BY remaining DESC;

-- Refresh planner stats on every UPDATEd table (BS#934). ANALYZE cannot run
-- inside a transaction, so it lives here, outside any BEGIN/COMMIT. Only
-- `artists` and `library` are UPDATEd by this script -- `rotation` and
-- `flowsheet` above are read-only audits, not writes, so they don't need it.
-- See docs/bulk-update-playbook.md for the full pattern.
ANALYZE wxyc_schema.artists;
ANALYZE wxyc_schema.library;
