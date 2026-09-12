# BS#2424 — bound and batch `library-etl`'s secondary imports

Interim fix, by design. The durable fix is WXYC/wiki#89 (Phase 3.5, flip the catalog source of truth to Backend), which retires this import path entirely. Nothing here should become a reason to defer #89.

Closes the root cause of WXYC/Backend-Service#2413.

_Revision 2 — incorporates the plan review. Changes from r1 are marked **[r2]**._

> **As-landed correction — the full-re-sync predicate.** Wherever this document writes `WHERE job_name LIKE 'library-etl%'` (§4's `[r2]` row, §6 step 5, §7's last risk row), the shipped predicate is the narrower `WHERE job_name = 'library-etl' OR job_name LIKE 'library-etl:%'`. `:` is the namespace separator and the bare `%` form would sweep up a future job named `library-etl-something`, which an operator running the recipe would not intend. That is what `jobs/library-etl/job.ts`, `shared/database/src/schema.ts`, `jobs/library-etl/README.md` and both test suites use, and `jobs/library-etl/README.md`'s "Delta bounds and watermarks" section is the canonical statement of it. The body below is left as the historical plan record; copy the recipe from the README, not from here.

## 0. Measurements taken before designing (acceptance criterion 1)

**The `Compilation track artists:` line was read off real work slots.** Host journal on `wxyc-ec2`, three consecutive working runs on 2026-09-10 (all times PDT; journald stamps UTC and is converted here):

| slot start | artist xrefs | release xrefs | compilation tracks                            | total     |
| ---------- | ------------ | ------------- | --------------------------------------------- | --------- |
| 09:00:02   | 09:00:12     | 09:00:13      | **09:14:59** — `imported 139748, skipped 869` | 14 m 58 s |
| 09:30:01   | 09:30:12     | 09:30:12      | **09:42:55** — `imported 139748, skipped 869` | 12 m 54 s |
| 10:00:03   | 10:00:14     | 10:00:14      | **10:13:14** — `imported 139748, skipped 869` | 13 m 11 s |

The line is present with a six-figure count on every work slot, so the ticket's primary hypothesis is **confirmed, not refuted**: both cross-reference imports finish within one second of the transaction opening, and the entire remaining 12–15 minutes is `importCompilationTracks`. The bare `catch` in `fetchLegacyCompilationTracks` is not firing.

`139748 + 869 = 140617`, which is exactly the upstream row count — the import re-processes the whole corpus every time.

**Upstream re-measured live against `wxycmusic` on 2026-09-10, not taken from the fixture:**

| table                          | rows                                             | `TIME_LAST_MODIFIED`                                                      | newest row                  |
| ------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------- | --------------------------- |
| `LIBRARY_CODE_CROSS_REFERENCE` | 119                                              | present, 0 NULL, 0 zero                                                   | **2025-04-17 07:52:30 PDT** |
| `RELEASE_CROSS_REFERENCE`      | 35                                               | present, 0 NULL, 0 zero                                                   | **2008-09-14 14:32:22 PDT** |
| `COMPILATION_TRACK_ARTIST`     | 140,617 over 2,586 distinct `LIBRARY_RELEASE_ID` | **absent** (`DESC` confirms four columns, no timestamp, no surrogate key) | —                           |

**Findings that shape the design, none of which are in the ticket:**

1. **A timestamp bound makes both cross-reference deltas permanently empty.** The newest artist cross-reference edit is 17 months old and the newest release cross-reference edit is **18 years** old. So bounding does not merely risk freezing the unresolved-row gap that note 6 warns about — it freezes 100% of it, on the first run after deploy, and `imported 74` becomes `imported 0` forever. Whatever replaces the accidental backfill is therefore not a nicety; it is the only thing that keeps these two imports doing anything at all. This is the decisive argument for the periodic full pass in §3C.

2. **Upstream `COMPILATION_TRACK_ARTIST` contains real intra-table duplicates on the Postgres unique key.** 1,871 duplicate groups spanning 3,941 rows, i.e. **2,070 surplus rows** that collide on `(LIBRARY_RELEASE_ID, ARTIST_NAME, TRACK_TITLE)` — the exact tuple of `cta_unique_idx`. Batching therefore has to handle duplicates _within a single multi-row statement_, and it will meet them on the very first production pass. (Separately: `TRACK_TITLE` is NULL-or-blank on **0** upstream rows, so the partial `cta_unique_null_track_idx` is not exercised by this importer — but the untargeted `ON CONFLICT DO NOTHING` must stay untargeted so it remains an arbiter if that ever changes.)

