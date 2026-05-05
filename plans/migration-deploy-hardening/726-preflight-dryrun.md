# Plan: Pre-flight migration dry-run against prod-shaped data before merge

- **Issue**: WXYC/Backend-Service#726
- **Project**: [Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) — Phase 2 (prevention, highest leverage)
- **Size**: M — has real engineering choices

## Context

PR CI runs migrations against a fresh dev DB with no data. Migrations whose preconditions check against current data shape (e.g., 0071's `RAISE EXCEPTION` on duplicate active rotation groups) never fire at PR time. The failure surfaces at deploy against prod, where the data shape that triggers the guard exists.

The local replication tunnel (`scripts/sync/setup-replication.sh`) already keeps a local PG in sync with prod. A pre-flight that uses that infrastructure (or an equivalent CI-side snapshot) would have caught 0071 at PR-review time on 2026-05-01, before #718's manual recovery was needed.

**Hard ordering recommendation**: #725 (legible failure output) should land before this PR opens for review, OR be merged as a sibling commit on the same branch. Without #725, a failing dry-run produces the same opaque "exit 1" the deploy currently does — the dry-run runs, but a reviewer can't act on the failure because the actual error text is shadowed. If timing forces shipping #726 first, gate the merge on a follow-up that lands #725 within the same week and label this PR `blocked-on-#725-for-legible-output` in the title.

**Branch + commit conventions** (from CLAUDE.md): branch `feature/issue-726-migrate-dryrun`. Commit messages: scope to `ci:` for the workflow change and `docs:` for the CLAUDE.md update. Two commits is fine, one is fine — author's call.

## Approach decision

Three options were laid out in #726's body:

a. **Daily-refreshed RDS snapshot in CI** — restore a snapshot to a sandboxed test DB before each migrate-touching PR run. Highest fidelity, ~1-2min restore time, no ongoing maintenance.
b. **Persistent sandbox DB kept fresh by the replication tunnel** — long-lived PG subscribing to prod; CI connects for dry-runs. Fastest, requires reset-between-PRs choreography.
c. **Operator's laptop replica + push-button command** — no CI integration; relies on author running `npm run db:dryrun-migrate` locally. Lowest engineering, lowest enforcement.

**Recommended: (a) — daily snapshot restored fresh per run.** Rationale:

- Bounded restore time (~1-2 min) parallelizes with other CI jobs; doesn't gate the critical path.
- Zero state contamination across PRs (each run gets a clean snapshot).
- No persistent infrastructure to maintain (the snapshot pipeline is one of: a scheduled GHA workflow, a Lambda, or an RDS automated snapshot).
- Aligns with the "ephemeral CI" pattern the rest of the deploy uses.

(b) is faster but risks state corruption if a previous run mutated the sandbox in a way the next test depended on; reset-via-snapshot defeats the speed advantage anyway. (c) is the fallback if budget kills (a).

This plan assumes (a). If RDS snapshot economics or AWS access make it untenable, the implementer should revisit and pick (c) with a manually-enforced "ran the dry-run before merging" PR-checklist box.

## Implementation

### Step 1 — Verify RDS snapshot availability

RDS automated snapshots run daily; the prod DB likely has 7-day retention by default. Confirm:

```bash
aws rds describe-db-snapshots --db-instance-identifier <prod-id> --snapshot-type automated --max-items 5
```

If automated snapshots aren't enabled, enable them in the RDS console (one-time, ops). If they are, we have the source.

### Step 2 — Expose the existing `db-init` filter as a job output

Verified state of `.github/workflows/test.yml` (lines 32-65 at time of writing):

- `detect-changes` job already declares outputs: `apps`, `jobs`, `shared`, `tests`, `src`, `run-integration`. **It does NOT expose `db-init`** even though the filter exists.
- The `db-init` filter (lines 58-64) already covers the right paths: `dev_env/init-db.mjs`, `shared/database/src/migrations/**`, `shared/database/src/schema.ts`, plus `dev_env/{Dockerfile.init,package.init.json,seed_db.sql}`.

No filter changes needed. Just expose `db-init` as a job output:

```yaml
detect-changes:
  outputs:
    apps: ${{ steps.changes.outputs.apps }}
    jobs: ${{ steps.changes.outputs.jobs }}
    shared: ${{ steps.changes.outputs.shared }}
    tests: ${{ steps.changes.outputs.tests }}
    src: ${{ steps.changes.outputs.src }}
    run-integration: ${{ steps.should-run.outputs.run-integration }}
    db-init: ${{ steps.changes.outputs.db-init }}  # NEW
```

The `db-init` name is correct as the trigger condition for `migrate-dryrun` — it covers exactly the paths whose changes could move the migration result on prod-shaped data.

### Step 3 — Add the `migrate-dryrun` CI job

```yaml
migrate-dryrun:
  name: Migration Dry-Run (prod-shaped data)
  needs: [detect-changes]
  if: needs.detect-changes.outputs.db-init == 'true'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    # Match the existing AWS credential pattern used throughout
    # .github/workflows/deploy-base.yml (lines 246, 254, 265, 329, 337, 363, 454).
    # Long-lived AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY secrets, scoped via
    # IAM policy. Migrating the whole repo to OIDC is a separate concern; not
    # in scope for this PR.
    - uses: aws-actions/configure-aws-credentials@v4
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: ${{ secrets.AWS_REGION }}

    - name: Restore latest prod snapshot to sandbox
      run: |
        SNAPSHOT_ID=$(aws rds describe-db-snapshots \
          --db-instance-identifier ${{ secrets.PROD_DB_ID }} \
          --snapshot-type automated \
          --query 'sort_by(DBSnapshots, &SnapshotCreateTime)[-1].DBSnapshotIdentifier' \
          --output text)
        SANDBOX_ID="dryrun-${{ github.run_id }}"
        # Publicly accessible because GitHub Actions runners have no VPC
        # connectivity to the prod VPC. Ingress is gated by the dedicated
        # security group SG_DRYRUN_GHA, which allows port 5432 from GitHub's
        # documented egress IP ranges only — see Step 4's network prereq.
        aws rds restore-db-instance-from-db-snapshot \
          --db-instance-identifier "$SANDBOX_ID" \
          --db-snapshot-identifier "$SNAPSHOT_ID" \
          --db-instance-class db.t4g.micro \
          --publicly-accessible \
          --vpc-security-group-ids ${{ secrets.SG_DRYRUN_GHA }}
        aws rds wait db-instance-available --db-instance-identifier "$SANDBOX_ID"
        echo "SANDBOX_ID=$SANDBOX_ID" >> $GITHUB_ENV

    - name: Get sandbox endpoint
      run: |
        ENDPOINT=$(aws rds describe-db-instances \
          --db-instance-identifier "$SANDBOX_ID" \
          --query 'DBInstances[0].Endpoint.Address' --output text)
        echo "DB_HOST=$ENDPOINT" >> $GITHUB_ENV

    # Run ONLY the migrate step, not the full init-db.mjs pipeline. init-db
    # also installs extensions, optionally seeds, and runs journal-skip
    # verification — all benign against a snapshot but the brittler the
    # pre-flight, the more chances for a non-migration failure to mask the
    # signal we care about. A purpose-built dryrun-migrate.mjs is shorter,
    # narrower, and reuses the same drizzle-orm migrate() + formatPgError
    # helper #725 introduces.
    - name: Run drizzle:migrate against sandbox
      env:
        DB_HOST: ${{ env.DB_HOST }}
        DB_PORT: '5432'
        DB_NAME: ${{ secrets.PROD_DB_NAME }}
        DB_USERNAME: ${{ secrets.PROD_DB_USERNAME }}
        DB_PASSWORD: ${{ secrets.PROD_DB_PASSWORD }}
      run: node scripts/dryrun-migrate.mjs

    - name: Tear down sandbox
      if: always()
      run: |
        if [ -n "$SANDBOX_ID" ]; then
          aws rds delete-db-instance \
            --db-instance-identifier "$SANDBOX_ID" \
            --skip-final-snapshot \
            --delete-automated-backups
        fi
```

**Key points:**

- `if: needs.detect-changes.outputs.db-init == 'true'` — only runs when migration / db-init files change.
- `needs: [detect-changes]` — runs in parallel to other CI jobs; doesn't extend the critical path.
- Sandbox DB instance class is small (`db.t4g.micro`) — cheap; dry-run is the only workload.
- `if: always()` on teardown + the `if [ -n "$SANDBOX_ID" ]` guard — even if restore fails before `SANDBOX_ID` is set, we don't try to delete an unset id (would error and obscure the actual failure).

### Step 4 — IAM policy for the AWS_ACCESS_KEY_ID user

The existing IAM user behind `AWS_ACCESS_KEY_ID` already has ECR + EC2 permissions for the deploy. Add a narrowly-scoped RDS policy attached to the same user (or a sibling user if separation is preferred):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "rds:DescribeDBSnapshots",
        "rds:DescribeDBInstances",
        "rds:RestoreDBInstanceFromDBSnapshot",
        "rds:ModifyDBInstance",
        "rds:DeleteDBInstance",
        "rds:AddTagsToResource"
      ],
      "Resource": "*"
    }
  ]
}
```

`Resource: "*"` is appropriate here because the snapshot identifiers are dynamically picked; we can narrow to `arn:aws:rds:*:*:snapshot:rds:<prefix>-*` once the naming pattern is stable. Document the policy attachment as an ops step, not part of the PR diff.

**Network prerequisite**: the sandbox DB is provisioned with `--publicly-accessible` because the standard GitHub Actions `ubuntu-latest` runner has no VPC connectivity to the prod VPC. Ingress is gated by a dedicated security group (`SG_DRYRUN_GHA`) that allows port 5432 from GitHub's documented egress IP ranges only (see [GitHub's hosted-runner IP allowlist](https://api.github.com/meta) — the `actions` array). Provision the security group as a one-time ops step:

```bash
# Create SG in the same VPC as the prod RDS subnet group
aws ec2 create-security-group --group-name dryrun-gha-ingress \
  --description "GHA runner → ephemeral RDS dryrun ingress" \
  --vpc-id <prod-vpc-id>
