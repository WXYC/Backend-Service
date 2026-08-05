# BS#2000 — remediate V/A Apple-Music-URL rows persisted by the pre-LML#1139 matcher

Issue: https://github.com/WXYC/Backend-Service/issues/2000
Blocked by: https://github.com/WXYC/library-metadata-lookup/issues/1139 (guard **and** `track_streaming_url_cache` purge must be deployed first)
Branch: `bugfix/issue-2000` (worktree `Backend-Service-worktrees/bs-2000-va-apple-remediation`, off `origin/main` @ 004ef2fc)

> **Revision 6** — five rounds of plan review, each finding verified against the codebase before folding in. Rev 2 fixed an unregistered LML caller and a single-pass `none`; rev 3 replaced a wedge-prone halt rule and surfaced LML#904 (~56% of LML's Apple track probes already time out on LML's own self-throttle); rev 4 fixed a candidate net that could not reach the rows its own arbiter was written for; rev 5 replaced a hand-rolled fold with the shipped `foldArtistName`, discarded an unworkable control-cohort gate, and added a compare-and-set to the overwrite; rev 6 records an **open scope question** (below) that the issue body gets wrong, and moves the net/arbiter pin to the integration tier.

## Problem

LML's pre-#1139 Apple **track** matcher had no V/A awareness on the artist axis: the constant `Various Artists - ` prefix alone scores ~85 between any two V/A credits, over the 80 floor. The dominant path was the LML#782 album-dropped fallback re-admitting a winner on vacuous-artist + generic-track-title. Those wrong deep-links were returned to BS enrichment and **persisted**. BS persistence is fill-only and `enriched_match` rows are never revisited, so the pollution is permanent without a data fix. The 30d telemetry measured 18 FP occurrences across 2 pair classes, but the pattern has operated since #782 shipped, so the polluted total exceeds that sample.

LML#1139 fixes the matcher and purges LML's own L1 cache. This is the BS half.

## OPEN SCOPE QUESTION — `album_metadata` (rev 6, needs a decision before `--execute`)

**The issue body's scope rule is wrong, and following it would make the job largely ineffective for linked rows.** It says:

> `album_metadata` is filled from album-level lookups (album path) — not implicated. Do not touch it.

That conflates the album **matcher** with the `album_metadata` **table**. Verified in this repo:

- `apps/backend/services/flowsheet.service.ts:243` projects `apple_music_url: coalesce(album_metadata.apple_music_url, flowsheet.apple_music_url)` — **`album_metadata` wins**.
- `apps/enrichment-worker/enrich.ts:285` (and the conflict branch at `:348`) writes `album_metadata.apple_music_url` from `artwork.apple_music_url` — the **same track-aware Apple probe** this issue is about.
- `enrich.ts:557` labels the inline `flowsheet` write "Unlinked + match: write the 10 columns inline on flowsheet" — i.e. the flowsheet column is the **unlinked-only** path.

So for a **linked** V/A row (`album_id IS NOT NULL`), the polluted, DJ-visible URL lives in `album_metadata`, and a flowsheet-only `--execute` would leave what users actually see unchanged. The zero-V/A-false-positives evidence the issue cites for the album path is about `find_best_source_match` (the 5-service album matcher) — it does not extend to this table.

Two defensible resolutions; **this is the ticket owner's call, not the implementer's**:

- **(A) Widen scope to `album_metadata.apple_music_url`.** Fixes what users see. Note the write shape genuinely differs: `album_metadata` carries an `apple_music_status` sibling (`shared/database/src/schema.ts:1403`) that `flowsheet` lacks, so a NULL there must also set the status rather than "silently freezing a transient null" — the explicit BS#1915 doctrine documented at `enrich.ts:272-286`, which is the same hazard this plan's three-pass rule fights, arrived at independently.
- **(B) Keep flowsheet-only, and restrict the net to `album_id IS NULL`.** Honest and narrow: remediate exactly the rows where the flowsheet column is the one being served, and file linked-row pollution as a follow-up. Strictly better than the issue's current wording, which remediates linked rows' flowsheet column to no visible effect.