3. **[r2] The semantics that finding 2 depends on were verified against Postgres before designing around them,** on **14.24** — prod's major version, per the `NULLS NOT DISTINCT is PG15+` note in `shared/database/src/schema.ts` — and again on 18.0. Against a table carrying both of `compilation_track_artist`'s unique indexes: an intra-statement duplicate on the three-column key inserts once and does not raise; a duplicate hitting the partial NULL-title index inserts once; re-running an identical batch inserts zero; a batch mixing new, existing and intra-batch-duplicate rows lands exactly the new distinct rows. `ON CONFLICT DO NOTHING` uses speculative insertion and sees rows inserted earlier in the same command, unlike `DO UPDATE`, which raises `cannot affect row a second time`.

4. **[r2] The blocking mechanism behind #2413 is now identified, and it is not the FK check that investigation assumed.** `library_watermark` is a **single-row** table, and `wxyc_schema.touch_library_watermark()` (migration `0104_library-watermark.sql:59-66`) is `UPDATE ... WHERE id = true` — so every statement that fires it takes an exclusive row lock on that one row and holds it until the transaction commits. Seven `FOR EACH STATEMENT` triggers call it, and two of them are the two jobs in question: `touch_library_watermark_from_compilation_track_artist` (`0143_narrow-cta-watermark-trigger.sql:137-144`) and **`touch_library_watermark_from_rotation`** (`0105_library-watermark-parent-tables.sql:72-75`). So `library-etl` acquires that lock on its first `library` write and holds it for the whole 12–15 minutes, while `legacy-linkage-resolve`'s rotation `UPDATE` fires the rotation trigger, needs the same row, and waits until the 300 s `statement_timeout` cancels it.

   This explains both observations that made the earlier investigation rule things out: the flowsheet pass finishes normally in the same failing runs because it touches neither `library` nor `rotation` and never needs the lock, and a healthy rotation pass is 31 ms because 300 s is a wait, not work. It also confirms the fix is correct and sufficient: the lock is held for the transaction's _duration_ regardless of how many times it is taken, so collapsing the duration is exactly what releases it. No lock-timeout tuning and no schedule change are needed.

5. **[r2] Batching drops ~140,617 single-row `library_watermark` UPDATEs to ~141.** The CTA trigger is `FOR EACH STATEMENT`, so today's row-at-a-time import fires it once per row against a one-row table — 140,617 dead tuples on `library_watermark` per work slot, all inside the transaction holding its lock. Not the headline win, but it is real and it lands for free.

## 1. What is wrong

`run()` in `jobs/library-etl/job.ts` gates everything on the `LIBRARY_RELEASE` delta (`job.ts:1070-1073`), then opens one `db.transaction` (`job.ts:1093`) that holds until the run ends. Inside it:

- every legacy MySQL read still to come is issued over the SSH-tunnelled `mysql` CLI — genres, formats, both cross-reference tables and all of `COMPILATION_TRACK_ARTIST` — each one an SSH round trip with the Postgres write transaction open and waiting;
- three of the four imports are unbounded full-table pulls;
- `importCompilationTracks` (`job.ts:740`) issues **one awaited `INSERT ... ON CONFLICT DO NOTHING` per row** — 140,617 sequential round trips.

## 2. Desired end state

No `library-etl` transaction, on any cadence, holds a write transaction on `library` / `compilation_track_artist` — and therefore on `library_watermark` — for more than ~30 s. Every legacy read happens with no Postgres transaction open. Each secondary import reads only what could have changed since its own last successful run, and the one import that must sometimes do a full pass does it in batched statements.

## 3. Design

Three changes, ordered by how much of the 12–15 minutes each buys back.

### A. Batch the compilation-track write — the load-bearing change

`importCompilationTracks` builds a chunked multi-row `INSERT ... ON CONFLICT DO NOTHING` at `CTA_INSERT_CHUNK_ROWS = 1000` instead of one awaited statement per row. 140,617 round trips become ~141. Four columns × 1,000 rows = 4,000 bind parameters, comfortably under Postgres's 65,535 limit.

