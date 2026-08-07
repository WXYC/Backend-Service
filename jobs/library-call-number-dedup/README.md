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

Every FK referencing `library.id` is repointed to the survivor **before** the losing row is deleted. That is not stylistic. Of the 13 reference sites, five cascade and two null out the reference:

| On delete  | Sites                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------- |
| `cascade`  | `rotation`, `album_metadata`, `reviews`, `album_critic_reviews`, `compilation_track_artist` |
| `set null` | `flowsheet.album_id`, `album_review_submissions.album_id`                                   |
| no action  | `artist_library_crossreference`, `bins`, `library_identity`, `library_identity_source`      |
| no FK      | `library_identity_history`, `album_popularity.representative_library_id`                    |

Deleting first would silently destroy rotation history, album metadata, and reviews, and silently unlink plays — no error raised. The no-action sites are the only ones that would fail loudly.

**These actions are the ones the database enforces, not the ones `schema.ts` declares.** The two disagree: `schema.ts` marks `artist_library_crossreference.library_id` as `cascade`, but migration `0022` created it `no action` and nothing since has altered it — one of the four drifted constraints catalogued in [#2015](https://github.com/WXYC/Backend-Service/issues/2015). Reading the schema file alone would put it in the wrong row of that table. Reading only the migration that first _created_ a constraint is also insufficient: `album_metadata.album_id` was created `no action` in `0023`, dropped with its table in `0035`, and recreated `cascade` in `0079`. The live catalog is the authority, which is why `enforced-fk-actions` in the integration spec asserts every row of the table above against `information_schema` rather than against either file.

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
- `ANALYZE` on the rewritten tables after an `--execute` run, per `docs/bulk-update-playbook.md`.

## Sequencing

**Run this after the tubafrenzy ETL stops.** `jobs/library-etl` upserts on `legacy_release_id` and carries `code_number` in its refresh set, so while that ETL is live it will overwrite a renumber and reinstate a deleted row from the upstream MySQL catalog on its next pass.

Then, in order:

1. Dry run. Review the plan and the worklist.
2. `--execute`.
3. Give the worklist to the librarian. Until the discs are relabelled, the shelf and the catalog disagree.
4. Add the uniqueness constraint, keyed as above.

## Running

Manual Build & Deploy with `target=library-call-number-dedup`, then on EC2:

```bash
docker run --rm --env-file .env <image>            2>&1 | tee log-dry
docker run --rm --env-file .env <image> --execute  2>&1 | tee log-exec
```

Environment: standard `DB_*` connection vars, same as the other one-shots.

## Tests

- `tests/unit/jobs/library-call-number-dedup/classify.test.ts` — the merge/renumber split, over real collisions measured in the production catalog.
- `tests/unit/jobs/library-call-number-dedup/report.test.ts` — worklist legibility.
- `tests/integration/library-call-number-dedup-merge.spec.js` — the destructive functions against a real Postgres, including the cascade-ordering invariant.
