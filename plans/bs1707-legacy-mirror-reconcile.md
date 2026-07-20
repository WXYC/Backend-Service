# BS#1707 — Legacy mirror reconciliation (self-heal orphaned tubafrenzy markers/entries)

Issue: https://github.com/WXYC/Backend-Service/issues/1707 (labels: `bug`, `tubafrenzy`). Follow-up root-cause of BS#1705 (PR #1706).

## Problem (restated)

The Backend-Service → tubafrenzy legacy mirror fires exactly once per mutation inside a `res.once('finish', …)` callback (`createHttpMirrorMiddleware`, `apps/backend/middleware/legacy/mirror.middleware.ts:65`). There is no retry and no reconciliation. If that single attempt does not run — the PostHog `backend-mirror` flag was off for the caller, a PostHog eval hiccup, a transient tubafrenzy HTTP failure, or a BS process restart mid-request — the show row, its `show_start`/`show_end` markers, or its entries never reach tubafrenzy and stay orphaned forever. `mirrorCreateShow` has one call site (the `/flowsheet/join` new-show branch of `startShow`); a mid-show flag flip does not re-fire the one-shot handler. Prod evidence: BS `shows.id` 1949437 / tubafrenzy 172277 — the tubafrenzy show was created ~1h after go-live, early entries carry NULL `legacy_entry_id`, and the `show_start` marker was never mirrored.

The BS#1705 query fix (announce the `show_start` marker by `entry_type` instead of newest `play_order`) hardens a real latent bug but cannot heal a mirror that was simply off/failing at go-live — there is no re-drive path. That gap is this ticket.

## Desired end state

A reconciliation sweep that re-drives mirror-eligible show/entry rows whose single `res.finish` attempt was skipped, so a transient mirror outage or a mid-show flag flip self-heals instead of permanently orphaning rows in tubafrenzy.

## Mechanism decision (AC item)

**Chosen: a recurring `jobs/legacy-mirror-reconcile` cron**, modeled on `jobs/flowsheet-metadata-backfill`.