What is _not_ defensible is the plan as written before rev 6: full-table flowsheet scope with `album_metadata` untouched, which spends the LML budget on linked rows and changes nothing a DJ sees. **Everything below is written for the flowsheet column; the `album_metadata` arm is additive if (A) is chosen.**

## Decision: option 1 (LML re-verify) — chosen

The issue leaves the remediation arm open. **Option 1.** Wrong and correct V/A URLs are indistinguishable at rest (the row doesn't record which pass won), so the choice is re-adjudicate-via-LML vs destroy-them-all.

Why option 1 over blanket-null:

- Blanket-null destroys the correct album-cleared V/A links, and flowsheet nulls are **terminal** — the enrichment worker never revisits `enriched_match` rows, so those links are gone for good.
- The LML cost is bounded by **DISTINCT `(artist_name, album_title, track_title)`**, not row count. The FP pattern is repeat plays of the same compilations, so the fan-out collapses hard: one lookup fans to every row carrying that triple. The BS#1631 donor already caches on exactly this key (per BS#1192, Apple URLs are track-aware).
- Each re-verify re-warms LML's just-purged L1 cache with a _correct_ value, so the purge's recall cost is partly repaid by this job rather than by DJs on air.

Cost model, stated honestly: post-purge the probes are cold (~4.8 s each). With the `BACKFILL_LML_*` defaults (`Sem(1)` + `TokenBucket(20/min)`) throughput is latency-bound at ~12 lookups/min, and the multi-pass rule roughly doubles-to-triples wall clock for triples that miss on the first pass. 1,000 triples ≈ 2–4 h; 10,000 ≈ 20–40 h. Note the BS#1995 unit mismatch at `docs/env-vars.md:194`: this bucket counts **LML lookups**, not the Discogs calls they fan out into (~2.5× measured on prod), so effective Discogs egress is ~30/min at the default — do not "raise it toward 50". The dry-run reports the distinct-triple count **before** any spend, so the operator can bail to option 2 if the number is absurd. The README records the decision and the run result (AC).

## Candidate net

Coarse SQL net + pure TS arbiter (the BS#1715 idiom), erring **broad**, since over-selection costs one wasted re-verify (which simply re-confirms the row) while under-selection leaves polluted rows behind:

```sql
-- Run this SELECT before any UPDATE (org data-safety rule). Same predicate the job uses.
SELECT COUNT(*) FROM wxyc_schema.flowsheet
WHERE apple_music_url IS NOT NULL
  AND wxyc_schema.fold_artist_name(artist_name) ~ '(various|soundtrack|compilation|v[./]\s*a\.?)';
```

Two corrections that were silently breaking this net:

**(a) The fold has to happen in SQL, or the arbiter's normalization is dead code.** Rev 3 used `lower(artist_name)` — but `lower('Vàrious Artists')` matches none of the alternatives, so every diacritic-bearing V/A row was filtered out _before_ the normalized TS arbiter saw it, and the `Vàrious Artists → true` pin would pass in unit tests while the row it represents was never selected. `wxyc_schema.fold_artist_name(text)` already ships (migration `0134_fold-artist-name.sql`, `IMMUTABLE PARALLEL SAFE`): `lower(regexp_replace(normalize(x, NFD), '[̀-ͯ]', '', 'g'))`. Used in the phase COUNT, the paged SELECT, and the UPDATE so all three agree.

**(b) The `v.a` alternative must lose its mandatory trailing dot.** LML's donor net (`scripts/audit_va_writeback_pollution.py:31`) writes `v\.a\.`, but `is_compilation_artist` accepts the dotless form — measured: `v.a`, `v.a - jazz`, `v.a 1998` are all arbiter-**True** and donor-net-**False**. `v[./]\s*a\.?` catches all of them. LML#1139's purge takes the identical widening; the two nets stay in lockstep.

(Rev 2 also wrapped the column in `btrim`, crediting it with tolerating leading whitespace — wrong; the regex is unanchored, so surrounding whitespace never affected the match. Dropped.)

**Cost note:** `flowsheet_artist_name_trgm_idx` (migration 0042) is a `gin_trgm_ops` GIN on the **raw** column, so `fold_artist_name(...)` makes this a deliberate seq scan of `flowsheet`. The right trade — an index-eligible `artist_name ~* '…'` reintroduces problem (a) — but a real cost on a ~1.9M-row table, stated in the README rather than discovered during the run.

### The arbiter

`va-artist.ts` mirrors **wxyc-etl's `is_compilation_artist`** — leading-anchored prefixes (`various artists`, `v/a`, `v.a`, `soundtracks`) terminated by end-of-string or a non-alphanumeric char, plus exact-only names (`various`, `soundtrack`, `compilation`) — layered on a **shared fold**.

**It does not roll its own normalizer.** Earlier revisions specified hand-written NFKC (then NFKD) + `\p{M}`. Both were wrong: NFKC is a _composing_ form so `\p{M}` finds nothing to strip (`'Vàrious Artists'.normalize('NFKC').replace(/\p{M}/gu,'')` → `"vàrious artists"`, verified), and NFKD is strictly _broader_ than the SQL fold, reopening the very net/arbiter gap (a) closes. `@wxyc/database` already exports **`foldArtistName`** (`shared/database/src/fold-artist-name.ts`, exported at `index.ts:11`, contract-pinned by `tests/unit/database/fold-artist-name.test.ts`) — a deliberately byte-identical TS twin of the SQL function, written for BS#1897 with a "MUST stay byte-identical" contract and its own drift test. The arbiter imports it, so net and arbiter share **one** fold by construction rather than by assertion.

The unit mock needs the re-export added, matching the pure-module-path pattern at `tests/mocks/database.mock.ts:501` (which deliberately points at `env-parsers.js`, not the barrel, so the mock never pulls in `client.js`):
`export { foldArtistName } from '../../shared/database/src/fold-artist-name.js';`

> **Deliberately NOT reusing the existing V/A predicates.** Three exist in this repo and **all three disagree with wxyc-etl**:
>
> - `jobs/artist-search-alias-consumer/compilation.ts` and `apps/backend/services/requestLine/matching/compilation.ts` do a **substring** scan (`artistLower.includes('various')`) — the convention wxyc-etl 0.5.0 tightened away from, which sweeps up real artists (`Various Production`, `The Soundtrack of Our Lives`).
> - `jobs/library-etl/job.ts:79-88` — writer of the `artists`/`library` V/A credits these flowsheet values are copied from — special-cases `/^various\s*artists\s*-rock\s*-[a-z]$/i` to `isVarious: false`, the opposite of wxyc-etl's pinned `("Various Artists-Rock-Y", true)`.
>
> **Naming:** the new file is `va-artist.ts` exporting `isVariousArtistsCredit`, **not** a third `compilation.ts` / `isCompilationArtist`. The two substring copies carry an explicit "keep in lockstep — both files must agree on the keyword set" header; a same-named, same-signature file whose purpose is to _disagree_ would invite exactly the lockstep-reconciliation edit this job must not receive. Its header points at all three as what it is deliberately not. (Reconciling them is out of scope — separate blast radius, separate ticket.)

**Documented residual:** the net keys on `flowsheet.artist_name` (what BS passed to LML), whereas LML's guard fired on `row_artist` (the resolved library row's artist). These agree for the overwhelming majority of WXYC V/A rows; a row whose `artist_name` is non-V/A while its resolved library row was V/A is outside this net. Recorded in the README rather than chased.

**Downstream interaction:** "flowsheet nulls are terminal" is true of the _enrichment worker_ but **not** of the sibling one-shot. `jobs/apple-music-url-backfill/orchestrate.ts:199-205` selects `entry_type='track' AND apple_music_url IS NULL AND (discogs_url IS NOT NULL OR l.on_streaming = true) AND artist_name IS NOT NULL` — so every row this job NULLs becomes a BS#1631 candidate. Not a blocker (BS#1631 is a completed one-shot, not a cron), but it goes in this job's README, `jobs/apple-music-url-backfill/README.md`, and that job's CLAUDE.md row: "do not re-run against the V/A cohort post-BS#2000."

## Job: `jobs/va-apple-music-url-remediation`

One-shot npm workspace, `job-type: one-shot` in package.json (`deploy-base.yml:661` → built + pushed to ECR, **not** crontab-registered). Donors: `jobs/streaming-url-remediation` (BS#1715 — skeleton, net/arbiter split, batched write, ANALYZE, cursor, SIGTERM) and `jobs/apple-music-url-backfill` (BS#1631 — LML re-query arm, limiter, per-triple URL cache, multi-pass rule).

```
jobs/va-apple-music-url-remediation/
  job.ts            entrypoint, signal handlers, dry-run resolve, exit code
  orchestrate.ts    paged scan → arbiter → triple dedupe → LML re-verify → batched write → ANALYZE
  va-artist.ts      leading-anchored V/A arbiter over the shared foldArtistName
  verdict.ts        pure: GatedLookupResponse → Verdict ('url' | 'none' | 'indeterminate')
  calibrate.ts      in-band throttle detector: rescue-rate tracking + abort (the LML#904 gate)
  lml-fetch.ts      lookupMetadata shim, extended:true, job-owned limiter, registered caller tag
  lml-limiter.ts    BACKFILL_LML_* family, Sem(1) + TokenBucket(20/min)
  env.ts, logger.ts vendored from the donors
  README.md         option-1 decision record, runbook, run result
  package.json, tsconfig.json, tsup.config.ts
Dockerfile.va-apple-music-url-remediation
tests/unit/jobs/va-apple-music-url-remediation/*.test.ts
tests/integration/va-apple-music-url-remediation-net.spec.js
```

Hard CI gates, not nice-to-haves:

- **Register the LML caller.** `'va-apple-music-url-remediation'` in `ALL_LML_CALLERS` **and** `CALLER_CLASS` (`shared/lml-client/src/policy.ts`, class **5**, beside `'apple-music-url-backfill'` at `:200`/`:265`). `scripts/check-lml-caller-classification.mjs` runs at `.github/workflows/test.yml:202` and hard-fails otherwise; `resolveLmlPolicy` also throws at runtime (`policy.ts:541-548`). Easy to miss because `jobs/**` is outside `npm run typecheck`.
- **CLAUDE.md** workspace-table row.
- **Root `npm install`** to sync `package-lock.json` — a new workspace without it fails CI `npm ci` on both lint-and-typecheck and unit-tests, and local checks pass anyway because the node_modules symlink hides it (bit BS#1491).
- **`docs/env-vars.md`**: a full entry for `VA_REMEDIATION_AFTER_ID`, `_BATCH_SIZE`, `_UPDATE_TIMEOUT_MS`, `_ANALYZE_TIMEOUT_MS`, `_SAMPLE_SIZE`, `_SECOND_PASS_DELAY_MS`, `_MAX_RESCUE_RATE`, `_MIN_RESCUE_SAMPLE`, `_MAX_INDETERMINATE`, plus the shared `LIVE_ACTIVITY_*` reuse and the LML rate-limit dependency. **Also update the `BACKFILL_LML_*` section header at `:189`**, which today reads "(`jobs/flowsheet-metadata-backfill`, `jobs/rotation-release-id-backfill`)" — `apple-music-url-backfill` already reuses the family without being listed, so that drift predates this plan; add both jobs so the "sibling cron container Exited" pre-flight is discoverable from the job the operator is running.

### Adjudication semantics

Per distinct `(artist_name, album_title, track_title)`, `lookupMetadata(artist, album, track, { extended: true })`; a **pure** `verdict.ts` classifies into three outcomes — never two:

| Verdict         | Condition                                                                           | Action on every row with that triple                                        |
| --------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `url`           | `results[0].artwork.apple_music_url` is a non-empty string                          | SET `apple_music_url` = that value (re-adjudicated; may differ from stored) |
| `none`          | ≥ 1 result and no Apple URL, **confirmed by three consecutive passes**              | SET `apple_music_url` = NULL                                                |
| `indeterminate` | thrown error, shed `outcome`, `skipped_discogs_unavailable`, **or empty `results`** | **no write** — retryable                                                    |

**Multi-pass before any NULL.** BS#1631 exists because LML returns a null `apple_music_url` on a _first_ lookup whenever its ~4 s Apple probe times out or LML#706's eventually-consistent post-process hasn't filled; the donor waits `SECOND_PASS_DELAY_MS` (15 s) and re-asks (`jobs/apple-music-url-backfill/orchestrate.ts:331-336`). A single-pass `none` would permanently null correct V/A links on a transient timeout — worse here than in the donor, where a false null merely left an already-null column. This job requires **three** consecutive nulls.

This is the same doctrine as **BS#1915**, documented at `apps/enrichment-worker/enrich.ts:272-286`: "Apple Music has NO fallback — null is load-bearing 'no verified iTunes match' (BS#1192), disambiguated by `apple_music_status` instead of silently freezing a transient null." That column-level disambiguation is exactly what `flowsheet` lacks — it has no `apple_music_status` sibling — which is why this job has to buy the same guarantee procedurally (three passes + the rescue-rate gate) instead of structurally. Scope note: adding status parity to `flowsheet` is out of scope here and is entangled with the open `album_metadata` question above.

**The `none` arm depends on a specific LML response shape — pin it, don't assume it.** It only works if a guard-struck V/A lookup returns **non-empty `results` with a null `artwork.apple_music_url`**. If LML#1139 instead returned an _empty_ `results`, every polluted row would classify `indeterminate`, nothing would be written, the max-indeterminate ceiling would abort, and the job would burn the full budget for nothing. By construction it is the former — the guard lives inside `_select_best_track_candidate`, which decides only the Apple _streaming probe_'s outcome, while `results` comes from the untouched library-search leg. Rollout step 3 asserts it against the deployed guard rather than inferring it.

The `indeterminate` arm is the rest of the safety story: collapsing it into `none` would let a transient shed, breaker-open, or Discogs-unavailable window mass-null correct URLs (the failure caught in PR #1894 review). Empty `results` is indeterminate too — "the library row wasn't found this time" is not evidence the stored URL is wrong.

Typing: `verdict.ts` takes **`GatedLookupResponse`** (`outcome` lives only there, `shared/lml-client/src/index.ts:903`), reads sheds via the exported `shedReasonOf` (`:942`), and checks `skipped_discogs_unavailable` (`:894`) explicitly. `lml-fetch.ts` widens its return to `GatedLookupResponse` — **not** because the donor's narrower declaration fails to compile (it doesn't; `GatedLookupResponse extends LookupResponse` and `lookupMetadata` already returns the wider type at `:1010`) but because declaring `LookupResponse` at the shim boundary **erases `outcome`**.

Reachability: for a **job-owned** limiter the shed arm cannot currently fire — `createLmlLimiter({ maxConcurrent, ratePerMinute })` passes neither `breaker` nor `queueWaitMs`, and `index.ts:447-477` only throws `LimiterShedError` when one is configured ("job limiters keep the unbounded shape"). The arm stays as a forward-compat pin; the risk section must not credit it as an active mitigation.

**Failure policy: skip-and-account, never halt-in-place.** Bounded retry (3 attempts, backoff) per triple; a triple still `indeterminate` is counted, logged with its `(artist, album, track)`, and the page **continues**. Rev 2's halt-at-page-boundary was an unrecoverable wedge: re-running from that cursor re-selects the same page, re-hits the same triple, halts again — and it is the _expected_ case, since a genuinely unfindable obscure V/A compilation returns empty `results` forever. That is the BS#1011 wedge shape (`jobs/flowsheet-metadata-backfill`'s work-list is explicitly built so a failing row can never be re-selected within a run) and the infinite-loop pitfall in `docs/bulk-update-playbook.md`. The AC is enforced at **run end** instead: non-zero exit with the full `indeterminate` list whenever that bucket is non-empty. `VA_REMEDIATION_MAX_INDETERMINATE` aborts early on systemic failure.

### The LML#904 throttle-null hazard, and how the job detects it

`docs/env-vars.md:56` (LML repo) records that at the default `LML_APPLE_MUSIC_RATE_PER_MIN=60` (1 req/s), **~56% of `find_track_url` probes time out at the 4 s ceiling and return null**, with **zero 429s** — the wait is LML's own acquire-time, not Apple's (raw GET ~338 ms). Multi-pass alone doesn't save the job: at `p≈0.56`, three passes still wrongly null a correct link ~18% of the time.

Two mitigations, both required:

1. **Raise the ceiling before the run** (shared with LML#1139's purge rollout): step `LML_APPLE_MUSIC_RATE_PER_MIN` 60 → 300 → 600 per LML#904's guidance, staying under the ~15 req/s semaphore ceiling.
2. **In-band detection**, since a BS-side control cohort cannot work. Rev 3/4 proposed sampling non-V/A rows and treating their null rate as ambient; review caught that LML#1139's purge is **V/A-scoped**, so non-V/A triples return from LML's _untouched, warm_ L1 without ever running the Apple probe (`LookupOptions` has no cache-bypass; `forceLookup` only overrides the BS#1293 gate). The measured rate would be ≈0 regardless of the throttle — a gate that always passes, worse than none. The V/A cohort is the only cold-by-construction population post-purge, and every member is also subject to the guard, so no within-run control group exists.

What replaces it — free byproducts of the multi-pass rule:

- **Rescue rate.** A triple that nulls on pass 1 and returns a URL on pass 2 _or_ 3 is a _directly observed_ throttle-null. With three passes the observed rate is `p(1−p)(1+p)` — ≈0.38 at `p=0.56`, ≈0.05 at `p=0.05`. (Rev 5 quoted the two-pass `p(1−p)` ≈0.25, which would have set the threshold ~50% low at the dangerous end.) Default `VA_REMEDIATION_MAX_RESCUE_RATE=0.10`, evaluated only after `VA_REMEDIATION_MIN_RESCUE_SAMPLE=50` first-pass nulls have accumulated so early noise can't trip it; exceeding it aborts before further writes.
- **Three-pass confirmation**, above.

The **environment gate proper lives in the runbook**, where it can actually be measured: LML#904's own prescribed verification is watching the 429-count + null-rate Sentry queries after each bump. That measurement lives on the LML side, where the probe is, and is a human gate recorded on the issue before `--execute` — not something this job can honestly self-certify from BS.

### Write mechanics

- Batched VALUES-join UPDATE per page (`docs/bulk-update-playbook.md`), `ANALYZE flowsheet` after the final batch. **Nothing in CI enforces this for a TS job** — `scripts/check-bulk-update-analyze.mjs` scans `.sql` files only (`:117`), and this job's UPDATE and ANALYZE are both TypeScript. Pinned by a unit test copying the donor's `tests/unit/jobs/streaming-url-remediation/orchestrate.test.ts:232`.
- The UPDATE **omits `updated_at`** — flowsheet's BEFORE UPDATE trigger `bump_flowsheet_updated_at` (migration 0084) owns that stamp.
- Surgical: same `apple_music_url IS NOT NULL` + folded-V/A predicate as the SELECT, plus `id = ANY(...)` from the arbitrated page. Sets `apple_music_url` and nothing else.
- **Optimistic concurrency.** The VALUES join carries the URL the page _read_, and the UPDATE adds `AND f.apple_music_url IS NOT DISTINCT FROM v.old_url`, counting mismatches as `skipped_changed_under_us`. Unlike the fill-only siblings (`jobs/apple-music-url-backfill/resolve.ts:67` guards on `isNull`), this job **overwrites a non-null value**, so it needs the compare-and-set they get for free. The window is real: under cooperative pause a page can sit unwritten for a long time, and two other writers touch this column — the hourly `jobs/flowsheet-metadata-backfill/enrich.ts:318` and `apps/enrichment-worker`, the latter _not_ covered by the "sibling cron containers Exited" pre-flight (it is a long-running consumer, not a cron).
- Id-cursor resume via `VA_REMEDIATION_AFTER_ID`, advancing only after a page's write commits. Resolved with `@wxyc/database`'s `requireNonNegativeInt` (as `jobs/streaming-url-remediation/orchestrate.ts:191-208` does), **not** the donor's `envInt`, which requires `parsed > 0` and would silently reject `=0` ("start at the beginning"). Batch size and timeouts use `requirePositiveInt`; `envInt` is kept only for the LML per-call timeout.
- Cooperative pause via shared `checkLiveActivity`; SIGTERM/SIGINT flips a cooperative-stop flag, the in-flight batch finishes, a `stopped` log carries the resume cursor.
- Dry-run is the **default**; `--execute` writes. Dry-run does the full scan + arbitration + dedupe and reports counts and a sample, with **zero writes and zero LML calls** — sizing is free. (Rev 4's calibration pass spent ~17 min of LML traffic on a dry-run; the rev-5 in-band detector is a byproduct of the main pass, so there is nothing extra to spend.)

### Why post-run verification is run-internal, not a net re-count

Unlike BS#1715 — where a fixed row drops out of its net — a re-verified row here **stays in the net** (still V/A, still non-null). "Adjudicated" is not recorded at rest and this job adds no column for it. Verification is therefore `scanned == written_url + written_null + skipped_changed_under_us` with `indeterminate == 0`, asserted at run end. Corollary for the README: a re-run is a **full re-adjudication**, not a cheap idempotent no-op — which is why the id-cursor exists.

## Test plan (TDD)

`tests/unit/jobs/va-apple-music-url-remediation/`:

- `va-artist.test.ts` — the arbiter matrix mirroring wxyc-etl's cases: `Various Artists`, `Various`, `VARIOUS`, `Various Artists-Rock-Y`, `V/A`, `V.A.`, `Soundtrack(s)`, `Compilation` → true; `The Soundtrack of Our Lives`, `The Various`, `Various Production`, `Stereolab`, `Juana Molina`, `""`, null/undefined → false. Plus fold pins (`  Various Artists`, `Various  Artists - Blues`, `Vàrious Artists` → true) and explicit pins that it **disagrees** with the substring copies on `Various Production` and with `jobs/library-etl/job.ts` on `Various Artists-Rock-Y`.
- `verdict.test.ts` — URL present → `url`; three-pass-confirmed absence → `none`; a URL on pass 2 or 3 → `url` + rescue counter; empty `results` → `indeterminate`; `skipped_discogs_unavailable` → `indeterminate`; empty-string URL → treated as absent. Shed cases → `indeterminate`, labelled **forward-compat pins** (unreachable through a job-owned limiter today).
- `calibrate.test.ts` — rescue rate at/below `MAX_RESCUE_RATE` proceeds; above it aborts before further writes; not evaluated until `MIN_RESCUE_SAMPLE` is reached.
- `orchestrate.test.ts` — injected LML + write seams (donor pattern, no db mock on the write path): triple dedupe fans one lookup to N rows; dry-run writes nothing and makes no LML call; an `indeterminate` triple after retries is **skipped, the page continues**, and the run exits non-zero at the end with it listed (the anti-wedge regression — pins that the same page is not re-selected); `MAX_INDETERMINATE` aborts early; `none` nulls; `url` overwrites; the compare-and-set skips a row changed under us; the arbiter rejects a coarse-net row (`Various Production`) so it is never written; ANALYZE runs after the final batch.
- `resolveDryRun` contradictory-flags pin; `VA_REMEDIATION_AFTER_ID=0` resolves to 0, not the fallback.

`tests/integration/va-apple-music-url-remediation-net.spec.js` — **the net/arbiter superset pin must live here, not in the unit tier.** `jest.unit.config.ts:20` maps `^@wxyc/database$` to `tests/mocks/database.mock.ts`, so there is no Postgres: neither `wxyc_schema.fold_artist_name` nor PG's `~` operator is evaluated, and a JS re-implementation of the regex would pin the TS twin against itself — exactly the drift class the pin exists to prevent. Against a real DB, assert that rows with `Vàrious Artists`, `v.a`, `v.a - jazz` (all arbiter-positive) are **selected by the SQL net**. Precedent: `tests/integration/library-etl-artist-fold-match.spec.js` and `tests/integration/artist-unicode-dedup.spec.js` both exercise the real `fold_artist_name`.

`npm run test:unit` + `test:integration` + `typecheck` + `lint` + `format:check` locally, plus `npm run ci:testmock` per the pre-push rule. Because `typecheck` skips `jobs/**`, also run `tsc --noEmit` against the job's tsconfig.

## Rollout

1. Merge LML#1139; deploy guard + run its purge (`--execute`, staged) on prod. Record the LML deploy SHA.
2. **Raise `LML_APPLE_MUSIC_RATE_PER_MIN`** 60 → 300 → 600 via the sanctioned `set-railway-var.yml` (it waits for the redeploy and health-probes) and confirm the new rate is live — a bare var-set can return `SKIPPED` and leave the process untouched (`docs/env-vars.md:65`). Leave it raised through this job's run; restore after.
3. **Three gates, all against the deployed guard, not the plan:**
   a. Diff the merged LML#1139 guard predicate against `va-artist.ts` — same fold, same leading-anchored rule.
   b. Assert the **response shape** for a known-polluted triple: non-empty `results`, null `artwork.apple_music_url`. Record it in the README.
   c. Confirm the LML#904 null-rate is acceptable in LML's Sentry after step 2 — the human environment gate.
4. Merge this PR and **verify the auto-deploy pushed the image** (`deploy-base.yml:98-111` detects affected targets via Turborepo, so merging already builds and pushes). Use `deploy-manual.yml` only if it didn't.
5. SSH prod, run the SELECT COUNT above; then `docker run …` (dry-run) for candidate + distinct-triple counts. Free.
6. Pre-flight: sibling LML cron containers Exited; note `apps/enrichment-worker` keeps running (that is what the compare-and-set is for); off-peak window; cooperative pause defers around live DJs.
7. `--execute`. Record on the issue: candidate count, distinct triples, `url`/`none`/`indeterminate` split, rescue rate, `skipped_changed_under_us`, and the LML deploy SHA (AC).
8. README gets the run result; add the "do not re-run BS#1631 against the V/A cohort" note to the three places listed above.

## Risks

- **Wrong column remediated** — the open scope question above. Until it is resolved, a flowsheet-only run may not change what any DJ sees on linked rows. Highest-priority item; blocks `--execute`, not implementation.
- **Throttle-null destruction** — LML#904's ambient null rate makes `none` untrustworthy at the default ceiling. Mitigated by the verified rate-limit roll-up, three-pass confirmation, and the in-band rescue-rate abort. Rev 4's control cohort is **not** among the mitigations — it would have read a warm cache and passed vacuously.
- **Deploy-order violation** — re-verifying against the unguarded matcher re-persists the wrong URLs; against a guarded matcher with an unpurged cache, the wrong URL returns from L1. Mitigated by the blocked-by dependency, the README gate, step 3, and recording the LML SHA.
- **Cost surprise** — dry-run reports distinct triples before any spend; fall back to option 2 if absurd.
- **Coarse-net over-match** — the SQL superset is broader than the leading-anchored rule; the arbiter narrows it back. A row failing the arbiter is scanned and skipped, never written.
- **Nulled rows re-enter BS#1631's net** — documented in three places rather than fixed in code.
- **Re-runs are expensive** — accepted; the cursor is the mitigation.
- _Not_ a mitigation: `verdict.ts`'s shed arm. It cannot fire through a job-owned limiter; forward-compat pin only.
