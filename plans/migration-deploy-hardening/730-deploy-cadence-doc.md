# Plan: Document deploy cadence as a migration-chain risk dimension in CLAUDE.md

- **Issue**: WXYC/Backend-Service#730
- **Project**: [Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) — Phase 3 (docs)
- **Size**: XS — pure docs change, with optional script

## Context

The 2026-05-04 deploy wedge was amplified by 4 days of accumulated migrations (0071, 0072, 0073) since the prior successful deploy on 2026-04-30. Each migration in isolation might have been caught; together they hid the failure (0071+0072 net to a no-op, but the chain runs each in isolation). Subsequently, the precondition-guard pattern was retroactively retrofit onto 0071 — changing its behavior 2 hours after the original author moved on.

Frequent deploys reduce the surface area for any single migration's failure mode to compound with others. Daily-or-faster cadence on migration-touching PRs would have shown 0071 in isolation, before #2710f2e changed its behavior.

## Approach

Pure docs change to `Backend-Service/CLAUDE.md`. Single new subsection under "## Deployment". Optionally pair with a small standalone script that emits a Sentry breadcrumb on each migrate run noting "N un-deployed migrations on main since last successful prod deploy" — defer to follow-up if anyone wants the operational signal.

## Implementation

### Step 1 — Add subsection to CLAUDE.md

Locate the existing "## Deployment" section (currently 4 lines). Add the following subsection immediately after:

```markdown
### Deploy cadence and migration-chain risk

Migration-touching PRs should trigger a deploy soon after merge — ideally same-day. Long deploy gaps accumulate migration-chain risk: each new migration sits unapplied on `main`, and a failure on any one of them at deploy time wedges the whole chain.

The canonical recent example is the 2026-05-04 deploy wedge (run [25337297761](https://github.com/WXYC/Backend-Service/actions/runs/25337297761)), where 4 days of accumulated migrations (0071, 0072, 0073) compounded with a retroactive precondition guard added in commit `2710f2e`. Migration 0071's guard fired against current prod state and aborted the chain, leaving the deploy stuck. Had 0071 deployed in isolation immediately after authoring (2026-05-01), the guard wouldn't have been retrofitted yet, and the wedge wouldn't have happened.

The other defenses in [Project #26 — Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) (legible failure output, pre-flight dry-runs against prod-shaped data) reduce the cost of an individual wedge. This cadence note reduces the *likelihood* by limiting how many migrations stack up between deploys.

**Practical rule of thumb**: when a PR that touches `shared/database/src/migrations/**` merges, run Manual Build & Deploy within 24 hours.
```

### Step 2 — (Optional) Operational signal script

If anyone wants visibility into the gap, a small script under `scripts/` could emit on each migrate run:

```js
// scripts/migrate-cadence-breadcrumb.mjs (sketch)
// Reads __drizzle_migrations cursor, compares to journal length, logs gap.
// Wired into init-db.mjs after migrate completes.
const cursor = await sql`SELECT MAX(created_at) FROM drizzle.__drizzle_migrations`;
const journal = JSON.parse(readFileSync('database/migrations/meta/_journal.json'));
const undeployed = journal.entries.filter(e => Number(e.when) > Number(cursor[0].max));
if (undeployed.length > 3) {
  console.warn(`[cadence] ${undeployed.length} migrations applied this run; consider deploying more frequently. Sentry breadcrumb emitted.`);
  // Optionally: Sentry.addBreadcrumb({ category: 'migrate-cadence', level: 'info', message: `...`, data: { undeployed: undeployed.length } });
}
```

Defer this step to follow-up unless there's appetite. The docs change is the minimum viable.

## Test plan

- **Docs change**: render the markdown locally; confirm formatting, link to project #26 resolves, link to run 25337297761 resolves.
- **Optional script**: unit-test the gap calculation against a mock cursor + journal. Don't need to test the Sentry side-effect.

## Risks / gotchas

1. **The "rule of thumb" is advisory.** Don't gate merges on cadence; that punishes the wrong people (PR authors don't necessarily own deploys). The doc just informs decisions; the real defense is the Phase 1 + Phase 2 work in this project.
2. **The optional script adds noise.** If implemented, calibrate the threshold (default `> 3` undeployed migrations is arbitrary — tune based on actual run frequency).

## Acceptance criteria

- [ ] CLAUDE.md "Deployment" section grows a "Deploy cadence and migration-chain risk" subsection (text per Step 1).
- [ ] References the 2026-05-04 incident as the canonical example.
- [ ] Links to project #26 and to the failed run.
- [ ] (Optional) Operational script lands under `scripts/` and is documented in CLAUDE.md.

## Why this is the lowest-priority item in the project

The root cause of the 2026-05-04 wedge was visibility (the spinner ate the error → #725) and PR-time prevention (no precondition dry-run against prod-shaped data → #726). Frequent deploys don't fix either; they just reduce blast radius. Once #725 + #726 ship, this docs note becomes mostly informational. Worth landing for completeness — and the optional script could provide a useful operational signal — but neither blocks anything.

## Out of scope

- Automated deploy-after-merge (would change the deploy authorization model; bigger conversation).
- Per-migration deploy gating (don't punish PR authors).
- Cross-repo deploy cadence (this repo's deploy cadence has no bearing on LML, dj-site, etc.).

## References

- RCA for run 25337297761
- Project #26 README — articulates how this item fits the broader picture
