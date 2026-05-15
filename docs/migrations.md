# Drizzle Migrations

Operational rules for adding migrations to `shared/database/src/migrations/`. CLAUDE.md links here.

## Quick reference

```bash
npm run drizzle:generate   # Generate SQL migration from schema changes
npm run drizzle:migrate    # Apply migrations to database
npm run drizzle:drop       # Delete a migration file
```

Each migration produces three artifacts: the `.sql` file, a journal entry in `meta/_journal.json`, and a per-migration snapshot in `meta/<idx>_snapshot.json`. Always run `drizzle:generate` to add a migration — never hand-create the journal entry, never hand-edit the SQL or snapshot.

## One-time per-clone setup

`shared/database/src/migrations/meta/_journal.json` is an append-only Drizzle index. Every PR that adds a migration appends an entry; concurrent PRs collide on the array even when the new entries don't overlap. The repo ships `.gitattributes` with `merge=journal`, but the actual merge driver lives in `.git/config` and isn't checked in — each collaborator must register it once after cloning:

```bash
npx git-merge-append install \
  --name journal \
  --array-path entries --key idx --sort-by idx \
  -- shared/database/src/migrations/meta/_journal.json
```

After this, `git rebase` / `git merge` resolve concurrent journal appends automatically. If you skipped the install and are mid-rebase with `<<<<<<<` in `_journal.json`, run `npx git-merge-append resolve --array-path entries --key idx --sort-by idx -- shared/database/src/migrations/meta/_journal.json` to fix it post-hoc. See [git-merge-append](https://github.com/jakebromberg/git-merge-append) for details.

## Rules

<!-- @rule id=journal-snapshot-coupling enforced-by=scripts/validate-migrations.mjs:check-7 added=2026-02-15 incidents=#590 -->

**Always run `drizzle:generate`.** The `meta/` directory holds two parallel artifacts: `_journal.json` (one entry per migration, ordered by idx) and per-migration `meta/<idx>_snapshot.json` files (each capturing cumulative schema state through that idx). Drizzle-kit emits all three (SQL, journal entry, snapshot) as a side-effect of `generate`. Hand-creating a journal entry without running `generate` ships the migration but skips the snapshot, and the chain rots silently — `drizzle:generate` then diffs against the last _real_ snapshot, producing a noisy catch-up migration that contains operations the database already has. WXYC/Backend-Service#590 covers the cleanup. `scripts/validate-migrations.mjs` Check 7 enforces the rule going forward via the `HISTORICAL_MISSING_SNAPSHOT_IDXS` allowlist (which must not grow).

<!-- @rule id=hand-edit-when enforced-by=scripts/validate-migrations.mjs:check-1 added=2026-02-01 incidents=#400,#550 -->

**The one sanctioned hand-edit on the new journal entry is the `when` field.** Drizzle-kit auto-stamps `when = Date.now()`, but Drizzle's runtime migrator (`drizzle-orm/pg-core/dialect.js`) decides what to apply by comparing each entry's `when` against `max(__drizzle_migrations.created_at)` in production — anything `when <= max` is silently skipped on every subsequent migrate run, with no way to re-insert (see #400 / #550 for the two production incidents this caused). Once a previous PR landed a future-dated `when` (deliberately or via a now-stale fake clock), every subsequent migration's auto-stamped `when` will be below that cursor and must be bumped. **The recipe is: set the new entry's `when` to `previous_entry.when + 1` (one millisecond above the journal tail).** PR #551 did this explicitly when replaying 0054 as 0065 (`when=1779683200001`); PR #564 used `1779683200002` for 0066; the practice continues through 0067/0068. Validator Check 1 enforces strict monotonicity, so any deviation from `+1ms` is fine as long as it's strictly greater. Do not touch any other journal field by hand, and do not edit the snapshot — drizzle-kit uses snapshots as the diff baseline, so any hand-edit there rots the chain.

<!-- @rule id=parallel-pr-when-collision enforced-by=none added=2026-03-12 incidents=#400,#550 -->

**Parallel-PR collision on `when`.** Two open PRs picking the same `previous_entry.when + 1` would each generate a journal entry at identical `when`. The `git-merge-append` driver resolves _structural_ conflicts on the entries array (concurrent appends), but it does not detect that two entries carry the same `when` value — both can land cleanly, and Drizzle's runtime cursor would silently skip the second on first deploy (the same #400 / #550 failure mode this rule exists to prevent). When the journal-merge driver auto-resolves your branch and the resulting tail has a duplicate `when`, the second-merging PR must rebase and bump again before merging.

<!-- @rule id=sql-comment-block enforced-by=none added=2026-02-15 -->

**The generated SQL file may grow a leading comment block.** Drizzle-kit emits the bare DDL; the established practice (see 0053, 0063, 0065) is to prepend a `--`-comment header explaining the migration's purpose, the operational caveats (lock behavior, expected duration), and any companion backfill job. The DDL itself stays exactly as drizzle-kit produced it.

<!-- @rule id=if-not-exists-index enforced-by=none added=2026-03-01 -->

**`CREATE INDEX` migrations may add `IF NOT EXISTS` by hand.** When an index ships against a large prod table, the deploy runbook is to build it CONCURRENTLY out-of-band first (no AccessExclusiveLock, no INSERT pause) and then merge a migration that finds it already there. Drizzle-kit doesn't emit `IF NOT EXISTS` for indexes; hand-edit it onto the `CREATE INDEX` line so the migration is a no-op against the prod DB while fresh dev databases pick the index up on first migrate. The comment block must include the exact `CREATE INDEX CONCURRENTLY ...` command for ops to run, and must explain that the in-migration form is _not_ CONCURRENTLY because Drizzle wraps each migration in a transaction (`CONCURRENTLY cannot run inside a transaction block`). Reference: 0057, 0068, 0070. Don't add `IF NOT EXISTS` to other DDL (ALTER TABLE, etc.) — the index pattern is the only one that needs prod pre-prep.

<!-- @rule id=ddl-only enforced-by=none added=2026-02-15 incidents=#511 -->

**Migrations are DDL-only.** Bulk DML (rewrites of more than ~10k rows) does not belong inside a migration file because the DDL portion takes an `AccessExclusiveLock` that is held until the transaction commits, and a long DML can wedge the table for hours. Put the rewrite in a one-shot backfill job under `jobs/<name>-backfill/` (declared with `"job-type": "one-shot"` in `package.json`). The build pipeline pushes the image to ECR; a human invokes it via `docker run --rm --env-file .env <image>` during a low-traffic window. If a downstream migration depends on the backfill having run, gate it with a `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard at the top of the file. See `0053_flowsheet-dj-name-column.sql` + `jobs/flowsheet-dj-name-backfill/` + `0054_flowsheet-search-doc-with-dj-name.sql` for the canonical pattern, and issue #511 for the incident this rule was learned from.

<!-- @rule id=constraint-precondition-guards enforced-by=scripts/validate-migrations.mjs:check-8 added=2026-04-20 incidents=#705 -->

**Constraint-adding migrations should include precondition guards.** Any migration that adds a `UNIQUE`, `CHECK`, `NOT NULL`, or `FOREIGN KEY` constraint depends on a data invariant that current rows must satisfy. If they don't, Postgres aborts the migration mid-apply and the deploy wedges (recovery pattern: #511). Guard the DDL with a `DO $$ ... RAISE EXCEPTION ... END $$;` block above the `CREATE`/`ALTER` so the migration fails fast with a readable message and the transaction rolls back cleanly. Example for the rotation unique partial index from #694:

```sql
-- 0071 unique partial index on (rotation.album_id, rotation.rotation_bin) WHERE kill_date IS NULL
-- Requires: all duplicate active groups must be resolved first.

DO $$
DECLARE dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT album_id, rotation_bin
    FROM wxyc_schema.rotation
    WHERE kill_date IS NULL
    GROUP BY album_id, rotation_bin
    HAVING COUNT(*) > 1
  ) g;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot apply rotation_active_album_bin_uniq: % duplicate groups remain. Run rotation-dedupe job first or pre-clean manually.', dup_count;
  END IF;
END $$;

-- The actual DDL follows
CREATE UNIQUE INDEX IF NOT EXISTS ...
```

The same shape covers `NOT NULL` (count `WHERE col IS NULL`), `CHECK` (count rows that violate the predicate), and `FK` (count orphans via `LEFT JOIN ... WHERE referenced.id IS NULL`). The pattern is the same prevention this codebase already uses on the 0053 + `jobs/flowsheet-dj-name-backfill/` + 0054 chain — generalize it to any constraint-adding migration. Some constraints are provably safe (e.g. a `UNIQUE` index on a freshly-added nullable column, or `NOT NULL` paired with a `DEFAULT`); when no real precondition exists, document the reasoning with a `-- @no-precondition-needed: <reason>` comment so the linter (`scripts/validate-migrations.mjs` Check 8) suppresses its warning. The PR-bot data-shape report (companion #703) catches violations at PR time; the precondition guard is the last line of defense at apply time.

<!-- @rule id=cross-cache-identity-guards enforced-by=scripts/check-precondition-guards.sh added=2026-04-25 -->

**Cross-cache-identity precondition guards (cross-epic, project-scoped).** The precondition-guard pattern above (0053 → `jobs/flowsheet-dj-name-backfill/` → 0054, scoped within a single migration chain) extends to **cross-epic** prerequisite chains for the cross-cache-identity project. The substrate migration `0NNN_library_identity_substrate.sql` (filed under WXYC/Backend-Service#663; PR number to be backfilled here when the substrate PR opens) ships its gate-check at `scripts/check-library-identity-gate.sql`. Any migration in any epic that FK-references `library_identity` / `library_identity_source` / `library_identity_history`, or adds a `NOT NULL` / `UNIQUE` / `CHECK` constraint to those tables, must include a `DO $$ ... RAISE EXCEPTION ... END $$;` block that calls or inlines the gate-check's `truly_unresolved_rows < 1000` predicate. Same mechanism as 0053/0054, scoped across epics rather than within one chain. Plan reference: `WXYC/wiki/plans/library-hook-canonicalization-plan.md` §3.2.3. CI enforcement is the `Migration guards` job in `.github/workflows/test.yml`, which runs `scripts/check-precondition-guards.sh` (ships with the substrate PR); a migration that legitimately doesn't need the guard opts out with a `-- precondition-guard: not-required (rationale)` first line.

<!-- @rule id=decision-timeout-flag-only enforced-by=none added=2026-04-25 -->

**Decision-timeout pattern (cross-cache-identity scope).** For decision timeouts during the cross-cache-identity project, use **flag-only** GitHub Action comments per plan §4 step 0. The workflow lives at `WXYC/catalog-audits/.github/workflows/cross-cache-identity-timeouts.yml` (filed in WXYC/Backend-Service#666). It posts a deadline-overdue comment after 10 business days but does NOT propose or set a default — silence does not select an option. The pattern is intentionally project-scoped: do not reuse it for other projects without explicit similar documentation in their plan. The reason it cannot generalize is that auto-defaulting on silence violates the "questions are not commands" principle (`~/.claude/CLAUDE.md`); flag-only is the form that informs without acting. Forward link: filter-decision gate is tracked at WXYC/catalog-audits#11 (E5 step 1 — library coverage filter discovery).

<!-- @rule id=library-identity-source-set enforced-by=scripts/validate-library-identity-sources.sh added=2026-04-25 -->

**`library_identity_source` source-set extensibility (manual-override + dual-table writer).** The `library_identity_source.source` column is an open enum: 8 sources today (`discogs_master`, `discogs_release`, `mb_release_group`, `mb_release`, `mb_recording`, `wikidata`, `spotify`, `apple_music`) per plan §3.2.2. The set is hardcoded in three places that must move in lockstep: (a) `shared/database/src/schema.ts` (`library_identity` per-source columns), (b) `jobs/library-identity-manual-override/` (validator's `failure_reason` enum + CSV schema), (c) `apps/backend/services/identity/*` (writer's source iteration list). Adding a 9th source (e.g., a Bandcamp leg per LML#207) is a single coordinated PR that updates all three; the `lint:identity-sources` CI job (script `scripts/validate-library-identity-sources.sh`, ships with the substrate PR) fails on mismatch so no half-wired source can land. Plan reference: §3.2.4 manual-override workflow extensibility.

## Flowsheet attempt-at markers

`flowsheet` carries two `timestamp with time zone` markers that record "this row was attempted by job X" so subsequent passes can target only the rows that still need work, without confusing tried-and-no-match for tried-and-failed:

- `legacy_link_attempted_at` — set when the `legacy_release_id → library.id` resolver ran for the row and could not link. Migration 0063, populated by `jobs/broken-fk-recovery`. Lets B-2.2's LML backfill query both never-had-legacy-id rows and the broken-FK residual in one predicate.
- `metadata_attempt_at` — set when the LML metadata fetch responded for the row (success-with-match OR success-no-match). Migration 0069 (#639), stamped at runtime by `apps/backend/services/metadata/enrichment.service.ts` inside `.then()` (the `.catch` branch deliberately leaves it NULL so transient LML failures stay retryable). The historical drain (#638) and the recurring drift-repair sweep (#639 Phase 2) target `metadata_attempt_at IS NULL`. **Load-bearing dependency: the "stay retryable" guarantee only holds because `jobs/flowsheet-metadata-backfill/` runs nightly (`0 6 * * *` UTC, cron-registered via deploy-base) and re-attempts every `metadata_attempt_at IS NULL` row. If that cron is paused or removed, the `.catch` arm silently strands the row's enrichment forever — the runtime path has no second chance.**

## Rule annotation convention

Each rule above is preceded by a `<!-- @rule -->` marker. Fields:

- `id` — short kebab-case identifier; must be unique across all `docs/*.md` rules.
- `enforced-by` — file path + check name (e.g. `scripts/validate-migrations.mjs:check-1`), or `none` when the rule lives on author discipline.
- `added` — ISO date the rule was added.
- `incidents` — comma-separated list of incident issues (`#NNN`). Optional.
- `review-after` — optional ISO date. When set and reached, `scripts/check-doc-rules.mjs` flags the rule for review.

`scripts/check-doc-rules.mjs` parses these markers and emits warnings for:

- rules whose `enforced-by` is `none` and whose `added` date is more than 180 days ago — consider promoting the rule to a check, or removing it if it's been internalized
- rules whose `enforced-by` is non-`none` AND whose prose body exceeds ~600 chars — the check now carries the load; the prose can collapse to a 1-line pointer
- rules whose `review-after` date has passed

Run on demand: `npm run check:doc-rules`. Also runs in `.husky/pre-push` (warn-only — never blocks).

The intent is a forcing function for the question this codebase keeps re-asking: when is an incident-anchored rule ready to compress? Once enforcement exists in a script or CI check, the prose stops being load-bearing and becomes commentary — the script tells you when the moment has arrived.