# For each CIDR in https://api.github.com/meta -> .actions:
aws ec2 authorize-security-group-ingress --group-id sg-... \
  --protocol tcp --port 5432 --cidr <gha-cidr>
# Save the SG id as the SG_DRYRUN_GHA secret
```

Alternative: use a self-hosted runner inside the prod VPC. More secure (no public ingress at all) but more operational overhead. Defer unless the public-accessible posture becomes a real concern.

### Step 3.5 — Add `scripts/dryrun-migrate.mjs`

The CI step calls this purpose-built script rather than `node dev_env/init-db.mjs`. init-db.mjs runs extensions install, migrations, journal verification, and optional seeding — all benign against a snapshot but they bloat the failure surface (a future change to init-db.mjs that touches data could silently mask a migration failure in the dry-run). A narrow script that does ONLY the migrate is cleaner.

Sketch (full implementation lives in this PR's scope):

```js
// scripts/dryrun-migrate.mjs
//
// Purpose-built migration dry-run for the Migration Deploy Hardening
// pre-flight CI job (#726). Runs drizzle-orm's programmatic migrate()
// against whatever DB the env vars point at, dumps Postgres ERROR fields
// on failure (reuses the formatter #725 introduces), exits 0 on success
// or 1 on failure.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { formatPgError } from '../dev_env/format-pg-error.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sql = postgres({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  max: 1,
});

