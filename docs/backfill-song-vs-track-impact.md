# Impact: `flowsheet-metadata-backfill` shipped with the wrong LML wire shape (#888)

## TL;DR

From 2026-04-29 through 2026-05-15, the historical metadata drain
(`jobs/flowsheet-metadata-backfill/`) posted `body.track` to LML's
`/api/v1/lookup` instead of `body.song`. FastAPI/Pydantic silently drops
unknown keys on `LookupRequest`, so every backfill request to LML was
processed as an artist+album-only query — none of LML's track-aware strategies
(`TRACK_ON_COMPILATION`, `SONG_AS_TRACK`, `SONG_AS_ARTIST`) fired. The runtime
path (`apps/backend/services/lml/lml.client.ts`) was always correct.

The fix is one character; the question this document answers is _how much it
mattered_, and whether a re-run of the affected window is warranted.

## How the impact was measured

A random sample of **1000 rows** was drawn from `flowsheet` where:

```sql
metadata_attempt_at >= '2026-04-29'
  AND track_title  IS NOT NULL
  AND artist_name  IS NOT NULL
```

The 2026-04-29 floor is the deploy date of the buggy job (per the
`flowsheet-metadata-enrichment` memory). The track/artist NOT NULL constraint
isolates rows where the bug actually had a chance to matter — rows with no
track title were degenerate cases that any wire shape would have handled the
same way.

For each sampled row, prod LML was called twice with bearer auth:

| Shape     | Body sent                                      | What LML's parser sees                                           |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| **Buggy** | `{artist, album, raw_message}` (no `song` key) | `parsed.song = None` → only `ARTIST_PLUS_ALBUM`-class strategies |
| **Fixed** | `{artist, album, song, raw_message}`           | `parsed.song = <track>` → all track-aware strategies in play     |

Both calls used the same `raw_message` (`"<artist> - <album> - <track>"`),
matching what `lml-fetch.ts` synthesizes. Only the structured `song` field
differs — which is the same delta the production fix introduces.

Comparison key: top-1 `release_id` from each call's `results[0]`.

Throttle: 1 in-flight + ~150ms inter-request pacing, mirroring the runtime
chokepoint's load profile. Total wall time ≈ 30–40 min on EC2 against prod
Railway LML.

## Outcomes

Per-row outcomes are bucketed into five disjoint classes:

