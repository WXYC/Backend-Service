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
--     23162) are also still corrupt. The #863 recovery
--     (bs_replacement_char_recovery.sql) fixed both of those names on
--     `library.artist_name` only -- it never touched the `artists` source of
--     truth, so those two rows are a standing hazard: if `artists.artist_name`
--     is ever written again for either row for an unrelated reason, migration
--     0060's cascade trigger will push the still-corrupt value back onto
--     every linked `library` row and silently UNDO the #863 fix. Worth its
--     own follow-up ticket.
--   - The rotation/flowsheet re-check the next section runs (BS#2114
--     acceptance criterion 5) found 5 rows in the clone, all pre-existing
--     residue from #863 Phase 3.5's deliberately-unrecovered bucket (no
--     canonical was identifiable at the time): `rotation` ids 10789
--     (Justice, album_title mangled to 3 replacement chars), 13703
--     (`Acc<U+FFFD>sed`), 21149 (`N<U+FFFD>dia & Valentina`), 21335
--     (`Civilistj<U+FFFD>vel! & Mayssa Jallad`), and 16683 (artist_name
--     already fixed to "Amara Toure", but album_title still reads
--     `Amare Tour<U+FFFD> 1973-1980` -- the #863 fix only matched the exact
--     artist_name value, not this separate album_title occurrence). None of
--     the 5 map to a `legacy_release_id` this ticket names.
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
-- BS#2114 also asks to re-check wxyc_schema.rotation and wxyc_schema.flowsheet
-- with the same U+FFFD predicate #863 used (this ticket only measured the
-- catalog export, i.e. wxyc_schema.library). That predicate is included
-- below as an INFORMATIONAL, non-fixing audit -- this script has no
-- tubafrenzy-verified correct values for whatever it might find there. A
-- non-zero count in that section needs either a follow-up ticket naming the
-- counts, or a future phase of this same script family once ground truth is
-- established.

-- ===========================================================
-- Pre-amble: targeted rows + their BEFORE counts (1 / 10 / 1 against the
-- 2026-08-12 dev clone, see header -- re-run this against prod to get the
-- real prod counts before COMMIT).
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
-- `artists.alphabetical_name` is included per the "check it" ask above; see
-- the header comment for why it's expected to stay at 0 structurally.
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
ORDER BY remaining DESC;

-- Refresh planner stats on every UPDATEd table (BS#934). ANALYZE cannot run
-- inside a transaction, so it lives here, outside any BEGIN/COMMIT. Only
-- `artists` and `library` are UPDATEd by this script -- `rotation` and
-- `flowsheet` above are read-only audits, not writes, so they don't need it.
-- See docs/bulk-update-playbook.md for the full pattern.
ANALYZE wxyc_schema.artists;
ANALYZE wxyc_schema.library;
