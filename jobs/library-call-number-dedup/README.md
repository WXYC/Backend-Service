# library-call-number-dedup

One-shot dedup: resolve duplicate call-number slots in `library` so a uniqueness constraint can be added to the columns that address the shelf.

Dry-run by default. Pass `--execute` to write.

## Why

A WXYC call number addresses a physical slot on the shelf: the artist's genre-scoped code letters, a number, and an optional volume letter for a multi-disc set — rendered `KE 7`. Nothing in the schema enforces that a slot is used once, and `generateAlbumCodeNumber` reads `MAX(code_number)+1` and inserts without a lock, so two adds under one artist at the same moment already produce the same number with no user error involved. Slots accumulated more than one release.

Uniqueness has to be enforced in the database, not in a form: a form check cannot close the unlocked read-then-write. But the constraint cannot be added while the duplicates exist, which is what this job clears.

## The distinction the job turns on

Two rows in one slot are one of two very different things:

- **The same release entered twice.** Merges. Every reference is repointed to a survivor and the other row is deleted. No disc moves.
- **Two genuinely different releases.** One row is renumbered to a free slot — **and the physical disc has to be relabelled**, or the shelf and the catalog disagree.

Classifying on title equality gets this split wrong by better than 2x, because a release is routinely re-entered under a differently-decorated title. `It's a Party 12"` and `It's a Party cd-single` are one record filed twice, not two records sharing a number; so are a dirty LP and its clean-lyric pressing, and `Volume 1` versus `Volume One`. `classify.ts` strips the decoration that names a _pressing_ rather than a _work_ before comparing.

It deliberately does **not** strip volume or part numbers. `Ethiopiques vol. 21` and `Ethiopiques vol. 22` are different records; folding those together would merge two real releases and delete a catalog row that has plays.

## The slot key

```
(artist_id, genre_id, code_number, upper(coalesce(code_volume_letters, '')))
```

Two parts of that are load-bearing and easy to get wrong:

**`genre_id` is in the key** because code letters are genre-scoped — an artist filed under two genres has two shelves, and `BO 3` (Electronic) and `Bo 3` (Rock) are different slots holding different discs. That used to be implicit in there being two `artists` rows. It isn't any more: `jobs/artist-unicode-dedup` merges artist rows **globally across genres**, deliberately, so after it ran the genre is the only thing distinguishing the two shelves. A key of `(artist_id, code_number)` would call those a collision and destroy a correct filing.

**The volume letter is folded to upper case** because `D` and `d` are one slot, not two. The upstream MySQL catalog compares them case-insensitively under its default collation, so duplicates were created there that Postgres — which compares case-sensitively — would otherwise read as distinct and let straight through.

Any uniqueness constraint added afterward must use this same key, including the `coalesce`. Prod is PostgreSQL 14, where `NULLS NOT DISTINCT` is unavailable (PG15+), so a plain multi-column unique index treats every NULL volume letter as distinct — and most rows have a NULL volume letter, which is exactly the population the constraint is meant to cover.

## Order of operations is a data-safety property

Every FK referencing `library.id` is repointed to the survivor **before** the losing row is deleted. That is not stylistic. Of the 15 reference sites, seven cascade and two null out the reference:

| On delete  | Sites                                                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cascade`  | `rotation`, `album_metadata`, `reviews`, `album_critic_reviews`, `compilation_track_artist`, `artist_library_crossreference`, `uncovered_release_search_markers` |
| `set null` | `flowsheet.album_id`, `album_review_submissions.album_id`                                                                                                        |
| no action  | `bins`, `library_identity`, `library_identity_source`                                                                                                            |
| no FK      | `library_identity_history`, `album_popularity.representative_library_id`, `library_delete_denylist.library_id`                                                   |

Deleting first would silently destroy rotation history, album metadata, reviews, and now the artist cross-references too, and silently unlink plays — no error raised. The three no-action sites are the only ones that would fail loudly.

The three no-FK sites need no repoint and are listed so the inventory is complete rather than merely correct. `library_delete_denylist` is the newest of them (migration `0146`, landed while this branch was in review — the same `0146` this branch had to renumber around): it is keyed on `legacy_release_id`, and its `library_id` is explicitly informational, recording the id the row carried at delete time. A merge that deletes the losing `library` row therefore leaves it alone by design, which is the right behavior — the denylist's one consumer, `jobs/library-etl`'s import loop, reads only `legacy_release_id`.

**These actions are the ones the database enforces, not the ones `schema.ts` declares.** They used to disagree on `artist_library_crossreference.library_id`: `schema.ts` has always marked it `cascade`, while migration `0022` created it `no action` — one of the four drifted constraints catalogued in [#2015](https://github.com/WXYC/Backend-Service/issues/2015). **Migration `0147` ([BS#2112](https://github.com/WXYC/Backend-Service/issues/2112)) repaired exactly that constraint to the declared `cascade`, which is why it has moved rows in the table above.** On a database that has not yet applied `0147` it is still `no action`; the table describes a database that has. The sibling `artist_id` FK on the same table carries the same 0022 drift and was deliberately left alone.

That repair costs this job a safety net, and it is worth being explicit about the direction of the trade. Under `no action`, an incomplete repoint of `artist_library_crossreference` failed **loudly** — the survivor's `DELETE` raised a foreign-key violation and the per-slot transaction rolled back. Under `cascade` the same bug now fails **silently**: the stragglers are deleted along with the loser and the merge reports success. The delete-ordering argument above is what has to carry that weight now, so the ordering is a correctness property here rather than a defensive habit.

Reading only the migration that first _created_ a constraint is also insufficient: `album_metadata.album_id` was created `no action` in `0023`, dropped with its table in `0035`, and recreated `cascade` in `0079`. The live catalog is the authority, which is why `enforced-fk-actions` in the integration spec asserts every row of the table above against `information_schema` rather than against either file — and it is what caught the `0147` change.

Two tables are deliberately **not** targets: `album_plays` is a materialized view (refreshed, not repointed), and `specialty_shows` carries no library reference despite the name.

## Safety

- **Dry-run by default.** A dry run SELECTs and reports the whole plan with zero writes, including the child rows a merge would DROP as duplicates — counted separately from the ones it would repoint, so the destructive half of the plan is visible before approval.
- **Idempotent.** A completed merge drops that slot out of the `HAVING count(*) > 1` set, so a re-run finds nothing to do.
- **Per-slot atomic.** Each slot's repoints and delete run in one transaction, so a mid-run abort leaves each slot either fully merged or untouched.
- **Renumbers re-check their destination** inside the transaction and decline rather than collide, since the plan is built from a snapshot and a librarian may file concurrently. Declined renumbers are logged and left for a re-run.
- **Withheld renumbers.** When the disc that would move already has a same-titled copy elsewhere on the same shelf, giving it a new number would leave one title at three addresses. Which copy is real is a shelf question, so those are reported in the worklist and nothing is changed.
- **Data is moved before it can be dropped.** The survivor is chosen by inbound reference count, which says nothing about how complete its data is, so a fill-null pass COALESCEs the loser's expensive-to-recollect columns onto the survivor before anything is deleted — the LML identity resolution, curated artwork, and the music director's deliberate "not on Discogs" note, plus the same treatment for `album_metadata`. Without it a merge can delete the only row that carried them.
- **Refuses to start while a show is on air.** The job writes `flowsheet`, which dj-site polls every 60s. It is a one-shot run in a chosen window, so declining outright is cheaper than pausing mid-pass.
- **A skipped renumber sets a non-zero exit code** and is kept off the worklist. The catalog row never moved, so telling the librarian to relabel that disc would create the shelf/catalog disagreement this job exists to remove, in reverse.
- **A slot holding three rows** merges its duplicates and reports the remainder for the librarian, rather than guessing which of two different releases should move.
- **A dry-run worklist must never reach the librarian.** It describes physical relabelling against a catalog that has not moved, so acting on it produces the shelf/catalog disagreement this job exists to remove, in reverse — and because `--execute` is gated open-endedly on Phase 3.5 (below), a preview can sit around for months before a real worklist exists to displace it. A dry run therefore titles its worklist `PREVIEW, DO NOT DISTRIBUTE`, banners it above and below the table, and stamps `PREVIEW` in place of the check-off box on every row, so the warning survives being forwarded, pasted without its first paragraph, or printed. Only the `--execute` worklist carries the clean title.
- `ANALYZE` on the rewritten tables after an `--execute` run, per `docs/bulk-update-playbook.md`.

## Sequencing

**Run this after `jobs/library-etl` stops — turndown Phase 3.5 ([WXYC/wiki#89](https://github.com/WXYC/wiki/issues/89)), which has no calendar date.** `library-etl` upserts on `legacy_release_id` and carries both `code_number` and `code_volume_letters` in its refresh set, so while that ETL is live it will overwrite a renumber and reinstate a deleted row from the upstream MySQL catalog.

Do not read the 2026-09-07 turndown date as this job's start date. That date binds Surface 1 only — the flowsheet/playlist UI, Phase 3 ([wiki#88](https://github.com/WXYC/wiki/issues/88)), which is where `flowsheet-etl` and `rotation-etl` stop (BS#1858 flips those two to `job-type: one-shot` and **deliberately leaves `library-etl` alone**). Surface 2 (`/wxycdb` catalog edit) is chain-ready-gated, not calendar-gated: `/wxycdb` + MySQL + `library-etl` + the MySQL-sourced daily `library.db` sync survive frozen-scope past 9/7 at zero hosting penalty if the chain isn't ready. The critical path is the MD catalog-edit UI rebuild ([WXYC/dj-site#1071](https://github.com/WXYC/dj-site/issues/1071)).

**The revert is triggered by an upstream edit, not by the clock, and pausing the ETL is not a workaround.** `library-etl` is incremental — `buildReleaseQuery` filters `WHERE lr.TIME_LAST_MODIFIED > <last run>` — so it fetches only releases whose _upstream_ timestamp advanced. This job writes Postgres and leaves MySQL untouched, so a deduped release is absent from the next fetch and the next pass does not revert it. What reverts it is a librarian editing that release in tubafrenzy, at any point afterward: the re-fetch refreshes `code_number` from `excluded.*`, and a merged-away row whose `legacy_release_id` no longer resolves is INSERTed fresh, resurrecting the slot. A pause window covers a ~20-second run that was never at risk and restores the open-ended exposure the moment it lifts.

Running before the ETL stops is therefore not catastrophic but decays, and the decay is worse than it looks: the relabelling in step 3 is _physical_, so a later revert leaves a disc mislabelled in the opposite direction — the shelf/catalog disagreement this job exists to remove.

**Wait for parity sign-off, not just for the ETL to stop.** Phase 3.5's cutover ends with seven consecutive clean parity days comparing the Backend-sourced `library.db` build against the still-running prod MySQL build, where clean means zero unmatched after the documented residue ledger. This job _deliberately_ diverges the two: the 2026-08-07 dry run planned ~149 deletions of rows that still exist upstream, plus ~116 renumbers. Re-derive those two figures from a fresh dry run before writing them into the residue ledger — the gate is open-ended, so by the time it opens they will describe a plan that no longer exists. Running it inside that window injects intentional drift into the exact check trying to prove the two agree, and it reads as a parity failure rather than as the intended change. Run after the parity gate closes, or get the divergence written into the residue ledger first.

Then, in order:

1. Dry run. Review the plan and the worklist yourself; it is a preview, and it goes to nobody. (The plan drifts — re-derive it rather than trusting an earlier run's numbers.)
2. `--execute`.
3. Give **that run's** worklist to the librarian. Until the discs are relabelled, the shelf and the catalog disagree.
4. Add the uniqueness constraint, keyed as above.

**Step 4 has its own hard gate on the same event, for a different reason** ([#2033](https://github.com/WXYC/Backend-Service/issues/2033)). Upstream MySQL enforces no uniqueness on the call-number tuple and hosts the unlocked `MAX+1` allocator, so it can mint a new duplicate at any time. Once the constraint exists, that release's INSERT violates it — and `ON CONFLICT (legacy_release_id)` does not absorb a violation of a different index. The release loop is one transaction, so it aborts the entire ETL run, exactly as `job.ts` documents for `library_legacy_release_id_idx` and #752. Do not merge the constraint migration while `library-etl` is live.

## Running

Manual Build & Deploy with `target=library-call-number-dedup`, then on EC2:

```bash
docker run --rm --env-file .env <image>            2>&1 | tee log-dry
docker run --rm --env-file .env <image> --execute  2>&1 | tee log-exec
```

Environment: standard `DB_*` connection vars, same as the other one-shots.

The job writes no files — the worklist is Markdown on stdout, so it is lifted out of the log by hand. If you save one, let the filename repeat what the title already says: a dry run's copy is `call-number-worklist-PREVIEW-DO-NOT-DISTRIBUTE.md`, and only the `--execute` run's copy gets the plain `call-number-worklist.md` that a librarian may be sent.

## Tests

- `tests/unit/jobs/library-call-number-dedup/classify.test.ts` — the merge/renumber split, over real collisions measured in the production catalog.
- `tests/unit/jobs/library-call-number-dedup/report.test.ts` — worklist legibility.
- `tests/integration/library-call-number-dedup-merge.spec.js` — the destructive functions against a real Postgres, including the cascade-ordering invariant.
