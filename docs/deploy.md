# Deployment

## Where it runs

- Hosted on EC2
- CI/CD via GitHub Actions: push to `main` auto-triggers `.github/workflows/deploy-auto.yml`, which delegates to the reusable `deploy-base.yml`. `deploy-manual.yml` (Actions tab → Manual Build & Deploy → Run Workflow, with `target` + optional `version` inputs) is for re-deploying a specific tag, deploying a single app target, or rolling back.
- Docker images built with multi-stage Dockerfile (`node:24-alpine`), stored in Amazon ECR

## CI/CD pipeline detail

The `migrate-dryrun` job (one of the GitHub Actions workflow stages in `.github/workflows/test.yml`) runs only when `db-init` paths change (migrations, schema, `init-db.mjs`, etc.). It restores the most recent automated RDS snapshot to a sandbox DB instance, runs `node scripts/dryrun-migrate.mjs` against it, asserts exit 0, and tears the sandbox down. This catches preconditions that depend on prod data shape (e.g. the `RAISE EXCEPTION` guards added per WXYC/Backend-Service#705) at PR-review time rather than at deploy time. The script reuses `dev_env/format-pg-error.mjs` (#725) so the underlying Postgres error fields surface in the CI log on failure. To re-test against a fresher snapshot, trigger an on-demand snapshot via the AWS RDS console and rerun the workflow.

Network plumbing uses **per-run JIT authorize + revoke** (#757): between `Configure AWS credentials` and the snapshot restore the workflow detects its runner public IP via `checkip.amazonaws.com` and adds a `<runner-ip>/32 → tcp/5432` rule to `SG_DRYRUN_GHA`; an `if: always()` teardown step revokes the rule before sandbox delete, so the SG sits at zero ingress rules between runs. The IAM scoping for the authorize/revoke pair is conditioned on the SG's `Purpose=migrate-dryrun` tag, so the GHA user cannot touch any other security group with the same actions. End-to-end-validated in #775 (the always() teardown was confirmed to revoke even when the migrate step fails).

Provisioning prerequisites (ops, one-time, all idempotent via `scripts/provision-dryrun-aws.mjs`): IAM policy attached to the existing `AWS_ACCESS_KEY_ID` user with `rds:DescribeDBSnapshots`, `rds:DescribeDBInstances`, `rds:RestoreDBInstanceFromDBSnapshot`, `rds:DeleteDBInstance`, `rds:AddTagsToResource`, `ec2:AuthorizeSecurityGroupIngress`, `ec2:RevokeSecurityGroupIngress` (the EC2 pair scoped via `aws:ResourceTag/Purpose=migrate-dryrun`), `ec2:DescribeSecurityGroups`; security group `SG_DRYRUN_GHA` carrying the `Purpose=migrate-dryrun` tag (no permanent ingress rules); repo secrets `PROD_DB_ID`, `PROD_DB_NAME`, `PROD_DB_USERNAME`, `PROD_DB_PASSWORD`, `SG_DRYRUN_GHA`. See WXYC/Backend-Service#726 (initial gate setup) and #757 (shift from static CIDR allowlist to JIT).

## Deploy cadence and migration-chain risk

<!-- @rule id=deploy-cadence-24h enforced-by=none added=2026-05-06 incidents=#run-25337297761 -->

**Auto-deploy on push to `main` covers the common path.** Every merge fires `deploy-auto.yml`, so migrations don't normally stack up between deploys. The remaining risk is a **silent or failed auto-deploy** — if the auto run errors out and nobody notices, subsequent migration PRs land on top of the unapplied chain and recreate the wedge condition this rule was originally written for.

The canonical recent example is the 2026-05-04 deploy wedge ([run 25337297761](https://github.com/WXYC/Backend-Service/actions/runs/25337297761)), where 4 days of accumulated migrations (0071, 0072, 0073) compounded with a retroactive precondition guard added in commit `2710f2e`. Migration 0071's guard fired against current prod state and aborted the chain, leaving the deploy stuck. Had 0071 deployed in isolation immediately after authoring (2026-05-01), the guard wouldn't have been retrofitted yet, and the wedge wouldn't have happened. (That incident predates auto-deploy; under today's setup the same wedge would surface as a failed `deploy-auto` run on the merge that introduced 0071.)

The other defenses in [Project #26 — Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) (legible failure output, pre-flight dry-runs against prod-shaped data, validator checks for retroactive risk) reduce the cost of an individual wedge. Auto-deploy reduces the _likelihood_ of multi-migration stacking by deploying each migration in isolation.

**Practical rule of thumb**: when a PR that touches `shared/database/src/migrations/**` merges, verify the auto-deploy on that push succeeded within 24 hours. If it didn't, run `deploy-manual.yml` to clear the wedge before another migration PR merges on top. The rule is advisory — don't gate merges on cadence, since PR authors don't necessarily own deploys.

## Affected-target scoping (deploy matrix width)

<!-- @rule id=deploy-affected-merge-base enforced-by=tests/unit/scripts/deploy-affected-targets.test.ts added=2026-08-24 incidents=#2264 -->

`setup` → Detect Build Target picks the deploy matrix with `turbo ls --affected` over `github.event.before..github.sha`. That matrix drives **three** jobs per target (`handle-git-tags`, `build`, `deploy`), and GitHub bills a **one-minute minimum per job** — so matrix width is the dominant term in this workflow's cost, not job duration. At 50 targets a run is 155 jobs and ~266 billed minutes for ~156 minutes of actual compute.

**`turbo --affected` fails open.** When it cannot resolve the SCM range it prints a `WARNING  unable to detect git range, assuming all files have changed` and reports _every_ package as affected. That is safe and expensive, and it looks exactly like working.

It was wrong on every run from 2026-03-08 to 2026-08-24. `9ea9846d` introduced the `github.event.before` range and in the same diff deleted `fetch-depth: 2` from this job's checkout, replacing it with `git fetch origin <before> --depth=1`. `actions/checkout` defaults to `fetch-depth: 1`, so the runner held two disjoint shallow grafts with no common ancestor: `git merge-base` exits 1, turbo bails, all 50 targets deploy. The same commit widened the selector from `apps/` to `apps/` + `jobs/`, which wired the defect to the fastest-growing directory in the repo — 0 job targets in March, 10 in May, 24 in July, 47 by late August — so the cost compounded silently as backfill jobs accumulated.

Measured 2026-08-24: `deploy-auto.yml` billed **22,050 minutes in one period, 43.8% of the entire WXYC org's Actions spend**, more than dj-site's e2e and CI suites combined. Merges titled `docs(...)` and `plans: reframe the 2.2 spike memo to findings only` each rebuilt and redeployed all 47 ETL jobs. Across all 126 push ranges in the period, 15% needed no deploy at all and ~48% of the minutes were waste. The same fan-out also cut **5,853 git tags in August against 105 in March** (three tags per target per run), which is why this repo carries ~18k tags.

Two things keep it fixed, and both are load-bearing:

1. **`fetch-depth: 0` on `setup`'s checkout.** The range is only computable with real ancestry. Do not "optimize" this back to a shallow checkout plus a targeted `git fetch <sha> --depth=1` — that is precisely the shape that broke, and it fails silently.
2. **The fallback is decided in the workflow, not by turbo.** The step checks `git merge-base --is-ancestor` itself and splits the two cases apart: a push with no usable base (branch creation, force-push, all-zero `before`) warns and deploys everything, while a range that _is_ resolvable and still fails to diff **exits 1**. A recurrence of this bug now stops the run instead of quietly billing 266 minutes.

The five-month latency is the lesson: over-deploying is invisible because it is safe. Any future change to target selection needs to fail loudly or not at all.

## Job timeouts (`timeout-minutes`)

<!-- @rule id=deploy-job-timeout-headroom enforced-by=tests/unit/scripts/deploy-timeouts.test.ts added=2026-08-25 incidents=#2266 -->

Every job in `deploy-base.yml` sets an explicit `timeout-minutes`. Without one a job inherits GitHub's **360-minute default**, which is a reasonable default for a single job and a bad one here: the matrix from `setup` drives three jobs per target, and both `build` and `deploy` carry `fail-fast: false` — correctly, but that also means a stage-wide stall is not cancelled by a sibling failing. A hang that affects a whole stage would hold ~50 jobs at 360 minutes each until GitHub reaps them.

**This is insurance, not a fix for an observed incident.** No hang has occurred. Caps below are derived from p100 job duration measured 2026-08-25 across 32 `deploy-auto.yml` runs (2026-08-11 → 2026-08-25); nothing came near 360. Runs that read as very long in wall clock are queued behind the `concurrency` group, and queue time is neither billed nor bounded by `timeout-minutes`.

| job                | cap | p100  | headroom |
| ------------------ | --- | ----- | -------- |
| `validate_inputs`  | 10  | 0.38  | 26×      |
| `setup`            | 15  | 1.08  | 14×      |
| `handle-git-tags`  | 10  | 0.63  | 16×      |
| `build`            | 75  | 17.82 | 4.2×     |
| `reclaim-disk`     | 15  | 1.25  | 12×      |
| `ecr-refresh-cron` | 10  | 0.13  | 77×      |
| `migrate`          | 30  | 1.20  | 25×      |
| `deploy`           | 30  | 4.27  | 7×       |

**The caps are loose on purpose, and tightening them is the dangerous direction.** `deploy` runs `docker stop` → `docker rm` → `docker run` over SSH; a cap that fires between stop and run leaves the service **down** — the same hazard `fail-fast: false` on that matrix already exists to avoid. `migrate` applies schema migrations against prod. For both, a slow run is strictly better than a killed one.

`build`'s 75 is the one number that looks out of place. Its p100 is not a lone outlier: three of 1,512 sampled builds exceeded 10 minutes, all successful ETL images that missed the registry buildcache (see **Build image caching** below). A 30-minute cap would sit under 2× a duration seen three times in two weeks, which is the kind of number that eventually fires on a healthy run. 75 still removes 79% of the exposure on the widest job.

Re-measure before lowering any of these — the guard test holds the p100 figures, the date they were taken, and the full derivation.

## Build image caching

<!-- @rule id=deploy-buildx-registry-cache enforced-by=none added=2026-07-21 incidents=#run-29874378612 -->

`build` (in `deploy-base.yml`) uses `docker/build-push-action@v6` with a registry-backed buildx cache instead of a plain `docker build`: `cache-from`/`cache-to` point at a `:buildcache` tag in each target's own ECR repository (`type=registry`, `mode=max`). This matters because the matrix is Turbo-affected-scoped (`setup` → Detect Build Target, `TURBO_SCM_BASE=github.event.before`) and per-target version-skips a rebuild if its tag already exists in ECR (`Check if image exists in ECR`) — both guards make a **leaf** change (one app/job, or none) cheap regardless of caching. A change to a shared dependency (`shared/database`, `shared/authentication`, `shared/lml-client`, a `@wxyc/shared` bump, or `package-lock.json`) sits above every target in Turbo's graph, so all ~50 targets are marked affected and each gets a **new** version tag that can't hit the ECR-exists skip — every image rebuilds. The registry cache is what makes that full-fleet rebuild reuse unchanged layers instead of recomputing all of them from scratch, as happened in the ~23 min `f065761d` deploy ([run 29874378612](https://github.com/WXYC/Backend-Service/actions/runs/29874378612)).

`cache-to` **must** set `image-manifest=true,oci-mediatypes=true` — ECR rejects the default BuildKit cache-manifest media type and only accepts a cache exported as an OCI image manifest; omitting these options makes the cache push fail. It also sets `ignore-error=true` so a transient ECR cache-export failure degrades to a full rebuild instead of failing the deploy — caching is an optimization, not on the deploy critical path. Don't switch to `type=gha`: GitHub Actions cache is capped at 10 GB per repo, and ~50 images' layer caches would thrash/evict each other well below that ceiling — ECR registry cache scales per-repo instead. The three-tag push contract (`:${DEPLOY_TAG}`, `:sha-${github.sha}`, conditional `:latest`) is unchanged, just moved from manual `docker tag`/`docker push` calls into the action's `tags:` list.

The step sets `provenance: false` and `sbom: false`. buildx ≥0.11 (which `docker/build-push-action@v6` defaults on) otherwise generates a provenance attestation on push — `mode=max` on a public repo like this one — which wraps the single `linux/amd64` image in an OCI **image index** carrying an extra, _untagged_ attestation manifest. The `Apply ECR Lifecycle Policy` rule that expires untagged images after 1 day (below) would then reap the child manifests of a tagged deploy image, so a `deploy-manual.yml` rollback to a version older than a day would fail `docker pull :${DEPLOY_TAG}` with a missing-manifest error. Disabling both keeps each push a single manifest — identical in shape to the old `docker build`/`docker push` — so the untagged-expiry rule only ever touches dangling `:buildcache` layers. Do not re-enable provenance without first excluding tagged deploy images' children from the lifecycle policy.

The `npm ci` layer still busts on any `package-lock.json` change — exactly the fleet-wide shared-dep case — so per-target layer caching alone doesn't help the single most expensive layer; it's still recomputed once per target. Collapsing that into a single shared base image every `Dockerfile.<target>` builds `FROM` is a candidate follow-up if the registry cache alone doesn't cut wall-clock enough (BS#1738's suggested-approach step 2), not yet implemented.

**ECR storage**: the `:buildcache` tag holds the live cache manifest per repo; `.github/ecr-lifecycle-policy.json` (applied via `Apply ECR Lifecycle Policy`, run every `build` invocation so a newly-created repository picks it up on its first build) expires untagged images (the dangling layers left behind each time `:buildcache` is retagged) after 1 day and caps `sha-*` tags at the 20 most recent per repo. The `buildcache` tag itself is never matched by either rule, since it's always tagged and never has the `sha-` prefix.

## Dependency caching (`node_modules`)

<!-- @rule id=shared-node-modules-cache-key enforced-by=tests/unit/scripts/ci-node-modules-cache.test.ts added=2026-08-23 incidents=#2256 -->

**Every `node_modules` cache step in every workflow must use the identical key and the identical path list** — the list covering the workspace `node_modules` directories (`apps/*`, `jobs/*`, `shared/*`), not just the root one. GHA scopes an entry to the ref that wrote it, so only a default-branch run can fill the scope PRs restore from; and deps don't all hoist here, so a root-only tree fails the `Validate cached node_modules` gate and gets reinstalled anyway. Bump the key's `-vN` whenever the path list changes — the lockfile hash won't move, and `actions/cache` never overwrites an existing key. `tests/unit/scripts/ci-node-modules-cache.test.ts` enforces all of this and carries the full history (#2256).

## Host disk reclamation (pre-pull GC)

<!-- @rule id=reclaim-before-pull enforced-by=none added=2026-07-27 incidents=#run-30313671442 -->

The lifecycle policy above governs the **ECR registry**, not the **EC2 host's local image store**. Every deploy pulls a fresh version-tagged image per affected target onto the shared prod host (32 GB root FS), and each rollout path GCs old images — but the GC used to run _after_ `docker pull`. On 2026-07-27 the host filled to 93%, and from then on every deploy's image extraction failed with `no space left on device` **before** its own GC could run: full disk → failed rollout → GC skipped → still full, a self-perpetuating wedge that only cleared once ~10 GB of images were reclaimed by hand ([run 30313671442](https://github.com/WXYC/Backend-Service/actions/runs/30313671442)).

The fix is a **pre-pull** reclaim: a standalone `reclaim-disk` job runs **once** — gated before `migrate` (the earliest host pull, of the `db-migrate` image) via `needs`, and transitively before the `deploy` matrix — so a near-full host reclaims its own headroom before anything pulls and can never deadlock on its own pull. It's a single gate rather than a per-matrix-target step so the global sweep runs once, not ~50× across the deploy fan-out, and never touches the host for one-shot-job targets that don't roll out. The job is `continue-on-error` (best-effort headroom must never fail a deploy; a truly out-of-space host still fails loudly at `migrate`/`deploy`). Retention is **asymmetric**: the `reclaim-disk` sweep keeps only the newest **1** version per repo (maximum headroom under pressure), and the two post-pull GCs (`deploy-service/action.yml`, `Deploy Cron Job`) keep the newest **2** — current plus one rollback buffer. Net at-rest footprint is 2 versions per repo; the previous version survives for a fast `deploy-manual.yml` rollback.

Safety invariants, matched across all three blocks: `docker rmi` is always **soft** (never `-f`, `2>/dev/null || true`), so an image pinned by a running or stopped container refuses removal and is skipped — the running services and each cron's current tag (pinned by its last exited `<name>-cron` container) can never be reaped. Pruning is dangling-only (`docker image prune -f`, **never** `-a` or `--volumes`): a blind `prune -a` would delete the freshly-pulled cron images that legitimately have 0 containers until their next scheduled fire, and the host's ECR auth is a static ~12 h token with no credential helper, so an over-prune could strand a cron that then can't re-pull. `sha-*` images are not a host concern — both rollout paths pull only `:$DEPLOY_TAG`; the sole host `sha-*` image is `db-migrate`, trimmed to current by the `migrate` job. Do not move the reclaim back after the pull, and do not switch to `prune -a`.

## ECR auth token refresh (host cron)

<!-- @rule id=ecr-refresh-cron enforced-by=none added=2026-07-28 incidents=#1183 review-after=2027-01-01 -->

ECR issues a static ~12h auth token and the host has no credential helper installed (`amazon-ecr-credential-helper` was evaluated and deferred — see BS#1183). The consumer crons (`artist-identity-etl-cron` hourly, `rotation-etl-cron`/`library-etl-cron`/`flowsheet-etl-cron` every 30 min) normally pull inside that window so they're unaffected, but a once-daily cron (`flowsheet-metadata-backfill`, `0 6 * * *` UTC) can straddle a >12h gap since the last `docker login` on the host. On 2026-05-28 that's exactly what happened: the token had expired, `docker run` failed with `pull access denied ... authorization token has expired`, and nothing recorded it — no exited container (`docker run` never got that far), no alert, no marker. The daily backfill silently skipped a day.

The fix is a standalone `ecr-refresh-cron` job in `deploy-base.yml` (parallel to `reclaim-disk`, not gated on `has_targets`) that idempotently installs a host crontab entry running `aws ecr get-login-password | docker login` every 6 hours — comfortably inside the 12h token lifetime, independent of deploy cadence. It reuses the exact flock-serialized crontab-install idiom the per-target `wxyc_<target>` cron entries already use (same lockfile, `grep -v $CRON_ID` replace), so a rebuilt or reprovisioned host regains the refresh entry on the next push to `main` without a manual `crontab -e`. **Do not embed static AWS credentials in the crontab line** — the installed command relies on the EC2 instance role (already proven to have ECR authorization by the existing crons' successful pulls) resolved via the instance metadata service at execution time, not a secret baked into a world-readable crontab file. **Do not route the refresh job's stderr to `/dev/null`** — that was the pattern that caused the original incident one layer up; it logs to `/var/log/wxyc/cron/ecr-refresh.log` instead so a broken refresh (instance-role hiccup, ECR unreachable, network glitch) is forensically visible before it cascades into the next consumer cron's silent pull failure.

Host-specific gotchas the install step accounts for, none of which apply to the existing `docker`-only crontab entries so none had been hit before: (1) `/var/log` is root-owned, so the install step `sudo mkdir` + `sudo chown`s the log dir once rather than assuming the SSH/cron user can write there directly (`sudo` for privileged host edits is an established pattern on this box — see `docs/ops-album-level-backfill-phase3.md` / `docs/ops-lml-cron-revalidation.md`); the log FILE gets the same `sudo touch` + `sudo chown` treatment, since a stray root-owned file left over from manual host debugging (or an earlier iteration of this job) would make the append fail even with a writable dir; (2) user crontabs run with a minimal `PATH` that may not include `aws`, so the install step resolves `aws`/`docker` to absolute paths via `command -v` (from the full-PATH login shell) and bakes those into the crontab line rather than relying on cron's `PATH` to find them; (3) the piped `aws ecr get-login-password | docker login` is wrapped in `bash -c 'set -o pipefail; ...'` inside the crontab line itself (not just at the top of the install script), so a failed `aws` call can't be masked by `docker login`'s own exit status on the 6-hourly cron-triggered runs, which execute in a fresh shell that never inherited the install script's own `set -eo pipefail`; (4) the install step runs the exact installed command once synchronously right after writing the crontab, so a broken instance-role grant, an unwritable log dir, or a PATH miss is caught immediately rather than waiting up to 6h to find out. That validation is best-effort, though — the whole step is `continue-on-error`, so a failure there is a non-blocking warning on the step, not a failed job or a failed deploy, and it's easy to miss if nobody is watching the run. The definitive signal for a broken refresh is the standalone CloudWatch alarm (BS#1201), tracked separately, not this synchronous check.

Even with a fresh token, a pull can still fail if Docker GC'd the locally cached image and the registry is briefly unreachable at cron time — lower probability, mentioned for completeness (same caveat the originating issue called out). That residual is tracked separately, not by this job.

Two adjacent observability gaps were explicitly split out of BS#1183 rather than folded in here: BS#1200 (route every cron container's stdout/stderr to a per-cron log file, host-wide) and BS#1201 (heartbeat counter + CloudWatch alarm so a missed cron run pages instead of waiting on a human reading logs).

## Edge compression (nginx gzip)

<!-- @rule id=gzip-types-excludes-sse enforced-by=none added=2026-08-09 incidents=#2076 -->

**`text/event-stream` must never be added to `gzip_types`.** It is the _sole_ guard on `/events/stream`, not one of two — `apps/backend/utils/serverEvents.ts` writes SSE frames with bare `res.write` and never calls `res.flush()`, and marks the response `X-Accel-Buffering: no`, which suppresses nginx's proxy buffering and leaves the response with no upstream `Content-Length`. `gzip_min_length` has nothing to evaluate and cannot act as a backstop. Adding the type — the obvious move for anyone doing a routine "let's compress more types" pass — wedges every SSE consumer behind a compression buffer. `enforced-by=none` is literal: nothing in CI can inspect a config file that isn't in the repo, which is the argument for the version-control follow-up below.

Applied 2026-08-09 (BS#2076). Six directives live in the `api.wxyc.org` **443** server block of `/etc/nginx/nginx.conf` on the prod host, plus a `gzip off` opt-out on each of the two `/auth` locations:

```nginx
gzip              on;
gzip_vary         on;
gzip_proxied      any;
gzip_comp_level   5;
gzip_min_length   1024;
gzip_types        application/json application/javascript text/javascript text/css text/plain;
```

Measured on `/playlists/recentEntries`: 50,697 → 9,128 bytes on the wire (5.6x, 82% off), decoded body byte-identical.

### What it buys, in time

Measured 2026-08-09 from a single residential vantage point at ~67 ms RTT, randomized arm order, medians of n=10–14. "Response time" excludes DNS/TCP/TLS setup, so it is what a client with connection reuse (iOS `URLSession`, dj-site) actually experiences:

| Endpoint                   | Bytes          | Response time | Saving         |
| -------------------------- | -------------- | ------------- | -------------- |
| `/playlists/recentEntries` | 50,704 → 9,105 | 210 → 105 ms  | ~105 ms (−50%) |
| `/flowsheet`               | 26,948 → 6,852 | 624 → 570 ms  | ~54 ms (−9%)   |

**The win is round trips, not bandwidth**, and that determines how the number generalizes. The compressed body's transfer time is ~0.1 ms — it lands in a single burst — while the uncompressed one takes ~70 ms, almost exactly one extra RTT. That is the congestion window: ~9 KB fits inside the initial cwnd (10 MSS ≈ 14.6 KB), 27–50 KB does not and has to wait for it to grow. So the saving scales with a client's **RTT**, not its throughput: a phone on cellular at 150 ms RTT should save more than the table shows, and a fatter pipe will not shrink it. That is the opposite of the usual intuition that compression is a slow-connection optimization.

Read the two rows as different things. `/flowsheet` spends ~570 ms in the backend before nginx sees a byte, so compression takes 9% off a number dominated by query time — real, but not the lever on that endpoint. `/playlists/recentEntries` is the honest measure of what compression alone does.

Server-side cost is not observable at this volume: nginx workers at 0.0% CPU, load average 0.28 on 2 cores, at ~23K requests/day. `gzip_comp_level 5` (rather than 9) was chosen on a measured 1.3% size delta for materially more CPU — don't raise it without a reason.

Caveats worth keeping attached to these numbers: one network path, one client, small n. The uncompressed arm has a fat tail (one sample at 782 ms against a 210 ms median), so the mean saving is larger and noisier than the medians above. No cellular measurement was taken, which is the iOS app's real case. And anything under `gzip_min_length` saves nothing by design.

Four things about the directive block are load-bearing and non-obvious:

- **`gzip_types` is an opt-in allowlist**, which is why the SSE guard works at all — and why `text/html` is absent (nginx always compresses it and it cannot be removed from the list).
- **Both `application/javascript` and `text/javascript` are listed, and only the second one matches.** `swagger-ui-express` (`apps/backend/app.ts`) serves its 1.5 MB `swagger-ui-bundle.js` through `express.static` → `send@1.2.1` → send's **nested** `mime-types@3.0.2`, which resolves `.js` to `text/javascript`. The hoisted root `mime-types@2.1.35` still says `application/javascript` — checking that one instead is how the largest compressible asset on the host was nearly excluded. Verify against the resolving package, not the hoisted one.
- **`gzip off` goes on `location /auth/healthcheck` _and_ `location /auth/`.** nginx locations inherit from the enclosing `server`/`http` scope, never from a sibling whose prefix happens to be shorter, so the dedicated healthcheck location would otherwise run under the server-level `gzip on`. The exclusion itself is a BREACH-class precaution — those responses carry session tokens and JWTs — and it costs nothing: `/auth/*` averages ~262 bytes per response, already under `gzip_min_length`.
- **Scope is the api block on purpose.** Hoisting to `http { }` would also compress `explore.wxyc.org` (semantic-index) and `wiki.wxyc.org` (Wiki.js), which share this nginx and belong to other repos. That's a real egress win but not Backend-Service's unilateral call.

Apply procedure: `sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-$(date +%Y%m%d)` → edit → `sudo nginx -t` (**must pass** — a syntax error takes down api, explore, and wiki together) → `sudo systemctl reload nginx` (graceful; in-flight connections survive, main PID unchanged). **The `.bak` is the rollback** — this config is not in version control, so there is no `git revert` for it. Restore it, `nginx -t`, reload.

That last point is the standing weakness: an edge config with no history, no review, and no CI visibility, one hand-edit away from an outage. The path out is known rather than hypothetical — check the config into `deploy/nginx/` and install it from `deploy-base.yml` over `appleboy/ssh-action`, exactly as the `ecr-refresh-cron` job above already installs host-level state idempotently. Until then, treat any change here as unreviewed production surgery and back it up first.

## CI workflow pin maintenance

Three classes of pin in `.github/workflows/*.yml` exist for supply-chain reasons (mirrors WXYC/request-o-matic#124's free-tier hardening; see WXYC/wiki#67 for the org-wide rollout). They will bit-rot and need occasional bumps:

- **Workflow-level `permissions:`** scoped to the minimum each workflow needs. Four distinct profiles across the 8 workflows:
  - `contents: read`: `test.yml`, `nightly-tests.yml`, `set-ec2-env-var.yml`, `schema-shape-report.yml`. No `GITHUB_TOKEN` writes; all writes to external services use their own non-`GITHUB_TOKEN` secrets (`AWS_*`, `EC2_SSH_KEY`, etc.). `test.yml` keeps `contents: read` as its **workflow-level floor**, but its `migrate-dryrun` job escalates to `contents: read` + `pull-requests: write` at the **job** level so the folded schema-shape probe (#1982) can post its report. That job-scoped escalation is the pattern to copy — don't widen the workflow-level floor to suit one job.
  - `contents: write`: `deploy-base.yml` (the reusable workflow — pushes commits/tags as part of build artifacts) and its callers `deploy-auto.yml` + `deploy-manual.yml`. **Caller and callee must match** — when the callee escalates to `contents: write` and the callers stay at `contents: read`, the matrix run startup_failures with no jobs (the pattern documented in WXYC/Backend-Service#857 / PR #858 — silent for 10 commits across 2 days). When you change `deploy-base.yml`'s `permissions:`, audit `deploy-auto.yml` + `deploy-manual.yml` in the same PR.
  - `contents: read` + `packages: read`: `charset-corpus-drift.yml` — the reusable workflow pulls `@wxyc/shared` from `npm.pkg.github.com`.
  - `contents: read` + `pull-requests: write`: the `migrate-dryrun` job in `test.yml` — comments on PRs with the schema-shape report. (`schema-shape-report.yml` held this profile until #1982 folded the probe into `migrate-dryrun`; that file is now a DB-free self-test that posts nothing and is back at `contents: read`.)
    General failure mode is silent — a job that needs a missing scope (e.g. `pull-requests: write`) fails its API call but the workflow stays green. When adding a step that needs to comment on PRs, push tags, mint releases, etc., explicitly grant the scope at the **job** level (or widen the workflow-level floor only if every job in the file needs it). Don't apply a permissions block to a caller that grants strictly less than the callee — see #857.
- **Reusable-workflow refs pinned to `@gha/v1`**, not `@main` — today the only such ref is `WXYC/wxyc-shared/.github/workflows/check-charset-corpus-drift.yml@gha/v1` in `charset-corpus-drift.yml`. (Backend-Service does not consume the wxyc-etl marker-sync workflow — that's for Python repos with pytest.) The publishing repo treats `gha/v1` as a moving major tag — re-pointed forward on non-breaking changes, frozen on breaking changes (which get a fresh `gha/v2`). Don't downgrade to `@main`; if a `gha/v2` migration arrives, follow the procedure at the top of `WXYC/wxyc-shared/CLAUDE.md` "Tag Stability Policy". When future reusable-workflow consumers are added (e.g., if the org publishes a Node-side equivalent), pin them to `@gha/v1` here too.
- **Third-party action pins** — top-level (`@v4`, `@v6`, etc.). Not version-locked to a SHA today; bumps land via Dependabot as one PR per action (see recent commits `Bump aws-actions/configure-aws-credentials to v6`, `Bump actions/checkout from 4 to 6`). When adding a new third-party action, prefer a major-version tag from a published action (auditable maintainer, signed releases) over a SHA-pinned hack.

Run `actionlint .github/workflows/*.yml` locally before pushing workflow changes; it validates `permissions:` syntax, action-version pins, and shell-script blocks (via shellcheck), and catches the silent-mistake class of errors above before CI does.

Item 4 of #124 (pinning the Railway CLI) does not apply — Backend-Service deploys to EC2, not Railway.