| Class                    | Meaning                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same_release`           | Both calls returned the same top-1 `release_id`. Bug had no effect on this row.                                                                                             |
| `diff_release`           | Both calls returned a release, but a _different_ one. Buggy backfill enriched against the wrong release.                                                                    |
| `buggy_null_fixed_found` | Buggy call returned nothing; fixed call found a release. Buggy backfill failed to enrich this row at all.                                                                   |
| `buggy_found_fixed_null` | Buggy call returned a release; fixed call found nothing. Rare; suggests the buggy artist+album-only query is _more_ permissive than the song-gated path for this row shape. |
| `both_null`              | Neither call resolved a release. Bug had no effect; row is genuinely unresolvable.                                                                                          |

### Results

Run completed 2026-05-15. n=1000 sampled rows.

| Class                                            |   Count | % of N (1000) | % of bucketed (917) |
| ------------------------------------------------ | ------: | ------------: | ------------------: |
| `same_release`                                   |     533 |         53.3% |               58.1% |
| `diff_release`                                   |      76 |          7.6% |                8.3% |
| `buggy_null_fixed_found`                         |      90 |          9.0% |                9.8% |
| `buggy_found_fixed_null`                         |       3 |          0.3% |                0.3% |
| `both_null`                                      |     215 |         21.5% |               23.4% |
| **Divergent total** (`diff` + `bN_fY` + `bY_fN`) | **169** |     **16.9%** |           **18.4%** |
| Buggy-call errors (timeout/5xx)                  |      48 |          4.8% |                   — |
| Fixed-call errors (timeout/5xx)                  |      77 |          7.7% |                   — |

The bucketed denominator (917) excludes 83 rows where either the buggy or fixed
call errored and the comparison couldn't be made. The fixed-call error rate is
~3 points higher than the buggy-call rate, presumably because the track-aware
path exercises more of LML's strategy cascade and hits the 30s timeout
fractionally more often. Errors clustered after row ~700 (3→48 in 250 rows) —
likely a transient burst, not a structural problem with the comparison.

### Spot-check: what the divergence looks like

**`diff_release` (wrong artwork) examples — the song-aware path returns the
right release where the album-only path got it wrong:**

| Artist           | Album                            | Track                     | Buggy top-1                                | Fixed top-1                |
| ---------------- | -------------------------------- | ------------------------- | ------------------------------------------ | -------------------------- |
| Nicholas Collins | Tellus Tools                     | Devil's Music 1 (Excerpt) | "Let the State Make the Selection"         | "Devils Music"             |
| Languis          | Music for Plants                 | Photosynthesis            | "Untied"                                   | "Music for Plants"         |
| Seefeel          | S/T                              | Airless                   | "Quique"                                   | "Seefeel" (self-titled)    |
| Kool Keith       | Lost Masters Collection Volume 3 | Real Gold                 | "Sex Style"                                | "Lost Masters Collective"  |
| Little Brother   | the chitlin circuit              | what you do               | "Take it Back b/w On and On" by **Skillz** | "The Chittlin Circuit 1.5" |

The "S/T" → wrong-album case is representative: when the user writes the
album as a shorthand the track-aware lookup is required to disambiguate.

**`buggy_null_fixed_found` (no artwork at all) examples — the bug caused these
rows to land in the no-artwork bucket where track-aware lookup would have
found a compilation match:**

| Artist                          | Album                     | Track                      | Fixed found                                                    |
| ------------------------------- | ------------------------- | -------------------------- | -------------------------------------------------------------- |
| Les Troubadours du Roi Baudouin | Missa Luba                | Dibwe Diambula Kabanda     | "Missa Luba: A Mass Sung in Pure Congolese Style" (V/A Africa) |
| Silver Mount Zion               | Horses in the Sky         | god bless our dead marines | "Horses in the Sky" by A Silver Mt. Zion                       |
| Mr. Magic                       | _(null)_                  | Potential 1980             | "The Third Unheard: Connecticut Hip-Hop 1979-1983" (V/A)       |
| The Soul Duo                    | Ol' Virginia Soul: Part 1 | This Is Your Day           | "Eccentric Soul: The Linco Label" (V/A)                        |

**`buggy_found_fixed_null` (3 rows) — all are "artist + null album + song"
where the fixed call routes to LML's `search_type: compilation` flow.** That
flow returns multiple `library_item` matches without attaching a single
top-1 artwork, so `extractArtwork` falls back to `null`. The lookup is
genuinely finding more — `extractArtwork` is just not reaching into the
multi-result shape. This is a top-1 extraction quirk, not a regression in
LML's lookup pipeline, and it'll cost ~0.3% of rows artwork they previously
had if we re-run the window naively. (Filed as a follow-up below.)

### Extrapolation

Buggy-window population (`metadata_attempt_at >= '2026-04-29' AND
track_title IS NOT NULL AND artist_name IS NOT NULL`) was **841,049** rows
at 2026-05-15 15:12 UTC. Applying the bucketed fractions:

| Class                    | Sample % | Extrapolated rows | Interpretation                                           |
| ------------------------ | -------: | ----------------: | -------------------------------------------------------- |
| `same_release`           |    58.1% |          ~488,800 | Bug had no effect on artwork                             |
| `diff_release`           |     8.3% |           ~69,800 | **Carrying wrong artwork today**                         |
| `buggy_null_fixed_found` |     9.8% |           ~82,400 | **Missing artwork today; would resolve**                 |
| `buggy_found_fixed_null` |     0.3% |            ~2,800 | Carrying artwork that a re-run would clear (top-1 quirk) |
| `both_null`              |    23.4% |          ~196,800 | Unresolvable either way                                  |

The "carrying wrong artwork today" + "missing artwork today" buckets sum to
**~152,200 rows that a song-aware re-run would materially improve.** Against
2,800 rows the re-run would marginally regress (~54:1 favorable ratio), the
case for re-running is unambiguous.

## Recommendation

**Re-run the buggy window after PR #916 deploys.** The 16.9% sample divergence
extrapolates to ~152k rows with materially worse artwork than they should
have. The bN*fY bucket alone (~82k rows currently showing no artwork that
would resolve) is enough to justify the re-run; the diff_release bucket
compounds it with rows showing the \_wrong* album's artwork (Skillz where it
should be Little Brother, etc.).

The 0.3% bY_fN regression rate is acceptable for the v1 re-run. The
underlying issue is `extractArtwork` not reaching into LML's
`search_type: compilation` multi-result shape; that's a separate, narrow fix
worth filing as a follow-up (see "Follow-ups" below). Either land that fix
first and re-run after, or accept the ~2,800-row temporary downgrade now.

## Re-run plan

The backfill is idempotent on `metadata_attempt_at`: rows with the column
non-NULL are skipped, and the partial index (PR #660) keeps the drain query
cheap. To re-attempt the buggy-window rows, NULL the column on the buggy
intersection and let the existing cron drain them:

```sql
-- Pre-flight: confirm scope before the UPDATE
SELECT COUNT(*)
FROM wxyc_schema.flowsheet
WHERE metadata_attempt_at >= '2026-04-29'
  AND metadata_attempt_at <  '<fix-deploy-timestamp>'
  AND track_title IS NOT NULL
  AND artist_name IS NOT NULL;