Two properties that must be preserved, both pinned by tests:

- **`ON CONFLICT DO NOTHING` stays untargeted.** `compilation_track_artist` has two unique indexes; an untargeted clause arbitrates on both. Naming a target would silently stop deduping the other.
- **Duplicates _inside one statement_ are skipped, not inserted twice** — verified in §0 finding 3, exercised by the 2,070 rows in finding 2.

`importCompilationTracks` also currently scans **all** of `library` to build its `legacy_release_id -> id` map (`job.ts:745-751`). On a bounded pass it only needs the delta's ids, so the map load takes an optional id filter and the full scan is reserved for the full pass.

**[r2] The Postgres-side id filter uses Drizzle's `inArray()`, never an interpolated array in a `sql` template.** `docs/bulk-update-playbook.md:69` records that splatting a JS array into a `sql` template produces a row constructor Postgres rejects at parse time (SQLSTATE 42809), and that this exact defect has shipped three times (BS#1068, BS#1071, #2007); `:103` mandates `intArrayLiteral` (`shared/database/src/int-array-literal.ts:72`) where a literal is genuinely needed. `inArray()` is the right tool here because the filter is an ordinary Drizzle predicate, not raw SQL. The **MySQL**-side `IN` list is a hand-built string in a heredoc and is unaffected by any of this.

**Counter semantics are deliberately unchanged.** `imported` keeps meaning "rows that resolved to a `library` row and were handed to the insert", **not** "rows actually written" — the ticket's constraint notes that switching to a real affected-row count would make the number collapse for reasons unrelated to coverage, and the 6-for-6 correlation was read against these lines. The batch count is logged separately. The README says so explicitly.

### B. Move every legacy read out of the write transaction

`fetchLegacyGenres`, `fetchLegacyFormats`, `fetchLegacyArtistCrossRefs`, `fetchLegacyReleaseCrossRefs` and `fetchLegacyCompilationTracks` are hoisted above the `db.transaction` calls that consume their results. Each is an SSH `execCommand` spawning a remote `mysql` process; none of them needs a Postgres transaction open, and the CTA read alone streams 140,617 rows.

**[r2] The control flow in full**, since r1 left the unified idle path implicit and that is what made the unit-test breakage below easy to miss:

```
runStartedAt = now
lastRunMs    = getLastRunTimestamp('library-etl')
legacyReleases = fetchLegacyReleases(lastRunMs)                    // MySQL, no tx

// ---- Phase 1: release import ----
if (legacyReleases.length > 0) {
  legacyGenreNames, canonicalFormatNames = fetch…                  // MySQL, no tx  (hoisted)
  tx1 {
    syncGenres / syncFormats / genreMap / formatMap
    loadDeleteDenylist
    for (const release of legacyReleases) { … isDeniedAtWriteTime … findExistingRelease … upsert }
    reconcileDenylistedInserts(tx, insertedLegacyIds)
    updateLastRun(tx, 'library-etl', runStartedAt)
  }
} else {
  log 'No new legacy releases found.'
  tx { reconcileDenylistedInserts(tx, ∅) }                         // unchanged idle sweep
  updateLastRun(db, 'library-etl', runStartedAt)
}
reportStrandedResurrections(…)

// ---- Phase 2: secondary imports. ALWAYS runs. No early return above it. ----
runSecondaryImports(runStartedAt)
```

Phase 2's MySQL reads happen between the two transactions, with none open.

**The split is ordered, not a free reordering.** `importCompilationTracks` and `importReleaseCrossRefs` (via `findAlbumId`) resolve against `library` rows phase 1 writes, and `reconcileDenylistedInserts`' `tx.delete(library)` must land before CTA can reference a row. Phase 2 runs strictly after phase 1 **commits**, so those reads see committed state — read-your-writes becomes read-your-committed-writes, which is strictly safer. Phase 2 re-reads `genreMap` itself rather than inheriting phase 1's in-transaction snapshot.

One behaviour change worth stating: today a cross-reference failure rolls back the release import. After the split it does not — the releases stay committed and only the secondary watermarks fail to advance, so the next run retries exactly the failed part. **[r2]** That claim is only true if _every_ secondary import has a watermark of its own, which is why §3C gives one to compilation tracks as well; see the CTA note there.

### C. Per-import watermarks, delta bounds, and one periodic full pass

