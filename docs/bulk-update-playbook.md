# Bulk UPDATE Playbook

When a backfill, audit script, or mojibake-recovery `UPDATE` is about to land against prod, walk this list before kicking it off. The per-row cost on `flowsheet` and other heavily-indexed tables is much higher than it looks, and the second-order cost of leaving the planner's stats stale is what cost dj-site DJs 5-second autocomplete timeouts after the [2026-05-15 mojibake migration](https://github.com/WXYC/Backend-Service/issues/934).

## The per-row cost on `flowsheet`

A single `UPDATE` on `wxyc_schema.flowsheet` is more expensive than a hand-rolled rewrite estimate suggests. Per row:

1. **Heap rewrite** (~150 bytes WAL) — MVCC-mandatory. New row version + old row dead-marked.
2. **`search_doc` tsvector regeneration** — `search_doc` is `GENERATED ALWAYS AS ... STORED`. Every UPDATE on a column referenced by the expression recomputes the tsvector. Significant CPU + WAL.
3. **~6 index updates** (~50 bytes WAL each) — PK btree, `add_time`, `show_id`, `search_doc` GIN, plus situational partial indexes. HOT updates are blocked because indexes reference `dj_name` / `search_doc` and the table has no fillfactor headroom.
4. **WAL FPI** (8 KB) on the first dirty page after each checkpoint (`checkpoint_timeout = 300s`).
5. **CDC trigger fires `pg_notify('cdc', ...)`** with full-row JSON (~500 bytes). Measured trigger overhead during the 2026-04-27 dj_name backfill: `Trigger cdc_flowsheet: time=1480ms calls=4999` — about 30% of the per-batch cost. NOTIFY queue can backpressure if the listener falls behind.
6. **Replication to RDS standby** if Multi-AZ.

For a 1.96M-row backfill that totals roughly 3-5 GB of WAL plus ~1 GB of NOTIFY queue traffic.

## Run ANALYZE after every bulk UPDATE

After the UPDATE commits, the planner's stats on the touched columns are stale until autovacuum runs. Until then, any query that _should_ use a GIN trigram / partial / functional index covering those columns can fall off that path and revert to a sequential or bitmap-heap scan. For `/flowsheet/suggest/*`, that meant 5-second timeouts in front of on-air DJs.

Always pair the UPDATE with an explicit `ANALYZE` on the touched tables. `ANALYZE` cannot run inside a transaction, so it lives outside any `BEGIN`/`COMMIT` block — usually at the bottom of the operator-run script. The recipe:

```sql
SET statement_timeout = '5min';

-- ... your bulk UPDATEs here, possibly wrapped in BEGIN/COMMIT ...

-- Refresh planner stats so the GIN trigram / btree / partial indexes
-- that the UPDATEd columns are covered by stay on the index path. See
-- BS#934 for the incident this recipe was learned from.
ANALYZE wxyc_schema.flowsheet;
ANALYZE wxyc_schema.library;
ANALYZE wxyc_schema.rotation;
ANALYZE wxyc_schema.artists;
```

The check at `scripts/check-bulk-update-analyze.mjs` greps every `.sql` file under `shared/database/src/migrations/`, `scripts/`, and `jobs/` and warns when a `UPDATE table SET ...` statement isn't paired with an `ANALYZE table` (or a bare `ANALYZE;`, which re-stats everything). Suppress with `-- @no-analyze-needed: <reason>` when the UPDATE is small enough that stats drift doesn't matter (single-row config changes, fresh-table backfills, etc.) — already-applied migrations whose hashes are frozen use the per-tag `HISTORICAL_NO_ANALYZE_NEEDED_TAGS` allowlist in the script instead.

## What works (validated 2026-04-27)

- **Async commit (`DB_SYNCHRONOUS_COMMIT=off`)** — backfill containers opt in. Removes per-COMMIT fsync wait. Safe because backfills are idempotent (`WHERE col IS NULL` resume filter). 3-5x speedup. Knob documented in this CLAUDE.md.
- **Batch size 5000** — default in `BACKFILL_BATCH_SIZE`. Each batch under per-statement timeout on a healthy host. Bumping to 20000 amortizes per-tx overhead when prod has IOPS headroom.
- **Partial functional index for the inner SELECT** — e.g. `CREATE INDEX CONCURRENTLY ... ON flowsheet (id) WHERE entry_type = 'track' AND dj_name IS NULL`. Drop after backfill since it'll be empty. Saved hours on the 2026-04-27 backfill by making the resume-loop `SELECT id WHERE dj_name IS NULL ORDER BY id LIMIT 5000` an index-only scan.
- **gp3 storage** — see `project_prod_rds_config` in agent memory. The 3000 IOPS sustained baseline is the floor for bulk operations to even feasibly run.

