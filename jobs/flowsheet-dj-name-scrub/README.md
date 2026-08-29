# flowsheet-dj-name-scrub

One-shot scrub of historical `flowsheet.dj_name` — and the marker `message` text that embeds it — to the current PII-safe resolution policy. **Dry-run by default; `--execute` to write.** (BS#2281)

## Why this exists

`flowsheet.dj_name` is a denormalized snapshot written at play time. The write path has been correct since `2a37bbc6` (2026-06-08 21:05 PDT), but snapshots frozen under two superseded policies are still in the table, still served raw by every public flowsheet endpoint, and — through `GET /flowsheet/search` — still _matchable_:

- **Cohort A — the `auth_user.name` era.** Between `a0cd1979` (2025-12-30) and `2a37bbc6`, every `dj_name` writer fell back to better-auth `auth_user.name`, which dj-site's admin provisioning fills with the DJ's real name (`name: newAccount.realName || newAccount.username`).
- **Cohort B — the tubafrenzy `DJ_NAME` era.** The 2026-04-27 backfill behind migration 0053 froze `COALESCE(u.dj_name, s.legacy_dj_name, u.name)` onto ~2.6M rows at a time when `legacy_dj_name` was being loaded from tubafrenzy's `DJ_NAME` (full real name) rather than `DJ_HANDLE`.

`search_doc` carries `dj_name` at weight B and `buildDjNameMatch` ILIKEs the column, so this is not only a display leak — a real name is a working search key on a public, unauthenticated endpoint.

**Cohort C is deliberately out of scope**: real names DJs themselves typed into tubafrenzy's free-text `DJ_HANDLE` field. That is a policy question, not a correctness bug, and it is tracked separately. **Sampling after this job will still show name-shaped residue. That is expected, not a failed run.**

## What it does not do, and why the last attempt did not close this

`jobs/legacy-dj-name-remediation` (BS#1393, June 2026) aimed at the same problem and under-remediated in two independent ways. Both are worth knowing before reading this job's counts:

1. **Entry-type scope.** All four of its query sites filtered `entry_type IN ('show_start','show_end','dj_join','dj_leave')`. `GET /flowsheet/search` serves `entry_type = 'track'`. The remediated set and the searchable set were disjoint.
2. **`WHERE dj_name IS NULL`.** Its live UPDATE only filled NULLs, so **a row already holding a polluted value was never corrected**. Its reported "124,031 marker rows re-resolved" counts rows filled from NULL, not rows cleaned.

This job's idempotency therefore comes from comparing against the **recomputed** value (`IS DISTINCT FROM`), never from `IS NULL`.

## ⛔ Two jobs would reverse this scrub

This job deliberately **creates** `dj_name IS NULL` rows. Two one-shot jobs exist whose entire purpose is filling exactly those NULLs from the `shows` join:

| Job                               | Predicate                                   |
| --------------------------------- | ------------------------------------------- |
| `jobs/legacy-dj-name-remediation` | `entry_type IN (...) AND f.dj_name IS NULL` |
| `jobs/flowsheet-dj-name-backfill` | `WHERE dj_name IS NULL`                     |

Running either **after** this scrub silently re-attributes those rows to the primary DJ and undoes the privacy fix. Their root Dockerfiles have been removed so `Manual Build & Deploy` cannot produce an image, and `tests/unit/jobs/flowsheet-dj-name-scrub/reversal-guard.test.ts` fails if one is restored without a deliberate decision. Do not restore one because this document calls BS#1393 "under-remediated" — re-running it cleans nothing and reverses this job.

## The three intentional-NULL classes

A `NULL dj_name` after this run is the fix, not a regression. Do not "repair" these:

1. **PII-nulled `dj_join` / `dj_leave` markers.** The joining guest's identity is not recoverable from `shows` — that row joins through `shows.primary_dj_id`, which is a _different DJ_. Restoring attribution is out of scope; removing PII is not. These rows get an exact-equality probe against the `auth_user` real-name index and are nulled on a hit. **Attribution loss is accepted and counted.**
2. **Orphan rows (`show_id IS NULL`, or DANGLING — a `show_id` set but pointing at no `shows` row that exists).** No shows join is possible for either shape, so there is nothing to recompute from. Same probe, same outcome. See "Known limits" below for why this probe is weakest on exactly this cohort.
3. **Rows whose canonical chain genuinely resolves to nothing** — no override, no usable handle, no legacy handle. `resolveShowDjName` returns `null` and so does this job.

`verifyComplete`'s predicate is **deliberately inverted** relative to `jobs/flowsheet-dj-name-backfill`'s, which asserts _zero_ rows with `dj_name IS NULL`. Copying that predicate here would guarantee a false failure. Migration 0054's matching guard was already removed (`0054:3-4`), so nothing downstream depends on the old invariant.

## Design in one line

Page rows out, compute the expected value **in TypeScript** with the canonical `@wxyc/database` helpers (`resolveShowDjName` / `resolveDjDisplayName` / `showDjNameOverride`), write back only what differs. Parity with the serving path is by construction — there is no second copy of the chain to drift. `shared/database/src/dj-name.ts:1-13` records why re-deriving the chain in SQL is the documented anti-pattern; a scrub that exists to remove a helper-vs-data divergence must not reintroduce it in its own implementation.

### Scope is per entry type — this is load-bearing

| `entry_type`                                   | Reconciled against                                      | Action                                                        |
| ---------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `track`                                        | `resolveDjNameForShow` → `resolveShowDjName`            | Recompute                                                     |
| `show_end`                                     | same (BS#2068)                                          | Recompute                                                     |
| `show_start`, `primary_dj_id IS NOT NULL`      | `startShow` — override → handle, **no legacy fallback** | Recompute against _that_ chain                                |
| `show_start`, `primary_dj_id IS NULL` (legacy) | `jobs/flowsheet-etl` (tubafrenzy codes 1 and 9)         | Recompute via the shows chain                                 |
| `dj_join` / `dj_leave`                         | —                                                       | **PII-null probe only.** Never recomputed from the shows join |
| `talkset`, `breakpoint`, `message`             | —                                                       | **Never touched, under any pass**                             |

The `show_start` split is not a refinement. Applying `startShow`'s no-legacy chain to the legacy cohort resolves `null` for every one of those rows, because those shows have no `primary_dj_id` and therefore no user row to read — wiping what migration 0053 wrote. `flowsheet.service.ts:1219-1222` documents that exact outcome as the bug BS#2068 fixed on `show_end`: _"the old form resolved `null` for the ENTIRE legacy cohort (2,813 of production's 2,814 open shows on 2026-08-21)"_.

The `talkset` / `breakpoint` / `message` exclusion is the single most dangerous failure mode in the job: those rows are deliberately NULL, and under a bare `IS DISTINCT FROM <shows chain>` every one becomes a candidate and gets **newly populated** — a PII scrub that invents DJ names on rows that never had one.

### The `message` pass

`message` is client-facing and `startShow` / `endShow` embed the resolved name in it, so scrubbing `dj_name` alone leaves the real name rendered. Rewrites are anchored on the writers' own templates and the candidate name is extracted _positionally_, then compared with exact equality — a message that does not match a known template is left alone rather than guessed at.

| `entry_type` | Rewritten to          | New corpus shape?                                                 |
| ------------ | --------------------- | ----------------------------------------------------------------- |
| `show_start` | `Start of show: ${t}` | No — `startShow` already emits this when the name is unresolvable |
| `show_end`   | `End of show: ${t}`   | No — `endShow` already emits this                                 |
| `dj_join`    | `DJ joined the set!`  | **Yes**                                                           |
| `dj_leave`   | `DJ left the set!`    | **Yes**                                                           |

`dj_join` / `dj_leave` have no existing nameless form — those writers _suppress the row entirely_ rather than degrade it — so any rewrite is by definition new to the stored corpus. Deleting the rows is not on the table: they are real events. The chosen wording matches the fallback `WXYC/website`'s `describeNonTrackEntry` (`lib/flowsheetRange.js:320-326`) already renders for a null `dj_name`, so it is new to the corpus but not new to what _that_ reader sees. **Scope that claim honestly: it is verified for the website only. The iOS and Android clients render their own fallbacks and were not checked.**

**Deliberately NOT re-rendered here: `show_start` / `show_end` PII rows degrade to the nameless wording above, even though the correct handle IS available from the same `shows` join the main pass just used for that row.** Unlike `dj_join`/`dj_leave` (the guest's identity genuinely is not recoverable from `shows` — it belongs to a different DJ), re-rendering `Start of Show: ${recomputedHandle} joined the set at ${t}` here would preserve attribution instead of discarding it. Deferred on purpose: it widens this pass from "remove PII" to "restore attribution", it needs the main pass's recomputed value threaded into a pass with its own separate cursor and query, and rewording client-facing prose deserves its own review rather than riding in on a privacy scrub. Tracked as a follow-up issue (see "Related issues" below).

## Known limits

- **The orphan-pass PII probe is weakest on exactly the cohort most likely to need it.** The exact-equality probe against the `auth_user` real-name index is sound for `dj_join`/`dj_leave` — those values provably originated in `auth_user`. It is NOT sound for orphan rows: `schema.ts:1084` describes `show_id IS NULL` rows as pre-dating `shows` entirely, i.e. the legacy cohort — the population LEAST likely to have an `auth_user` row and MOST likely to hold a bare tubafrenzy real name the index can never contain. So the orphan pass will likely find almost nothing on exactly the rows most likely to be polluted. This is a documented limit, not a bug to widen here — widening the probe to catch it would mean matching on something other than roster membership, which is Cohort C (see above) and out of scope. **Read `orphan.scanned` vs `orphan.changed` in the run summary accordingly**: a near-zero `changed` count against a non-trivial `scanned` count is the probe finding nothing, not evidence the orphan cohort is clean.
- **`shows.legacy_dj_name` being clean is asserted, not independently proven — this job checks it, but does not fix it.** The recompute TRUSTS `legacy_dj_name` on the strength of BS#1393's rewrite from tubafrenzy `DJ_NAME` (real name) to `DJ_HANDLE` (on-air handle). If that rewrite is wrong for any subset of shows, this job actively WRITES real names onto every in-scope row of those shows, because `resolveShowDjName` reads `legacy_dj_name` as a direct chain input with no PII check of its own — unlike `dj_name`/`message`, which this job probes explicitly. See "shows.legacy_dj_name pre-flight" below.

## Related issues

- [WXYC/Backend-Service#2312](https://github.com/WXYC/Backend-Service/issues/2312) — re-render the `show_start`/`show_end` message templates around the recomputed handle instead of degrading them to the nameless form, closing the attribution loss the "Known limits" section above accepts.
- [WXYC/Backend-Service#2313](https://github.com/WXYC/Backend-Service/issues/2313) — convert `jobs/flowsheet-etl/job.ts:121` and `apps/backend/routes/internal.route.ts:195` from a re-derived `COALESCE` to the canonical `@wxyc/database` helper — see "Verification" below for why this job's divergence check is bounded on exactly these two writers.

## Run procedure

```bash
# Build: Manual Build & Deploy with target=flowsheet-dj-name-scrub, then on EC2:

# 1. Dry run. Writes nothing. Read the per-pass counts before going further.
docker run --rm --name flowsheet-dj-name-scrub --env-file .env \
  <ECR-URI>/flowsheet-dj-name-scrub:<tag> 2>&1 | tee scrub-dry.log

# 2. Live run.
docker run --rm --name flowsheet-dj-name-scrub --env-file .env \
  <ECR-URI>/flowsheet-dj-name-scrub:<tag> --execute 2>&1 | tee scrub-live.log
```

`--execute` and `--dry-run` together is a hard error, not a precedence puzzle.

### Before the first live run

- [ ] **The SSE fan-out guard is deployed.** `filterMetadataUpdate` broadcasts on _any_ flowsheet UPDATE landing in a terminal `metadata_status`, and historical `track` rows are almost all terminal. Without an age guard this drain emits one `liveFs:update` per row to every `/events/stream` client on every backend instance, for hours. The guard (`LIVE_FS_UPDATE_MAX_AGE_HOURS`, default 24h) ships alongside this job — confirm it is live, and watch `SSE/UpdateSuppressed` climb during the run. That climb is the guard working.
- [ ] **Run outside peak listening hours.** See the watermark note below.
- [ ] **Confirm no sibling flowsheet job is running** (`flowsheet-metadata-backfill`, `flowsheet-etl`, the enrichment worker's sweep).
- [ ] **Read the `legacy_dj_name_preflight` log line — even in the dry run.** Every run opens with a startup scan of `shows.legacy_dj_name` for roster real names, logged as `legacy_dj_name_pii_count` and surfaced on the run summary and the `flowsheet_dj_name_scrub.run.summary` Sentry span. A non-zero count means the recompute is about to WRITE those values onto every in-scope row of the affected shows — see "shows.legacy_dj_name pre-flight" below before proceeding to `--execute`.

### `shows.legacy_dj_name` pre-flight

This job's recompute (`resolveShowDjName`) reads `shows.legacy_dj_name` as a direct chain input with no PII check of its own — unlike `dj_name` and `message`, which this job probes explicitly against the `auth_user` real-name index. That is safe only if `legacy_dj_name` is already clean, which rests entirely on BS#1393 having rewritten it from tubafrenzy `DJ_NAME` (real name) to `DJ_HANDLE` (on-air handle) across the whole table. That rewrite is probably correct, but it was asserted, not independently checked, until this pre-flight existed — and if it is wrong for any subset of shows, this job actively writes real names onto every in-scope row of those shows.

The pre-flight is a single cheap query (`shows` is one row per broadcast, not one per track) run at startup, in BOTH dry-run and `--execute` mode, before the first pass. A non-zero count logs a `warn` line and a Sentry capture, and is carried on the run's `RunResult.legacyDjNamePiiCount` and the summary span's `scrub.legacy_dj_name_pii_count` attribute — but it does NOT abort the run: fixing the underlying pollution is a `shows`-table remediation outside this job's scope (this job only ever nulls or recomputes `flowsheet` columns), so a hard failure here would be a permanent red build over a condition this job cannot itself correct. Treat a non-zero count as a stop-and-investigate signal before running `--execute`, not as a run failure to route around.

### Resume

Each pass has its own cursor, logged in every `batch_done` line and in the final summary as `last_id`:

| Pass             | Env var                            |
| ---------------- | ---------------------------------- |
| main (recompute) | `DJ_NAME_SCRUB_FLOWSHEET_AFTER_ID` |
| message          | `DJ_NAME_SCRUB_MESSAGE_AFTER_ID`   |
| orphan           | `DJ_NAME_SCRUB_ORPHAN_AFTER_ID`    |

A run can end mid-drain **by design**: `buildWaitForQuietPeriod` throws `LiveActivityPauseCeilingExceededError` once the cumulative cooperative-pause budget (`LIVE_ACTIVITY_MAX_PAUSE_MS`) is spent, and a TypeScript job must abort there rather than silently continue (`docs/env-vars.md:34`). All three cursors are persisted before that throw propagates, so the abort is resumable rather than a lost multi-hour pass. Same for SIGTERM: the in-flight page finishes, then a structured `stopped` line carries the cursors.

After a **failed** run, resume from a conservative cursor rather than the last logged one — under `DB_SYNCHRONOUS_COMMIT=off` a page the client believed had committed can be lost to a Postgres crash inside the fsync window.

## Operational envelope

Per `docs/bulk-update-playbook.md`, the per-row cost on `flowsheet` is a heap rewrite + `search_doc` regeneration + **~7** index updates + a WAL full-page image + a CDC `pg_notify` carrying full-row JSON (~30% of per-batch cost, measured 2026-04-27).

- **The playbook's index count is one low.** It predates migration 0084, which added `flowsheet_updated_at_idx` (a DESC btree). Add it to the estimate.
- **Budget 3–5 GB WAL and ~1 GB NOTIFY.** Pause if the CDC listener backpressures — that is a second, independent pause condition, not a substitute for the live-DJ probe.
- **No separate reindex.** `search_doc` is `STORED GENERATED` over an expression containing `dj_name`, so the UPDATE recomputes it per row. Migration 0054 relies on exactly this.
- **`updated_at` is never written by this job.** Migration 0084's BEFORE UPDATE trigger `bump_flowsheet_updated_at` owns it.
- **Operator-visible side effect: the conditional-GET watermark.** `touch_flowsheet_watermark` advances `last_modified_at` by at least a second on every statement (`0084:39-44`), so for the entire multi-hour drain every polling iOS / Android / web client gets a `200` instead of a `304`. That is a bandwidth and battery cost on live clients, not a correctness problem — and it is the reason to run outside peak listening hours.
- **Three read passes.** Separating the message and orphan passes costs two extra read-only PK walks of the table. The writes — the expensive part — are unchanged.
- `ANALYZE wxyc_schema.flowsheet` runs once after the drain (BS#934: stale planner stats are what cost dj-site DJs 5-second autocomplete timeouts after the 2026-05-15 mojibake migration).

## Verification

`verifyScrub` re-scans read-only and counts rows that would still be written, **bounded to `id <= <drain high-water mark>`**. The bound is not caution, it is correctness: two live writers still re-derive the chain in SQL —

- `jobs/flowsheet-etl/job.ts:121` — `SET dj_name = COALESCE(u.dj_name, s.legacy_dj_name)`
- `apps/backend/routes/internal.route.ts:195` — the same COALESCE on the webhook path

— and both predate `dj_name_override` (BS#1321) and omit the literal-`'Anonymous'` filter (BS#1286), so both can write values the canonical helper would not produce. An unbounded check would fail nondeterministically on any row they touch after the drain passed it.

**Consequence beyond this run: divergence regrows at the rate those two writers run.** Converting them to the canonical helper is the durable fix and is tracked as a follow-up. This job is not complete without it.

Sample the **legacy cohort** (`primary_dj_id IS NULL`) when reviewing output — the `auth_user` join cannot see it, which is why BS#1393 reported an empty residue class.

## Environment

Reuses the shared `LIVE_ACTIVITY_*` knobs for the BS#2009 cooperative pause rather than defining its own — including `LIVE_ACTIVITY_MAX_PAUSE_MS`. Job-specific vars (`DJ_NAME_SCRUB_*`) are documented in `docs/env-vars.md`.

The Dockerfile sets `DB_STATEMENT_TIMEOUT_MS=300000` (the API's 5s default is far too tight for the paged scans) and `DB_SYNCHRONOUS_COMMIT=off` (per the playbook).