**Phase 2 no longer sits behind the release-delta early return.** It runs on every pass, including the ~98% that return `No new legacy releases found`. This is what closes the ticket's note-4 loss channel: with the secondary imports behind the gate _and_ bounded on the job-wide watermark, a cross-reference added during any half hour with no `LIBRARY_RELEASE` edit would be skipped at that run and then excluded forever, because the idle path advances the watermark at `job.ts:1081` before the imports have run.

**[r2] Four** new `cronjob_runs` rows (`job_name` is `varchar(64)`; all fit):

| row                              | bounds                                                                        | advanced                                 |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| `library-etl:artist-crossref`    | `WHERE cr.TIME_LAST_MODIFIED > <watermark>` on `LIBRARY_CODE_CROSS_REFERENCE` | end of phase 2, in phase 2's transaction |
| `library-etl:release-crossref`   | same, on `RELEASE_CROSS_REFERENCE`                                            | same                                     |
| `library-etl:compilation-tracks` | **[r2]** the `TIME_LAST_MODIFIED` boundary CTA's own release-id query uses    | same                                     |
| `library-etl:secondary-full`     | not a delta bound — the "last full reconciliation" clock                      | only on a run where the full pass ran    |

**[r2] Why compilation tracks get their own watermark rather than reusing phase 1's in-memory delta.** r1 had CTA bounded on the release-id set phase 1 already had in hand, which loses data: phase 1 commits `updateLastRun('library-etl')` before phase 2 runs, so if phase 2 throws, the next run's release delta is empty and those CTA rows are never re-attempted — only the 24-hour full pass would recover them, and §3B's "the next run retries exactly the failed part" would be false for this one import. Instead, phase 2 derives its own id set with `SELECT ID FROM LIBRARY_RELEASE WHERE TIME_LAST_MODIFIED > <library-etl:compilation-tracks>` and only advances that watermark on success. One extra small MySQL query per run (0 rows on an idle pass), and phase 2 becomes fully self-contained on its own four watermarks instead of coupled to phase 1's bookkeeping.

Above `CTA_DELTA_ID_MAX = 500` delta ids (a full re-sync, or an unusually large librarian batch) the `IN` list is dropped in favour of a full fetch — the same work, without a 50k-element list in a heredoc.

**[r2] `NULL` upstream timestamps are treated as always-in-delta.** Both bounds are written `WHERE (cr.TIME_LAST_MODIFIED IS NULL OR cr.TIME_LAST_MODIFIED > <watermark>)`. Prod has zero NULL rows today (§0), but a row that were ever inserted without a stamp would otherwise be invisible to the bound forever, and re-importing an unstamped row is a no-op upsert. This also keeps the existing `dev_env/etl-seed.sql` fixture meaningful — its crossref rows leave the column at `DEFAULT NULL` (`:181-187`).

**The full reconciliation pass, and the backfill decision it implements.** When `library-etl:secondary-full` is absent or older than `SECONDARY_FULL_PASS_INTERVAL_HOURS = 24`, all three secondary fetches drop their bounds and run unbounded, exactly as they do today. This is the **"rare full pass"** option from the ticket's note 6, chosen over recording unresolved pairs, for three reasons:

1. §0 finding 1: a bound alone would freeze the cross-reference gap immediately and completely, and the retry is the only thing these two imports still do.
2. It is genuinely cheap here. A full cross-reference pass is ~300 Postgres statements — the ticket's own arithmetic, and the sub-second timings in §0 confirm it. A full CTA pass, once batched, is ~141 statements.
3. It also covers the clock-skew hole in _any_ timestamp bound. `runStartedAt` is Backend's clock and `TIME_LAST_MODIFIED` is tubafrenzy's; the release import has always had this exposure. A daily unbounded pass bounds the damage to a day instead of forever.

**[r2] Why 24 h is not a reduction in the BS#2386 retry cadence.** The obvious objection is that a `*/30` job retrying unresolved cross-references 48×/day drops to 1×/day. It does not, because **today's retry is already behind the release-delta gate** — it runs only on work slots, which the §0 window measured at 6 in 5.2 days, i.e. **~1.15×/day**. A daily full pass is therefore at parity with, or slightly ahead of, the cadence being replaced. Worth restating because §8 of r1 claimed the retry was "preserved" without quantifying it; it is preserved at its actual rate, not at its nominal one. If BS#2386 later wants faster convergence, the interval is a one-line constant and an operator can force a pass immediately by deleting the `library-etl:secondary-full` row.