## The infinite-loop pitfall (real bug from the 2026-04-27 backfill)

The original `applyBatch` looked like:

```sql
UPDATE flowsheet f SET dj_name = COALESCE(u.dj_name, s.legacy_dj_name, u.name)
FROM shows s LEFT JOIN auth_user u ON u.id = s.primary_dj_id
WHERE f.show_id = s.id AND f.entry_type = 'track' AND f.dj_name IS NULL
  AND f.id IN (SELECT id FROM flowsheet WHERE entry_type='track' AND dj_name IS NULL ORDER BY id LIMIT 5000);
```

When `u.dj_name`, `s.legacy_dj_name`, `u.name` are _all_ NULL (which happens when a show has no `primary_dj_id` and the legacy ETL hasn't populated `legacy_dj_name`), `COALESCE(...)` returns NULL. The UPDATE writes NULL → NULL — Postgres counts the row as "updated" but `dj_name IS NULL` still holds. The resume loop never narrows. We saw 25 rows spinning at thousands of iterations/second before catching it.

**Fix for any future backfill that uses `WHERE col IS NULL` to resume**: guard the SET expression so it cannot collapse to NULL. Either:

- Add `AND COALESCE(...) IS NOT NULL` to the WHERE clause (skip rows that would be no-ops), or
- Provide a non-null fallback in the SET (e.g., `'Unknown DJ'`).

**Value-ordered drains — the work-list-cursor variant (BS#1591)**: the id-cursor recipe (`id > lastId`) is what makes a drain wedge-proof, but it only works when the drain order is id order. If a drain must process rows in some _value_ order (e.g. play-count-descending), a naive "re-SELECT the head of the cohort each batch" re-selects the same failing row at the top forever — failing rows deliberately stay in the cohort for cross-run retry. The recipe: materialize the run's work-list ONCE (ordered ids, in memory or a scratch table) and advance a monotonic cursor over it; a failed row waits for the next run's work-list, and within the run each id is selected at most once. See `jobs/flowsheet-metadata-backfill/worklist.ts` + `orchestrate.ts` for the reference implementation.

## Sync-gap remediation

For 24 of the 25 stuck rows from the 2026-04-27 incident, the `dj_name` was actually present in tubafrenzy (`FLOWSHEET_RADIO_SHOW_PROD.DJ_NAME`) — Backend-Service's `shows.legacy_dj_name` just hadn't synced. The fix path:

1. Query tubafrenzy via SSH+MySQL (live data needs `sshpass` via docker).
2. `UPDATE wxyc_schema.shows.legacy_dj_name` from tubafrenzy values for the affected `legacy_show_id`s.
3. Re-run the JOIN-based UPDATE — picks up the rows automatically.

The underlying ETL bug is tracked in [#605](https://github.com/WXYC/Backend-Service/issues/605).

## Pre-flight checklist

Before kicking off a bulk UPDATE on `flowsheet` (or any heavily-indexed live table):

1. Walk the per-row cost list above and budget WAL + IOPS. At 3000 IOPS, expect ~1-2 effective IOPS per row → 1.96M rows ≈ 30 min minimum on a healthy instance.
2. Set `DB_SYNCHRONOUS_COMMIT=off` and a 5+ minute `DB_STATEMENT_TIMEOUT_MS` in the backfill container.
3. If the SET expression can resolve to NULL, guard it. Don't trust `WHERE col IS NULL` alone to terminate the loop.
4. Add `ANALYZE <table>;` for every UPDATEd table at the bottom of the script (or in a paired post-script step if the UPDATEs run inside a transaction).
5. After the run completes: drop temporary indexes, leave the production-grade ones, and confirm no NULL rows remain.

## Related

- [BS#934](https://github.com/WXYC/Backend-Service/issues/934) — Suggest endpoints regress to 5s timeouts after the mojibake migration; missed `ANALYZE` on touched tables.
- [BS#605](https://github.com/WXYC/Backend-Service/issues/605) — `shows.legacy_dj_name` ETL sync gap.
- [`docs/migrations.md`](migrations.md) — DDL-only rule (`@rule id=ddl-only`) and post-bulk-UPDATE ANALYZE rule (`@rule id=post-bulk-update-analyze`).
