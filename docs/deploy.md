# Deployment

## Where it runs

- Hosted on EC2
- CI/CD via GitHub Actions (manual trigger: Actions tab → CI/CD Pipeline → Run Workflow)
- Docker images built with multi-stage Dockerfile (`node:25-alpine`), stored in Amazon ECR

## CI/CD pipeline detail

The `migrate-dryrun` job (one of the GitHub Actions workflow stages in `.github/workflows/test.yml`) runs only when `db-init` paths change (migrations, schema, `init-db.mjs`, etc.). It restores the most recent automated RDS snapshot to a sandbox DB instance, runs `node scripts/dryrun-migrate.mjs` against it, asserts exit 0, and tears the sandbox down. This catches preconditions that depend on prod data shape (e.g. the `RAISE EXCEPTION` guards added per WXYC/Backend-Service#705) at PR-review time rather than at deploy time. The script reuses `dev_env/format-pg-error.mjs` (#725) so the underlying Postgres error fields surface in the CI log on failure. To re-test against a fresher snapshot, trigger an on-demand snapshot via the AWS RDS console and rerun the workflow.

Network plumbing uses **per-run JIT authorize + revoke** (#757): between `Configure AWS credentials` and the snapshot restore the workflow detects its runner public IP via `checkip.amazonaws.com` and adds a `<runner-ip>/32 → tcp/5432` rule to `SG_DRYRUN_GHA`; an `if: always()` teardown step revokes the rule before sandbox delete, so the SG sits at zero ingress rules between runs. The IAM scoping for the authorize/revoke pair is conditioned on the SG's `Purpose=migrate-dryrun` tag, so the GHA user cannot touch any other security group with the same actions. End-to-end-validated in #775 (the always() teardown was confirmed to revoke even when the migrate step fails).

Provisioning prerequisites (ops, one-time, all idempotent via `scripts/provision-dryrun-aws.mjs`): IAM policy attached to the existing `AWS_ACCESS_KEY_ID` user with `rds:DescribeDBSnapshots`, `rds:DescribeDBInstances`, `rds:RestoreDBInstanceFromDBSnapshot`, `rds:DeleteDBInstance`, `rds:AddTagsToResource`, `ec2:AuthorizeSecurityGroupIngress`, `ec2:RevokeSecurityGroupIngress` (the EC2 pair scoped via `aws:ResourceTag/Purpose=migrate-dryrun`), `ec2:DescribeSecurityGroups`; security group `SG_DRYRUN_GHA` carrying the `Purpose=migrate-dryrun` tag (no permanent ingress rules); repo secrets `PROD_DB_ID`, `PROD_DB_NAME`, `PROD_DB_USERNAME`, `PROD_DB_PASSWORD`, `SG_DRYRUN_GHA`. See WXYC/Backend-Service#726 (initial gate setup) and #757 (shift from static CIDR allowlist to JIT).

## Deploy cadence and migration-chain risk

<!-- @rule id=deploy-cadence-24h enforced-by=none added=2026-05-06 incidents=#run-25337297761 -->

**Migration-touching PRs should trigger a deploy soon after merge — ideally same-day.** Long deploy gaps accumulate migration-chain risk: each new migration sits unapplied on `main`, and a failure on any one of them at deploy time wedges the whole chain.

The canonical recent example is the 2026-05-04 deploy wedge ([run 25337297761](https://github.com/WXYC/Backend-Service/actions/runs/25337297761)), where 4 days of accumulated migrations (0071, 0072, 0073) compounded with a retroactive precondition guard added in commit `2710f2e`. Migration 0071's guard fired against current prod state and aborted the chain, leaving the deploy stuck. Had 0071 deployed in isolation immediately after authoring (2026-05-01), the guard wouldn't have been retrofitted yet, and the wedge wouldn't have happened.

The other defenses in [Project #26 — Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) (legible failure output, pre-flight dry-runs against prod-shaped data, validator checks for retroactive risk) reduce the cost of an individual wedge. This cadence note reduces the _likelihood_ by limiting how many migrations stack up between deploys.

**Practical rule of thumb**: when a PR that touches `shared/database/src/migrations/**` merges, run Manual Build & Deploy within 24 hours. The rule is advisory — don't gate merges on cadence, since PR authors don't necessarily own deploys.

## CI workflow pin maintenance

Three classes of pin in `.github/workflows/*.yml` exist for supply-chain reasons (mirrors WXYC/request-o-matic#124's free-tier hardening; see WXYC/wiki#67 for the org-wide rollout). They will bit-rot and need occasional bumps:

- **Workflow-level `permissions:`** scoped to the minimum each workflow needs. Four distinct profiles across the 8 workflows:
  - `contents: read`: `test.yml`, `nightly-tests.yml`, `set-ec2-env-var.yml`. No `GITHUB_TOKEN` writes; all writes to external services use their own non-`GITHUB_TOKEN` secrets (`AWS_*`, `EC2_SSH_KEY`, etc.).
  - `contents: write`: `deploy-base.yml` (the reusable workflow — pushes commits/tags as part of build artifacts) and its callers `deploy-auto.yml` + `deploy-manual.yml`. **Caller and callee must match** — when the callee escalates to `contents: write` and the callers stay at `contents: read`, the matrix run startup_failures with no jobs (the pattern documented in WXYC/Backend-Service#857 / PR #858 — silent for 10 commits across 2 days). When you change `deploy-base.yml`'s `permissions:`, audit `deploy-auto.yml` + `deploy-manual.yml` in the same PR.
  - `contents: read` + `packages: read`: `charset-corpus-drift.yml` — the reusable workflow pulls `@wxyc/shared` from `npm.pkg.github.com`.
  - `contents: read` + `pull-requests: write`: `schema-shape-report.yml` — comments on PRs.
    General failure mode is silent — a job that needs a missing scope (e.g. `pull-requests: write`) fails its API call but the workflow stays green. When adding a step that needs to comment on PRs, push tags, mint releases, etc., explicitly grant the scope at the **job** level (or widen the workflow-level floor only if every job in the file needs it). Don't apply a permissions block to a caller that grants strictly less than the callee — see #857.
- **Reusable-workflow refs pinned to `@gha/v1`**, not `@main` — today the only such ref is `WXYC/wxyc-shared/.github/workflows/check-charset-corpus-drift.yml@gha/v1` in `charset-corpus-drift.yml`. (Backend-Service does not consume the wxyc-etl marker-sync workflow — that's for Python repos with pytest.) The publishing repo treats `gha/v1` as a moving major tag — re-pointed forward on non-breaking changes, frozen on breaking changes (which get a fresh `gha/v2`). Don't downgrade to `@main`; if a `gha/v2` migration arrives, follow the procedure at the top of `WXYC/wxyc-shared/CLAUDE.md` "Tag Stability Policy". When future reusable-workflow consumers are added (e.g., if the org publishes a Node-side equivalent), pin them to `@gha/v1` here too.
- **Third-party action pins** — top-level (`@v4`, `@v6`, etc.). Not version-locked to a SHA today; bumps land via Dependabot as one PR per action (see recent commits `Bump aws-actions/configure-aws-credentials to v6`, `Bump actions/checkout from 4 to 6`). When adding a new third-party action, prefer a major-version tag from a published action (auditable maintainer, signed releases) over a SHA-pinned hack.

Run `actionlint .github/workflows/*.yml` locally before pushing workflow changes; it validates `permissions:` syntax, action-version pins, and shell-script blocks (via shellcheck), and catches the silent-mistake class of errors above before CI does.

Item 4 of #124 (pinning the Railway CLI) does not apply — Backend-Service deploys to EC2, not Railway.
