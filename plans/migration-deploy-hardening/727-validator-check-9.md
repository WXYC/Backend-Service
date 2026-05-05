# Plan: validate-migrations Check 9 — RAISE EXCEPTION messages must cite reachable paths

- **Issue**: WXYC/Backend-Service#727
- **Project**: [Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) — Phase 2 (prevention)
- **Size**: XS

## Context

Migration 0071's `RAISE EXCEPTION` says: `'Cannot apply ... Run rotation-dedupe job first or pre-clean manually.'`. The cited rotation-dedupe job exists only on the unmerged feature branch `task/694-rotation-dedupe`. An operator hitting 0071 in prod who follows the runbook hits a broken pointer.

Low-severity, high-confusion failure mode. The whole point of a guard's RAISE message is to give the operator a runnable next step.

## Approach

Slot a new Check 9 into `scripts/validate-migrations.mjs`. Mirror Check 8's pattern: walk SQL files, regex-extract a target shape, emit `reportWarning` per finding. Warning, not error — false positives are tolerable; the goal is informational.

## Implementation

### Step 1 — Read the existing Check 8 to lock the pattern

`scripts/validate-migrations.mjs` line 283 onwards is the Check 8 reference. Note its conventions:

- Walks `shared/database/src/migrations/*.sql`.
- Uses `reportWarning(file, message)` (not `reportError`).
- Suppression syntax: `-- @no-precondition-needed: <reason>` comment in the file.
- Does NOT block CI (warnings only).

### Step 2 — Implement Check 9

Add to the validator after Check 8:

```js
// Check 9: WARNING — RAISE EXCEPTION messages should cite paths reachable
// from main. Migrations whose precondition guards reference a runbook (e.g.
// "Run rotation-dedupe job first") that points to an unmerged feature branch
// give operators a broken next-step. The check extracts path-shaped tokens
// from RAISE EXCEPTION strings and warns when fs.existsSync returns false.
//
// Suppressible per-migration with `-- @no-runbook-needed: <reason>` for
// migrations whose RAISE message intentionally cites a path-shaped string
// that isn't a real path (false positive on URLs, doc references, etc.).
//
// See: WXYC/Backend-Service#727.
function checkRunbookReferences() {
  const RAISE_PATTERN = /RAISE\s+EXCEPTION\s+(['"])((?:\\.|[^\\])*?)\1/gi;
  // Path-shaped tokens: top-level directory we'd recognize, followed by /...
  // Loose by design — the warning suppression handles real false positives.
  const PATH_PATTERN = /\b(jobs|scripts|apps|shared)\/[A-Za-z0-9_./-]+/g;
  const SUPPRESS_PATTERN = /--\s*@no-runbook-needed:/;

  for (const file of sqlFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (SUPPRESS_PATTERN.test(content)) continue;

    let match;
    while ((match = RAISE_PATTERN.exec(content)) !== null) {
      const messageText = match[2];
      const paths = messageText.match(PATH_PATTERN) ?? [];
      for (const candidate of paths) {
        const repoPath = path.join(repoRoot, candidate);
        if (!fs.existsSync(repoPath)) {
          reportWarning(
            file,
            `RAISE EXCEPTION cites '${candidate}' which doesn't exist on main. ` +
              `Either merge the runbook before this migration ships, rephrase the ` +
              `message, or suppress with '-- @no-runbook-needed: <reason>'.`
          );
        }
      }
    }
  }
}
```

### Step 3 — Wire into the existing checks runner

Add `checkRunbookReferences()` to the existing list of check function calls (the spot where checks 1-8 are invoked). Order doesn't matter — checks are independent.

### Step 4 — Update the docstring

The validator's top-of-file docstring enumerates checks 1-8. Add Check 9 with the same shape, scope-explicit upfront so a future operator reading the warning understands its boundaries without consulting this issue:

> 9. WARNING: RAISE EXCEPTION messages cite **explicit paths** to directories (`jobs/`, `scripts/`, `apps/`, `shared/`) that exist on main. **Scope limitation:** free-form prose references (e.g., "Run rotation-dedupe job" without a `jobs/` prefix) are not detected; only explicit path-shaped patterns match. Suppressible per-migration with `-- @no-runbook-needed: <reason>`. See WXYC/Backend-Service#727.

### Step 5 — Run against current main

The check will fire on at least one current migration (0071 cites `rotation-dedupe job` — though note the current text is "rotation-dedupe job" without a path prefix, so the regex may NOT match). Examples:

- 0071: cites "rotation-dedupe job" — no `jobs/` prefix in the actual string, so the path regex misses it. Decide: tighten the regex (false-positive-prone) or accept this as a Check 9 limitation (a future migration that DOES write `jobs/rotation-dedupe` will trigger it; pre-existing prose-style references are out of scope).

Document the decision in the Check 9 docstring.

## Test plan (TDD)

Existing tests for the validator live at `tests/unit/scripts/validate-migrations.test.ts` (TypeScript, Jest config `jest.unit.config.ts`). They spawn the validator as a subprocess against temporary migration fixtures. Append Check 9's tests there; do not create a new test file under `scripts/__tests__/`.

Tests:

1. **Happy path**: migration with `RAISE EXCEPTION 'See jobs/library-artist-name-backfill for prior art'` → no warning (path exists).
2. **Broken reference**: migration with `RAISE EXCEPTION 'Run jobs/this-does-not-exist first'` → warning emitted naming both the file and the missing path.
3. **Multiple paths in one message**: warning emitted per missing path, none for present ones.
4. **Suppression**: file with both a broken-reference message and `-- @no-runbook-needed: see #N`-style comment → no warning.
5. **No RAISE EXCEPTION at all**: no warning (no false positive on every migration).
6. **Path-shaped string in message that isn't followed by `jobs/`/`scripts/` etc.**: no warning (regex doesn't fire on free-form prose like "rotation-dedupe job").

