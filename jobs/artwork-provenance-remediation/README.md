# artwork-provenance-remediation

One-shot drain (BS#2258) that repairs `wxyc_schema.album_metadata.artwork_url` rows whose stored image is provably **not a release cover** — a Discogs _artist image_ or _label logo_ that LML's `_resolve_fallback_artwork` cascade returned when it could not find the real thing, and that Backend-Service persisted with no way to tell the difference.

This is the exact complement of [`flowsheet-artwork-repair`](../flowsheet-artwork-repair/README.md) (BS#1209). That drain healed the rows the same upstream bug left **null**; its `artwork_url IS NULL` predicate could not reach the rows it left **wrong and non-null**. dj-site's card catalog reads `album_metadata`, so these render as the Warp Records logo where an Autechre cover belongs.

## How a wrong row is identified

Every Discogs image URL carries its origin S3 key as a base64url blob split across the URL's path segments:

```
https://i.discogs.com/<sig>/rs:fit/g:sm/q:90/h:300/w:299/
  czM6Ly9kaXNjb2dz/LWRhdGFiYXNlLWlt/YWdlcy9MLTE4NjYt/MTIzMzE5MzU1Ny5q/cGVn.jpeg
  -> s3://discogs-database-images/L-1866-1233193557.jpeg
```

`R-` is a release cover, `A-` an artist image, `L-` a label logo. The decoder is `classifyArtworkProvenance` in [`@wxyc/metadata`](../../shared/metadata/src/helpers/discogs-image-provenance.ts), unit-tested against verbatim prod URLs of each class.

**The selector is a positive match on `A-`/`L-`, never a negative match on "not `R-`".** Apple `mzstatic` covers and pre-imgproxy `img.discogs.com` URLs decode to nothing at all and are perfectly good artwork; a negative selector would sweep every one of them into an overwrite.

## Population, measured against prod 2026-08-24

|                                            | rows      |
| ------------------------------------------ | --------- |
| `album_metadata` rows with artwork         | 41,524    |
| Discogs-hosted (what the SQL scan returns) | 41,333    |
| `R-` release cover — correct, untouched    | 33,383    |
| **`L-` label logo — drained**              | **6,977** |
| **`A-` artist image — drained**            | **973**   |
| Apple `mzstatic` — legitimate, untouched   | 191       |

**79% of the drain population already has a correct cover in `library`.** Cross-checking the two tables on `album_metadata.album_id = library.id`: 5,764 label-logo rows and 517 artist-image rows (6,281 of 7,950) have an `R-` release cover in `library` for the same album, written by a different writer at a different time from a different LML answer. That is independent corroboration that LML _can_ resolve these covers, and an unexploited optimization — a copy-from-`library` path would cut the drain from 7,950 LML calls to 1,669. Not implemented: it is a second heal source with different failure modes, and `library`'s `R-` proves the image is _a_ release cover, not that it is _this album's_. Worth its own measurement.

`wxyc_schema.library` carries a further 629 `L-` + 1,121 `A-` rows. **This job does not touch them.** Both `library.artwork_url` writers hard-guard `IS NULL` (BS#720), so that half needs a deliberate correction path rather than a re-enrichment drain; it stays open on BS#2258.

## What it writes

Only `artwork_url` and `updated_at`, and only when the fresh answer is strictly better:

| outcome       | condition                                                      | writes? |
| ------------- | -------------------------------------------------------------- | ------- |
| `healed`      | LML resolved artwork that is not an artist image or label logo | yes     |
| `still_wrong` | LML resolved another `A-`/`L-` image                           | no      |
| `no_match`    | LML resolved no artwork (or only a `spacer.gif`)               | no      |
| `raced`       | the guarded UPDATE matched zero rows                           | no      |
| `error`       | the LML call threw                                             | no      |

Two refusals are deliberate and are BS#2258's "decide this explicitly and record the decision":

- **Never null a row out.** A wrong image is bad; a blank tile on a row that at least rendered something is a visible regression.
- **Never write a lateral answer.** Swapping a label logo for an artist photo fixes nothing and spends the row's `updated_at`, which BS#2258 relies on as the only proxy for artwork-write time.

### Does the fresh lookup bind the right album?

The obvious objection to a narrow write is that the replacement comes from a fresh lookup which might bind a different release than the row's `discogs_url` already names. Measured on a 240-row stratified read-only probe against prod, 2026-08-25 — 60 rows from each of `label`/`artist` x has-`discogs_url`/hasn't (the `artist`-without-`discogs_url` cell is a census; its pool is exactly 60):

|                                                                      |                                       |
| -------------------------------------------------------------------- | ------------------------------------- |
| Discogs release title matches the catalog title exactly              | **238 / 240**                         |
| Wrong-album bindings                                                 | **0**                                 |
| Covers sourced from a sibling pressing rather than the bound release | **0**                                 |
| Healed to a real `R-` cover                                          | 232 / 240 (99.6% population-weighted) |

The two non-exact titles were a same-album format variant (`Pork Soda` vs `Pork Soda + 2 [10-inch single]`) and one row Discogs returned no title for. The 8 rows that did not heal were left byte-identical, as designed: 4 resolved to another artist image, 4 to no artwork at all.

**A release-id guard would have been worse than no guard.** 23 of the 119 sampled rows carrying a stored `discogs_url` bound a _different_ release today than when they were written — and 22 of those 23 still matched the catalog title exactly, while all 23 healed to a real cover. They are different pressings of one album. Refusing on id disagreement would have skipped 19% of the rows that heal correctly.

So the write is narrow and ungated, and the job **counts** title agreement instead of enforcing it (`title_agreed` / `title_diverged`, each divergence logged with both titles). That asks the same question at 7,950 rows rather than 240, and it is what would catch a regression in LML's matching before it wrote confident wrong covers.

### Race guard

The UPDATE's WHERE pins `artwork_url` to the value the selector classified, not just `album_id`. A row a live enrichment healed between the scan and the write falls out of the predicate (`raced`) instead of being overwritten with this drain's staler answer. That makes the whole run idempotent and order-independent — re-running it re-selects only rows that are still wrong.

## Running it

```bash
# What would be drained, with no lookups and no writes.
DRY_RUN=1 npm start --workspace=@wxyc/artwork-provenance-remediation

# The real pass.
npm start --workspace=@wxyc/artwork-provenance-remediation
```

At the default pace (`BACKFILL_LML_RATE_PER_MIN=20`, `BACKFILL_LML_MAX_CONCURRENT=1`) the full 7,950-row population takes roughly 6.5 hours. The job pauses cooperatively while a DJ is on air; set `LIVE_ACTIVITY_LOOKBACK_SECONDS=0` for a catch-up run.

### Environment

| var                              | default        | meaning                                                                  |
| -------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `LIBRARY_METADATA_URL`           | —              | required; the job aborts before scanning if unset                        |
| `DRY_RUN`                        | unset          | `1`/`true` — enumerate + classify + report, no lookups, no writes        |
| `ARTWORK_PROVENANCE_TIMEOUT_MS`  | `35000`        | per-LML-call timeout                                                     |
| `BACKFILL_LML_RATE_PER_MIN`      | `20`           | shared with the sibling drains, so two concurrent jobs share one ceiling |
| `BACKFILL_LML_MAX_CONCURRENT`    | `1`            | ditto                                                                    |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS` | `60`           | `0` disables the cooperative pause                                       |
| `LIVE_ACTIVITY_PAUSE_MS`         | shared default | how long to defer when the flowsheet is live                             |
| `LIVE_ACTIVITY_MAX_PAUSE_MS`     | shared default | cumulative pause ceiling; `0` = uncapped                                 |

### Why this job sends no budget header

It passes `budgetMs: null`, suppressing `X-Caller-Budget-Ms`. Class 5's default header caps LML's effective search budget at ~4s — right for an ordinary backfill, wrong here. These rows are exactly the ones whose covers LML failed to resolve the first time, so answering them means a cold cross-pressing resolution that measures 4–20s on prod; under the cap LML returns `degraded: deadline_exceeded` with `artwork: null`, which this drain would score `no_match` and leave wrong. That is the failure BS#1914 documented for the enrichment-worker. The BS#2258 pilot that justified running the drain was measured headerless, and the job reproduces those conditions. Rationale in full in [`lml-fetch.ts`](lml-fetch.ts).

## Sequencing

BS#2258 gates the drain on LML having a path to the covers. Two LML fixes matter:

- **LML#1237** (PR#1242, prod 2026-08-23) re-asks Discogs for the bound release when `artwork_checked_at IS NULL`. This is what makes the label-logo cohort answerable: a read-only pilot of 120 sampled `L-` rows against prod carrying this fix resolved **120/120** to real release covers, zero nulls, zero artist images (two independent 60-row samples — lowest-`album_id` and md5-pseudo-random; 95% upper bound on the failure rate ≈ 2.5%).
- **LML#1241**, the sibling-pressing rung, is merged dark behind `LML_RESOLVE_SIBLING_PRESSING_ARTWORK=false`. It covers the rows whose cover lives under a _different_ pressing than the one LML bound.

Running before the #1241 flip is the measured call rather than a premature one: the pilot says the dominant cohort heals without it, and a row that does not heal is left byte-identical, so a re-run after the flip picks it up.

## Related

- WXYC/Backend-Service#2258 — this ticket
- WXYC/Backend-Service#1209 / #1946 — the null-cohort drain and its HITL prod execution; the procedural model here
- WXYC/Backend-Service#720 — the `library.artwork_url` race-guard that forecloses correction on the other half
- WXYC/library-metadata-lookup#1237, #1241, #687 — the upstream artwork cascade
