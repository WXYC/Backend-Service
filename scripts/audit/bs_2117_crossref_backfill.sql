-- BS2117: backfill wxyc_schema.artist_crossreference from tubafrenzy's
-- LIBRARY_CODE_CROSS_REFERENCE, ahead of the 2026-08-31 tubafrenzy turndown.
--
-- Like V_BS_FFFD (scripts/audit/bs_replacement_char_recovery.sql), this is a
-- HAND-APPLIED operator script, NOT a Drizzle migration — docs/migrations.md
-- says migrations are DDL-only, and this is DML over a curated table. There
-- is no entry in shared/database/src/migrations/; version history is just
-- `git log -- scripts/audit/bs_2117_crossref_backfill.sql`. Run against prod as
--
--     psql -v ON_ERROR_STOP=1 -f scripts/audit/bs_2117_crossref_backfill.sql
--
-- (see scripts/query-flowsheet.sh for the EC2-docker connection pattern).
-- ON_ERROR_STOP=1 is REQUIRED, matching scripts/relabel-rotation-direct-backfill.sql.
-- Without it a failure in the pair load does not stop psql: it runs on through
-- the transaction block (whose COMMIT then degrades to a rollback), the
-- post-amble and ANALYZE, and prints `resolved_pairs 0 / present_in_backend 0`
-- — which is indistinguishable from a successful idempotent re-run.
--
-- Note also that `psql -f` is non-interactive and the COMMIT is unconditional:
-- the pre-amble is a record to READ, not a gate that pauses. If you want to
-- inspect before writing, run the file down to the `BEGIN;` first, or run it
-- inside a transaction you roll back yourself.
--
-- ## Problem (#2117)
--
-- The first full catalog-parity run (discogs-etl#365, WXYC/wiki#89) found 157
-- catalog rows whose tubafrenzy-derived `cross_reference_names` is non-empty
-- but whose Backend-derived value is empty. tubafrenzy's authority for this
-- field is `LIBRARY_CODE_CROSS_REFERENCE`; Backend's is `artist_crossreference`
-- (see the `artist_aliases` CTE in apps/backend/services/catalog-export.service.ts).
--
-- ## Root cause: a keying mismatch in the deployed importer
--
-- jobs/library-etl/job.ts already imports this exact table on every run
-- (`fetchLegacyArtistCrossRefs` / `importArtistCrossRefs`, unconditional full
-- scan of LIBRARY_CODE_CROSS_REFERENCE, not gated by "modified since"). Its
-- `findArtistId` resolves an artist by
--   fold_artist_name(artists.artist_name) = fold_artist_name($name)
--   AND lower(artists.code_letters) = lower($codeLetters)
-- i.e. it REQUIRES an exact `code_letters` match, with no name-only fallback.
-- 35 of the 110 resolvable tubafrenzy pairs (below) have an EMPTY
-- CALL_LETTERS on the referencing side — tubafrenzy's convention for a
-- "pointer" LIBRARY_CODE that carries a PRESENTATION_NAME purely for
-- cross-referencing but has no catalog holdings of its own (CALL_NUMBERS is
-- also 0 on every one of these), e.g. "Barry Black" -> "Eric Bachmann"
-- ("Barry Black is filed w/ Eric Bachmann"). Backend's `artists.code_letters`
-- is NOT NULL, so `lower('') = lower(artists.code_letters)` can only ever
-- match a Backend row that itself has an empty code_letters, which a real
-- catalogued artist never has. The ETL's `skipped++` counter absorbs every
-- one of these with no operator-visible signal.
--
-- That blind spot is the right SIZE for the defect. `cross_reference_names`
-- is exported per catalog ROW of the artist the row hangs off, so a pointer
-- pair that fails to import leaves the artist it points AT short an alias on
-- every one of that artist's rows. In the dev clone the 35 empty-CALL_LETTERS
-- pairs point at 30 distinct Backend artists owning **166 `library` rows** —
-- against the harness's 157 empty-in-Backend catalog rows. That is a fit, not
-- a proof (the clone is not prod), but it is a materially better fit than any
-- competing explanation, and it is consistent with prod's
-- `artist_crossreference` being otherwise well populated — which the
-- harness's other buckets independently require (next section).
--
-- This script's resolver (below) does NOT require code_letters equality: it
-- matches by folded name first, and uses code_letters, then
-- genre_artist_crossreference.artist_genre_code, only to DISAMBIGUATE when a
-- name matches more than one Backend artist. A name that resolves to zero or
-- multiple Backend artists is reported in the pre-amble and skipped, never
-- guessed.
--
-- ## What the dev clone can and cannot tell us
--
-- The dev clone (dev_env/seed-clone.sql) reports `artist_crossreference` as
-- completely EMPTY. **That measurement carries no information about prod and
-- must not be read as "the import step never ran."** The fixture's leading
-- TRUNCATE block lists `wxyc_schema.artist_crossreference`, and its
-- `pg_dump --data-only` body restores only five tables — `format`, `artists`,
-- `genre_artist_crossreference`, `library`, `rotation`. The cross-reference
-- table is truncated and never repopulated, so it reads as empty in every
-- environment that loads this fixture, whatever staging or prod actually
-- holds. Its emptiness here is an artifact of the fixture's table list.
--
-- The parity harness settles the question in the other direction. Its
-- 11-empty-in-tubafrenzy and 28-differ-on-both-sides buckets each require
-- Backend to be emitting cross-reference values that tubafrenzy does not
-- match; an empty table cannot produce either bucket. **Prod's
-- `artist_crossreference` is populated**, the deployed importer has been
-- running and mostly succeeding, and what it has never been able to import is
-- the pointer pairs above.
--
-- What the clone IS good for is the resolver: it carries real,
-- staging-derived `artists` / `genre_artist_crossreference` / `library` data
-- (~24k artists, ~64k library rows), so running the three-stage resolver
-- against it exercises real WXYC artist names rather than synthetic ones.
-- Measured there:
--
--   * 110 pairs -> 15 excluded as provenance conflicts (above), 31 do not
--     resolve, 64 resolve on both sides and are eligible to insert. Every one
--     of the 31 fails on the REFERENCING side, and every one has an empty
--     tubafrenzy CALL_LETTERS (the converse does not hold: 4 of the 35
--     empty-CALL_LETTERS pairs do resolve).
--   * 0 pairs come out AMBIGUOUS. Five endpoint tuples match more than one
--     Backend artist by folded name — DAT Politics, Exene Cervenka, Sankofa,
--     and the two Oliver Lakes — and stages 2 and 3 narrow every one of them
--     to a single artist.
--   * 60 of the 64 eligible pairs would ALSO satisfy the deployed importer's
--     strict `code_letters` equality on both sides. Only 4 need this script's
--     more lenient name-first resolution — those 4 pairs are the entire
--     population this script recovers that the ETL could not.
--   * 64 eligible pairs collapse to 62 distinct unordered pairs, inserted as
--     62 rows against the clone's empty table.
--   * Their 108 endpoint artists own 630 `library` rows between them — the
--     upper bound on how many catalog rows change value.
--
-- Because prod's table is populated and the clone's is empty by construction,
-- **the row count this inserts against prod will be far lower than 62** —
-- most of those 60 strict-matchable pairs should already be present, and the
-- guards below will skip them. Read the pre-amble and the `INSERT 0 n` line
-- before accepting the COMMIT; the counts will legitimately differ from every
-- clone-measured figure in this header.
--
-- ## Provenance conflicts: 15 pairs EXCLUDED because tubafrenzy's own FK is wrong
--
-- `LIBRARY_CODE_CROSS_REFERENCE.CROSS_REFERENCING_ARTIST_ID` is, despite its
-- name, a `LIBRARY_CODE.ID` (the referenced side is a LIBRARY_CODE id too).
-- The 110 pairs embedded below resolve it that way and match tubafrenzy
-- exactly — verified row-by-row against the live database, 0 mismatches.
--
-- But on 15 of them the FK is CORRUPT UPSTREAM, and each row's own COMMENT
-- proves it. Many comments carry a machine-generated provenance prefix,
-- `[from <Genre>-<LETTERS>-<NUM> to <target>]`. Where the referencing row is a
-- real filing (CALL_NUMBERS <> 0) and that prefix names a different non-zero
-- code, the two disagree — and the prefix is the one telling the truth:
--
--   id  FK resolves to              provenance note names        target
--   26  Cactus World News CA 46     Rock DO 66 = Tonya Donelly   The Breeders
--   27  Cactus World News CA 46     Rock DO 66 = Tonya Donelly   Belly
--   29  Capping Day CA 74           Rock CO 184 = Graham Coxon   Blur
--   31  Chris Cacavas CA 66         Rock CA 37 = Camper Van B.   Eugene Chadbourne
--   32  Cactus CA 153               Rock DE 80 = The Dentists    Coax
--   33  Gloria Loring LO 24         Rock DE 90 = Amy Denio       Danubians
--   34  Cabal CA 72                 Rock CA 8 = Caravan          Delivery
--   36  Gloria Loring LO 24         Rock DO 73 = Julie Doiron    Eric's Trip
--   38  Papa John Creach CR 59      Rock DE 39 = Dead Can Dance  Lisa Gerrard
--   41  Capping Day CA 74           Rock DA 7 = Dave Davies      The Kinks
--   43  Cabaret Voltaire CA 42      Rock DR 7 = Dream Syndicate  Last Days of May
--   44  Cabaret Voltaire CA 42      Rock CH 11 = Sheila Chandra  Monsoon
--   45  Cabaret Voltaire CA 42      Rock DR 7 = Dream Syndicate  Opal
--   46  Cabal CA 72                 Rock CL 55 = Allen Clapp     The Orange Peels
--   48  Cactus World News CA 46     Rock CA 69 = Lori Carson     Golden Palominos
--
-- Every note names a real, well-known musical relationship (Donelly was in the
-- Breeders and founded Belly; Coxon is in Blur; Davies is a Kink; Gerrard is
-- half of Dead Can Dance; Chandra fronted Monsoon; Clapp is the Orange Peels;
-- Carson sang with the Golden Palominos). Every FK reading is nonsense
-- (Cabaret Voltaire did not spawn Monsoon; Papa John Creach is not Lisa
-- Gerrard). Note too that one FK value collapses several distinct true sources
-- onto one arbitrary name — Cabaret Voltaire CA 42 stands in for three
-- different referencing codes.
--
-- These 15 are EXCLUDED from the INSERT (see `bs2117_provenance_conflicts`
-- below) and reported as `provenance_conflict_skip` in the pre-amble. The
-- reason is asymmetric risk: unlike the missing pairs, these are associations
-- prod does NOT hold, so no guard below would skip them — they would land as
-- brand-new FALSE aliases on real catalog rows, and this script has no delete
-- path to walk them back. A wrong alias on a live catalog row is worse than a
-- missing one.
--
-- Repairing them by re-resolving the referencing side from the provenance
-- prefix is mechanically easy and probably correct, but it is a data-quality
-- judgement about tubafrenzy's own corruption, made from free-text prose, and
-- it belongs to a cataloger and a follow-up ticket — not to a backfill whose
-- stated contract is to move cataloger data across unchanged.
--
-- ## Hard ceiling: 31 of the 110 pairs are NOT recoverable by this script
--
-- Do not read a later "0 remaining empty-in-Backend mismatches" as this
-- script's success, and do not expect that number at all. 31 of the 110
-- pairs name a referencing artist — 28 distinct names — for which Backend has
-- NO `artists` row whatsoever. That is an absence, not a name-match failure a
-- looser fold could solve. These are tubafrenzy "pointer" LIBRARY_CODEs: no
-- catalog holdings, so no release import ever created a Backend artist for
-- them.
--
-- They are not a zero-impact residue. The pointer artist contributes no
-- catalog rows of its own, but the artist it points AT does, and those are
-- the rows missing the alias. In the clone the 31 pairs point at 26 Backend
-- artists owning 150 `library` rows — i.e. the large majority of the ticket's
-- 157 survives this backfill untouched. This script closes the 4 pairs the
-- ETL could not; it does not close the bucket.
--
-- Closing the rest is a different repair, deliberately NOT attempted here
-- because it CREATES catalog identities rather than linking existing ones:
-- insert an `artists` row for each pointer name (`code_letters` is
-- varchar(4) NOT NULL, so '' is representable) and link that. Whether WXYC
-- wants 28 holdings-free artist rows in its catalog is a cataloger's call,
-- not this script's. A handful of the 28 are name VARIANTS rather than true
-- absences and would need an alias rule instead of a new row: "Wedding
-- Present" vs Backend's "The Wedding Present", tubafrenzy's bare "X" vs
-- Backend's "X [US]", "Return to Forever" vs "Chick Corea (Return to
-- Forever)". "Cash, Larry Jr." is a fourth case and not a lost association at
-- all — it is the alphabetical inversion of Backend's own "Larry Cash, Jr.",
-- so both sides of that pair are one artist. None of these are safe to
-- automate blind.
--
-- ## Source data: 110 of 119 raw rows resolve; 9 dangle
--
-- LIBRARY_CODE_CROSS_REFERENCE has 119 rows. 9 have an endpoint whose
-- LIBRARY_CODE no longer exists (the FK target was deleted from tubafrenzy
-- at some point after the cross-reference was recorded). These are
-- unrepairable by this script — there is no surviving PRESENTATION_NAME to
-- resolve against Backend, and re-deriving one from free-text COMMENT prose
-- (a couple of the 9 name the missing side in the comment, e.g. row 19's
-- comment mentions "DeGli Antoni, Mark -- DE 137") is a guess, not cataloger
-- data, and is deliberately NOT attempted here. Enumerated for the record
-- (LIBRARY_CODE_CROSS_REFERENCE.ID, existing side, missing side, comment):
--
--   8   : missing(4835)              -> Clouddead (CL 7)              "Why? a member of Clouddead"
--   19  : Soul Coughing               -> missing(7318)                 "...to Mark DeGli Antoni]#[see also DeGli Antoni, Mark -- DE 137]"
--   30  : missing(6357)              -> Camper Van Beethoven (CA 37)  "...to Camper Van Beethoven]#[see also Camper Van Beethoven]"
--   63  : Danger Mouse (DA 35)        -> missing(14013)                (no comment)
--   64  : missing(14013)             -> Danger Mouse (DA 35)          (no comment; reverse of 63, same missing id both times)
--   102 : What Peggy Wants (WH 40)    -> missing(17024)                (no comment)
--   103 : Dillon Fence (DI 41)        -> missing(17024)                (no comment)
--   104 : Snatches of Pink (SN 9)     -> missing(17024)                (no comment)
--   111 : missing(11941)             -> Charlemagne (CH 182)          (no comment)
--
-- Disposition: excluded from this backfill. No further action proposed;
-- these associations are lost with tubafrenzy regardless of what this
-- script does.
--
-- ## The "28 both-sides-differ" bucket (#2117 acceptance criterion)
--
-- The parity harness also reports 28 catalog rows where `cross_reference_names`
-- is non-empty on BOTH sides but the values differ. This script cannot
-- enumerate those 28 by name — that list comes from `catalog_parity_diff.py`
-- comparing a live Backend export against tubafrenzy, and there is no prod
-- Backend database available in this environment (see below). What this
-- script DOES do: it backfills every one of the 110 resolvable tubafrenzy
-- pairs (idempotently, ON CONFLICT DO NOTHING), not just a hand-picked
-- subset believed to cover the 157 empty-in-Backend bucket. If any of the 28
-- both-sides-differ rows are explained by Backend having SOME but not ALL of
-- a given artist's tubafrenzy cross-references (the same keying-mismatch
-- root cause, partially masked because that artist already had at least one
-- correctly-imported pair), this backfill fixes them as a side effect. It
-- cannot fix a row where Backend holds a cross-reference tubafrenzy does NOT
-- have (this script only inserts, never deletes) — that shape requires
-- prod-side enumeration this environment doesn't have. Re-run the parity
-- harness after this script deploys; file a follow-up naming whatever
-- remains in the 28 (or a subset of it).
--
-- ## Reconciling "110 pairs" against "157 catalog rows"
--
-- These count different things. 110 raw rows collapse to 108 distinct
-- unordered artist pairs (one exact duplicate: LIBRARY_CODE_CROSS_REFERENCE
-- ids 88/89, "Preservation Hall Jazz Band"/"Sweet Emma Barrett" recorded
-- twice; one reversed duplicate: ids 74/75, "Sankofa"/"The Apple Juice Kid"
-- recorded in both directions), touching 182 distinct artist names across 183
-- distinct (name, CALL_LETTERS, CALL_NUMBERS) tuples — "Oliver Lake" appears
-- as two tuples. 28 of those names resolve to no Backend `artists` row at all
-- (the 31 unresolvable pairs share them); the other 154 resolve, to 155
-- distinct Backend artist ids.
--
-- `cross_reference_names` is exported per catalog ROW (one row per library
-- pressing), keyed off that row's own artist, so a touched artist contributes
-- to the 157 once per `library` row it owns. Note that an unresolvable
-- "pointer" artist (e.g. "Barry Black") does NOT drop out of the 157 just
-- because it owns no catalog rows itself: the alias it supplies is missing
-- from the rows of the artist it points at ("Eric Bachmann"), and those rows
-- are counted. That is why the 31 leave ~150 clone rows permanently short
-- rather than costing nothing — see the hard-ceiling section above.
--
-- Measured against the clone: the 155 resolvable endpoint artists own 915
-- `library` rows between them, of which the 130 artists that are an endpoint
-- of an actually-inserted pair own 766. Neither number reconciles 1:1 with
-- the harness's 157 and neither needs to — most of those rows already carry a
-- correct, non-empty `cross_reference_names` on the prod Backend side today.
-- They bound the blast radius of the watermark rebuild, not the defect.
--
-- ## Keying: tubafrenzy LIBRARY_CODE vs. Backend artists (resolution rule)
--
-- tubafrenzy identifies a LIBRARY_CODE by
-- (PRESENTATION_NAME, CALL_LETTERS, CALL_NUMBERS, GENRE_ID) — CALL_NUMBERS
-- and GENRE_ID are per-catalog-placement, not per-artist. Backend's
-- `artists` row is name-scoped (no call number at all); the per-genre
-- catalog number lives on `genre_artist_crossreference.artist_genre_code`,
-- separately. So a tubafrenzy LIBRARY_CODE is not 1:1 with a Backend
-- `artists` row. `bs2117_resolve_artist()` below resolves in three stages,
-- each only engaged when the previous stage left more than one candidate:
--   1. `fold_artist_name(artists.artist_name) = fold_artist_name(name)` —
--      the same Unicode-form/diacritic/case-insensitive fold migration 0134
--      added and jobs/library-etl already uses for this exact purpose.
--   2. Narrow to candidates whose `code_letters` matches (case-insensitive)
--      when the tubafrenzy side recorded non-empty CALL_LETTERS.
--   3. Narrow further to candidates with a `genre_artist_crossreference`
--      row whose `artist_genre_code` matches CALL_NUMBERS, when non-zero.
-- A name matching zero artists is UNRESOLVED; a name still matching more
-- than one artist after all three stages is AMBIGUOUS. Both are reported in
-- the pre-amble and excluded from the INSERT — never guessed.
--
-- `wxyc_schema.fold_artist_name` is present in prod, on two independent
-- counts: migration 0134 (`0134_fold-artist-name`, merged 2026-07-31) created
-- it and now sits nine entries behind the journal tip, and `jobs/library-etl`
-- calls it on every ETL run, which would fail outright if it were missing.
-- There is also an `artists_fold_name_idx` btree on the expression, so stage 1
-- is index-backed rather than a per-row seq scan — the whole 110-pair resolve
-- measures ~25ms against 24k artists, well inside the 30s statement_timeout.
--
-- The fold's STRENGTH is deliberate and correct for this repair: NFD-normalize,
-- strip combining marks, lowercase. Nothing else. It does not strip
-- punctuation, articles, or bracketed qualifiers, so it cannot merge distinct
-- artists — "Paris [rock band]" and "Paris [hiphop mc]" stay separate, which
-- matters because pairs 54/55 reference both. The cost of that conservatism is
-- that it misses tubafrenzy name VARIANTS, which is a real but small effect
-- here: of the 28 unresolvable names, 24 have no plausible Backend
-- counterpart at all, and only 4 are variants a looser rule would reach (see
-- the hard-ceiling section). Loosening the fold to catch those 4 would risk
-- the many-to-one collapses this table has no way to detect after the fact, so
-- it is not done.
--
-- Two properties of the resolution were checked against the clone rather than
-- assumed, because both would be silent if wrong:
--   * Stage 2 falls THROUGH when `code_letters` narrows the candidate set to
--     zero — it restores the stage-1 set rather than failing, so stage 3 still
--     gets a chance. That path never engages here: no name with more than one
--     candidate has zero code_letters matches among them. If it ever did, the
--     worst case is still bounded — stage 3 either narrows to one, or the pair
--     is reported AMBIGUOUS and skipped.
--   * No single-candidate resolution CONTRADICTS tubafrenzy. Every endpoint
--     that resolves to exactly one Backend artist and carries a non-empty
--     CALL_LETTERS has that artist's `code_letters` agreeing with it. The
--     lenient name-first rule is therefore never overriding a letters
--     disagreement; it only fires where tubafrenzy recorded no letters to
--     check against.
--
-- ## Concurrency
--
-- Run exactly one copy. The either-direction `NOT EXISTS` guard below reads a
-- snapshot, so under READ COMMITTED two simultaneous runs could each see a
-- pair as absent and insert it in OPPOSITE directions — which the ordered
-- unique index cannot reject, and which is precisely the duplicate the guard
-- exists to prevent. This is a hand-run operator script, so serializing it is
-- a matter of not starting it twice, not of adding a lock.
--
-- ## Direction, idempotency, and the reversed-duplicate guard
--
-- `artist_crossreference`'s unique index is on the ORDERED pair
-- (source_artist_id, target_artist_id); the export's `artist_aliases` CTE
-- unions both FK directions, so a pair only needs to exist once, in either
-- direction, for the alias to appear on both artists' catalog rows. Two
-- distinct hazards follow, both guarded explicitly below rather than left to
-- ON CONFLICT alone:
--   - SELF-PAIRS: a defensive guard, not a guard against a known row. The
--     only candidate in the source data is LIBRARY_CODE_CROSS_REFERENCE row
--     128, which links "Oliver Lake" to "Oliver Lake" (comment: "same Oliver
--     Lake") — two DIFFERENT tubafrenzy LIBRARY_CODEs (CALL_NUMBERS 17 vs. 2)
--     sharing one PRESENTATION_NAME, cross-referenced to point catalogers at
--     the correct one. Backend's artist identity is NOT name-unique, and in
--     the clone it mirrors tubafrenzy exactly: artist 1829 ("Oliver Lake",
--     LA, genre code 17) and artist 15780 ("Oliver Lake", LA, genre code 2)
--     are two separate rows. Stage 2 cannot separate them (both are `LA`),
--     but stage 3 can, on the genre code — so row 128 resolves to 1829 ->
--     15780, is classified `resolved` (NOT `self_pair_skip`) in the pre-amble,
--     and IS inserted. That is the correct outcome: it reproduces exactly the
--     alias tubafrenzy's own export emits for both Oliver Lake catalog rows,
--     which is the parity this ticket is chasing. The `source <> target`
--     filter therefore matches zero rows against the clone. It stays because
--     prod may hold only ONE "Oliver Lake" (or the two may not carry
--     distinguishing genre codes), in which case both sides collapse to one
--     id and the guard is what stops an uninterpretable self-referential row.
--     The pre-amble reports that case as `self_pair_skip`, so an operator can
--     tell the two outcomes apart before committing — the resolution is
--     surfaced either way, never silently picked.
--   - REVERSED DUPLICATES: rows 74/75 record "Sankofa" -> "The Apple Juice
--     Kid" AND "The Apple Juice Kid" -> "Sankofa" — the same unordered pair,
--     opposite direction. `ON CONFLICT (source_artist_id, target_artist_id)
--     DO NOTHING` does NOT catch this (different ordered key), so this
--     script deduplicates by `LEAST`/`GREATEST` of the resolved artist ids
--     BEFORE the INSERT (picking the direction where the lower artist id is
--     the source — an arbitrary but deterministic, auditable convention),
--     and separately guards against a pair Backend may already hold in
--     EITHER direction via an explicit `NOT EXISTS` check (not just
--     ON CONFLICT on the exact ordered pair) — necessary because we cannot
--     inspect prod's existing rows ahead of time (see below).
--
-- Net effect: safe to run more than once. A second run finds nothing left
-- to insert.
--
-- ## Cataloger comments
--
-- 51 of the 110 pairs carry a tubafrenzy COMMENT (free-text cataloger
-- rationale — "which one?", "RH records as Cyanosis", "shared member Adrian
-- Finch", etc.). These are cataloger judgements the same way the
-- cross-references themselves are (per the tracking issue's framing) and
-- are lost forever after tubafrenzy turndown, so this script carries them
-- into `artist_crossreference.comment` verbatim rather than discarding them.
-- "Verbatim" is exact, not approximate: tubafrenzy's own
-- `LIBRARY_CODE_CROSS_REFERENCE.COMMENT` is `varchar(100)`, so the 100-char
-- values here (e.g. row 31, which ends mid-word at "for Camper Va") are
-- already the full stored value — the truncation happened in tubafrenzy years
-- ago and nothing is being clipped on the way out. The Backend column is
-- `varchar(255)`, so there is headroom, not a lossy fit.
--
-- ## Trigger costs (expected, not bugs)
--
-- Two triggers fire on this INSERT; both are intended, neither is free.
--
--   1. Migration 0138's `touch_library_watermark_from_artist_crossreference`
--      is AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE FOR EACH STATEMENT
--      (verified against the live table definition: it does fire on INSERT,
--      not only on UPDATE). It advances `library_watermark` exactly once for
--      this script's single INSERT statement, which forces the next
--      `GET /library/catalog` request to rebuild the full gzip export cache.
--      Correct behavior — making `cross_reference_names` edits visible is the
--      whole point of 0138 — and the same one-time cost any `library` add
--      already pays.
--   2. `cdc_artist_xref` is AFTER INSERT OR UPDATE OR DELETE FOR EACH **ROW**,
--      calling `cdc_notify()`. So this INSERT also emits one `pg_notify('cdc')`
--      per inserted row. The payload is a single narrow three-column row, far
--      under the 7800-byte guard in `cdc_notify`, and the count is bounded by
--      the number of rows actually inserted (77 against an empty table, fewer
--      against prod). Any LISTENer on the `cdc` channel sees that burst in one
--      transaction; nothing downstream needs to be quiesced for it, but do not
--      run this at the same moment as another bulk catalog mutation.
--
-- ## What this script CANNOT verify (no prod database available here)
--
-- There is no PROD Backend database reachable from this environment — no
-- prod credentials. Everything measured above comes from the dev clone, whose
-- `artists` / `genre_artist_crossreference` / `library` data is real and
-- staging-derived but whose `artist_crossreference` is empty by fixture
-- construction (see above) and therefore tells us nothing about what prod
-- already holds. Consequences the operator must keep in mind:
--
--   * The insert count will differ from 77, and should be much smaller.
--   * Which of the 110 pairs prod already has correctly is unknown; the
--     NOT EXISTS + ON CONFLICT guards are what make that safe to not know.
--   * The 157 / 11 / 28 / 1 harness buckets cannot be re-derived here. Re-run
--     `catalog_parity_diff.py` after this lands to measure what actually moved.
--
-- Read the pre-amble output before letting the transaction commit, per the
-- SELECT-before-write convention. Its counts are authoritative for the
-- database you are pointed at; this header's are not.
--
-- ## Compatibility
--
-- Target: PostgreSQL 14 (prod RDS 14.22). No PG15+-only syntax is used, and
-- this is not assumed — the file was executed end to end on PostgreSQL 14.23
-- against a minimal schema stub (clean run, idempotent re-run inserting 0,
-- and a re-run against a table pre-seeded with the REVERSED direction, which
-- correctly inserted nothing for that pair). Do not validate this file only
-- against the dev container: it runs PostgreSQL 18 and accepts syntax prod
-- would reject.
--
-- The pair table and resolver are session-temp objects created OUTSIDE the
-- transaction block, so they survive the COMMIT and are still visible to the
-- post-amble and to `ANALYZE`. That holds under `psql -f`, which runs the
-- whole file in one session — verified on 14.23. It does NOT hold if the file
-- is split across sessions, and `psql -1 -f` is wrong here (ANALYZE cannot run
-- inside a transaction block).

-- ===========================================================
-- Setup: load the 110 resolvable tubafrenzy pairs into a session-temp
-- table, and define the three-stage name resolver as a session-temp
-- function. Both are read by the pre-amble AND the transactional INSERT
-- below, so the pair data is written exactly once in this file.
-- ===========================================================
-- pg_temp-qualified so a re-run in a dirty session drops only THIS session's
-- scratch table. Unqualified, the name would resolve through search_path and
-- could drop a same-named permanent table; on a fresh session pg_temp does not
-- exist yet and IF EXISTS turns that into a NOTICE (verified on PG 14.23).
DROP TABLE IF EXISTS pg_temp.bs2117_pairs;
CREATE TEMP TABLE bs2117_pairs (
  row_id       int PRIMARY KEY,   -- LIBRARY_CODE_CROSS_REFERENCE.ID, for traceability
  src_name     text NOT NULL,     -- referencing LIBRARY_CODE.PRESENTATION_NAME
  src_letters  text NOT NULL,     -- referencing LIBRARY_CODE.CALL_LETTERS ('' if none)
  src_number   int  NOT NULL,     -- referencing LIBRARY_CODE.CALL_NUMBERS (0 if none/"pointer" entry)
  tgt_name     text NOT NULL,     -- referenced LIBRARY_CODE.PRESENTATION_NAME
  tgt_letters  text NOT NULL,     -- referenced LIBRARY_CODE.CALL_LETTERS
  tgt_number   int  NOT NULL,     -- referenced LIBRARY_CODE.CALL_NUMBERS
  xref_comment text              -- tubafrenzy LIBRARY_CODE_CROSS_REFERENCE.COMMENT, NULL if none
) ON COMMIT PRESERVE ROWS;

INSERT INTO bs2117_pairs (row_id, src_name, src_letters, src_number, tgt_name, tgt_letters, tgt_number, xref_comment) VALUES
    (2, 'Return to Forever', '', 0, 'Elf Power', 'EL', 38, 'shared member Adrian Finch'),
    (3, 'Return to Forever', '', 0, 'Masters of the Hemisphere', 'MA', 182, 'shared member Adrian Finch'),
    (4, 'Grace Braun', '', 0, 'DQE', 'DQ', 1, 'Grace''s solo work is filed w/ DQE'),
    (5, 'Anne Gomez', '', 0, 'Cantwell Gomez & Jordan', 'CA', 166, 'bassist'),
    (6, 'Return to Forever', '', 0, 'Chick Corea (Return to Forever)', 'Co', 11, 'RTF is filed w/ Chick Corea'),
    (7, 'Sheryl Samuel', '', 0, 'Don Haynie', 'HA', 27, 'recorded as a duo'),
    (9, 'Odd Nosdam', '', 0, 'Clouddead', 'CL', 7, 'Odd a member of Clouddead'),
    (10, 'Chris D', '', 0, 'Divine Horsemen', 'DI', 32, '[from Rock-CH-0 to Divine Horsemen]#[see Divine Horsemen: Rock DI 32]'),
    (12, 'Legendary Pink Dots', 'LE', 35, 'DNA Le Draw D Kee', 'DN', 2, '[from Rock-LE-0 to DNA Le Draw D Kee]#[see also DNA Le Draw D Kee -- DN 02]'),
    (13, 'Dairy Queen Empire', '', 0, 'DQE', 'DQ', 1, '[from Rock-DA-0 to DQE]#[see DQE: Rock DQ 1]'),
    (14, 'Arthur Brown', '', 0, 'The Crazy World of Arthur Brown', 'CR', 21, '[from Rock-BR-0 to The Crazy World of Arthur Brown]#[see Crazy World of Arthur Brown -- CR 21]'),
    (15, 'Dirty Rotten Imbeciles', '', 0, 'D.R.I.', 'DR', 12, '[from Rock-DI-0 to D.R.I.]#[see D.R.I. -- DR 12]'),
    (16, 'Marc Riley', '', 0, 'The Creepers', 'CR', 30, '[from Rock-RI-0 to The Creepers]#[see Creepers, The]'),
    (17, 'Kevin Godley', '', 0, 'Lol Creme', 'CR', 6, '[from Rock-GO-0 to Lol Creme]#[see Creme, Lol]'),
    (18, 'Volupuk', '', 0, 'Guigou Chevonier', 'CH', 135, '[from Rock-VO-0 to Guigou Chevonier]#[see also Chevonier, Guigou]'),
    (20, 'Cash, Larry Jr.', '', 0, 'Larry Cash, Jr.', 'LA', 132, '[from Rock-CA-0 to Larry Cash, Jr.]#[band, not a person: filed under Rock LA 132]'),
    (21, 'Wedding Present', '', 0, 'Cinerama', 'CI', 24, '[from Rock-WE-0 to Cinerama]#[see also Cinerama featuring David Gedge -- CI 24]'),
    (23, 'Kendra Smith', '', 0, 'Clay Allison', 'CL', 20, '[from Rock-SM-0 to Clay Allison]#[see also Clay Allison]'),
    (24, 'X', '', 0, 'Exene Cervenka', 'CE', 9, '[from Rock-X-0 to Exene Cervenka]#[see also Cervenka, Exene -- CE 9]'),
    (25, 'Cactus', 'CA', 153, 'Jeff Beck', 'Be', 6, '[from Rock-CA-153 to Jeff Beck]#[see also Beck, Jeff]'),
    (26, 'Cactus World News', 'CA', 46, 'The Breeders', 'Br', 70, '[from Rock-DO-66 to The Breeders]#[see also The Breeders]'),
    (27, 'Cactus World News', 'CA', 46, 'Belly', 'Be', 76, '[from Rock-DO-66 to Belly]#[see also Belly]'),
    (29, 'Capping Day', 'CA', 74, 'Blur', 'Bl', 101, '[from Rock-CO-184 to Blur]#[see also Blur]'),
    (31, 'Chris Cacavas', 'CA', 66, 'Eugene Chadbourne', 'CH', 21, '[from Rock-CA-37 to Dr. Eugene Chadbourne]#[see also Chadbourne, Eugene - Rock Ch 21 - for Camper Va'),
    (32, 'Cactus', 'CA', 153, 'Coax', 'CO', 156, '[from Rock-DE-80 to Coax]#[see also Coax -- CO 156]'),
    (33, 'Gloria Loring', 'LO', 24, 'Danubians', 'DA', 103, '[from Rock-DE-90 to Danubians]#[see also Danubians -- DA 103]'),
    (34, 'Cabal', 'CA', 72, 'Delivery', 'DE', 135, '[from Rock-CA-8 to Delivery]#[see also Delivery]'),
    (36, 'Gloria Loring', 'LO', 24, 'Eric''s Trip', 'ER', 7, '[from Rock-DO-73 to Eric''s Trip]#[see also Eric''s Trip: Rock ER 7]'),
    (38, 'Papa John Creach', 'CR', 59, 'Lisa Gerrard', 'GE', 28, '[from Rock-DE-39 to Lisa Gerrard]#[see also Gerrard, Lisa -- GE 28]'),
    (41, 'Capping Day', 'CA', 74, 'The Kinks', 'KI', 5, '[from Rock-DA-7 to The Kinks]#[see also Kinks, The]'),
    (42, 'Bill Ding', 'BI', 118, 'La Makita Soma', 'LA', 114, '[from Rock-BI-118 to La Makita Soma]#[see also La Makita Soma]'),
    (43, 'Cabaret Voltaire', 'CA', 42, 'Last Days of May', 'LA', 116, '[from Rock-DR-7 to Last Days of May]#[see also Last Days of May - Rock LA 116]'),
    (44, 'Cabaret Voltaire', 'CA', 42, 'Monsoon', 'MO', 25, '[from Rock-CH-11 to Monsoon]#[see also Monsoon]'),
    (45, 'Cabaret Voltaire', 'CA', 42, 'Opal', 'OP', 2, '[from Rock-DR-7 to Opal]#[see also Opal - Rock OP 2]'),
    (46, 'Cabal', 'CA', 72, 'The Orange Peels', 'OR', 31, '[from Rock-CL-55 to Orange Peels]#[see also Orange Peels]'),
    (47, 'Chris D and the Divine Horsemen', '', 0, 'Divine Horsemen', 'DI', 32, '[from Rock-D-1 to Divine Horsemen]#[see Divine Horsemen: Rock D-32]'),
    (48, 'Cactus World News', 'CA', 46, 'Golden Palominos', 'GO', 6, '[from Rock-CA-69 to Golden Palominos]#[see Golden Palominos]'),
    (49, 'Crooked Fingers', '', 0, 'Eric Bachmann', 'BA', 189, 'Crooked Fingers is filed w/ Eric Bachmann'),
    (50, 'Barry Black', '', 0, 'Eric Bachmann', 'BA', 189, 'Barry Black is filed w/ Eric Bachmann'),
    (51, 'Tom Carter', '', 0, 'Charalambides', 'CH', 116, 'member'),
    (52, 'Tom Carter', '', 0, 'The Mike Gunn', 'MI', 88, 'member'),
    (53, 'Roger Hayes', '', 0, 'Cyanosis', 'CY', 10, 'RH records as Cyanosis'),
    (54, 'Paris', '', 0, 'Paris [rock band]', 'PA', 5, 'which one?'),
    (55, 'Paris', '', 0, 'Paris [hiphop mc]', 'Pa', 2, 'which one?'),
    (56, 'June Carter Cash', 'CA', 42, 'Carter Family', 'Ca', 20, NULL),
    (57, 'Adam Forkner', '', 0, '[[[[ VVRSSNN ]]]]', 'VE', 3, 'pronounced ''Version'''),
    (58, 'Version', '', 0, '[[[[ VVRSSNN ]]]]', 'VE', 3, NULL),
    (59, 'Minerva Strain', 'MI', 70, 'Polynya', 'PO', 123, NULL),
    (60, 'Arab Strap', 'Ar', 47, 'Malcolm Middleton', 'MI', 155, NULL),
    (61, 'Geraldine Fibbers', 'GE', 25, 'Carla Bozulich', 'BO', 148, NULL),
    (62, 'Get Up Kids', 'GE', 31, 'The New Amsterdams', 'NE', 117, NULL),
    (65, 'Steven Wray Lobdell', 'LO', 156, 'Davis Redford Triad', 'DA', 117, NULL),
    (66, 'The Animals', 'An', 4, 'Alan Price', 'PR', 6, NULL),
    (67, 'The Animals', 'An', 4, 'Eric Burdon', 'BU', 121, NULL),
    (68, 'Mission of Burma', 'MI', 26, 'Consonant', 'CO', 220, NULL),
    (69, 'Lozenge', 'LO', 93, 'Kyle Bruckmann', 'BR', 53, NULL),
    (70, 'Blackalicious', 'Bl', 18, 'The Gift of Gab', 'GI', 3, NULL),
    (71, 'The Be Good Tanyas', 'BE', 14, 'Jolie Holland', 'HO', 20, NULL),
    (72, 'Hella', 'HE', 116, 'Nervous Cop', 'NE', 125, NULL),
    (73, 'Deerhoof', 'DE', 121, 'Nervous Cop', 'NE', 125, NULL),
    (74, 'Sankofa', 'Sa', 6, 'The Apple Juice Kid', 'AP', 6, NULL),
    (75, 'The Apple Juice Kid', 'AP', 6, 'Sankofa', 'Sa', 6, NULL),
    (76, 'Oval', 'OV', 2, 'Microstoria', 'MI', 20, NULL),
    (77, 'Mouse On Mars', 'Mo', 1, 'Microstoria', 'MI', 20, NULL),
    (79, 'The Promise Ring', 'PR', 78, 'Maritime', 'MA', 262, NULL),
    (80, 'Matthew Shipp', 'Sh', 15, 'The Blue Series Continuum', 'BL', 29, NULL),
    (81, 'Cannibal Ox', '', 0, 'Vast Aire', 'VA', 11, NULL),
    (82, 'Califone', 'CA', 141, 'The Black-Eyed Snakes', 'BL', 176, NULL),
    (83, 'Low', 'LO', 80, 'The Black-Eyed Snakes', 'BL', 176, NULL),
    (84, 'Prefuse 73', 'PR', 20, 'Savath + Savalas', 'SA', 95, NULL),
    (85, 'DAT Politics', 'DA', 39, 'Aelters', 'AE', 2, NULL),
    (86, 'LAN', '', 0, 'L@N', 'L', 4, NULL),
    (87, 'Local Area Network', '', 0, 'L@N', 'L', 4, NULL),
    (88, 'Preservation Hall Jazz Band', 'Pr', 6, 'Sweet Emma Barrett', 'BA', 45, NULL),
    (89, 'Preservation Hall Jazz Band', 'Pr', 6, 'Sweet Emma Barrett', 'BA', 45, NULL),
    (90, 'Duncan Browne', 'Br', 7, 'Metro', 'ME', 115, NULL),
    (91, 'Peter Godwin', 'GO', 12, 'Metro', 'ME', 115, NULL),
    (92, 'The Raymond Brake', 'RA', 84, 'Tussle', 'TU', 36, NULL),
    (93, 'Pere Ubu', 'PE', 15, 'Rocket from the Tombs', 'RO', 63, NULL),
    (94, 'Dead Boys', 'DE', 38, 'Rocket from the Tombs', 'RO', 63, NULL),
    (99, 'Califone', 'CA', 141, 'Red Red Meat', 'RE', 83, NULL),
    (100, 'The Ladybug Transistor', 'LA', 75, 'Finishing School', 'FI', 93, NULL),
    (101, 'The Essex Green', 'ES', 10, 'Finishing School', 'FI', 93, NULL),
    (105, 'Godspeed You Black Emperor!', 'GO', 98, 'Valley of the Giants', 'VA', 54, NULL),
    (106, 'Do Make Say Think', 'DO', 82, 'Valley of the Giants', 'VA', 54, NULL),
    (107, 'Broken Social Scene', 'Br', 147, 'Valley of the Giants', 'VA', 54, NULL),
    (108, 'Shalabi Effect', 'SH', 126, 'Valley of the Giants', 'VA', 54, NULL),
    (109, 'Leroy Jenkins', 'Je', 2, 'The Revolutionary Ensemble', 'RE', 22, NULL),
    (110, 'Antipop Consortium', 'An', 4, 'Beans [hiphop mc]', 'Be', 15, NULL),
    (112, 'Pelt', 'PE', 52, 'Jack Rose', 'RO', 145, NULL),
    (113, 'Arab Strap', 'Ar', 47, 'Sons and Daughters', 'SO', 106, NULL),
    (114, 'Boredoms', 'Bo', 59, 'OOIOO', 'OO', 1, NULL),
    (115, 'The Moon Seven Times', 'MO', 102, 'Lanterna', 'LA', 80, NULL),
    (116, 'Area', 'Ar', 12, 'Lanterna', 'LA', 80, NULL),
    (119, 'Don Caballero', 'DO', 55, 'Thee Speaking Canaries', 'SP', 72, NULL),
    (120, 'The Lyres', 'LY', 4, 'DMZ', 'DM', 1, NULL),
    (121, 'Vocokesh', 'VO', 16, 'F/I', 'FI', 85, NULL),
    (122, 'Madlib', 'MA', 40, 'Madvillain', 'MA', 48, NULL),
    (123, 'Damo Suzuki', '', 0, 'Can', 'CA', 61, NULL),
    (124, 'The Minus 5', 'MI', 100, 'The Young Fresh Fellows', 'YO', 8, NULL),
    (125, 'Hella', 'HE', 116, 'The Advantage', 'AD', 25, NULL),
    (126, 'Crime in Choir', 'CR', 127, 'The Advantage', 'AD', 25, NULL),
    (128, 'Oliver Lake', 'La', 17, 'Oliver Lake', 'LA', 2, 'same Oliver Lake'),
    (129, 'Superchunk', 'SU', 36, 'Tom Scharpling', 'SC', 1, 'Superchunk drummer Jon Wurster is one-half of Scharpling & Wurster'),
    (130, 'Peter Cook', 'CO', 2, 'Beyond the Fringe', 'BE', 4, 'see also Beyond the Fringe'),
    (131, 'Dudley Moore', '', 0, 'Beyond the Fringe', 'BE', 4, 'see also Beyond the Fringe'),
    (132, 'Don Novello', '', 0, 'Father Guido Sarducci', 'SA', 1, 'see Sarducci, Father Guido'),
    (133, 'Peter Sellers', '', 0, 'Goon Show', 'GO', 3, 'see Goon Show'),
    (134, 'Thom Yorke', 'YO', 57, 'Radiohead', 'RA', 27, NULL),
    (135, 'Upsetters', 'Up', 2, 'Lee ''Scratch'' Perry', 'Pe', 1, NULL);

-- ===========================================================
-- Provenance conflicts: 15 pairs whose referencing side is contradicted by
-- their own COMMENT, and which are therefore EXCLUDED from the INSERT.
-- See the "Provenance conflicts" section in the header for the evidence.
--
-- Rule (mechanical, not hand-picked): the referencing LIBRARY_CODE is a real
-- filing (CALL_NUMBERS <> 0), its COMMENT carries a machine-generated
-- `[from <Genre>-<LETTERS>-<NUM> to <target>]` provenance note whose NUM is
-- also non-zero, and the note's (LETTERS, NUM) differs from the referencing
-- row's own. On every one of the 15, the note names a musically-correct
-- artist and the FK names an unrelated one, so the FK is what is wrong.
-- ===========================================================
DROP TABLE IF EXISTS pg_temp.bs2117_provenance_conflicts;
CREATE TEMP TABLE bs2117_provenance_conflicts (
  row_id     int PRIMARY KEY,  -- LIBRARY_CODE_CROSS_REFERENCE.ID
  fk_says    text NOT NULL,    -- what CROSS_REFERENCING_ARTIST_ID resolves to
  note_says  text NOT NULL,    -- what the COMMENT's provenance prefix names
  target     text NOT NULL
) ON COMMIT PRESERVE ROWS;

INSERT INTO bs2117_provenance_conflicts (row_id, fk_says, note_says, target) VALUES
    (26, 'Cactus World News [CA 46]', 'Rock DO 66 = Tonya Donelly',      'The Breeders'),
    (27, 'Cactus World News [CA 46]', 'Rock DO 66 = Tonya Donelly',      'Belly'),
    (29, 'Capping Day [CA 74]',       'Rock CO 184 = Graham Coxon',      'Blur'),
    (31, 'Chris Cacavas [CA 66]',     'Rock CA 37 = Camper Van Beethoven','Eugene Chadbourne'),
    (32, 'Cactus [CA 153]',           'Rock DE 80 = The Dentists',       'Coax'),
    (33, 'Gloria Loring [LO 24]',     'Rock DE 90 = Amy Denio',          'Danubians'),
    (34, 'Cabal [CA 72]',             'Rock CA 8 = Caravan',             'Delivery'),
    (36, 'Gloria Loring [LO 24]',     'Rock DO 73 = Julie Doiron',       'Eric''s Trip'),
    (38, 'Papa John Creach [CR 59]',  'Rock DE 39 = Dead Can Dance',     'Lisa Gerrard'),
    (41, 'Capping Day [CA 74]',       'Rock DA 7 = Dave Davies',         'The Kinks'),
    (43, 'Cabaret Voltaire [CA 42]',  'Rock DR 7 = Dream Syndicate',     'Last Days of May'),
    (44, 'Cabaret Voltaire [CA 42]',  'Rock CH 11 = Sheila Chandra',     'Monsoon'),
    (45, 'Cabaret Voltaire [CA 42]',  'Rock DR 7 = Dream Syndicate',     'Opal'),
    (46, 'Cabal [CA 72]',             'Rock CL 55 = Allen Clapp',        'The Orange Peels'),
    (48, 'Cactus World News [CA 46]', 'Rock CA 69 = Lori Carson',        'Golden Palominos');

-- Three-stage resolver: fold_artist_name -> code_letters -> genre code.
-- Session-local (pg_temp), so it never touches the shared wxyc_schema
-- namespace and needs no cleanup migration.
CREATE OR REPLACE FUNCTION pg_temp.bs2117_resolve_artist(
  p_name text, p_letters text, p_number int
) RETURNS TABLE(artist_id int, match_count int, ambiguous boolean) AS $$
DECLARE
  v_stage1 int[];
  v_ids int[];
BEGIN
  SELECT array_agg(a.id) INTO v_stage1
  FROM wxyc_schema.artists a
  WHERE wxyc_schema.fold_artist_name(a.artist_name) = wxyc_schema.fold_artist_name(p_name);

  IF v_stage1 IS NULL OR array_length(v_stage1, 1) = 0 THEN
    RETURN QUERY SELECT NULL::int, 0, false;
    RETURN;
  END IF;

  IF array_length(v_stage1, 1) = 1 THEN
    RETURN QUERY SELECT v_stage1[1], 1, false;
    RETURN;
  END IF;

  v_ids := v_stage1;
  IF p_letters IS NOT NULL AND p_letters <> '' THEN
    SELECT array_agg(a.id) INTO v_ids
    FROM wxyc_schema.artists a
    WHERE a.id = ANY(v_stage1) AND lower(a.code_letters) = lower(p_letters);
    IF v_ids IS NULL OR array_length(v_ids, 1) = 0 THEN
      v_ids := v_stage1; -- letters didn't narrow anything; fall through still ambiguous
    END IF;
  END IF;

  IF array_length(v_ids, 1) = 1 THEN
    RETURN QUERY SELECT v_ids[1], 1, false;
    RETURN;
  END IF;

  IF p_number IS NOT NULL AND p_number <> 0 THEN
    DECLARE
      v_ids2 int[];
    BEGIN
      SELECT array_agg(a.id) INTO v_ids2
      FROM wxyc_schema.artists a
      WHERE a.id = ANY(v_ids)
        AND EXISTS (
          SELECT 1 FROM wxyc_schema.genre_artist_crossreference g
          WHERE g.artist_id = a.id AND g.artist_genre_code = p_number
        );
      IF v_ids2 IS NOT NULL AND array_length(v_ids2, 1) >= 1 THEN
        v_ids := v_ids2;
      END IF;
    END;
  END IF;

  IF array_length(v_ids, 1) = 1 THEN
    RETURN QUERY SELECT v_ids[1], 1, false;
    RETURN;
  END IF;

  -- Still 2+ candidates after all three stages: report as ambiguous, using
  -- the original (widest) match count so the pre-amble shows the true scope.
  RETURN QUERY SELECT NULL::int, array_length(v_stage1, 1), true;
END;
$$ LANGUAGE plpgsql STABLE;

-- ===========================================================
-- Pre-amble: resolution report. Read this before letting the COMMIT below
-- land. "resolved" pairs are what will be inserted (modulo the self-pair
-- and reversed-duplicate/already-exists guards in the transaction);
-- "unresolved"/"ambiguous" are reported, never guessed.
-- ===========================================================
SELECT '=== BS2117 pre-amble: total pairs loaded ===' AS section;
SELECT count(*) AS total_pairs FROM bs2117_pairs;

SELECT '=== BS2117 pre-amble: resolution outcome per pair ===' AS section;
WITH resolved AS (
  SELECT
    p.row_id, p.src_name, p.tgt_name, p.xref_comment,
    EXISTS (SELECT 1 FROM bs2117_provenance_conflicts pc WHERE pc.row_id = p.row_id) AS provenance_conflict,
    src.artist_id AS source_artist_id, src.match_count AS source_match_count, src.ambiguous AS source_ambiguous,
    tgt.artist_id AS target_artist_id, tgt.match_count AS target_match_count, tgt.ambiguous AS target_ambiguous
  FROM bs2117_pairs p
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.src_name, p.src_letters, p.src_number) AS src(artist_id, match_count, ambiguous)
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.tgt_name, p.tgt_letters, p.tgt_number) AS tgt(artist_id, match_count, ambiguous)
)
SELECT
  row_id, src_name, tgt_name,
  CASE
    WHEN provenance_conflict THEN 'provenance_conflict_skip'
    WHEN source_artist_id IS NULL AND NOT source_ambiguous THEN 'source_unresolved'
    WHEN source_ambiguous THEN 'source_ambiguous'
    WHEN target_artist_id IS NULL AND NOT target_ambiguous THEN 'target_unresolved'
    WHEN target_ambiguous THEN 'target_ambiguous'
    WHEN source_artist_id = target_artist_id THEN 'self_pair_skip'
    ELSE 'resolved'
  END AS outcome,
  source_artist_id, source_match_count, target_artist_id, target_match_count
FROM resolved
-- Anomalies FIRST: these are the rows the operator must inspect before
-- committing, and burying them under ~79 successful rows defeats the point.
ORDER BY (CASE
    WHEN provenance_conflict THEN 'provenance_conflict_skip'
    WHEN source_artist_id IS NULL AND NOT source_ambiguous THEN 'source_unresolved'
    WHEN source_ambiguous THEN 'source_ambiguous'
    WHEN target_artist_id IS NULL AND NOT target_ambiguous THEN 'target_unresolved'
    WHEN target_ambiguous THEN 'target_ambiguous'
    WHEN source_artist_id = target_artist_id THEN 'self_pair_skip'
    ELSE 'resolved'
  END) = 'resolved', row_id;

SELECT '=== BS2117 pre-amble: outcome counts ===' AS section;
WITH resolved AS (
  SELECT
    p.row_id,
    EXISTS (SELECT 1 FROM bs2117_provenance_conflicts pc WHERE pc.row_id = p.row_id) AS provenance_conflict,
    src.artist_id AS source_artist_id, src.ambiguous AS source_ambiguous,
    tgt.artist_id AS target_artist_id, tgt.ambiguous AS target_ambiguous
  FROM bs2117_pairs p
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.src_name, p.src_letters, p.src_number) AS src(artist_id, match_count, ambiguous)
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.tgt_name, p.tgt_letters, p.tgt_number) AS tgt(artist_id, match_count, ambiguous)
),
classified AS (
  SELECT
    CASE
      WHEN provenance_conflict THEN 'provenance_conflict_skip'
      WHEN source_artist_id IS NULL AND NOT source_ambiguous THEN 'source_unresolved'
      WHEN source_ambiguous THEN 'source_ambiguous'
      WHEN target_artist_id IS NULL AND NOT target_ambiguous THEN 'target_unresolved'
      WHEN target_ambiguous THEN 'target_ambiguous'
      WHEN source_artist_id = target_artist_id THEN 'self_pair_skip'
      ELSE 'resolved'
    END AS outcome
  FROM resolved
)
SELECT outcome, count(*) FROM classified GROUP BY outcome ORDER BY outcome;