Use temp-directory fixtures with synthetic SQL files; don't depend on real migrations changing.

## Risks / gotchas

1. **Regex false positives.** A RAISE message that mentions a documentation page or external URL whose path component happens to start with `jobs/`/`scripts/` would warn. Suppression syntax handles it, and the warning's job is to inform — false-positive cost is low (just suppress).
2. **Regex false negatives.** Free-form prose ("Run rotation-dedupe job first" — no `jobs/` prefix) won't match. That's a deliberate limitation; tightening the regex would inflate false positives. Document the limitation in the docstring; accept that this check catches the explicit-path case (which is the higher-confidence signal anyway).
3. **The 0071 case (the prompting issue) won't trip Check 9 as written.** This is fine — 0071's recovery is being handled separately via #718. The check is forward-looking: future authors who DO write `jobs/foo-bar` in a RAISE message will be caught.
4. **CI integration.** Check 9 is a warning, not an error, so it doesn't gate CI. The validator's exit code logic should remain unchanged (errors fail; warnings inform).

## Acceptance criteria

- [ ] Check 9 implemented in `scripts/validate-migrations.mjs` following Check 8's pattern.
- [ ] Docstring at top of file enumerates Check 9 alongside the existing 8.
- [ ] Unit tests cover happy path, broken reference (single + multiple paths), suppression, no-RAISE, and prose-style false-negative.
- [ ] Validator's exit code logic unchanged (warnings inform, don't fail CI).
- [ ] Run validator against current main; document any current Check 9 hits or non-hits in PR description.

## Out of scope

- Validating that the cited path is _runnable_ (executable, has a README). Existence is the bar.
- Tightening the regex to catch prose-style references. The signal/noise becomes too low.
- Auto-fixing or auto-rephrasing messages. Human judgment.

## References

- `scripts/validate-migrations.mjs` — existing 8-check infrastructure
- Migration 0071 — the prompting case (note: existing form won't trip the regex; the check is forward-looking)
- WXYC/Backend-Service#705 — Check 8 precedent (precondition guards)
