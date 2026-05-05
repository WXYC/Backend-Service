# Plan: Audit the four other migrations 2710f2e retroactively guarded

- **Issue**: WXYC/Backend-Service#728
- **Project**: [Migration Deploy Hardening](https://github.com/orgs/WXYC/projects/26) — Phase 1 (audit)
- **Size**: S — investigation + comments, no production code changes

## Context

Commit `2710f2e` ("Migration precondition guards: pattern, retroactive examples, validator check", 2026-05-01) retrofitted `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guards onto 5 recent constraint-adding migrations as exemplars. Migration 0071 is one of those five and wedged today's deploy because its retroactive guard fires against current prod data shape.

The other 4 migrations in that commit are unaudited. Each could be a deferred wedge waiting for the next deploy that crosses its `__drizzle_migrations` cursor.

## Approach

Investigation. No production code change unless a wedge is found, in which case file follow-ups (one per finding) under this project.

## Implementation

### Step 1 — Enumerate the 5 migrations

```bash
git show 2710f2e --stat -- 'shared/database/src/migrations/*.sql'
```

Capture the list. Should include 0071 (already known) plus 4 others. Record their paths.

### Step 2 — Determine prod's current `__drizzle_migrations` cursor

After the manual recovery for #718 (the 0071/0072 backfill INSERTs land), the cursor will be at `1779856000004` (0072's `when`). Confirm with:

```bash
ssh wxyc-ec2 "docker exec <db-container> psql -U <user> -d <db> -c 'SELECT MAX(created_at) FROM drizzle.__drizzle_migrations'"
```

Or, if logical replication is current, query the local replica. Do whichever doesn't add prod load.

**Replica freshness check before running guard SELECTs.** Logical replication has bounded but non-zero lag; `srsubstate = 'r'` means "subscriber is ready to receive", not "subscriber is at the tip". Before trusting any guard-predicate SELECT against the replica, confirm:

```sql
SELECT
  subname,
  pg_wal_lsn_diff(pg_current_wal_lsn(), latest_end_lsn) AS lag_bytes,
  EXTRACT(EPOCH FROM (now() - latest_end_time)) AS lag_seconds
FROM pg_stat_subscription;
```

Require `lag_seconds < 60` and `lag_bytes < 1000` before running any Bucket B/C SELECT. Otherwise wait for the replication slot to catch up, or fall back to querying prod directly via the SSH tunnel — note in the audit comment which path was used per finding so the freshness assumption is auditable.

### Step 3 — Bucket each retroactively-guarded migration

For each of the 5 migrations (including 0071 for completeness):

| Migration | when | cursor < when? | Bucket |
|---|---|---|---|
| ... | ... | ... | ... |

- **Bucket A** (cursor >= when): migration was applied before the guard was added. Guard never runs again. Safe.
- **Bucket B** (cursor < when, guard predicate is currently false): guard exists, guard would run on next migrate, but it'll pass. Safe.
- **Bucket C** (cursor < when, guard predicate is currently true): wedge in queue. **File follow-up.**

For Bucket B/C migrations, run the precondition guard's SELECT against the local replica (which mirrors prod data shape). The SELECT lives inside the `DO $$ ... BEGIN SELECT ... INTO ... FROM ... HAVING ... ; ... END $$;` block — extract and run the inner SELECT directly. If `count > 0`, it's Bucket C.

### Step 4 — Document findings

Comment on issue #728 with the bucketing table. For Bucket C entries, file follow-up issues under the Migration Deploy Hardening project. Each follow-up should:

- State the wedge mode plainly: "migration N's guard fires because <data condition>".
- Link to the migration file and the prod query that confirmed the failure.
- Recommend a fix from #718's three options: manual `__drizzle_migrations` insert, run the runbook the guard cites, or fold-with-its-revert if applicable.

### Step 5 — Update CLAUDE.md if a pattern emerges

If 2+ Bucket C wedges surface, the retrofitting practice itself needs a note in CLAUDE.md's migration section warning future authors to bucket each retrofit explicitly before merging.

## Test plan

This is investigation, not code. The "test" is reproducibility:

- Each Bucket A claim must be backed by `cursor >= when` evidence.
- Each Bucket B claim must show the guard's SELECT returning 0 rows against the replica.
- Each Bucket C finding must show the SELECT returning >0 rows.

Capture the SQL and outputs as a comment on #728 so a future audit can re-run them.

## Risks / gotchas

1. **The local replica may lag prod.** Logical replication has bounded latency but is not transactional with prod. If a Bucket B SELECT returns 0 rows at audit time but prod has stale data the replica hasn't caught up to, the audit can miss a Bucket C. Mitigation: check `pg_stat_subscription` shows current state before running SELECTs; or wait for a quiescent window.
2. **A guard's predicate may reference a table the replica doesn't replicate.** The replication tunnel covers `wxyc_schema` per the publication setup — confirm it covers all tables the guards reference (rotation, flowsheet, library, etc.). If a guard touches an auth table, the audit may need to query prod directly.
3. **Re-merging the rotation-dedupe job (currently on `task/694-rotation-dedupe`) is its own decision.** If the audit reveals 0071 is the only Bucket C and the recommended fix is "merge the dedupe job", that's a different conversation. Don't auto-merge.

## Acceptance criteria

- [ ] All 5 migrations 2710f2e touched are bucketed (table posted as comment on #728).
- [ ] Each Bucket B/C finding includes the SQL run and the row count returned.
- [ ] Bucket C findings each have a filed follow-up issue under project #26.
- [ ] If 2+ Bucket C findings: a CLAUDE.md update lands warning future authors about retrofitting guards onto already-authored migrations without bucketing them first.

## Out of scope

- Auditing migrations 2710f2e didn't touch. The risk window is specifically retroactive guards on already-authored migrations.
- Deciding whether to merge `task/694-rotation-dedupe`. Surface the dependency; let the user choose.
- Changing the precondition-guards pattern itself (it's correct for new migrations; the failure mode is retroactive application).

## References

- `2710f2e` — the retrofitting commit
- Issue #718 — the recovery for 0071 specifically
- Run 25337297761 — the deploy that exposed the wedge