Rejected alternatives, and why:
- **Bounded retry on the existing `res.finish` HTTP mirror.** Covers only *transient tubafrenzy failures*. It cannot cover the flag-off case (the handler bails before doing any work) or the mid-show flag-flip case (the one-shot handler already ran and won't re-fire), which are the actual prod failure modes. Useful as an orthogonal add-on, not a substitute. Out of scope here; noted as a possible follow-up.
- **In-process bounded retry queue.** Dies with the process — the exact restart failure mode we must survive. A durable, DB-selected sweep is required.

A cron reads the durable signal (`shows.legacy_show_id IS NULL` / `flowsheet.legacy_entry_id IS NULL`) straight from Postgres, so it heals regardless of *why* the live attempt was skipped, and survives restarts. It bounds the blast radius to a scheduled off-peak window.

## Selection logic & idempotency

The re-drive is uniform: every mirror-eligible row is detected by a NULL legacy surrogate key, so the loop guard (BS#908) is honored automatically — a row imported from tubafrenzy (ETL/webhook) always has a non-null `legacy_entry_id`/`legacy_show_id` and is never selected.

**Shows to create** (create the tubafrenzy `radioShow`, then persist `legacy_show_id`):
```
SELECT * FROM shows s
WHERE s.legacy_show_id IS NULL
  AND s.primary_dj_id IS NOT NULL            -- mapShowToTubafrenzy needs a DJ; DJ-less legacy shows can't be mirrored
  AND s.start_time <  now() - interval 'SETTLE'   -- older than the res.finish settling window (default 15 min): don't race a still-in-flight live mirror
  AND s.start_time >  now() - interval 'WINDOW'    -- bounded recent window (default 48h): NOT a historical backfill
  AND NOT EXISTS (SELECT 1 FROM flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NOT NULL)  -- all-or-nothing (review R4 High #1)
ORDER BY s.start_time ASC
```
**Why the `NOT EXISTS` guard on the show sweep (review R4 High #1 — data safety).** In the mid-show-flag-flip case (the plan's primary failure mode), `startShow`'s mirror is skipped so `legacy_show_id` stays NULL, but a later `addEntry` *does* fire and mirrors entries with `radioShowID` **omitted** — `mapEntryToTubafrenzy` drops it when null (`http.mirror.ts:311,341`), so tubafrenzy auto-resolves/creates a show *server-side* and stamps those entries' `legacy_entry_id` against it. The BS `shows` row still shows `legacy_show_id IS NULL`. Without this guard the show sweep would POST a *second, empty* radioShow and persist its id — an empty duplicate, with `legacy_show_id` now pointing at the wrong tubafrenzy show (a later `endShow` would sign off the empty one). Excluding shows that already have any mirrored entry routes these to the partial-mirror report instead. Net: **both** sweeps are all-or-nothing — a show is auto-healed only when it has zero mirrored entries (hence no server-side auto-resolved show to collide with).

**Entries to create + signoff** — this is a **second sweep**, keyed on `legacy_show_id IS NOT NULL` (NOT "created this run"). It covers both a show just created by the show sweep above *and* a show created on a **prior** run whose entry loop crashed before finishing (the mid-run-kill recovery — review R3 Medium #2). The candidate set:
```
-- all-or-nothing shows that have a tubafrenzy show but no mirrored entries yet
SELECT s.* FROM shows s
WHERE s.legacy_show_id IS NOT NULL
  AND s.start_time > now() - interval 'WINDOW'
  AND EXISTS     (SELECT 1 FROM flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM flowsheet f WHERE f.show_id = s.id AND f.legacy_entry_id IS NOT NULL)
```
Then for each such show, drive all its NULL-legacy entries in `play_order` order:
```
SELECT * FROM flowsheet
WHERE show_id = $showId
  AND legacy_entry_id IS NULL              -- not yet mirrored AND not loop-guarded (BS#908)
ORDER BY play_order ASC
```
and, after the entries succeed, **sign off** the show if it is finalized (`end_time IS NOT NULL`) — see Signoff parity below. This is idempotent by construction: once a show's entries carry `legacy_entry_id`, the `NOT EXISTS (… legacy_entry_id IS NOT NULL)` guard drops it from the candidate set, and `mirrorSignoffShow` is an idempotent POST.

Every entry type (`track`, `show_start`, `show_end`, `dj_join`, `dj_leave`, `talkset`, `breakpoint`, `message`) is mirror-eligible via the live path, and `mapEntryToTubafrenzy` already encodes the non-track → legacy-type-code mapping (9=start, 10=end, 7=talkset, 8=breakpoint). So the reconcile iterates all NULL-legacy entries through the same mapper — no special-casing of markers.

**Ordering invariant & the partial-mirror exclusion (review High #2).** tubafrenzy assigns `SEQUENCE_WITHIN_SHOW` server-side at insert time as `MAX(SEQUENCE_WITHIN_SHOW)+1` (the live SQL analog is `flowsheet.mirror.ts:143`). So a POST always *appends* to the end of the show. Re-driving the early NULL-legacy entries of a **partially**-mirrored show (mirror came on mid-show; later entries already present) would land them *after* the already-present later rows — rendering them at the tail, out of order. Correcting that would require renumbering existing tubafrenzy sequences, which is an overwrite (data-safety violation) and out of scope. Therefore the auto-heal is scoped to **all-or-nothing shows** (zero already-mirrored entries), where re-driving in `play_order` reproduces correct order because every insert starts from an empty sequence. This is the common, motivating failure (flag off / mirror down for a *whole* show). **Partially**-mirrored shows (some entries mirrored, some NULL) are detected and reported (structured log + Sentry warning with `show_id` + orphan count) for manual remediation — they are the historical-remediation class already declared out of scope for the recurring sweep. Note the prod case BS `shows.id` 1949437 / tubafrenzy 172277 is itself a partial case (show + later entries present, early entries + `show_start` NULL), so it is a *report* target here, healed by the separate one-time remediation — this ticket stops the condition from *accruing* going forward and makes it observable.

A re-driven show is created in tubafrenzy (→ `legacy_show_id`) *before* any of its entries; `mapEntryToTubafrenzy(entry, legacyShowId, isRotationMatch)` requires the legacy show id.

**Signoff parity (review Medium #3, corrected R3 Medium #2).** The live `endShow` makes a separate `mirrorSignoffShow(legacyShowId, endMs)` call (`flowsheet.mirror.ts:107`) *in addition* to the `show_end` marker. After re-driving the entries of an all-or-nothing show, if the show is finalized (`end_time` set), call `mirrorSignoffShow` — **regardless of when its `legacy_show_id` was set**. The earlier "created this run" restriction was wrong: the job's core failure mode is a mid-run process kill, where a show created on run N whose entry loop crashed carries `legacy_show_id` on run N+1 and must still be healed + signed off. Idempotency needs no durable column: `mirrorSignoffShow` (`http.mirror.ts:432`) just POSTs `{radioShowId, signoffTime}` and is inherently idempotent, and a healed show drops out of the all-or-nothing candidate set once its entries exist — so a re-sign can't recur. (A show whose entries were *all* mirrored live but whose signoff POST alone failed is a partial-state case — it has mirrored entries, so it's excluded from the auto-heal and surfaces in the partial-mirror report rather than being re-signed here.)

**Rotation-match parity (review High #1).** The live `addEntry` computes `isActiveRotationMatch(entry)` (`flowsheet.mirror.ts:323`) and passes it to `mapEntryToTubafrenzy` so a hand-typed rotation track maps to legacy type 2 (`http.mirror.ts:334`). The reconcile must do the same or it silently misclassifies re-driven rotation matches as unbadged (type 6/0). `isActiveRotationMatch` lives in `rotation-match.mirror.ts`, whose only imports are `@wxyc/database` + `drizzle-orm` + `captureMirrorFailure` — so it is extracted to the shared package alongside the HTTP helpers (see reuse section; this makes PR 1 larger than "pure HTTP helpers").

**Idempotency:**
- Selection is guarded on `IS NULL`, so a second run after a successful sweep is a no-op.
- After each helper call succeeds, persist the returned legacy id on the BS row in the same shape the live path uses (`flowsheet.mirror.ts:53,86,330`). A crash between the tubafrenzy POST and the persist would re-create on the next run — the one place a duplicate is possible. **Duplicate-show risk mitigation:** the `SETTLE` lower bound keeps the sweep away from still-in-flight live mirrors; the cooperative pause defers while a DJ is live; the window is off-peak. `mirrorCreateShow` has 5-attempt backoff so a slow-but-eventually-ok POST persists rather than orphaning. Residual duplicate risk (POST-ok / persist-crash) is documented and judged acceptable for a rare self-heal; a stronger guarantee (tubafrenzy-side upsert key) is a tubafrenzy-repo follow-up, not in scope.
- **Single-flight guard (review Low #6 + R2 Medium).** The `IS NULL`/`SETTLE`/pause mitigations guard against racing a *live* mirror, not against two reconcile invocations overlapping (a manual run beside the cron, or a long run spilling past the next schedule) — both would select the same NULL-legacy show and both POST. The job takes `pg_try_advisory_lock(<fixed key>)` at startup and exits 0 immediately if it can't acquire it (another reconcile is running). **Held on a dedicated `createPostgresClient({ max: 1 })` client, not the shared pooled `db`** (R2 Medium): a session-scoped advisory lock binds to the specific backend connection that served the acquire, but the pooled `db` (`client.ts:126`, `max=10`) would run the job's other queries on *other* connections and "release on close" wouldn't be deterministic at exit. The `max:1` client (repo already exports `createPostgresClient` at `client.ts:106` "for serial single-purpose clients") holds the lock for the whole run and releases it deterministically on its own `end()` in `finally`.

## Reuse of the HTTP mirror helpers (key architectural decision — reviewer input wanted)

The reconcile must produce byte-identical tubafrenzy payloads to the live path, so it must call the same `mirrorCreateShow` / `mirrorCreateEntry` / `mirrorSignoffShow` / `mapShowToTubafrenzy` / `mapEntryToTubafrenzy` / `isActiveRotationMatch` helpers rather than re-implement the mapping (re-implementing would drift; the mapping is correct and must stay single-source). The HTTP helpers live in `apps/backend/middleware/legacy/http.mirror.ts`; their only non-local import is `@sentry/node`. `isActiveRotationMatch` lives in `rotation-match.mirror.ts` (imports `@wxyc/database` + `drizzle-orm` + `captureMirrorFailure`) and is **required** for track-payload parity (review High #1). **No existing job imports across the `apps/backend` boundary**, and root `npm run typecheck` does not cover `jobs/**`.

- **Option C — new dedicated `shared/legacy-mirror/` package (RECOMMENDED, review R4 Medium #3).** Move `http.mirror.ts` + `rotation-match.mirror.ts` (+ the shared Sentry taxonomy `mirror.logging.ts` if `captureMirrorFailure` is split out) into a **new** `@wxyc/legacy-mirror` workspace. Both `apps/backend` and the job import from `@wxyc/legacy-mirror`; the `apps/backend/middleware/legacy/*.mirror.ts` files become **thin re-export shims**. Keeps the outbound-`fetch`-plus-`@sentry/node` client **out of `@wxyc/database`** — the ORM/schema package should not carry a REST/observability client into the transitive surface of every workspace that imports it (`sql.mirror.ts` is a weak precedent: it's still DB access, MySQL-over-SSH, not an outbound REST client). `@wxyc/legacy-mirror` declares `@sentry/node`, `drizzle-orm`, and `@wxyc/database` (rotation-match's `db`/`rotation`/`library`/`artists` stay a normal cross-package import — no self-reference, no relative rewrite). Still inside the workspace boundary; still gets root-typecheck coverage (root `typecheck` runs `--workspace=shared/**`).
- **Option A — move into `shared/database/src/legacy/` (rejected).** Next to `sql.mirror.ts`; smaller footprint (no new package) but pulls `@sentry/node` + an HTTP client into `@wxyc/database`'s dependency surface — the layering stretch Option C avoids. Also requires rewriting rotation-match's `@wxyc/database` import to relative `../client.js`/`../schema.js` (self-referential package import is fragile under tsup).
- **Option B — vendor via relative import + tsup bundling (rejected).** Job imports `../../apps/backend/middleware/legacy/http.mirror.js`; Dockerfile copies the files; tsup inlines. Crosses the app→job boundary (unprecedented), no root-typecheck coverage of the seam, fragile if app internals move.

**Test-mocking reality (applies to A or C; review R3 High #1).** App consumers keep importing the **app-path shim**, unchanged — `flowsheet.mirror.ts` continues to import `./http.mirror.js` / `./rotation-match.mirror.js` (now shims), **no import swap** — so collaborator tests that `jest.mock('.../legacy/http.mirror')` / `jest.mock('.../legacy/rotation-match.mirror')` (`endshow-shape-guard.test.ts:22,98`, `delete-entry-legacy-id.test.ts:38,78`, `mirror.loop-prevention.test.ts:21,85`) keep intercepting. Shipped behavior is unchanged, but the plan does **not** claim "tests untouched": PR 1 budgets for repointing the two *implementation* suites (`http.mirror.test.ts`, `rotation-match.mirror.test.ts`) to the moved module and mocking the DB at the new boundary. `tests/integration/mirror-http.spec.js` is the behavior-parity guard.

**Recommendation: Option C**, split into a chain to keep each PR reviewable and de-risk the production-mirror touch:

- **PR 1 (extraction, no shipped-behavior change):** create `@wxyc/legacy-mirror`; move the helpers; app path becomes re-export shims; repoint the two implementation test suites; integration parity test green.
- **PR 2 (the reconcile job):** `jobs/legacy-mirror-reconcile` consuming `@wxyc/legacy-mirror` + Dockerfile + cron wiring + tests + detection signal.

## Flag gate from a job (new pattern)

`isMirrorEnabled` (`mirror.middleware.ts:11`) is module-private and derives its PostHog `distinctId` from the Express `req` (`req.user?.id ?? req.ip`). A cron has no request. The job will:
- If `POSTHOG_API_KEY` is unset → mirror enabled (preserve the dev/E2E convention).
- Else evaluate the flag **per show, keyed on that show's `primary_dj_id`** — `isFeatureEnabled('backend-mirror', show.primary_dj_id)` — exactly mirroring the live path's per-caller `req.user.id` gate (review R4 Medium #2). This is the faithful contract under *either* rollout shape: a 100%/0% kill-switch behaves globally as expected, and a genuine per-DJ percentage rollout heals exactly the shows whose DJ is in the ON cohort — never re-driving a DJ the rollout deliberately excluded (which a single fixed synthetic distinctId would get wrong in both directions: healing OFF-cohort shows at full blast, or healing nothing). A show whose DJ evaluates OFF is skipped this run (logged, retry-eligible next run if the rollout changes). This is a deliberate *approximation* of the live gate: the live path keys on the actual mutation caller (`req.user?.id ?? req.ip`), which for a guest-DJ or Auto-DJ entry can differ from the show's `primary_dj_id`. Under the flag's real-world 100%/0% kill-switch shape this never diverges; under a hypothetical per-DJ rollout the reconcile keys on the show owner rather than the per-entry caller — an acceptable, documented approximation (it would only mis-decide entries added by a caller in a different cohort than the show owner during an active partial rollout).
- **Client lifecycle (review Medium #4).** `posthog-node` keeps background flush timers; unlike the long-lived app client (`apps/backend/utils/posthog.ts`, never shut down), a short-lived cron container must `await client.shutdown()` in its `finally` or the process may hang on exit. The job's `finally`: `await client.shutdown()` → advisory-lock client `end()` → `await closeDatabaseConnection()` → `await closeLogger()`. No `.shutdown()` call exists in the repo today to model from — this is part of the new pattern.
- **This is the first `jobs/` reader of a PostHog flag** — establish the pattern; document the `POSTHOG_API_KEY`-unset short-circuit *and* the shutdown requirement.

## Cooperative pause (#735)

Reuse the shared probe `checkLiveActivity` from `@wxyc/database` (`shared/database/src/live-activity.ts`, which honors `WXYC_SCHEMA_NAME`) wrapped in a local `awaitQuietWindow` loop (`awaitQuietWindow` shape at `concerts-artist-lml-resolver/job.ts:126`). Note the deliberate divergence: the donor jobs define their *own* local `checkLiveActivity` (`concerts-artist-lml-resolver/job.ts:111`, with a hardcoded `wxyc_schema`); we instead reuse the shared `live-activity.ts` export so the probe respects the per-worker test schema — better, not the donor's convention (R3 Low #4). Pause before each sweep and between shows so reconcile never fights live DJ traffic — and, as a bonus, this is the primary guard against racing a still-in-flight live mirror.

## Detection signal (AC: optional-but-recommended)

Emit the orphan count as an observable signal so the condition is visible before a user notices (would have caught #1705 proactively): a structured log line with `orphan_shows` / `orphan_entries` counts each run, and a Sentry `captureMessage` (warning) when the count exceeds a threshold. A full CloudWatch dimensionless-companion metric (org convention) is noted as a follow-up rather than built here (the job publishes no CloudWatch metrics today; adding that pathway is its own increment).

## Files (PR 2 unless noted)

**PR 1 (extraction, no shipped-behavior change) — Option C:**
- `shared/legacy-mirror/` — new `@wxyc/legacy-mirror` workspace: `package.json` (deps `@sentry/node`, `drizzle-orm`, `@wxyc/database`), `tsconfig.json`, `tsup.config.ts`, `src/index.ts`, `src/http-mirror.ts` (from `apps/backend/middleware/legacy/http.mirror.ts`), `src/rotation-match.ts` (from `rotation-match.mirror.ts` — its `@wxyc/database` import stays a normal cross-package import).
- `apps/backend/middleware/legacy/http.mirror.ts` + `rotation-match.mirror.ts` — thin re-export shims from `@wxyc/legacy-mirror` (preserve existing import sites so collaborator `jest.mock('.../legacy/http.mirror')` targets keep intercepting; R3 High #1).
- `apps/backend/middleware/legacy/flowsheet.mirror.ts` — **imports unchanged** (keeps importing `./http.mirror.js` / `./rotation-match.mirror.js` shims); no swap.
- `apps/backend/package.json` — add `@wxyc/legacy-mirror` dep; root `package-lock.json` — `npm install` to register the new shared workspace.
- **`Dockerfile.backend` prod stage (impl discovery — CI hard-fail otherwise):** the prod stage enumerates each shared package explicitly (`COPY ./shared/<pkg>/package*` before `npm install --omit=dev`, then `COPY --from=builder .../shared/<pkg>/dist`). The `apps/backend` runtime imports `@wxyc/legacy-mirror` via the shim, so **both** lines must be added for it — the builder already builds it via the `shared/**` glob, but without the prod-stage copies the container dies at boot with `ERR_MODULE_NOT_FOUND: Cannot find package '@wxyc/legacy-mirror'` and the CI healthcheck times out. (`Dockerfile.auth` and the job Dockerfiles don't import it, so they're untouched.)
- **Root `package.json` build ordering (impl discovery):** add `@wxyc/legacy-mirror` to `lint:prebuild` **and** `predev` (which today build only database/authentication/lml-client/metadata). Root `typecheck` = `lint:prebuild` then `typecheck --workspace=shared/** --workspace=apps/**`; `apps/backend` imports `@wxyc/legacy-mirror` via the shim, so its dist/types must exist before apps typecheck — matches how `@wxyc/lml-client` is wired (a built dep, **not** a `tsconfig` project reference; `apps/backend/tsconfig.json` references only database + authentication).
- `jest.unit.config.ts` — add the `@wxyc/legacy-mirror` moduleNameMapper entry (mirrors the existing `@wxyc/lml-client`/`@wxyc/metadata` → `src/index.ts` mappings) so unit suites resolve the source. **Not** the integration config (R5 Medium): the integration suite runs via `jest.config.json`, which has no `moduleNameMapper` — `tests/integration/mirror-http.spec.js` resolves `@wxyc/legacy-mirror` as a real built workspace dep via node resolution (so `npm install` + build must register/build the new package).
- `tests/unit/middleware/legacy/http.mirror.test.ts` + `rotation-match.mirror.test.ts` — repoint to the moved module + mock the DB at the new boundary (R3 High #1). Collaborator suites (`endshow-shape-guard`, `delete-entry-legacy-id`, `mirror.loop-prevention`, `startshow-marker-mirror`) unchanged; `tests/integration/mirror-http.spec.js` is the behavior-parity guard.

**PR 2 (the reconcile job):**
- `jobs/legacy-mirror-reconcile/{job.ts, orchestrate.ts, logger.ts, package.json, tsconfig.json, tsup.config.ts}` — entrypoint takes the `flowsheet-metadata-backfill/job.ts` skeleton (init logger → try/catch/finally → `closeDatabaseConnection`/`closeLogger`) and **layers two net-new steps** on it (neither exists anywhere in the repo today — R5 Low): an advisory-lock acquire before the sweep, and a PostHog `shutdown()` in `finally`. Co-located `logger.ts` per the every-job convention (R2 Low). `finally` = PostHog `shutdown()` → advisory-lock client `end()` → `closeDatabaseConnection()` → `closeLogger()` (review Medium #4 + R2 Medium). `package.json` deps: `posthog-node` (first `jobs/` PostHog reader — R2 Low), `@sentry/node`, `@wxyc/database`, `@wxyc/legacy-mirror`. `cron-schedule` real value (proposed `0 8 * * *` UTC ≈ 03:00 ET, off-peak; overridable — see below); `job-type` defaults to `cron`.
- `scripts/check-legacy-entry-id-writes.mjs` — **add the exact writer file to the `ALLOWLIST` (R2 High + R4 Low #5).** Hard-fail CI job (`.github/workflows/test.yml`) that greps `/\blegacy_entry_id:/` across `jobs/**` and exits 1 for any unlisted file. The job confines the `.set({ legacy_entry_id })` write to a **single** module (`jobs/legacy-mirror-reconcile/orchestrate.ts`) → one allowlist entry; a second writer file would need its own entry. Also add the paired three-use comment to that writer *and* to `schema.ts:875` (the script header requires both, not just the allowlist).
- `Dockerfile.legacy-mirror-reconcile` — two-stage, copies `shared/*` (incl. the new `shared/legacy-mirror`) and the job dir; `--env-file .env` supplies `TUBAFRENZY_URL`, `MIRROR_API_KEY`, `POSTHOG_API_KEY`, `SENTRY_DSN` (R4 Low #6 — the moved `http-mirror.ts` calls Sentry directly + the detection `captureMessage`; env-vars.md notes per-cron DSN has been a missed step historically), DB vars.
- `scripts/resolve-cron-schedule.sh` — add `legacy-mirror-reconcile` to the `BACKFILL_CRON_SCHEDULE` allowlist `case` **only if** we want a per-deploy override (its unit test `tests/unit/scripts/resolve-cron-schedule.test.ts` must be updated in lockstep). Default: rely on package.json's `cron-schedule`, no allowlist entry.
- `docs/env-vars.md` — document the **new** knobs `RECONCILE_WINDOW_HOURS`, `RECONCILE_SETTLE_MINUTES`; **reuse the shared** `LIVE_ACTIVITY_LOOKBACK_SECONDS` / `LIVE_ACTIVITY_PAUSE_MS` names rather than a `RECONCILE_`-prefixed fork (R4 Low #4); and add the currently-undocumented `TUBAFRENZY_URL`, `MIRROR_API_KEY`, `POSTHOG_API_KEY`, `SENTRY_DSN` for this cron (R4 Low #6 + review Medium #5).
- `CLAUDE.md` — add the `@wxyc/legacy-mirror-reconcile` **job** row *and* the `@wxyc/legacy-mirror` **shared-package** row to the monorepo workspace table (review Medium #5).
- Root `package-lock.json` — `npm install` at root to register **both** new workspaces (`shared/legacy-mirror` in PR 1, the job in PR 2) (per memory: a new workspace needs lockfile sync or CI `npm ci` fails).
- Tests: `tests/unit/jobs/legacy-mirror-reconcile/*.test.ts` (all-or-nothing selection, idempotency guard, flag-off short-circuit, ordering show-before-entries, signoff-only-for-freshly-created-finalized, partial-mirror detection/report, pause, advisory-lock bail) and an integration test against the mock tubafrenzy API (`tests/integration/mirror-http.spec.js` precedent).

## Acceptance criteria mapping

- [ ] Un-mirrored shows (`legacy_show_id IS NULL`, real started/finalized, in window) re-driven → tubafrenzy show + markers + signoff (if finalized). → shows sweep + all-or-nothing entries sweep (markers are just NULL-legacy entries) + freshly-created-finalized signoff.
- [ ] Un-mirrored `flowsheet` rows (`legacy_entry_id IS NULL`, not loop-guarded) on all-or-nothing shows re-driven; partial-mirror shows reported not auto-appended (review High #2). → entries sweep + partial-mirror report.
- [ ] Idempotent second run = no-op; no duplicate tubafrenzy shows/entries. → IS NULL guard + persist + advisory lock; duplicate risk bounded (see above).
- [ ] Respects `backend-mirror` flag, BS#908 loop guard, cooperative pause. → flag eval + NULL-legacy selection + `awaitQuietWindow`.
- [ ] Tests: unit (selection + idempotency + partial exclusion + signoff scope) + integration (mock tubafrenzy). → test list above.
- [ ] Mechanism decision documented. → this plan / PR description.

## Constraints honored

Idempotency (IS NULL guards + loop guard), ordering (show before entries), flag gate, data safety (only *creates missing* tubafrenzy rows; the only BS writes are setting previously-NULL legacy ids — never deletes/overwrites), cooperative pause, bounded recent window (not a historical backfill — 172277-class remediation stays a separate explicitly-scoped job).

## Resolved from first review

- **High #1 rotation-match parity** — extract `rotation-match.mirror.ts` to shared too; job calls `isActiveRotationMatch`.
- **High #2 partial-mirror ordering** — auto-heal scoped to all-or-nothing shows (correct order guaranteed); partial-mirror shows detected + reported, not auto-appended.
- **Medium #3 signoff** — sign off freshly-created finalized shows; idempotent by construction.
- **Medium #4 PostHog lifecycle** — `client.shutdown()` in `finally`.
- **Medium #5 docs** — `docs/env-vars.md` + CLAUDE.md job-table row added to PR 2 Files.
- **Low #6 overlap** — `pg_try_advisory_lock` single-flight guard.

Resolved from second review:
- **R2 High** — new `legacy_entry_id` writer added to `scripts/check-legacy-entry-id-writes.mjs` ALLOWLIST (CI hard-fail otherwise).
- **R2 Medium (deps)** — ~~`@sentry/node` added to `shared/database/package.json`~~ **superseded by Option C (R4)**: the moved helper lives in the new `@wxyc/legacy-mirror` package, which declares its own `@sentry/node`; `shared/database/package.json` stays `drizzle-orm`/`node-ssh`/`postgres`.
- **R2 Medium (lock)** — advisory lock held on a dedicated `createPostgresClient({ max: 1 })` client, not the pooled `db`.
- **R2 Low** — job ships its own `logger.ts`; `posthog-node` added to job deps.

Resolved from third review:
- **R3 High** — extraction is not a "pure move": app consumers keep importing the app-path shim (unchanged) so collaborator mocks still intercept; the two *implementation* test suites are explicitly repointed. No "tests untouched" claim.
- **R3 Medium (signoff)** — entry+signoff heal keyed on `legacy_show_id IS NOT NULL` all-or-nothing shows (covers mid-run-crash recovery), signoff for any finalized such show; explicit second selection query added.
- **R3 Medium (rotation-match)** — moved `rotation-match.ts` imports (relative under Option A; a normal `@wxyc/database` cross-package import under the now-recommended Option C).
- **R3 Low** — pause reuses the shared `live-activity.ts` probe (schema-aware); dropped the inaccurate "newer-job convention" framing.

Resolved from fourth review:
- **R4 High (data safety)** — show sweep gains the same all-or-nothing `NOT EXISTS(… legacy_entry_id IS NOT NULL)` guard, preventing a duplicate/empty tubafrenzy show when `addEntry` already server-side-auto-resolved one.
- **R4 Medium (flag)** — reconcile evaluates `backend-mirror` **per show** on the show's `primary_dj_id`, faithfully mirroring the live per-caller gate under either kill-switch or cohort rollout.
- **R4 Medium (layering)** — switched to Option C: a dedicated `@wxyc/legacy-mirror` package, keeping the HTTP/Sentry client out of `@wxyc/database`.
- **R4 Low** — reuse shared `LIVE_ACTIVITY_*` env names; single-writer allowlist entry + paired comments; provision + document `SENTRY_DSN` and the three other cron vars.

## Open questions for review (non-blocking; sensible defaults chosen)

1. **Schedule & cadence** — daily `0 8 * * *` UTC enough for a self-heal, or more frequent given orphans degrade the public flowsheet until the next sweep? Add to the `BACKFILL_CRON_SCHEDULE` override allowlist or keep schedule static? (Default: daily, static.)
2. **Window/settle defaults** — 48h window / 15min settle sane defaults (env-tunable)?
3. **Detection depth** — log + Sentry-on-threshold (incl. the partial-mirror report) sufficient for this ticket, with the CloudWatch dimensionless-companion metric as a follow-up? (Default: yes, metric deferred.)
4. **Historical backfill** — confirm the one-time 172277-class (partial-mirror) remediation stays a separate ticket, and this recurring job deliberately does not reach back past the window or renumber existing tubafrenzy sequences. (Default: separate ticket.)