-- ===========================================================
-- Transactional INSERT block.
-- ===========================================================
BEGIN;
SET LOCAL statement_timeout = '30s';

WITH resolved AS (
  SELECT
    p.xref_comment,
    src.artist_id AS source_artist_id,
    tgt.artist_id AS target_artist_id
  FROM bs2117_pairs p
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.src_name, p.src_letters, p.src_number) AS src(artist_id, match_count, ambiguous)
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.tgt_name, p.tgt_letters, p.tgt_number) AS tgt(artist_id, match_count, ambiguous)
  WHERE src.artist_id IS NOT NULL
    AND tgt.artist_id IS NOT NULL
    AND src.artist_id <> tgt.artist_id -- self-pair guard (row 128 "Oliver Lake"/"Oliver Lake")
    -- Provenance guard: drop the 15 pairs whose referencing side is
    -- contradicted by their own COMMENT. Without this the script inserts
    -- brand-new FALSE aliases (Cactus World News <-> The Breeders, Capping Day
    -- <-> Blur, ...) that prod does not hold, so nothing below would skip them
    -- and there is no delete path to walk them back.
    AND NOT EXISTS (
      SELECT 1 FROM bs2117_provenance_conflicts pc WHERE pc.row_id = p.row_id
    )
),
canon AS (
  -- Canonicalize direction so a reversed duplicate (rows 74/75:
  -- Sankofa<->The Apple Juice Kid) collapses to one row: the lower
  -- artist_id becomes source. Deterministic, not meaningful beyond dedup —
  -- the export CTE reads both directions regardless.
  SELECT
    LEAST(source_artist_id, target_artist_id) AS source_artist_id,
    GREATEST(source_artist_id, target_artist_id) AS target_artist_id,
    xref_comment
  FROM resolved
),
deduped AS (
  -- The ORDER BY must carry a tiebreaker past the DISTINCT ON key: two source
  -- rows that canonicalize to the same pair can hold DIFFERENT comments (the
  -- reversed pair 74/75 happens to be NULL on both sides, but nothing in
  -- tubafrenzy enforces that), and without it Postgres is free to keep either
  -- one, making the committed comment non-deterministic across runs. Prefer a
  -- real comment over a NULL one, then the lowest text, so re-running against
  -- a different plan cannot produce a different row.
  SELECT DISTINCT ON (source_artist_id, target_artist_id)
    source_artist_id, target_artist_id, xref_comment
  FROM canon
  ORDER BY source_artist_id, target_artist_id, xref_comment ASC NULLS LAST
)
INSERT INTO wxyc_schema.artist_crossreference (source_artist_id, target_artist_id, comment)
SELECT d.source_artist_id, d.target_artist_id, d.xref_comment
FROM deduped d
WHERE NOT EXISTS (
  -- Guard the reversed-duplicate case ON CONFLICT (on the ordered pair)
  -- cannot see: a pair Backend already holds in the OPPOSITE direction.
  SELECT 1 FROM wxyc_schema.artist_crossreference existing
  WHERE (existing.source_artist_id = d.source_artist_id AND existing.target_artist_id = d.target_artist_id)
     OR (existing.source_artist_id = d.target_artist_id AND existing.target_artist_id = d.source_artist_id)
)
ON CONFLICT (source_artist_id, target_artist_id) DO NOTHING;

