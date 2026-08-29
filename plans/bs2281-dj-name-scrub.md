# BS#2281 — Scrub historical `flowsheet.dj_name` to the current resolution policy

## Problem

`flowsheet.dj_name` is a denormalized snapshot written at play time. Rows written under superseded policies still hold DJ real names, and every public flowsheet endpoint serves the column raw (`projectFlowsheetEntry`), including `GET /flowsheet/search`, which additionally makes it _matchable_ — `buildDjNameMatch` ILIKEs the column and `search_doc` carries it at weight B.

Two cohorts are in scope:

- **A — `auth_user.name` era.** Between `a0cd1979` (2025-12-30) and `2a37bbc6` (2026-06-08 21:05 PDT) every writer fell back to better-auth `name`, which dj-site admin provisioning fills with the real name. `2a37bbc6` is the cutoff, **not** #1286/#1288 (2026-06-03), which centralized the helper while keeping the real-name arm.
- **B — tubafrenzy `DJ_NAME` era.** The 2026-04-27 backfill (migration 0053) froze `COALESCE(u.dj_name, s.legacy_dj_name, u.name)` onto ~2.6M rows while `legacy_dj_name` held `DJ_NAME` (full real name).

**Cohort C** — real names DJs themselves typed into tubafrenzy's optional free-text `DJ_HANDLE` — is explicitly out of scope here. It is a policy question, not a correctness bug, and is tracked separately. Sampling will still show name-shaped residue after this job; that is expected, not a failure.

## Why the previous remediation did not close this

Two prior jobs are relevant. `jobs/flowsheet-dj-name-backfill` (2026-04-27, migration 0053) is what _wrote_ cohort B, and its docstring (`job.ts:22-26`) already records the entry-type limitations this plan's design table encodes. `jobs/legacy-dj-name-remediation` (BS#1393, June 2026) then tried to clean up and under-remediated in two independent ways:

1. **Entry-type scope.** All four query sites filter `entry_type IN ('show_start','show_end','dj_join','dj_leave')` (`job.ts:178, 221, 293, 306`). `GET /flowsheet/search` serves `entry_type = 'track'` (`search.service.ts:130`). The remediated set and the searchable set are disjoint.
2. **`WHERE dj_name IS NULL`.** `reresolveMarkerDjNames`' live UPDATE only fills NULLs, while its dry-run preview counts the wider `dj_name IS NULL OR trim(dj_name) = trim(s.legacy_dj_name)`. The doc comment claims the preview "matches the live-run impact"; it does not. Review iteration `a40f6c17` reinforced the narrow predicate as an idempotency device. Correct for gap-filling, wrong for a scrub: **a row already holding a polluted value is never corrected**, so the reported "124,031 marker rows re-resolved" counts rows filled from NULL, not rows cleaned. Markers are therefore still polluted, which is what a March-2015 sample showed (10 of 46 distinct marker values name-shaped).

**The load-bearing constraint for this job: idempotency must come from comparing against the recomputed value (`IS DISTINCT FROM`), never from `IS NULL`.**

## End state

- Every `flowsheet` row's `dj_name` equals what the current chain would produce from current inputs, for all entry types.
- `flowsheet.search_doc` reflects the scrubbed values. **No separate reindex step**: it is `STORED GENERATED` over an expression containing `dj_name` (`schema.ts:1295`), so the scrub's UPDATE recomputes it per row. Migration 0054 relies on exactly this.
- The job computes expected values with the canonical `@wxyc/database` helpers, so it cannot drift from the serving path by construction — no second copy of the chain exists to drift.
- A data-level guard fails if any served `dj_name` equals an `auth_user.name`.

## Design

### 1. There is no single "current chain" — scope is per entry type

The plan's first draft assumed one recomputed expression for all entry types. That is wrong against the actual writers and would corrupt data. Each entry type is reconciled against the writer that produces it:

| entry_type                                     | Writer                                                                        | Chain                                                                         | Scrub action                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `track`                                        | `resolveDjNameForShow` -> `resolveShowDjName`                                 | override -> user handle -> **legacy**                                         | Recompute via `resolveShowDjName`                               |
| `show_end`                                     | same (BS#2068)                                                                | same                                                                          | Recompute via `resolveShowDjName`                               |
| `show_start`, `primary_dj_id IS NOT NULL`      | `startShow` (`flowsheet.service.ts:1022`)                                     | `effective_override ?? resolveDjDisplayName(djName)` — **no legacy fallback** | Recompute against _that_ chain                                  |
| `show_start`, `primary_dj_id IS NULL` (legacy) | `jobs/flowsheet-etl` (tubafrenzy codes **1** and **9**, `transform.ts:30,64`) | shows chain, legacy arm                                                       | Recompute via `resolveShowDjName`                               |
| `dj_join` / `dj_leave`                         | `createJoinNotification` / `createLeaveNotification` (`:1082`, `:1290`)       | the **joining** user's handle; row suppressed if unresolvable                 | **Do not recompute from shows.** PII-null pass only (section 3) |
| `talkset`, `breakpoint`, `message`             | n/a                                                                           | always NULL                                                                   | **Explicitly excluded. Never touched.**                         |

**The `show_start` split is load-bearing, not a refinement.** Applying `startShow`'s no-legacy chain to legacy rows resolves NULL for every one of them, because those shows have no `primary_dj_id` and therefore no user row to read — wiping the `legacy_dj_name` migration 0053 wrote. `flowsheet.service.ts:1219-1222` documents this precise outcome as the bug BS#2068 fixed on `show_end` three weeks ago: "the old form resolved `null` for the ENTIRE legacy cohort (2,813 of production's 2,814 open shows on 2026-08-21)". An unsplit `show_start` recompute re-introduces it on the opening marker.

**Two live writers still re-derive the chain in SQL.**

Neither is a scrub target, but both bound what this job can promise:

- `jobs/flowsheet-etl/job.ts:121` — `SET dj_name = COALESCE(u.dj_name, s.legacy_dj_name)`, scoped `dj_name IS NULL`.
- `apps/backend/routes/internal.route.ts:195` — the same two-column COALESCE on the webhook path.