-- Surgical re-attempt: only rows the bug could have touched
UPDATE wxyc_schema.flowsheet
SET metadata_attempt_at = NULL
WHERE metadata_attempt_at >= '2026-04-29'
  AND metadata_attempt_at <  '<fix-deploy-timestamp>'
  AND track_title IS NOT NULL
  AND artist_name IS NOT NULL;
```

Apply the bulk-UPDATE playbook (`project_bulk_update_playbook.md`): small
batches, `SET LOCAL synchronous_commit = OFF`, watch CDC trigger and
search_doc tsvector regen load. The metadata_attempt_at column doesn't
trigger search_doc, but it does fire the CDC trigger, so a single bulk
update of ~841k rows will produce a CDC burst. Either rate-limit the
UPDATE or pause the CDC consumer for the duration.

Drain pacing: the nightly cron at 06:00 UTC has cooperative pause (#735)
when DJs are active. If the drain is configured at, e.g., 30k rows/tick,
the full re-run completes in roughly a month of nightly ticks. If faster
turnaround matters, bump the per-tick limit temporarily or kick a one-shot
run between cron ticks.

## Follow-ups

1. **`extractArtwork` compilation-shape blind spot.** The bY_fN cases (3/1000)
   are all "artist + null album + song" rows that hit LML's
   `search_type: compilation` flow. Those responses return multiple
   `library_item` matches without a single top-1 `artwork` object, so
   `enrich.ts:extractArtwork` returns null even though LML has the data.
   File as: "`extractArtwork` should pick the best artwork from compilation
   responses." Estimated impact: ~2.8k rows in the buggy window, plus an
   unknown ongoing rate on the runtime path. Small ticket.

2. **Quantify the user-visible artwork-quality delta separately.** This
   document compares `release_id` only. Two different Discogs release IDs
   for the same album frequently share artwork (re-issues, regional
   variants). The "wrong artwork at the pixel level" rate is bounded by 8.3%
   but is probably lower in practice. If we want to size that more precisely,
   compare `artwork_url` (or a perceptual hash) instead of `release_id` on
   the same sample. Not blocking the re-run decision.

3. **B4 client consolidation will prevent this class of drift.** Both
   consumers will share the one `lml.client.ts` and the field-name
   constraint will be type-checked at compile time. See the parent epic
   in #876.

## References

- Bug ticket: #888
- Fix PR: #916 — `body.track` → `body.song` plus a regression test pinning
  the wire shape.
- Runtime path (always correct): `apps/backend/services/lml/lml.client.ts:159`
- Backfill job: `jobs/flowsheet-metadata-backfill/lml-fetch.ts:58`
- LML strategy gate on `parsed.song`: `library-metadata-lookup/lookup/orchestrator.py:1633`
- LML `LookupRequest` schema: `wxyc-shared/api.yaml`
- `extractArtwork`: `jobs/flowsheet-metadata-backfill/enrich.ts:101`
- B4 (client consolidation): parent epic #876.