The trade the ticket asks to be named: this does **not** recover deletions. Both upstream `delete(int id)` implementations are hard `DELETE`s with no tombstone, so no timestamp bound and no full _upsert_ pass can see a removal. The import is upsert-only and never propagated deletions before this change either — that is unchanged, not regressed, and the README says so rather than leaving it implied.

**[r2] `isFirstCrossrefRun` is rewired, not left dead.** `job.ts:1333-1337` computes it from two `count(*)` queries and uses it only to print a log line — r1 called it unused, which is wrong. The `both tables empty` predicate is the part that is wrong once each table has its own watermark; the replacement is per-import — a missing watermark row means an unbounded fetch for that import, which is the same first-run backfill the flag was reaching for. The two `count(*)` queries go away with it.

## 4. Files

| file                                                                                                                           | change                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs/library-etl/job.ts`                                                                                                      | all of §3, plus **[r2]** adding `buildArtistCrossRefQuery`, `buildReleaseCrossRefQuery`, `buildCompilationTrackQuery`, `chunk` and `isSecondaryFullPassDue` to the `export {}` block at `:1391-1412` so the unit tests can import them. There is no precedent to copy — the analogous `buildReleaseQuery` (`:272`) is not exported today — so the export block grows by five names |
| `jobs/library-etl/README.md`                                                                                                   | new "Delta bounds and watermarks" section: which imports are bounded, on what column, against which watermark, how the backfill gap is covered, what the counters mean, why deletions are not propagated, and the force-a-full-pass recipe                                                                                                                                         |
| **[r2]** `jobs/library-etl/README.md:63`, `:191`; `jobs/library-etl/job.ts:941`; `shared/database/src/schema.ts:1810`, `:1830` | the sanctioned full-re-sync recipe `DELETE FROM wxyc_schema.cronjob_runs WHERE job_name = 'library-etl'` becomes `WHERE job_name LIKE 'library-etl%'` at all four sites. Left alone it silently stops being a full re-sync: the three `library-etl:*` rows survive, the secondary imports stay bounded, and the operator gets a release-only pass while believing otherwise        |
| **[r2]** `tests/unit/jobs/library-etl.test.ts:830`                                                                             | same recipe quoted in a comment; update to match                                                                                                                                                                                                                                                                                                                                   |
| `tests/unit/jobs/library-etl.test.ts`                                                                                          | new pure-function coverage (§5), **[r2]** plus rewriting the two source-text ordering tests that this change breaks — see §5                                                                                                                                                                                                                                                       |
| **[r2]** `dev_env/etl-seed.sql`                                                                                                | give the crossref fixture rows real `TIME_LAST_MODIFIED` values so the bounded path is exercised; add a CTA row pair that duplicates on `(LIBRARY_RELEASE_ID, ARTIST_NAME, TRACK_TITLE)` so the e2e asserts intra-batch dedup against the real job                                                                                                                                 |
| **[r2]** `tests/e2e/etl.test.ts`                                                                                               | `runETL`'s reset clears only `job_name = 'library-etl'`; extend to `LIKE 'library-etl%'` so the new watermarks don't make the suite order-dependent. New assertions per §5                                                                                                                                                                                                         |
| `tests/integration/library-etl-cta-batch.spec.js`                                                                              | **new** — PG-semantics pin for the batched insert                                                                                                                                                                                                                                                                                                                                  |

No migration. No schema change. No new env var — `SECONDARY_FULL_PASS_INTERVAL_HOURS`, `CTA_INSERT_CHUNK_ROWS` and `CTA_DELTA_ID_MAX` are plain constants, following the `FUTURE_TIMESTAMP_TOLERANCE_MS` precedent in `shared/database/src/legacy/etl-utils.ts`: an operator who needs a full pass right now deletes the `library-etl:secondary-full` row, which is a documented one-liner and does not need a deploy. No cron or schedule change — §0 finding 4 shows collapsing the transaction is both necessary and sufficient.

## 5. Tests

Written first, in this order.

**Unit** (`tests/unit/jobs/library-etl.test.ts`, existing mock-based file):

1. `buildArtistCrossRefQuery(null)` emits no `WHERE`; with a watermark it emits `cr.TIME_LAST_MODIFIED IS NULL OR cr.TIME_LAST_MODIFIED > <n>`. Same pair for the release cross-reference builder.
2. `buildCompilationTrackQuery(null)` emits no `WHERE`; with an id list it emits `LIBRARY_RELEASE_ID IN (...)`; with an empty list the caller must not call it at all (asserted at the call site, not in the builder).
3. `chunk()` — exact multiples, remainder, empty input, single element.
4. `isSecondaryFullPassDue(lastFull, now)` — null watermark is due; exactly at the interval is due; one ms under is not.

**[r2] Two existing tests in this file break and must be rewritten, not deleted.** `:1063` (`sweeps on idle runs too`) reads `job.ts` as text and asserts `reconcileDenylistedInserts` appears between `'No new legacy releases found'` and the next `return;` — §3B removes that `return;`, so `indexOf` lands elsewhere or returns `-1`. `:1043` (`re-checks at write time ahead of findExistingRelease…`) pins `reconcileDenylistedInserts(tx, insertedLegacyIds)` before `importArtistCrossRefs(` in source order, which the transaction split invalidates as a _textual_ claim. Both guard real invariants that survive the change, so both keep their invariant and change their evidence:

- idle sweep: assert the idle branch's `reconcileDenylistedInserts(tx, new Set<number>())` call exists and precedes the phase-2 entry point, rather than anchoring on a `return;` that no longer exists.
- ordering: assert `reconcileDenylistedInserts(tx, insertedLegacyIds)` precedes the phase-2 entry point in source order, and that `importArtistCrossRefs(`/`importCompilationTracks(` appear inside the phase-2 function — the invariant is "reconcile commits before anything can reference the row", which the split strengthens.

**Integration** (`tests/integration/library-etl-cta-batch.spec.js`, new, real Postgres, hand-written SQL in the `library-etl-setwhere.spec.js` style — the integration runner is babel-jest and cannot import the ETL's drizzle code). These re-assert §0 finding 3 against the real table rather than a probe copy:

5. A single multi-row `INSERT ... ON CONFLICT DO NOTHING` containing an intra-statement duplicate on `(library_id, artist_name, track_title)` inserts **one** row, not two, and does not raise.
6. The same statement re-run against already-present rows inserts zero and raises nothing (idempotence).
7. A batch mixing new rows, rows already in the table, and intra-batch duplicates lands exactly the new distinct rows.
8. A batch whose rows all have `track_title IS NULL` and share `(library_id, artist_name)` inserts one — pins that the untargeted clause still arbitrates on the partial index, even though upstream currently has no such rows.

**[r2] End-to-end** (`tests/e2e/etl.test.ts`, `npm run test:etl:env` + `npm run test:etl`). r1 wrongly claimed no harness existed for driving `run()` against both a MySQL mirror and Postgres; this is exactly that harness, it already asserts on `compilation_track_artist` (`:121`), both crossref tables (`:139-174`) and the `library-etl` watermark row (`:175`), and **its 12 `Library ETL` tests pass on unmodified `main` in this worktree**. (The suite's other 21 tests fail on unmodified `main` too — `flowsheet-etl` now refuses to run without `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1` after the Phase 3 decommission. Pre-existing, unrelated, and out of scope here; worth its own ticket.) New coverage:

9. The 12 existing `Library ETL` assertions still pass after the split — the regression gate for phases 1 and 2 together.
10. A second run with all four watermarks in place imports nothing new and leaves row counts unchanged (bounded path is genuinely bounded, and idempotent).
11. After bumping one seed crossref row's `TIME_LAST_MODIFIED` past the watermark, a re-run picks up exactly that edit — the bounded path propagates edits.
12. With the release watermark left in place (no new releases) but a crossref row bumped, a re-run still imports it — the note-4 regression test: proves phase 2 is no longer behind the release-delta early return.
13. The CTA seed's duplicate pair (added per §4) lands exactly one row through the real batched importer.
14. All four `library-etl:*` `cronjob_runs` rows exist and advance.

## 6. Verification before and after deploy

Local, before pushing (per CLAUDE.md — every push burns budget):

```
npm run lint && npm run format:check && npm run typecheck
npm run test:unit
npm run test:etl:env && npm run test:etl     # [r2] Library ETL block must stay green
npm run ci:testmock                          # includes the new integration spec
```

**[r2]** `ci:testmock` shares one Compose project across every checkout of this repo (`docs/testing.md`), so it needs `COMPOSE_PROJECT_NAME` and its own `CI_DB_PORT` / `CI_PORT` / `CI_AUTH_PORT` / `MOCK_API_PORT` in this worktree's `.env` if another worktree is running it. `@wxyc/database` must be built in the worktree first or `test:etl` fails with `ERR_MODULE_NOT_FOUND` on `dist/index.mjs`.

Production, after deploy — the ticket's remaining acceptance criteria:

1. **Force a work slot rather than waiting.** Work slots run ~6 per 5 days and journald retention is ~5.5 days, so waiting risks losing the evidence window. `UPDATE wxyc_schema.cronjob_runs SET last_run = now() - interval '7 days' WHERE job_name = 'library-etl';` re-selects only the last week of `LIBRARY_RELEASE` edits — a real, small, non-empty delta. This is deliberately **not** the README's full-re-sync recipe, which would re-select the entire catalog and make the duration measurement meaningless. Run the `SELECT` with the same `WHERE` first.
2. Read the slot off the journal: `Compilation track artists:` must land **seconds** after the transaction opens, against the 14 m 58 s / 12 m 54 s baselines, and `imported`/`skipped` must still read `139748` / `869` on a full pass — an unchanged count is the coverage check that batching regressed nothing.
3. `legacy-linkage-resolve` green on that same slot (BS#2413's acceptance criterion).
4. A subsequent bounded work slot completes in seconds.
5. `SELECT job_name, last_run FROM wxyc_schema.cronjob_runs WHERE job_name LIKE 'library-etl%';` shows all four rows advancing.

## 7. Risks

| risk                                                                                                         | mitigation                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intra-batch `DO NOTHING` does not dedupe as expected and 2,070 duplicate rows land                           | Verified on PG 14.24 and 18.0 before designing (§0 finding 3); re-pinned by integration tests 5–8 and e2e test 13                                                                                                                                                                           |
| A malformed row (e.g. over-length `artist_name`) now aborts a 1,000-row statement instead of a 1-row one     | Same outcome either way — an uncaught error aborts the whole transaction today. The batch loop logs the chunk's index range so the failing window is still identifiable                                                                                                                     |
| Phase 2 running on every pass adds SSH round trips to the ~98% idle path                                     | `MirrorSQL` holds one persistent SSH connection with a 5-minute idle dispose (`shared/database/src/legacy/sql.mirror.ts:41-47`), so each extra read is an `execCommand` on an open channel against 119- and 35-row tables. The CTA fetch is skipped outright when the delta id set is empty |
| The full pass relocates a long transaction to a daily slot instead of removing it                            | This is the ticket's explicit warning. Batching (§3A) is what prevents it, which is why it ships in the same change and is measured in §6.2 rather than assumed                                                                                                                             |
| Clock skew between Backend and tubafrenzy skips a cross-reference edit                                       | The daily full pass bounds it to a day. Documented in the README rather than left implicit                                                                                                                                                                                                  |
| **[r2]** An operator runs the old full-re-sync recipe from memory or an old doc and gets a release-only pass | All four in-repo sites move to `LIKE 'library-etl%'` in this change (§4), and the README section says which rows exist and what each one gates                                                                                                                                              |

## 8. Out of scope

- BS#2127, the sibling artist-resolution defect in the same job.
- BS#2386's 78/119 and 22/35 cross-reference shortfall. **[r2]** This change preserves the retry that has been narrowing it, at its measured effective rate (~1.15×/day, not the nominal 48×/day — see §3C); it does not fix the resolution failures themselves.
- BS#1996's ~4.9k double-encoded CTA rows.
- Any schedule change to `library-etl` or `legacy-linkage-resolve`. §0 finding 4 shows why collapsing the transaction is sufficient.
- **[r2]** The 21 pre-existing `tests/e2e/etl.test.ts` failures outside the `Library ETL` block (`flowsheet-etl`'s backwards-write refusal). Unrelated to this ticket; needs its own.
- **[r2]** Adding a Sentry cron monitor to `library-etl`, which `docs/ops-cron-scheduling.md:90` records as still missing. Unrelated, and the ticket asks not to over-invest here.