try {
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: join(__dirname, '../shared/database/src/migrations') });
  console.log('dryrun-migrate: ok');
} catch (error) {
  process.stderr.write('\n=== dryrun-migrate failed ===\n');
  process.stderr.write(formatPgError(error));
  process.stderr.write('===\n');
  process.exitCode = 1;
} finally {
  await sql.end();
}
```

This script does NOT call init-db.mjs's installExtensions, verify-journal, or seed steps. The snapshot already has all extensions installed, so installExtensions is unnecessary. Verify-journal is best done separately (and is preserved on the deploy path via init-db.mjs). Seed wouldn't fire anyway because the snapshot has data.

New repo secrets to provision (one-time, ops). All are repo-level GitHub Actions secrets (Settings → Secrets and variables → Actions → New repository secret), not environment-scoped — the job runs on the standard `ubuntu-latest` runner and doesn't need GitHub environment protection rules:

- `PROD_DB_ID` — RDS instance identifier of the prod DB (e.g., `wxyc-prod-db`).
- `PROD_DB_NAME` — Postgres database name.
- `PROD_DB_USERNAME`, `PROD_DB_PASSWORD` — match the RDS master credentials (snapshots restore with the source instance's master user). If `init-db.mjs` expects a non-master user, provision a dedicated migration user in the source DB first; otherwise the master credentials work.

### Step 5 — Document in CLAUDE.md

Update the "## CI/CD" section of `Backend-Service/CLAUDE.md` (currently 4 numbered steps describing the existing CI jobs). Add a new bullet after step 4:

> 5. **migrate-dryrun** (new, see WXYC/Backend-Service#726) — Only runs when `db-init` paths change (migrations, schema, init-db.mjs, etc.). Restores the most recent automated RDS snapshot to a sandbox DB instance, runs `node dev_env/init-db.mjs` against it, asserts exit 0, tears down. Catches preconditions that depend on prod data shape (e.g., the `RAISE EXCEPTION` guards added per WXYC/Backend-Service#705) at PR-review time rather than at deploy time. Failure surfaces the underlying Postgres error in the CI log (depends on WXYC/Backend-Service#725 — wrap drizzle:migrate). To re-test against a fresher snapshot: trigger an on-demand snapshot via the AWS RDS console and rerun the workflow.

### Step 6 — Self-test against the historical wedge

This is the regression test for the whole project. Concrete steps:

1. `git fetch origin` and identify the commit just before the wedge: `git log --oneline -- shared/database/src/migrations/0071*` finds `be0bbf6` (initial 0071, no precondition) and `2710f2e` (precondition retrofit). The wedge surfaces between `2710f2e` and the deploy run.
2. From a feature branch with the new CI step, push a draft PR whose only change is touching one of the `db-init` paths (e.g., a one-character whitespace change in `dev_env/init-db.mjs`), so `migrate-dryrun` triggers.
3. Verify the dry-run reproduces today's wedge: 0071's precondition guard fires with the visible `RAISE EXCEPTION` message in the CI log, exit 1.
4. Once verified, revert the synthetic change and document the run id in this issue's resolution comment so future maintainers can trace the regression test back.

If the snapshot used by the dry-run is fresher than the prod state at the time of the wedge (i.e., 0071+0072 have been manually applied via #718's INSERT), the wedge won't reproduce on that snapshot. Use an older snapshot (RDS keeps automated snapshots for the configured retention window — usually 7 days) or trigger an on-demand snapshot from a checkpoint that predates the manual recovery.

## Test plan

- **Smoke**: PR that touches a non-migration file → `migrate-dryrun` is skipped (paths-filter works).
- **Happy path**: PR adds a new migration that's a no-op against prod state (e.g., `CREATE TABLE foo (id SERIAL)`) → dry-run passes.
- **Caught-at-PR**: PR adds a migration with a precondition guard that would fail against current prod (mimic 0071's shape) → dry-run fails with the visible guard message; CI blocks merge.
- **Sandbox cleanup**: regardless of dry-run outcome, the RDS sandbox instance is deleted within 5 minutes of job completion (verify by querying RDS API after a synthetic test).

## Risks / gotchas

1. **AWS credentials in CI.** Need an IAM role with `rds:RestoreDBInstanceFromDBSnapshot`, `rds:DeleteDBInstance`, `rds:DescribeDBSnapshots`, `rds:DescribeDBInstances`. Provision via OIDC (no long-lived secrets); existing deploy workflow already has an IAM role pattern to copy from.
2. **Snapshot size and restore cost.** A small DB restores in 1-2 min; a 100GB+ DB can take 15-20 min. If prod is large, the dry-run gates merge for a long time. Mitigation: use a smaller scratch instance class (compute is decoupled from storage on RDS), and accept the wall-clock cost as the price of preventing prod wedges.
3. **Sandbox DB networking.** Resolved per Step 2/3.5: `--publicly-accessible` with a dedicated security group (`SG_DRYRUN_GHA`) gated to GitHub Actions' documented egress IP ranges. Self-hosted-runner-in-VPC is the more-secure alternative, deferred unless public-accessible posture becomes a concern. The security group provisioning is a one-time ops step (commands in Step 2's network-prereq block).
4. **Cost.** Each PR run with migrations spins up + tears down an RDS instance. At db.t4g.micro pricing, ~$0.02/hour; even with 5-min runs and 50 migration PRs/month, this is < $5/mo. Negligible.
5. **Flakiness from snapshot lag.** Automated snapshots run daily; a migration that depends on data younger than the most-recent snapshot won't see it. Mitigation: also wire an on-demand snapshot trigger (manually invokable when needed) so an author can `gh workflow run snapshot-prod-now.yml` before opening their PR if the data shape they care about is fresh.
6. **Dry-run mutates the snapshot.** That's fine — the sandbox is ephemeral. But the implementer must NOT reuse a snapshot across runs (snapshot-restore-mutate-snapshot would corrupt state).

## Acceptance criteria

- [ ] CI job `migrate-dryrun` runs on every PR that touches `shared/database/src/migrations/**`, `shared/database/src/schema.ts`, or `dev_env/init-db.mjs`.
- [ ] On a fresh-snapshot run, the job restores a sandbox, runs `node dev_env/init-db.mjs`, asserts exit 0, tears down.
- [ ] Postgres ERROR text from any migration failure reaches the CI log (depends on #725 — flag this as a soft-blocker if #725 hasn't landed).
- [ ] Self-test: re-run the workflow at `2710f2e..main` (using a backup of prod's pre-recovery state if needed) reproduces today's wedge with the visible guard message.
- [ ] CLAUDE.md "CI/CD" section documents the new job and how to debug failures.
- [ ] No persistent RDS instance leaks after a 24-hour soak test (verify with `aws rds describe-db-instances --query "DBInstances[?DBInstanceIdentifier!~\`prod\`]"`).

## Alternatives if (a) is infeasible

- **(b) — persistent sandbox**: spin up a long-lived `wxyc-staging-replica` RDS instance subscribing to prod via logical replication; have the CI step run migrations inside a SAVEPOINT it always rolls back. Risk: `DDL` doesn't always SAVEPOINT cleanly; some migrations create permanent state (e.g., extensions). Workable but fragile.
- **(c) — local-only**: add `npm run db:dryrun-migrate` script that documents the local replication setup and runs migrate against the operator's clone. PR-template checkbox: "I ran `npm run db:dryrun-migrate` locally and it passed." Lowest enforcement; useful as a fallback or interim while (a) is being provisioned.

## Out of scope

- Pre-flight for non-migration changes (the dev DB suffices for those).
- Drizzle-side improvements (idempotency, parallel migration apply, etc.).
- Auto-rolling back successful dry-runs that fail later in CI (the sandbox is already torn down per run; no rollback needed).

## References

- `scripts/sync/setup-replication.sh` — existing replication infrastructure
- `.github/workflows/test.yml` — existing PR CI
- `.github/workflows/deploy-base.yml:314` — current migrate step (the failure surface this prevents)
- RCA for run 25337297761
- WXYC/Backend-Service#725 — soft prerequisite for legible failure output
