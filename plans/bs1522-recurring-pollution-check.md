# BS#1522 — Schedule the rotation release-id pollution audit as a recurring check

Issue: [WXYC/Backend-Service#1522](https://github.com/WXYC/Backend-Service/issues/1522). Turns the one-shot auditor `scripts/audit/bs_rotation_release_id_pollution.py` (PR #1520, fixed in #1523/PR #1524) into a weekly scheduled prod check with per-`rotation_id` fingerprinted Sentry alerting. All calibration blockers are closed: #1517 (alert on `mismatch` only; the 60–79 `suspect` band was 100% false-positive), #1523 (auditor prod-data-shape defects), and #1528 (the 11 held degenerate-reference rows — resolved 2026-07-06: 4 repointed to `md_verified`, 4 NULL-and-reset, 3 confirmed-correct leaves).

## Current state the check will see

Post-#1528 prod state (verified 2026-07-06): active rows with a stored release id by source = `discogs_direct_backfill` 168, `md_verified` 4, `tubafrenzy_paste` 1, `lml_offline_backfill` 0 — the 2026-05-29 relabel (`scripts/relabel-rotation-direct-backfill.sql`, #1521) folded the rescue lineage's `lml_offline_backfill` rows into `discogs_direct_backfill`, and the bucket only repopulates if the _sanctioned_ trust-gated one-shot (`jobs/rotation-release-id-backfill`) is deliberately re-run. The default candidate set (`lml_offline_backfill` + `discogs_direct_backfill`, active only) is therefore ~168 rows today (~9 min at 20/min pacing). Expected verdicts: everything `ok`/`suspect`/`error` **except the 3 confirmed-correct "leave" rows from #1528 (8276, 8277, 15726)** — their free-text references are degenerate ("s/t"-style), so they score below 60 by construction and land in `mismatch` despite being verified correct. Without handling, the first scheduled run opens 3 standing Sentry issues for known-good rows — the exact re-fire-on-known-rows failure this ticket exists to avoid.

## Decision 1: runner = Option 1, Python-in-Docker `jobs/` cron

The issue lists 4 options and asks the implementer to pick and record rationale. The review comment (2026-07-06) flagged Option 1's scaffolding cost as understated and asked that 1 and 2 be treated as co-equal pending the deploy-base feasibility check. That check is now done, and it favors **Option 1**:

1. **The pipeline is language-agnostic everywhere it touches the job.** `deploy-base.yml` builds with `docker build -f Dockerfile.<target>` (content unconstrained), reads `job-type`/`cron-schedule` from `jobs/<target>/package.json` via yq (a shim package.json satisfies it — that's where the metadata lives for TS jobs too), and the installed crontab line is a generic `docker run --env-file .env <image>` with the command baked into the image. Auto-deploy target detection is `npx turbo ls --affected` over npm workspaces (`jobs/*` glob) — any directory with a `package.json` is a workspace member, and Turborepo maps changed files inside the package dir to the package regardless of extension. Requirements: root `npm install` to sync `package-lock.json` (the known new-workspace gotcha that bit BS#1491), and a **no-op `build` script** (`"build": "echo 'python job: no compile step'"`) — the root `build` script is `npm run build --workspace=@wxyc/database --workspace=shared/** --workspace=apps/** --workspace=jobs/**` **without `--if-present`** (only `ci:build` got the `--if-present` treatment in PR #1452), so a jobs workspace lacking the script fails CI's lint-and-typecheck build step outright. (`typecheck` already excludes `jobs/**`.)
2. **Linter/formatter behavior on `.py` files, verified empirically in this worktree** (a probe `.py` file was placed under `jobs/` and the CI commands run against it):
   - `prettier --cache --check .` (the exact `format:check` CI form) exits 0 with the `.py` file present — directory expansion only picks up files with an inferable parser, so `.py` is silently skipped. The failure the reviewer anticipated occurs only with an explicit glob (`prettier --check "jobs/**"` does error with "No parser could be inferred"). To make the skip explicit rather than incidental, and to protect glob-form invocations, the PR **adds `*.py` to `.prettierignore`** (the existing `audit` entry already shields `scripts/audit/`; the new entry covers the job package and any future Python).
   - ESLint uses flat config (`eslint.config.mjs`, `tseslint.config`) — there is no `.eslintignore` because flat config doesn't consume one. Flat config only lints files matched by a config block's `files` patterns, which are TS-only here (plus `scripts/**` is globally ignored outright). A `.py` file matches no block and is never parsed. No config change needed; the full `npm run lint` runs locally pre-push with the Python files present as the belt-and-suspenders check.
3. **Option 2's "reuses all the scaffolding" premise is wrong for this repo.** The TS jobs' scaffolding is deliberately copied per job, not shared: `jobs/rotation-lml-identity-backfill/logger.ts` says it "mirrors `jobs/rotation-release-id-backfill/logger.ts` verbatim — the duplication keeps this job's build graph independent." The orchestrator and LML limiter are likewise per-job. The only genuinely shared import is `checkLiveActivity` (`shared/database/src/live-activity.ts`) — a 10-line SQL probe. So Option 2 copies ~200 lines of TS scaffolding; Option 1 writes ~150 lines of Python scaffolding. That's a wash.
4. **The decisive cost is scoring parity.** The engine's `similarity()` is `difflib.SequenceMatcher.ratio()` (Ratcliff/Obershelp + autojunk). A TS port must reimplement that algorithm, pinned by only the 5 `--self-test` scoring vectors — near-threshold divergence (the 60/80 boundaries) on unpinned strings is silent and is exactly the subtle-scoring-drift class #1523 was about. Python-runner literal import gives zero drift by construction, satisfying the "shared, not copied" AC in its strongest form.

Options 3 (fold into the daily identity cron) and 4 (EC2 crontab) are rejected for the reasons already in the issue body (near-complement predicate / cadence contradiction; outside the pipeline's cron registration).

Cost accepted: first Python runtime in the `jobs/` fleet. The Docker-per-job model absorbs the runtime; the scaffolding reimplementation (logger, pause probe, Sentry init) is sized above and mirrored on the sibling contracts (four-tag log lines, counter shape, `BACKFILL_LML_*`/`LIVE_ACTIVITY_*` env names).

## Decision 2: relocate the engine into the job package

`git mv scripts/audit/bs_rotation_release_id_pollution.py jobs/rotation-release-id-pollution-check/pollution_engine.py`. This solves two structural problems at once:

- **Turbo affected-detection only sees files inside the package dir.** If the engine stayed at `scripts/audit/`, an engine edit would never mark the job affected → auto-deploy never rebuilds → the cron runs stale scoring until someone remembers a manual deploy. Inside the package, engine edits auto-deploy like any job change.
- **`scripts/audit/**` is outside every CI path filter\*\*, so engine edits are CI-invisible today. Inside the package, the jest shell-out test (below) plus a Dockerfile build-time self-test gate cover it.

`scripts/audit/bs_rotation_release_id_pollution.py` is replaced by a thin wrapper (docstring pointer + `sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "jobs", "rotation-release-id-pollution-check"))` + `from pollution_engine import main`) so the ad-hoc local/clone usage documented in prior issues keeps working; the mechanism is anchored to `__file__`, not the CWD, and is documented in the job README under "Local usage". The prod manual-run runbook improves: instead of scp+venv, run the job image already present on the EC2 host (`docker run --rm --env-file .env <ecr>/rotation-release-id-pollution-check:latest`), with CSV/summary output to a bind mount when wanted. `scripts/audit/bs_rotation_release_id_remediation.py`'s docstring pointer to the auditor gets updated, as does `jobs/rotation-release-id-backfill/README.md`.

## Decision 3: the 3 leave rows — flip provenance to `md_verified` (prod write, gated on fresh approval)

Recommended: a one-shot guarded UPDATE flipping 8276, 8277, 15726 from `discogs_direct_backfill` to `md_verified`. They meet `md_verified`'s definition exactly (schema comment: written only by operator-run remediation after a human verified the id against Discogs — which is precisely what the #1528 MD pass did; LEAVE just didn't write anything at the time). This removes them from the default-sources candidate set with zero standing job config, the same way the 4 repoints dropped out. Mechanically: a small addendum script in `scripts/audit/` mirroring the #1528 script's conventions (per-row `WHERE id = ? AND discogs_release_id = <verified id> AND discogs_release_id_source = 'discogs_direct_backfill'` guards, SELECT before/after, dry-run default, `--self-test`); `lml_identity_id` is **not** cleared — the release id doesn't change, so the identity remains valid (BS#1380 invariant untouched). Runs on prod EC2 via the established runbook, **only after explicit user approval** (today's approval covered the #1528 run only).

Fallback if the flip is declined: a `KNOWN_ACCEPTED_ROTATION_IDS = {8276, 8277, 15726}` suppression set in the job (the issue body's sanctioned alternative), each entry commented with the #1528 verification reference. The flip is preferred because it keeps the "known-good" fact in the data where the enum was built to carry it, rather than in job config that outlives its reason.

**Execution flow, explicitly:** the flip script `scripts/audit/bs_1522_leave_rows_md_verified.py` **ships in the PR** (committed as durable provenance, same convention as `bs_1528_md_remediation.py` / #1529), but is **not executed by CI or the deploy** — it is applied manually on prod EC2 after the PR merges, via the established runbook (scp, `/tmp` venv or the audit-venv, creds parsed in Python from `docker inspect backend`, shred after), and only after the user grants prod approval for this specific run in this or a future session. Approval is requested at rollout step 4, not assumed. If approval is declined or delayed past the first Monday tick, the fallback suppression set must be enabled first (a one-line constant is included in `job.py` but empty by default; enabling it is a normal PR).

**No baseline circularity:** the provenance baseline (Decision 4) is computed **once at implementation time** and includes 8276/8277/15726. The baseline is a superset allowance — ids in the baseline that no longer carry the stamp simply never appear in the provenance query, so the same constant is correct before the flip (rows present, in-baseline, no alert), after the flip (rows absent from the query), and if the flip never happens. No post-flip recompute or constant-update PR is needed; rollout step 4's "verify" is a read-only sanity check, not a required edit.

## Decision 4: the provenance-anomaly branch — in scope, set-based baseline

The review comment's item 2: "new `discogs_direct_backfill` row appearing after #1521's retirement" is a second, separate detection the mismatch scorer can't cover (a new stamped row whose title happens to match would score `ok`). With #1521 closed, no sanctioned writer emits that stamp, so _any_ new membership is a writer regression. Implementation: freeze the set of rotation*ids currently stamped `discogs_direct_backfill` (**including killed rows** — a regressed writer could stamp anything, and including the 3 leave rows per Decision 3's no-circularity note) as a constant in `job.py`. **Computation procedure**: initial value from the repo's `dev_env/seed-clone.sql` prod snapshot (parse the rotation COPY block; no DB needed) — safe because every source-change since that snapshot \_removed* rows from the stamped set (#1517's 31 NULL-and-resets, #1528's 8) and a superset baseline is harmless. The residual risk is rows the retired rescue writer stamped _after_ the snapshot but _before_ #1521's retirement (2026-07-05): those would be missing from the clone and would false-alert. Therefore the authoritative check is a **read-only `SELECT id FROM wxyc_schema.rotation WHERE discogs_release_id_source = 'discogs_direct_backfill' ORDER BY id` against prod during the already-approved Decision 3 session** (same SSH runbook, no extra approval scope) — diff against the constant, and if prod has ids the constant lacks, ship the one-line constant addition before the first Monday tick. Both the procedure and the "superset is safe, subset false-alerts" rule go in the job README so future baseline edits aren't guessed at. Each run, `SELECT id FROM rotation WHERE discogs_release_id_source = 'discogs_direct_backfill'` (no kill filter, no LML calls) and alert on any id not in the baseline, fingerprinted `['rotation-release-id-pollution-check', 'provenance', <rotation_id>]`. Set shrinkage (future remediation) is fine and alerts nothing. This branch is verified by unit test (stub rows), not by the synthetic-prod insert — the AC's synthetic test covers the mismatch path.

## Package shape

```
jobs/rotation-release-id-pollution-check/
  package.json          # name @wxyc/rotation-release-id-pollution-check, job-type: cron (default), cron-schedule: "0 7 * * 1", no-op build script (see below)
  pollution_engine.py   # git mv'd auditor — canonical scoring + fetch + audit engine, unchanged logic
  job.py                # entrypoint: env, Sentry, JSON logging, cooperative pause, engine drive, alert emission, counters
  requirements.txt      # psycopg[binary], sentry-sdk (pinned)
  README.md             # runbook: alert meaning -> #1517 remediation recipe; counter shape; manual-run recipe; baseline-update procedure
Dockerfile.rotation-release-id-pollution-check   # at PROJECT ROOT alongside the other job Dockerfiles (deploy-base builds `-f Dockerfile.<target>` from root context); python:3.12-slim; RUN self-tests as build gate (sketch below)
tests/unit/jobs/rotation-release-id-pollution-check.test.ts   # jest shell-out: python3 pollution_engine.py --self-test && python3 job.py --self-test
scripts/audit/bs_rotation_release_id_pollution.py   # thin wrapper importing pollution_engine
scripts/audit/bs_1522_leave_rows_md_verified.py     # Decision 3 flip script (ships in PR, runs manually post-merge with approval)
.prettierignore                                      # + *.py (see Decision 1 point 2)
```

Dockerfile sketch (single stage — no compile step, so no builder/prod split like the Node jobs):

```dockerfile
FROM python:3.12-slim
WORKDIR /rotation-release-id-pollution-check
COPY ./jobs/rotation-release-id-pollution-check/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY ./jobs/rotation-release-id-pollution-check/ ./
# Build gate: a scoring or job-logic regression fails the image build in both
# CI and deploy-base, mirroring the role tsup/tsc plays for the Node jobs.
RUN python3 pollution_engine.py --self-test && python3 job.py --self-test
ENV DB_APPLICATION_NAME=wxyc-rotation-release-id-pollution-check
CMD ["python3", "job.py"]
```

(`psycopg[binary]` wheels bundle libpq, so no apt packages are needed. `DB_STATEMENT_TIMEOUT_MS` doesn't apply — the job issues only short SELECTs and sets a psycopg statement timeout in code.)

`job.py` responsibilities (engine stays pure):

- Env, two tiers. **Required** (job aborts at init if missing): `DB_*`, `LIBRARY_METADATA_URL`, `LML_API_KEY`, `SENTRY_DSN` — all already present in the EC2 `.env` because sibling cron jobs (`rotation-lml-identity-backfill`, `flowsheet-metadata-backfill`) consume the same set; nothing to add before go-live. **Optional tuning** (in-code defaults apply when absent from `.env`, which `docker run --env-file` simply doesn't pass): `LIVE_ACTIVITY_LOOKBACK_SECONDS` (default 60, 0 disables), `LIVE_ACTIVITY_PAUSE_MS` (default 30000), `BACKFILL_LML_RATE_PER_MIN` (default 20), `DRY_RUN` (default off; suppresses Sentry events and logs what would fire). No `docs/env-vars.md` delta beyond a one-line note that this job reuses the existing names; no pre-go-live `.env` edits.
- Cooperative pause (BS#735): Python port of `live-activity.ts` — `SELECT 1 FROM wxyc_schema.flowsheet WHERE entry_type = 'track' AND add_time > now() - (interval '1 second' * %s) LIMIT 1` (literal `'track'` kept inline to match the 0050 partial index), probed before each row's LML call, sleep-and-reprobe while true. Injected into the engine's `audit()` loop via a pre-row callback (small engine change: optional `before_row` hook param, default no-op — keeps the engine importable/self-testable unchanged).
- Logging: four-tag JSON contract (`repo`, `tool`, `step`, `run_id`), `step: init` / `live_activity_pause` / `finished` / `failed`, mirroring the sibling logger semantics.
- Counters in `finished`: `scanned`, `ok`, `suspect`, `mismatch`, `alerted`, `suppressed` (0 unless the fallback suppression set is in use), `error`, `provenance_anomalies`, with invariant `scanned == ok + suspect + mismatch + error`.
- Alerts (all `sentry_sdk.capture_message`, level=warning, tags `repo`/`tool`/`run_id`, extras carrying ref/stored titles, score, source, release id):
  - per unsuppressed `mismatch` row: fingerprint `['rotation-release-id-pollution-check', 'mismatch', <rotation_id>]` — a stable unremediated row regroups into its existing Sentry issue on later runs (no new-issue noise); a remediated row stops firing and auto-resolves; a genuinely new bad write opens a fresh issue.
  - per provenance anomaly: fingerprint as in Decision 4.
  - run-degraded guard: if `error > max(5, 25% of scanned)` (LML outage shape), one run-level event fingerprinted `['rotation-release-id-pollution-check', 'run-degraded']` instead of treating it as silence; per-row `error` rows never alert individually.
  - job crash: `capture_exception`, exit 1.
- Alerting is `capture_message` events, not span attributes — so the BS cron `SENTRY_TRACES_SAMPLE_RATE=0` default (the BS#1402/#1428 trap) does not apply; no tracing config needed.

Schedule: `0 7 * * 1` (Monday 07:00 UTC = 03:00 ET). The cron inventory's source of truth is the `cron-schedule` field of each `jobs/*/package.json` (per `scripts/resolve-cron-schedule.sh`); enumerate with `for f in jobs/*/package.json; do jq -r '[.name, .["cron-schedule"] // "-"] | @tsv' $f; done`. As of this plan that yields: hourly `:00` (artist-identity-etl), dailies 04:15/04:30/04:45/05:00/05:15/06:00×2, and `*/30` ETLs — Monday 07:00 is clear of all of them, after the 06:00 LML-paced dailies' typical windows, at dead-air hours; the pause probe defends any residual overlap. Weekly cadence per the issue's own proportionality argument. ~200 rows at 20/min ≈ 10–11 min per run.

## What is NOT in scope

- No schema/migration changes.
- No remediation writes from the job — read-only, per the issue's constraint (the Decision 3 flip is a separate operator script, not job behavior).
- No standing-mismatch digest — with the leave rows flipped, the standing set is empty; revisit only if a future run accumulates deliberately-deferred rows.
- No `md_verified` in default `--sources` (per the 2026-07-06 issue annotation: suppress by provenance, not by score).

## Test plan

1. Engine `--self-test` unchanged and passing (relocation is a move, not a rewrite).
2. `job.py --self-test`: pure-function checks — fingerprint construction, suppression/known-set filtering, provenance baseline diff, run-degraded threshold, counter invariant, env parsing defaults.
3. Jest shell-out test runs both self-tests in CI. This is a new pattern for unit tests (precedent exists in `tests/integration/migrations.spec.js` shelling to external tools). The `python3`-availability assumption is made **explicit and load-bearing**: the test does `spawnSync('python3', ['--version'])` first and **fails loudly with a clear message** if the interpreter is missing rather than silently skipping — a silent skip would let a scoring regression through the exact gate this test provides. The assumption is documented in the test's header comment and the job README: `python3` is present on `ubuntu-latest` CI runners and org dev machines (macOS). The Dockerfile `RUN` gate is the independent second layer (deploy-base build fails if scoring breaks even when jest didn't run).
4. **Synthetic mismatch (AC)**: in the local dev DB (seed-clone has real rotation data), insert a rotation row whose free-text `(artist_name, album_title)` points at a `discogs_release_id` for a different album (source `lml_offline_backfill`), run `job.py` against staging LML with a real `SENTRY_DSN` and `environment=development`, confirm the Sentry event fires with the per-`rotation_id` fingerprint. Never against prod. **Cleanup, explicitly**: DELETE the synthetic rotation row (guarded `WHERE id = <synthetic id>`; the dev DB is disposable via `db:stop` regardless), and manually resolve the Sentry issue in the UI — the `environment=development` tag keeps it out of prod alert routing either way. Staging LML is only read (`GET /discogs/release/{id}`), so nothing to clean there. If the test fails partway, the same two cleanup steps apply.
5. Local checks before push: **root `npm install` first** (new workspace → `package-lock.json` must be committed in sync, else CI `npm ci` fails in both lint-and-typecheck and unit-tests — the BS#1491 failure mode), then typecheck, lint, format:check, **root `npm run build`** (exercises the no-op build script through the exact CI glob), unit tests, `lint:migrations` (no-op here), plus both Python self-tests.

## Rollout sequence

1. PR with everything above. PR **references** #1522 but does not `Closes` it — the "two consecutive scheduled prod runs" AC can only be satisfied ~2 weeks post-deploy.
2. Record the Option-1 rationale as a comment on #1522 (AC requirement) when the PR opens.
3. Merge → auto-deploy registers the cron. Verify the deploy run's `Deploy Cron Job` + `Confirm cron is updated` steps and crontab line.
4. Decision 3 prod flip: request user approval, then run `bs_1522_leave_rows_md_verified.py` on prod EC2 via the established runbook, before the first Monday tick. Read-only sanity check of the provenance-stamped set afterward (the baseline constant needs no edit — see Decision 3's no-circularity note). If approval is declined/delayed, enable the fallback suppression set first instead.
5. Optional immediate smoke: one-shot `docker run --rm --env-file .env <image>` on EC2 with `DRY_RUN=true`; expect `mismatch=0, alerted=0` (or the dry-run log of what would fire).
6. Configure the Sentry alert rule (new-issue notification routed for `tool:rotation-release-id-pollution-check`) — Sentry UI step, recorded on the issue.
7. After two consecutive Monday runs with expected counters: tick the ACs, close #1522. Update the CLAUDE.md package table and memory.

## Risks

- **First Python job in the fleet**: the deploy pipeline treats it as an opaque Docker target (verified against `deploy-base.yml`), but this is still the first exercise of that generality — mitigated by the smoke run in step 5 and by `Confirm cron is updated`.
- **Lockfile sync**: new workspace requires root `npm install` or CI `npm ci` fails in two jobs (bit BS#1491) — explicitly in the checklist.
- **SequenceMatcher behavior is now load-bearing weekly** rather than one-shot: pinned by self-tests at build time; any future scoring change auto-deploys because the engine lives in the package (Decision 2).
- **Sentry noise regression**: if calibration is wrong and a false-mismatch class appears, each false row is one fingerprinted issue (bounded by row count, not run count); the runbook documents raising to #1522's successor rather than muting the rule.
