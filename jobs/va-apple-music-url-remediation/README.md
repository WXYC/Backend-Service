# va-apple-music-url-remediation

One-shot remediation for [BS#2000](https://github.com/WXYC/Backend-Service/issues/2000). Heals the Apple Music URLs BS persisted from LML's pre-[#1139](https://github.com/WXYC/library-metadata-lookup/issues/1139) Various-Artists-blind track matcher. **Dry-run is the default and makes zero LML calls; writes require `--execute`.**

## Problem

WXYC files V/A compilations under a shelf-genre convention (`Various Artists - Blues`), so the constant `Various Artists - ` prefix scores ~85 between any two such credits — over LML's 80 acceptance floor, carrying no identifying information. The LML#782 album-dropped fallback then re-admitted winners on a vacuous artist plus a generic standard's title (`I'm On My Way`, `Desafinado` — blues/latin standards that appear on hundreds of compilations and score 95–100 on the title axis while pointing at the wrong record). BS persisted those wrong deep-links.

BS persistence is fill-only, so they are frozen. On `flowsheet` the enrichment worker never revisits `enriched_match` rows. On `album_metadata` it is even more explicit: `resolveStreamingConflict` never overwrites a `'verified'` URL, and a URL's mere existence infers `'verified'`.

## Scope: both tables (a correction to the issue body)

The issue originally said "`album_metadata` is filled from album-level lookups — not implicated. Do not touch it." That conflates the album **matcher** with the `album_metadata` **table**. Verified:

- `apps/backend/services/flowsheet.service.ts:243` serves `coalesce(album_metadata.apple_music_url, flowsheet.apple_music_url)` — **`album_metadata` wins**.
- `apps/enrichment-worker/enrich.ts:285` / `:348` write `album_metadata.apple_music_url` from `artwork.apple_music_url` — **the same track-aware Apple probe**.
- `enrich.ts:557` marks the inline `flowsheet` write as the **unlinked-only** branch.

So for a linked V/A row the polluted, DJ-visible URL is in `album_metadata`. A flowsheet-only run would spend LML budget and change nothing anyone sees. Scope decision and evidence recorded in [this issue comment](https://github.com/WXYC/Backend-Service/issues/2000#issuecomment-5197168105).

The zero-V/A-false-positives evidence the issue cites is about `find_best_source_match` (the 5-service album matcher) and still holds — no other streaming column is touched.

## Two arms, because the two tables have different recovery paths

|               | `flowsheet`                                                         | `album_metadata`                                                                          |
| ------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Re-ask lane   | **none** — no status column, worker never revisits `enriched_match` | **yes** — `apple_music_status` + the BS#1915 hourly `streaming-reask.ts` sweep            |
| This job does | LML re-verify, one lookup per distinct `(artist, album, track)`     | invalidate to `apple_music_status='unresolved'`, `url=NULL`, `streaming_reask_attempts=0` |
| LML cost      | one lookup per distinct triple                                      | **zero**                                                                                  |

`album_metadata` is album-keyed while the URL it holds is a _track_ deep-link, so there is no honest `(artist, album, track)` triple to re-query it with. Rather than invent one, the job hands those rows to the mechanism built for exactly this — the re-ask sweep re-resolves them through the now-guarded matcher. Resetting `streaming_reask_attempts` is deliberate: the pre-#1139 "verification" was a shared prefix, so these rows were never validly verified and are owed a fresh adjudication. The cohort is finite, so the spend is bounded.

### Phase order is load-bearing

**flowsheet runs first.** Nulling `album_metadata` unmasks whatever `flowsheet.apple_music_url` holds for the same row, because the read-path coalesce falls through. Doing `album_metadata` first would open a window in which the polluted flowsheet value is the one being served — strictly worse than the status quo. If the flowsheet phase fails, the album phase is **skipped** for the same reason.

## Candidate net

```sql
-- Confirm scope BEFORE running (org data-safety rule). Same predicate the job uses.
SELECT COUNT(*) FROM wxyc_schema.flowsheet
WHERE apple_music_url IS NOT NULL
  AND wxyc_schema.fold_artist_name(artist_name) ~ '(various|soundtrack|compilation|v[./]\s*a\.?)';
```

Coarse SQL net + pure TS arbiter (`va-artist.ts`), the BS#1715 idiom. Two details that were each silently breaking it in draft:

- **The fold must happen in SQL.** `lower('Vàrious Artists')` matches none of the alternatives, so a `lower()`-based net drops diacritic rows _before_ the arbiter sees them — the TS-side fold pin would pass while the rows it represents were never selected. `wxyc_schema.fold_artist_name` (migration 0134) is used instead, and the arbiter imports its byte-identical twin `foldArtistName` from `@wxyc/database`, so net and arbiter share one fold **by construction**.
- **`v.a` needs no trailing dot.** LML's donor regex is `v\.a\.`, but `is_compilation_artist` accepts the dotless form: `v.a`, `v.a - jazz`, `v.a 1998` are arbiter-positive and donor-net-negative. Widened to `v[./]\s*a\.?` here and in LML#1139's purge; the two are meant to stay in lockstep.

`album_metadata` carries no artist column, so its net reaches one via `library.artist_name` falling back to the `artists` join.

The arbiter deliberately **disagrees** with all three V/A predicates already in this repo — two do a substring scan (sweeping up `Various Production`, `The Various`), and `jobs/library-etl/job.ts` classifies `Various Artists-Rock-Y` as _not_ various. None is the predicate LML#1139's guard keys on. Hence the distinct filename/export (`isVariousArtistsCredit`, not a third `compilation.ts`).

**Documented residual:** the net keys on `flowsheet.artist_name` (what BS passed to LML), whereas the guard fired on `row_artist` (the resolved library row's artist). These agree for the overwhelming majority of V/A rows; a row whose `artist_name` is non-V/A while its library row was V/A is outside this net.

## Adjudication: three outcomes, never two

| Verdict         | Condition                                                                         | Action                            |
| --------------- | --------------------------------------------------------------------------------- | --------------------------------- |
| `url`           | `results[0].artwork.apple_music_url` non-empty                                    | write it (may differ from stored) |
| `none`          | ≥1 result, no Apple URL, **on three consecutive passes**                          | write NULL                        |
| `indeterminate` | thrown error, shed outcome, `skipped_discogs_unavailable`, or **empty `results`** | write nothing, retryable          |

"LML returned no Apple URL" is far weaker evidence than it looks, and treating it as a no-match is how this job would destroy the data it protects:

- **LML#904:** at the default `LML_APPLE_MUSIC_RATE_PER_MIN=60`, ~**56%** of `find_track_url` probes time out on LML's _own_ self-throttle and return null — zero 429s, the wait is acquire-time.
- **LML#706:** the streaming post-process is eventually consistent, so a first lookup can legitimately return null. That is the entire premise of the BS#1631 sibling.
- A shed, open breaker, or BS#1293 skip all produce a well-formed response with no URL.

Same doctrine as **BS#1915** (`enrich.ts:272-286`): "null is load-bearing … instead of silently freezing a transient null." `album_metadata` buys that guarantee structurally with `apple_music_status`; `flowsheet` has no such column, so this job buys it procedurally — three-pass confirmation plus the rescue-rate abort.

**Failure policy is skip-and-account, never halt-in-place.** An `indeterminate` triple is counted, logged, and the page continues; the run exits non-zero at the _end_ with the list. Halting at the page boundary would wedge: re-running re-selects the same page, re-hits the same triple, halts again — and it is the _expected_ case, since a genuinely unfindable compilation returns empty results forever (the BS#1011 shape; see also the infinite-loop pitfall in `docs/bulk-update-playbook.md`).

## The throttle gate

At LML#904's default regime, three passes still wrongly null a correct link ~18% of the time. Two mitigations, both required:

1. **Raise `LML_APPLE_MUSIC_RATE_PER_MIN` first** (60 → 300 → 600) via LML's `set-railway-var.yml`, and **confirm it took** — a bare var-set can return `SKIPPED` and leave the process untouched.
2. **The in-band rescue-rate detector** (`calibrate.ts`). A triple that nulls on pass 1 and returns a URL later is a _directly observed_ throttle-null. With three passes the rate is `p(1-p)(1+p)` — ≈0.38 at `p=0.56`, ≈0.05 at `p=0.05` — so a high rate is live proof that `none` verdicts are untrustworthy, and the run aborts.

A control cohort of _non-V/A_ rows was considered and rejected: LML#1139's purge is V/A-scoped, so non-V/A triples return from LML's untouched warm L1 without ever running the Apple probe (there is no cache-bypass on the lookup path), and the gate would read ≈0 no matter how throttled the probe was — a gate that always passes, which is worse than none.

## Write mechanics

- Batched VALUES-join UPDATE per page + `ANALYZE` after the write pass (`docs/bulk-update-playbook.md`). **No CI check covers this for a TS job** — `scripts/check-bulk-update-analyze.mjs` scans `.sql` only — so the pairing is pinned by a unit test.
- `flowsheet` UPDATE **omits `updated_at`**: trigger `bump_flowsheet_updated_at` (migration 0084) owns it. `album_metadata` sets it (writer convention).
- **Compare-and-set:** `AND t.apple_music_url IS NOT DISTINCT FROM v.old_url`. Unlike the fill-only siblings (which guard on `IS NULL`), this job overwrites a non-null value, and under cooperative pause a page can sit unwritten a long time. Two other writers touch the column — the hourly `flowsheet-metadata-backfill` and the long-running `apps/enrichment-worker`, the latter _not_ covered by the "sibling crons Exited" pre-flight. Rejects are reported as `skipped_changed_under_us`.
- Not `DB_SYNCHRONOUS_COMMIT=off`, unlike the BS#1715 donor: a re-verified row stays in the candidate net whether or not its write landed, so a lost write is invisible to any re-scan while the cursor has advanced past it. Durable commits are the cheaper side of that trade.
- Id-cursor resume: `VA_REMEDIATION_FLOWSHEET_AFTER_ID` / `VA_REMEDIATION_ALBUM_AFTER_ID`, advancing only after a page's write commits.

**Re-running is a full re-adjudication, not a cheap no-op.** A remediated row stays net-matched (still V/A, still non-null), so "adjudicated" is not recorded at rest. That is precisely why the cursors exist. Verification is run-internal: `scanned == written_url + written_null + skipped_changed_under_us` with `indeterminate == 0`.

## Downstream interaction

Every row this job NULLs on `flowsheet` becomes a candidate for `jobs/apple-music-url-backfill` (BS#1631), whose net is `apple_music_url IS NULL AND (discogs_url IS NOT NULL OR l.on_streaming = true)`. That job is a completed one-shot, not a cron, so nothing fires automatically — but **do not re-run BS#1631 against the V/A cohort after this job runs**, or it will re-spend the budget and re-open the surface if the guard ever regresses.

## Environment

Reuses the `BACKFILL_LML_*` family (`docs/env-vars.md`) and inherits its pre-flight rule: **verify the sibling cron containers are Exited** before running. Job-specific knobs: `VA_REMEDIATION_BATCH_SIZE`, `_FLOWSHEET_AFTER_ID`, `_ALBUM_AFTER_ID`, `_UPDATE_TIMEOUT_MS`, `_ANALYZE_TIMEOUT_MS`, `_SECOND_PASS_DELAY_MS`, `_MAX_RESCUE_RATE`, `_MIN_RESCUE_SAMPLE`, `_MAX_INDETERMINATE`. Cooperative pause via the shared `LIVE_ACTIVITY_*`.

## Run procedure

1. LML#1139's guard **and** its track-cache purge deployed. Record the LML deploy SHA.
2. `LML_APPLE_MUSIC_RATE_PER_MIN` rolled up and **confirmed live**.
3. Gates: diff the merged guard predicate against `va-artist.ts`; assert the response shape for a known-polluted triple (non-empty `results`, null `artwork.apple_music_url` — the contract `verdict.ts` is written against); confirm LML's null-rate in Sentry.
4. Verify the auto-deploy pushed the image (merging already builds it); `deploy-manual.yml` only if not.
5. Run the SELECT COUNT above, then dry-run for the candidate + distinct-triple counts. Free.
6. Pre-flight: sibling crons Exited, off-peak window.
7. `--execute`. Record on the issue: candidate count, distinct triples, `url`/`none`/`indeterminate` split, rescue rate, `skipped_changed_under_us`, LML deploy SHA.

```bash
docker run --rm --name va-apple-music-url-remediation --env-file .env \
  <ECR-URI>/va-apple-music-url-remediation:<tag>            # dry-run
docker run --rm --name va-apple-music-url-remediation --env-file .env \
  <ECR-URI>/va-apple-music-url-remediation:<tag> --execute  # writes
```

## Run result

_Not yet run — pending LML#1139 deploy + purge. Record counts here._
