# Plan: validate-migrations Check 10 — flag un-deployed CREATE-then-DROP migration pairs

- **Issue**: WXYC/Backend-Service#729
- **Project**: [Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) — Phase 3 (structural)
- **Size**: M — most experimental of the project's checks; SQL parsing via regex is brittle by design

**Numbering**: this plan uses "Check 10" assuming #727's "Check 9" has landed first. If #729 ships before #727, slot this in as "Check 9" instead and renumber when #727 lands. The check is independent of #727's content.

## Context

Migrations 0071 and 0072 net to a no-op: 0071 creates a unique partial index on `rotation`; 0072 drops it. They shipped as two separate migrations because they were authored two hours apart on 2026-05-01. The chain runs each migration in isolation, so 0071's retroactively-added precondition guard fires before 0072 has a chance to undo its sibling. Folding the pair into a single no-op migration would have prevented today's wedge.

A validator check that detects this pattern at PR time would let authors fold pairs before merge — converting "two ships that net to a no-op" into "one migration with a `-- intentionally a no-op` comment".

## Why this is hard

SQL parsing via regex can't see:

- DDL composed via `EXECUTE format(...)`.
- DDL with quoted identifiers across multiple variants (`"my_idx"` vs `my_idx` vs `wxyc_schema."my_idx"`).
- Renames (`ALTER INDEX X RENAME TO Y` then `DROP INDEX Y` — the rename hides the create).
- Cascading DROPs (`DROP TABLE foo` removes any indexes on it; the validator would need a schema model to track).

Acceptance criteria below set the bar: catch the canonical CREATE-then-DROP-by-name pair (the 0071/0072 case). Document false-negative cases in the docstring; don't try to be exhaustive.

## Approach

Slot Check 10 into `scripts/validate-migrations.mjs` after Check 9. WARNING level (not error). Suppression syntax `-- @intentional-create-revert: <reason>`.

Two design choices:

1. **Window definition**: how recently does the CREATE need to be relative to the DROP? Options:
   - **Last successful prod deploy** (uses GH API to fetch deploy run, parse cursor) — most accurate, requires network access from the validator.
   - **Last N migrations** (configurable, default 10) — cheap, deterministic, runs offline.
   - **All un-merged-to-prod migrations** (parses `_journal.json` against a known-deployed cursor file) — middle ground.

   **Recommended: Last N migrations.** Works offline, no GH API dep, the N=10 default catches the 0071/0072 case (they're 1 apart) and any plausible future case.

2. **Object-name extraction**: how loose to be?
   - Strict: only catch named objects in standard DDL forms (CREATE INDEX X, DROP INDEX X; ALTER TABLE T ADD CONSTRAINT C, ALTER TABLE T DROP CONSTRAINT C; CREATE TABLE T, DROP TABLE T).
   - Loose: try to match across variations (rename detection, schema-qualified names).

   **Recommended: Strict.** Loose adds maintenance burden for marginal gain. Document the strict list in the docstring; loose-match cases can suppress with the comment.

## Implementation

### Step 1 — Read Check 8 and Check 9 to lock the pattern

Both already in `scripts/validate-migrations.mjs`. Same shape: walk SQL files, regex, emit `reportWarning`.

### Step 2 — Implement Check 10

```js
// Check 10: WARNING — detect CREATE-then-DROP migration pairs that net to
// a no-op within the last N migrations. Pairs like 0071+0072 (CREATE INDEX
// then DROP INDEX of the same name) ship as two migrations but conceptually
// undo each other; folding them prevents the chain from running each in
// isolation, which matters when the CREATE has a precondition that fires
// against current prod state. Suppressible with a per-migration comment
// `-- @intentional-create-revert: <reason>` when the pair is intentional
// schema evolution rather than a bugfix-revert.
//
// Limitations: parses bare DDL via regex. Misses dynamic SQL (EXECUTE
// format(...)), renames-then-drops, cascading DROPs. Strict by design — see
// WXYC/Backend-Service#729 for design rationale.
//
// Window: last N migrations (default 10), configurable via
// `process.env.CHECK_10_WINDOW_SIZE`.
function checkCreateThenDropPairs() {
  const WINDOW_SIZE = Number(process.env.CHECK_10_WINDOW_SIZE ?? 10);
  const SUPPRESS_PATTERN = /--\s*@intentional-create-revert:/;

  // Sorted by idx ascending — already what _journal.json gives us.
  const recent = journalEntries.slice(-WINDOW_SIZE);

  // Build per-object op-list: key = `<kind>:<name>`, value = [{idx, op}].
  // Kinds: 'index', 'constraint', 'table', 'column'.
  // Names are normalized: strip outer quotes, strip schema prefix.
  const timeline = new Map();
  const PATTERNS = [
    // CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name>
    { kind: 'index', op: 'create', re: /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["']?[\w.]+["']?\.)?["']?(\w+)["']?/gi },
    // DROP INDEX [IF EXISTS] [schema.]<name>
    { kind: 'index', op: 'drop', re: /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:["']?[\w.]+["']?\.)?["']?(\w+)["']?/gi },
    // ALTER TABLE <t> ADD CONSTRAINT <name>
    { kind: 'constraint', op: 'create', re: /ADD\s+CONSTRAINT\s+["']?(\w+)["']?/gi },
    // ALTER TABLE <t> DROP CONSTRAINT [IF EXISTS] <name>
    { kind: 'constraint', op: 'drop', re: /DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?["']?(\w+)["']?/gi },
    // (Tables and columns are not in the canonical 0071/0072 case; skip
    // unless real-world need surfaces.)
  ];

  for (const entry of recent) {
    const file = path.join(migrationsDir, `${entry.tag}.sql`);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    if (SUPPRESS_PATTERN.test(content)) continue;

    for (const { kind, op, re } of PATTERNS) {
      let match;
      while ((match = re.exec(content)) !== null) {
        const name = match[1];
        const key = `${kind}:${name}`;
        if (!timeline.has(key)) timeline.set(key, []);
        timeline.get(key).push({ idx: entry.idx, tag: entry.tag, op });
      }
    }
  }

  // Find pairs: for each object, if there's a create followed by a drop with
  // no further create in between, warn.
  for (const [key, ops] of timeline) {
    for (let i = 0; i < ops.length - 1; i++) {
      if (ops[i].op === 'create' && ops[i + 1].op === 'drop') {
        const [createOp, dropOp] = [ops[i], ops[i + 1]];
        const message =
          `Migration ${createOp.tag} creates ${key}, ` +
          `migration ${dropOp.tag} drops it. The pair nets to a no-op but the ` +
          `chain runs each migration in isolation — if the CREATE has a precondition, ` +
          `it fires even though the effect is reverted moments later. Consider folding ` +
          `the pair into a single no-op migration, or suppress with ` +
          `'-- @intentional-create-revert: <reason>' if this is intentional schema evolution.`;
        // Warn on the CREATE side (the one whose precondition would fire).
        const createFile = path.join(migrationsDir, `${createOp.tag}.sql`);
        reportWarning(createFile, message);
      }
    }
  }
}
```

### Step 3 — Wire into the runner + update docstring

Same pattern as Check 9. Add `checkCreateThenDropPairs()` to the runner; add Check 10 description to top-of-file docstring.

### Step 4 — Validate against current main

Expected hit on current main: `0071_rotation-active-album-bin-uniq` (creates `rotation_active_album_bin_uniq` index) + `0072_drop-rotation-active-album-bin-uniq` (drops it). Confirm Check 10 emits the warning.

If 0071 has already been "resolved" via the manual `__drizzle_migrations` insert from #718, Check 10 still warns at PR time on any future similar pair — that's the point.

## Test plan (TDD)

Existing tests for the validator live at `tests/unit/scripts/validate-migrations.test.ts` (TypeScript, Jest config `jest.unit.config.ts`). They spawn the validator as a subprocess against temporary migration fixtures. Append Check 10's tests there; do not create a new test file.

1. **Happy path**: 10 sequential migrations, no CREATE/DROP-of-same-name pair → no warning.
2. **Canonical pair (0071/0072 shape)**: synthetic migrations with `CREATE INDEX foo ...` + `DROP INDEX foo` → warning emitted on the CREATE migration.
3. **Beyond window**: pair separated by > WINDOW_SIZE migrations → no warning.
4. **CREATE-DROP-CREATE**: same name created, dropped, then created again — should warn on the first (create, drop) pair only, not on the second create.
5. **Suppression**: pair with `-- @intentional-create-revert: schema evolution from #N` → no warning.
6. **Quoted variants**: `CREATE INDEX "my_idx"` matched against `DROP INDEX my_idx` → warning (name normalization).
7. **Schema-qualified DROP**: `DROP INDEX wxyc_schema.my_idx` matched against `CREATE INDEX my_idx` → warning.
8. **CONSTRAINT pair**: `ALTER TABLE t ADD CONSTRAINT c ...` + `ALTER TABLE t DROP CONSTRAINT c` → warning.
9. **Dynamic SQL**: `EXECUTE format('CREATE INDEX %I', name)` + `DROP INDEX foo` → no warning (documented limitation).

Use temp-directory fixtures with synthetic SQL files.

## Risks / gotchas

1. **Regex SQL parsing has known limits.** Acceptable — Check 10 is a hint, not a guarantee. If false positives become noisy, suppression syntax handles it; if false negatives bite, #726 (pre-flight dry-run) catches the runtime failure.
2. **Window size is a tuning knob.** Default 10 is enough to catch 0071/0072 (1-apart) and any reasonable future pair. If a pair lands more than 10 apart, that's likely intentional schema evolution that *shouldn't* be folded — the false-negative is correct behavior.
3. **The warning-on-CREATE choice.** Could warn on either migration in the pair. CREATE-side is preferred because that's the migration whose precondition would fire — pointing the operator's eye at the migration that causes the wedge. Document the choice in the check's docstring.
4. **CONSTRAINT-name extraction is fragile.** The `ADD CONSTRAINT <name>` pattern is consistent in our migrations, but Postgres allows `CHECK (...)` without a name (auto-generated). Auto-generated names won't match across the pair. Acceptable false-negative; document.

## Acceptance criteria

- [ ] Check 10 implemented as a WARNING (not error), suppressible with `-- @intentional-create-revert: <reason>`.
- [ ] Runs on every PR via the existing validator invocation.
- [ ] Repro test: validator emits a warning on current main HEAD for the 0071+0072 pair (run before any cleanup of those migrations).
- [ ] Unit tests cover the 9 cases listed in Test Plan.
- [ ] Validator's exit code logic unchanged.
- [ ] Docstring lists Check 10 alongside Checks 1-9; documents the strict-DDL-only design choice and suppression syntax.

## Out of scope

- Detecting renames (`ALTER INDEX X RENAME TO Y`) and chasing the renamed object through the timeline.
- Detecting cascading DROPs (`DROP TABLE` removing all indexes on the table).
- Auto-folding pairs (would rewrite migration history; CLAUDE.md generally forbids).
- Cross-PR detection (the check looks at the current state of `_journal.json` only — a pair split across two un-merged PRs is invisible until both merge).

## References

- `scripts/validate-migrations.mjs` — existing 9-check infrastructure (assumes #727 lands first, but Check 10 doesn't depend on Check 9)
- 0071+0072 — the prompting case
- WXYC/Backend-Service#705 — Check 8 precedent (precondition guards)
- WXYC/Backend-Service#727 — Check 9 (sibling effort)