COMMIT;

-- ===========================================================
-- Post-amble: verify every resolved, non-self pair now exists in
-- artist_crossreference in at least one direction. Any row reporting
-- present = false here after a successful COMMIT is a bug in this script,
-- not an expected outcome.
-- ===========================================================
SELECT '=== BS2117 post-amble: resolved pairs now present (either direction) ===' AS section;
WITH resolved AS (
  SELECT DISTINCT
    src.artist_id AS source_artist_id,
    tgt.artist_id AS target_artist_id
  FROM bs2117_pairs p
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.src_name, p.src_letters, p.src_number) AS src(artist_id, match_count, ambiguous)
  CROSS JOIN LATERAL pg_temp.bs2117_resolve_artist(p.tgt_name, p.tgt_letters, p.tgt_number) AS tgt(artist_id, match_count, ambiguous)
  WHERE src.artist_id IS NOT NULL
    AND tgt.artist_id IS NOT NULL
    AND src.artist_id <> tgt.artist_id
    AND NOT EXISTS (
      SELECT 1 FROM bs2117_provenance_conflicts pc WHERE pc.row_id = p.row_id
    )
)
SELECT
  count(*) AS resolved_pairs,
  count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM wxyc_schema.artist_crossreference existing
      WHERE (existing.source_artist_id = resolved.source_artist_id AND existing.target_artist_id = resolved.target_artist_id)
         OR (existing.source_artist_id = resolved.target_artist_id AND existing.target_artist_id = resolved.source_artist_id)
    )
  ) AS present_in_backend
FROM resolved;

SELECT '=== BS2117 post-amble: total artist_crossreference row count ===' AS section;
SELECT count(*) FROM wxyc_schema.artist_crossreference;

-- Refresh planner stats on the touched table (#934 rule; touch_library_
-- watermark's own UPDATE on library_watermark is a single-row write with no
-- covering index affected, so it needs no ANALYZE of its own). ANALYZE
-- cannot run inside a transaction, so it lives here, after COMMIT.
ANALYZE wxyc_schema.artist_crossreference;

DROP TABLE IF EXISTS pg_temp.bs2117_pairs;
DROP TABLE IF EXISTS pg_temp.bs2117_provenance_conflicts;