Both predate `dj_name_override` (BS#1321) and omit the literal-"Anonymous" filter (BS#1286), so both can write values the canonical helper would not produce — on a show with an override, or a DJ whose stored handle is literally "Anonymous".

**Consequence for this job**: an unbounded "zero rows differ from the helper-computed value" check will fail nondeterministically on any row these two touch after the drain passes it. `verifyComplete()` is therefore bounded to `id <= <drain high-water mark>` (section 9).

**Consequence beyond this job**: divergence regrows at the rate those two writers run. Converting them to the canonical helper is the durable fix and is **deliberately out of scope here** — `internal.route.ts:126` documents its COALESCE as intentionally matching the ETL's, and `resolveShowDjName`'s trimmed/untrimmed asymmetry exists so a refactor "cannot change a single byte on the existing wire", so converting them is a wire-behaviour change needing its own issue and its own evidence. Filed as a follow-up; this plan is not complete without it, and saying so here is the point.

Two traps this table exists to avoid, both already documented in `jobs/flowsheet-dj-name-backfill/job.ts:22-26`:

- `dj_join`/`dj_leave` for guest DJs resolve through `shows.primary_dj_id`, so a shows-join recompute overwrites a correct guest handle with the primary DJ's name. Those rows also stamp the same string into `message` (`"${display_dj_name} joined the set!"`), so a shows-join recompute makes `dj_name` contradict `message` on the same row.
- `talkset`/`breakpoint`/`message` are deliberately NULL. Under a bare `IS DISTINCT FROM <shows chain>` every one becomes a candidate and gets **newly populated** — a PII scrub that invents DJ names on rows that never had one. This is the single most dangerous failure mode in the job and warrants an explicit test.

### 2. Compute in TypeScript via the canonical helpers — never re-derive in SQL

An earlier draft of this plan built per-writer SQL expressions and added a parity test to police drift against the TypeScript chain. That is the documented anti-pattern, not a mitigation for it. `shared/database/src/dj-name.ts:1-13` records why the helper was extracted:

> "so `jobs/` writers can apply the identical chain instead of re-deriving it in SQL. That re-derivation is exactly what went wrong: `jobs/flowsheet-april-gap-import` shipped a `COALESCE(auth_user.dj_name, shows.legacy_dj_name)` copy that predated `dj_name_override` (BS#1321) and omitted the literal-'Anonymous' filter (BS#1286)"

`CLAUDE.md:72` states the same rule for that job: "never a re-derived `COALESCE`". A scrub whose whole purpose is to remove a divergence between a helper and stored data must not reintroduce the divergence in its own implementation.

**Mechanism**: id-cursor paged SELECT joining `flowsheet` -> `shows` -> `auth_user`, compute the expected value in-process with `resolveShowDjName` / `resolveDjDisplayName` imported from `@wxyc/database`, and write back only the rows whose stored value differs. Precedent is `jobs/flowsheet-april-gap-import` (asserted at `tests/unit/jobs/flowsheet-april-gap-import/orchestrate.test.ts:380`); the in-process membership test rather than a SQL predicate also matches `jobs/flowsheet-ghost-row-sweep`.

This removes the parity-test requirement entirely — parity is by construction, not by assertion. What remains testable is that the job _calls_ the canonical helper rather than re-deriving, which a unit test can pin.

It also improves the write profile: only genuinely-differing rows are written, rather than issuing a blind UPDATE whose `IS DISTINCT FROM` guard Postgres evaluates per row after joining.

### 3. `dj_join` / `dj_leave`: remove PII, do not re-attribute

The joining guest's identity is not recoverable from `shows`. Attempting to restore correct attribution is out of scope; removing PII is not. These rows get the exact-equality pass only: null `dj_name` where it equals some `auth_user.name` that is not that same user's `dj_name`. That rule is exact for this cohort because these values originated in `auth_user`, and it never writes a _wrong_ name — it only removes one. Attribution loss is accepted and logged.

### 4. `message` also carries Cohort A pollution — same job, separate pass

`message` is client-facing (`flowsheet-projection.ts:67`) and `startShow` embeds the resolved name in it: `Start of Show: ${display_dj_name} joined the set at ${now}`. Before `2a37bbc6`, `display_dj_name` could be `auth_user.name`. So `show_start` (and `dj_join`/`dj_leave`) rows from the Cohort A window carry the real name in message text, and scrubbing `dj_name` alone leaves it rendered.

Not in `search_doc`, so display-only, not matchable. Handled as a distinct pass with its own count, and **anchored on the known templates rather than substring-matching against `auth_user`**. A naive "message contains a string equal to some `auth_user.name`" is `rows x |auth_user|` pattern comparisons per batch against a table carrying only trigram indexes on `name` — the one pass with no cost model in the previous draft.

Instead: extract the candidate name positionally from the writer's own templates and compare that single extracted string with exact equality — the same cheap probe as the orphan pass. A row whose message does not match a known template is left alone rather than guessed at.

`show_end` is in scope and was missed in an earlier draft: `endShow` was one of the four writers carrying the `name` fallback that `2a37bbc6` removed, and its template dates to `6a08a9a2` (2026-01-21), inside the Cohort A window.

| entry_type   | Template                                                  | Rewrite to                                      |
| ------------ | --------------------------------------------------------- | ----------------------------------------------- |
| `show_start` | `Start of Show: ${name} joined the set at ${t}` (`:1029`) | `Start of show: ${t}` (`:1031`)                 |
| `show_end`   | `End of Show: ${name} left the set at ${t}` (`:1230`)     | `End of show: ${t}` (`:1232`)                   |
| `dj_join`    | `${name} joined the set!` (`:1107`)                       | `DJ joined the set!` — **new shape, see below** |
| `dj_leave`   | `${name} left the set!` (`:1303`)                         | `DJ left the set!` — **new shape, see below**   |

`show_start` and `show_end` degrade to wording their own writers already emit when the name is unresolvable, so no new shape enters the corpus. **`dj_join` / `dj_leave` have no such form** — those writers _suppress the row entirely_ rather than degrade it, so any rewrite is by definition a new message shape. Deleting the rows is not on the table (destructive, and they are real events). The chosen wording matches the generic fallback public consumers already render for a null `dj_name` (`lib/flowsheetRange.js` `describeNonTrackEntry`: `entry.dj_name ? \`${entry.dj_name} joined\` : 'DJ joined'`), so it is new to the stored corpus but not new to what **that** reader sees. Scope the claim honestly: `describeNonTrackEntry`lives in the separate`WXYC/website` repo (`lib/flowsheetRange.js:320-326`), so this is verified for the website only — the iOS and Android clients render their own fallbacks and were not checked. Called out explicitly rather than buried, with its own acceptance criterion.

### 5. Drain mechanics

- **id-cursor drain** (`id > lastId`), per `docs/bulk-update-playbook.md`. Not a predicate resume: the work predicate is join-computed, and a predicate resume is what produced the 2026-04-27 infinite loop (NULL -> NULL writes counted as updated while the filter still matched).
- **Idempotency by `IS DISTINCT FROM <recomputed>`, never `IS NULL`** — the defect that left BS#1393 under-remediated.
- Dry-run and live share one predicate builder, asserted by test. BS#1393's diverged and its doc comment wrongly claimed they matched.
- `intArrayLiteral(...)` for `ANY()` bindings **in the job's Drizzle `sql` templates only** (BS#2010). The rule inverts in `tests/integration/*.spec.js`, where `getTestDb()` is postgres-js and a bare array is the correct binding — `docs/bulk-update-playbook.md` flags precisely this trap ("the same source line is right in one file and wrong in another").

### 6. Orphan rows (`show_id IS NULL`), and the exact-equality probes generally

`flowsheet` has no user FK — only `show_id` — so with `show_id IS NULL` there is no "that user", and the rule must be stated explicitly: null `dj_name` where it equals some `auth_user.name` belonging to a user whose `dj_name` is distinct from their `name`.

**Do this in process, not in SQL.** An earlier draft proposed a SQL `EXISTS (... u.name = f.dj_name ...)` probe and accepted a sequential scan on the grounds that `auth_user` carries trigram indexes on `name`/`dj_name`. **That premise is wrong.** Those indexes were created in migration 0051 and dropped three times over (`0054:64-65`, `0065:57-58`, `0095:18-19`); `schema.ts:71-74` documents the dropped state and removed the declarations. `auth_user` has **no index on `name` at all**, so the probe has nothing to work with on either side — worse than the "accepted one-off seq scan" the draft budgeted for.

Instead, load `auth_user`'s `(name, dj_name)` pairs into an in-process `Map` once at startup and test exact equality per row. `auth_user` is a station DJ roster — small enough that this is trivially cheap — and it makes the orphan pass, the `dj_join`/`dj_leave` PII-null pass (section 3), and the regression guard all use the same mechanism as the main pass in section 2, rather than leaving three exceptions to the job's own stated approach. Same in-process membership-test precedent as `jobs/flowsheet-ghost-row-sweep` (`keyspace.has(...)`, not a SQL `NOT IN`).

### 7. Operational envelope

Per `docs/bulk-update-playbook.md`, per-row cost on `flowsheet` is heap rewrite + `search_doc` regeneration + ~6 index updates + WAL FPI + a CDC `pg_notify` carrying full-row JSON (~30% of per-batch cost measured 2026-04-27).

- Batch 5000 (`BACKFILL_BATCH_SIZE`), `DB_SYNCHRONOUS_COMMIT=off`, `DB_STATEMENT_TIMEOUT_MS` >= 5min.
- Budget 3-5 GB WAL and ~1 GB NOTIFY; pause if the CDC listener backpressures.
- **The UPDATE omits `updated_at`** — migration 0084's `bump_flowsheet_updated_at` BEFORE trigger owns that column (`0084:81-83`). Both donor jobs record this decision in their READMEs (`jobs/va-apple-music-url-remediation/README.md:87`).
- **One more index write per row than the playbook budgets.** `docs/bulk-update-playbook.md`'s cost list predates migration 0084, which added `flowsheet_updated_at_idx`, a DESC btree (`schema.ts:1405`). Add it to the per-row estimate.
- **Operator-visible side effect: the conditional-GET watermark.** `touch_flowsheet_watermark` advances `last_modified_at` by at least one second on every statement (`0084:39-44`), so for the entire multi-hour drain every polling iOS / Android / web client gets a `200` instead of a `304`. This is a bandwidth and battery cost on live clients, not a correctness problem. It belongs in the run procedure as a stated decision — and argues for running the drain outside peak listening hours — rather than arriving as a support ticket.
- **SSE `liveFs:update` fan-out — resolve before running.** `filterMetadataUpdate` (`apps/backend/services/metadata-broadcast/metadata-broadcast.ts:206-215`) broadcasts on _any_ `flowsheet` UPDATE whose `metadata_status` is terminal. It has **no `entry_type` check and no age guard**, and historical `track` rows are almost all terminal — so the main pass would emit one projected `liveFs:update` per row to every `/events/stream` client on every backend instance, for the whole multi-hour drain. The sibling insert path received exactly this guard in BS#2131 (`:60-64`, `LIVE_FS_INSERT_MAX_AGE_HOURS`, default 24h); the update path never did. **Prerequisite, not an accepted cost**: land an age/`entry_type` guard on `filterMetadataUpdate` mirroring BS#2131 before the drain runs. Unlike the watermark item below — a bandwidth cost on clients that are already polling — this pushes millions of unsolicited events at live connections.
- `ANALYZE wxyc_schema.flowsheet` after the drain (BS#934).
- **Cooperative live-DJ pause** (BS#2009): `flowsheet` is the live on-air table and this drain budgets 3-5 GB of WAL against it. Port the donors' `waitForQuietPeriod` / `safeProbe` — probed once per page, never per row, with a throwing probe fail-open so a transient probe failure cannot abort the run (`flowsheet-ghost-row-sweep`, `streaming-url-remediation`, `va-apple-music-url-remediation`). CDC backpressure is a second, independent pause condition, not a substitute.

  Note the limit of "fail-open": it covers a _throwing probe_, not the pause ceiling. `buildWaitForQuietPeriod` (`shared/database/src/live-activity.ts:181`) throws `LiveActivityPauseCeilingExceededError` once cumulative pause is exhausted, and `docs/env-vars.md:34` is emphatic that a TypeScript job must abort there rather than silently continue ("do not resurrect the silent-disable behavior"). So the run _can_ end mid-drain by design. All three id cursors must therefore be logged and persisted **before** that throw propagates, so the abort is resumable rather than a lost multi-hour pass.

### 8. Deploy scaffolding

`.github/workflows/deploy-base.yml:454` builds `Dockerfile.${target}` from the repo root and each job's `docker:build` points at `../../Dockerfile.<name>`, so the job is unbuildable without it.

Directory `jobs/flowsheet-dj-name-scrub/`, package `@wxyc/flowsheet-dj-name-scrub`.

- `Dockerfile.flowsheet-dj-name-scrub` at repo root, modelled on `Dockerfile.legacy-dj-name-remediation`.
- `package.json` (`"job-type": "one-shot"`), plus `tsconfig.json` and `tsup.config.ts` — without the latter two `npm run build --workspace=...` has no entry point.
- `package-lock.json` entry for the new workspace; the Dockerfile's `npm ci` needs it. `jobs/*` is already globbed at `package.json:68`, so no `workspaces` edit.
- `jobs/flowsheet-dj-name-scrub/README.md` — 37 of 48 `jobs/*` carry one, including both structural donors cited here. The operator run procedure, the WAL/NOTIFY budget, and the three intentional-NULL classes belong there; the CLAUDE.md row is a one-line index, not run documentation.
- A row in `CLAUDE.md`'s package registry table.
- A `Type check: flowsheet-dj-name-scrub` step in `.github/workflows/test.yml`, beside the existing per-job step at `:234`. `npm run typecheck` is scoped to `@wxyc/database` / `shared/**` / `apps/**` (`package.json:10`), so `jobs/**` gets no type coverage by default — and `tsup --minify` is esbuild transpile-only, which is how `va-apple-music-url-remediation` shipped with two TS2554s (`test.yml:222-233`).
- `docs/env-vars.md` section plus `.env.example` entries — every comparable drain carries one. Three passes means three independent id cursors, named here so the resume story is pinned before implementation: `DJ_NAME_SCRUB_FLOWSHEET_AFTER_ID` (main recompute), `DJ_NAME_SCRUB_MESSAGE_AFTER_ID` (message pass), `DJ_NAME_SCRUB_ORPHAN_AFTER_ID` (orphan pass). Reuses the shared `LIVE_ACTIVITY_*` knobs for the BS#2009 pause rather than defining its own, **including `LIVE_ACTIVITY_MAX_PAUSE_MS`**.
- **File layout**: `job.ts` + `orchestrate.ts` + `logger.ts`, matching the donors this plan cites rather than the single-file shape of the two older `dj_name` jobs. Two acceptance criteria (shared predicate builder, `analyzeTables()` ordering) are only unit-testable with the orchestrate split — see `tests/unit/jobs/flowsheet-april-gap-import/orchestrate.test.ts`.
- **Default posture: dry-run by default, `--execute` to write**, matching `flowsheet-ghost-row-sweep` and `va-apple-music-url-remediation`. Not `--dry-run`-opt-in like the older remediation job.
- **Known CI risk**: `jobs/` currently holds 48 directories. (`package.json:12`'s "51st" counts all workspaces, not just `jobs/*`, so the two ordinals are on different bases — the headroom conclusion below rests on the measured peak, not on either count.) The ESLint heap ceiling is **already 12288 MiB**, raised from 8192 in BS#2258 (`package.json:12`), leaving roughly 2.6 GiB of headroom over that issue's measured 9.37 GiB peak. So an OOM is unlikely rather than expected — an earlier draft of this plan said the opposite, from a stale reading. If this workspace does cross the ceiling, `package.json:12` is explicit that the fix is to scope the type-aware rules or split the lint job, **not** to bump again.

### 9. Two deployed jobs would reverse this scrub

Sections 3 and 6 deliberately create `dj_name IS NULL` rows. Two one-shot jobs exist whose entire purpose is filling exactly those NULLs from the `shows` join — the wrong-attribution overwrite this plan warns about for guest DJs:

- `jobs/legacy-dj-name-remediation/job.ts:306-307` — `entry_type IN (...) AND f.dj_name IS NULL`
- `jobs/flowsheet-dj-name-backfill` — `WHERE dj_name IS NULL`

Both still have root Dockerfiles and are runnable by any operator. **This plan's own framing of BS#1393 as "under-remediated" makes a well-intentioned re-run more likely, not less** — someone reading it could reasonably conclude the old job should be run again. That would silently reverse the PII scrub.

In scope: a hard refusal guard in both jobs (exit non-zero with a pointer to this one), plus a prominent line in this job's README. Deleting them is the cleaner end state but is a separate call, since their run history is referenced from several issues.

### 10. Verification

- Per-entry-type behaviour proven over real rows in the integration tier, including `show_start`'s no-legacy-fallback chain and the trimmed/untrimmed asymmetry. No cross-language parity assertion is needed — section 2 removes the second copy of the chain that would have required one.
- `verifyComplete()` — structurally modelled on `jobs/flowsheet-dj-name-backfill/job.ts:144`, but **its invariant is deliberately inverted and must not be copied**. That job asserts _zero_ track+marker rows with `dj_name IS NULL`; this job intentionally creates NULLs (PII-nulled `dj_join`/`dj_leave` in section 3, orphans in section 6), so copying its predicate guarantees a false failure. Migration 0054's matching guard was already removed (`0054_flowsheet-search-doc-with-dj-name.sql:3-4`), so nothing downstream depends on the old invariant. New predicate, **bounded to `id <= <drain high-water mark>`** so the two live SQL re-derivers above cannot fail it nondeterministically on rows written after the drain passed: zero in-scope rows at or below the mark where the stored value differs from the helper-computed value, plus zero such rows matching the corrected guard below. The new NULLs are the fix, not a regression.
- Output sampling over the legacy cohort (`primary_dj_id IS NULL`), which the `auth_user` join cannot see. This blind spot is why BS#1393 reported an empty residue class.

## Acceptance criteria

- [ ] Dry-run reports per-cohort counts from a query, not an estimate.
- [ ] Live and dry-run share one predicate/decision path, asserted by test — BS#1393's diverged while its doc comment claimed they matched.
- [ ] `updated_at` is not written by the job; the migration-0084 trigger owns it.
- [ ] Unit tier (`tests/unit/jobs/flowsheet-dj-name-scrub/orchestrate.test.ts`): the job calls `resolveShowDjName` / `resolveDjDisplayName` from `@wxyc/database` and contains no re-derived name COALESCE.
- [ ] Integration tier (`tests/integration/flowsheet-dj-name-scrub.spec.js`, `getTestDb()`): per-entry-type behaviour over real rows, including `show_start`'s no-legacy-fallback chain and the trimmed/untrimmed asymmetry.
- [ ] Scrub is scoped per entry type per the table above, and overwrites non-NULL values.
- [ ] Integration tier proves `talkset` / `breakpoint` / `message` rows are never written to.
- [ ] Test proves `dj_join` / `dj_leave` are not recomputed from the shows join.
- [ ] `message`-column pass covers `show_start`, `show_end`, `dj_join`, `dj_leave`, counted separately per type.
- [ ] `show_start` / `show_end` rewrites use wording their own writers already emit; test asserts no new shape for those two.
- [ ] `dj_join` / `dj_leave` rewrite wording is explicitly recorded as a new corpus shape, with its own test.
- [ ] `show_start` is split by `primary_dj_id` provenance; test proves the legacy cohort is NOT nulled (the BS#2068 regression).
- [ ] Orphan-row pass counted separately, using the in-process `auth_user` `(name, dj_name)` Map rather than a SQL `EXISTS` probe (no index exists to support the latter).
- [ ] `verifyComplete()` returns zero, bounded to the drain high-water mark.
- [ ] Age/`entry_type` guard landed on `filterMetadataUpdate` before the drain runs (SSE fan-out prerequisite).
- [ ] Refusal guard added to `legacy-dj-name-remediation` and `flowsheet-dj-name-backfill`, plus a README warning that running either reverses this scrub.
- [ ] `Type check: flowsheet-dj-name-scrub` step added to `.github/workflows/test.yml`.
- [ ] All three id cursors persisted before a `LiveActivityPauseCeilingExceededError` propagates; test covers the resumable-abort path.
- [ ] Follow-up issue filed to convert `flowsheet-etl/job.ts:121` and `internal.route.ts:195` to the canonical helper; without it divergence regrows.
- [ ] Unit test asserts `analyzeTables()` runs after the drain. (`check-bulk-update-analyze.mjs` walks only `.sql` files (`:117`) and is blind to a TypeScript job, so citing it would assert nothing.)
- [ ] Regression guard, stated as the same expression as the scrub predicate: no served `dj_name` equals an `auth_user.name` **where that user's `dj_name` IS DISTINCT FROM their `name`**. Without the exemption a DJ whose on-air handle legitimately is their real name — which `resolveDjDisplayName` returns unchanged — trips the guard permanently.
- [ ] Existing `resolveDjDisplayName` / `resolveShowDjName` unit tests unchanged and passing — this job does not alter the helpers.

## Out of scope

- **`shows.legacy_dj_name` itself is not scrubbed by this job, even though the originating issue lists it as a second polluted store and names scrubbing it as an acceptance criterion.** This is a scope reduction relative to the issue, made explicit here rather than left implicit: the issue's premise was that `legacy_dj_name` might still hold tubafrenzy `DJ_NAME` (real name); this plan instead treats it as already clean, on the strength of BS#1393's rewrite of that column from `DJ_NAME` to `DJ_HANDLE`. That is probably right, but "probably right" is not the same as checked, and the recompute (`resolveShowDjName`) reads `legacy_dj_name` as a direct chain input with no PII probe of its own — unlike `dj_name` and `message`, which this job does probe explicitly. If BS#1393's rewrite is wrong for any subset of shows, this job would actively write real names onto every in-scope row of those shows. The check for that is a startup pre-flight (`countPollutedLegacyDjNames` in `orchestrate.ts`, documented in the job's README under "shows.legacy_dj_name pre-flight"): a cheap, single query over `shows` (small — one row per broadcast) run in both dry-run and `--execute` mode, before the first pass, that counts `legacy_dj_name` values matching the `auth_user` real-name index and warns loudly (structured log + Sentry capture) on a non-zero count. It does not gate the run — remediating `shows.legacy_dj_name` itself is a `shows`-table fix outside this job's blast radius (this job only ever touches `flowsheet` columns) — but it turns "asserted" into "checked and reported" before any write happens.
- Cohort C policy.
- Converting the two live SQL re-derivers to the canonical helper (wire-behaviour change; own issue, own evidence). Tracked as a follow-up, and this plan is explicitly incomplete without it.
- The read-seam stopgap (`DJ_NAME_EXPR`, `buildDjNameMatch`, `projectFlowsheetEntry` gating) — separate decision; it cannot close free-text matching anyway, since `search_doc` embeds `dj_name` and a tsquery cannot exclude one source field.
- Scrubbing the tubafrenzy dump before the 2026-08-31 cutover (BS#1543).
