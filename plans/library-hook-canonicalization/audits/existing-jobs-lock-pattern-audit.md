# Existing-jobs lock-pattern audit (E2 step 0e)

Closes WXYC/Backend-Service#668. Precondition for §4 step 2 (backfill identity from existing artifacts) per plan §3.2.0.2.

## TL;DR

Both existing identity-touching jobs (`jobs/library-canonical-entity-backfill/` and `jobs/artist-identity-etl/`) are **compatible** with the new `library_identity` + `library_identity_source` dual-table writer. Each holds row-level locks only, runs no DDL, has no `AccessExclusiveLock`, and is idempotent on interruption. The dual-write window (§4 step 1-4) can run both old and new writers concurrently without lock contention — the existing jobs target different columns or different tables than the new writer, so per-row locks do not overlap.

**Gate:** PASS. §4 step 2 backfill apply is unblocked.

## Scope

Per §3.2.0.1 the two existing jobs that interact with identity are:

| Job                                       | Table                                                                                                   | Disposition under E2                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `jobs/library-canonical-entity-backfill/` | `library` (writes `canonical_entity_id`, `canonical_entity_confidence`, `canonical_entity_resolved_at`) | Refactored — under E2 it writes to `library_identity_source` + `library_identity` instead of inline columns. |
| `jobs/artist-identity-etl/`               | `artists` (writes the six external-ID columns)                                                          | Kept as-is, separate concern — targets `artists`, not `library`. Out of scope for E2 directly.               |

This audit reads both end-to-end against `cross-cache-identity/e2-step-0e` at the current `main` tip and records observed transaction shape, lock holding, and idempotency per §3.2.0.2's deliverable list.

## 1. `library-canonical-entity-backfill`

### Files reviewed

- `jobs/library-canonical-entity-backfill/job.ts` (entry; calls `runBackfill`)
- `jobs/library-canonical-entity-backfill/orchestrate.ts` (loop body — `loadBatch`, `processRow`, `applyResolution`)
- `jobs/library-canonical-entity-backfill/lml-fetch.ts` (HTTP client; out-of-scope for lock analysis)
- `jobs/library-canonical-entity-backfill/resolve.ts` (pure; maps LML response → `Resolution`)

### Per-row UPDATE shape

Two distinct UPDATE statements in `applyResolution` (`orchestrate.ts:126-151`), one per outcome:

**`auto_accept` UPDATE** (`orchestrate.ts:128-135`):

```sql
UPDATE wxyc_schema.library
SET canonical_entity_id = $1,
    canonical_entity_confidence = $2,
    canonical_entity_resolved_at = now()
WHERE id = $3 AND canonical_entity_id IS NULL
```

**`review` UPDATE** (`orchestrate.ts:140-146`):

```sql
UPDATE wxyc_schema.library
SET canonical_entity_resolved_at = now()
WHERE id = $1
  AND canonical_entity_id IS NULL
  AND canonical_entity_resolved_at IS NULL
```

`no_match` is an intentional no-op; the row stays in the retry pool.

Both UPDATE statements:

- Target a single row by primary key (`WHERE id = $`).
- Include `IS NULL` predicates so a concurrent writer that already populated the row causes the UPDATE to no-op rather than overwrite.
- Use `now()` server-side rather than client clock.

### Batch shape

The orchestrator (`orchestrate.ts:236-250`) does NOT use an explicit transaction. Each `applyResolution` is its own auto-commit `db.execute(...)` call (postgres-js auto-commits in the absence of an explicit `db.transaction(...)`).

The pagination cursor (`lastId`) is in-memory only. Across runs, restarts pick up via the `WHERE canonical_entity_id IS NULL AND canonical_entity_resolved_at IS NULL` filter in `loadBatch` (`orchestrate.ts:197-214`), not via a persisted cursor.

`BATCH_SIZE = 500` (`orchestrate.ts:40`); `THROTTLE_MS = 100` between rows (`orchestrate.ts:47`). At those settings, ~5/sec — well under any reasonable LML rate budget.

`PARTITION_INDEX` / `PARTITION_COUNT` env knobs (`orchestrate.ts:64-90`) shard work across N concurrent containers via `(l.id % count) = index`. Disjoint partitions guarantee N containers never touch the same library row.

### Lock holding

- **No DDL.** `applyResolution` is INSERT-free; UPDATEs only.
- **No `AccessExclusiveLock`.** No `ALTER TABLE`, no index creation, nothing that escalates beyond per-row.
- **Per-statement `RowExclusiveLock` on `wxyc_schema.library`.** Standard for any UPDATE — does not block other UPDATEs unless they target the same row.
- **Per-row `Tuple` lock** acquired and released within each `applyResolution` call. Lock duration is microseconds because no transaction wraps multiple UPDATEs together.
- **Read-side `LEFT JOIN artists`** in `loadBatch` (`orchestrate.ts:197-214`) takes only `AccessShare` on `wxyc_schema.artists` for the duration of the SELECT.

### Idempotency

Restartable. The `WHERE canonical_entity_id IS NULL AND canonical_entity_resolved_at IS NULL` filter naturally excludes rows that have already been processed (auto-accepted: both columns set; review-flagged: `resolved_at` set).

Interruption cases:

- SIGTERM mid-batch: rows committed before the signal stay; the next run picks up where the in-memory cursor left off via the WHERE filter.
- LML failure on a single row: `processRow` (`orchestrate.ts:158-183`) returns `'error'`, logs, and continues. The row stays unresolved and rolls forward.
- Crash before `applyResolution`: the row is unchanged; the next sweep retries.

### Findings

**Compatible with the new writer.** `library-canonical-entity-backfill` writes ONLY to `library.canonical_entity_id*` columns. The new writer (E2-BS step 1, §3.2.2.2) writes to `library_identity` + `library_identity_source` — entirely different tables. Per-row locks are scoped to the row in each table independently; there is no cross-table lock contention.

Under E2 the existing job is **refactored** to write to the new tables instead of the old columns. Until that refactor lands, the two writers can run concurrently (e.g., during the §4 step 2 backfill) — they do not share a mutex domain. Even after refactor, the migrating job touches the same row with row-level locks; there is no escalation path.

## 2. `artist-identity-etl`

### Files reviewed

- `jobs/artist-identity-etl/job.ts` (entry; one-shot or `--poll` mode)
- `jobs/artist-identity-etl/runIncremental.ts` (per-run loop)
- `jobs/artist-identity-etl/fetch-lml.ts` (read from LML's `entity.identity` PG)
- `jobs/artist-identity-etl/transform.ts` (column-fill predicate helpers; pure)

### Bulk UPDATE shape

A single bulk `UPDATE … FROM (VALUES …) RETURNING id` per run (`runIncremental.ts:121-149`). Pseudocode:

```sql
UPDATE wxyc_schema.artists a
SET
  discogs_artist_id     = COALESCE(a.discogs_artist_id,     v.discogs_artist_id),
  musicbrainz_artist_id = COALESCE(a.musicbrainz_artist_id, v.musicbrainz_artist_id),
  wikidata_qid          = COALESCE(a.wikidata_qid,          v.wikidata_qid),
  spotify_artist_id     = COALESCE(a.spotify_artist_id,     v.spotify_artist_id),
  apple_music_artist_id = COALESCE(a.apple_music_artist_id, v.apple_music_artist_id),
  bandcamp_id           = COALESCE(a.bandcamp_id,           v.bandcamp_id)
FROM (VALUES (...), (...), ...) AS v(library_name, discogs_artist_id, ..., bandcamp_id)
WHERE a.artist_name = v.library_name
  AND ( <any column would actually flip from NULL to non-NULL> )
RETURNING a.id
```

Properties:

- **One round-trip per run, regardless of LML row count.** All `fillCandidates` rows from the in-memory loop are folded into a single UPDATE.
- `COALESCE`-in-`SET` preserves any existing non-null value — staff edits always win (per #506 / `runIncremental.ts:108-111`).
- The `WHERE` predicate filters rows where at least one column would actually flip from NULL → non-NULL, so no-op writes never touch the row.

### Batch shape

The whole run is implicitly one auto-commit transaction containing one UPDATE statement. There is no explicit `db.transaction(...)` wrapper, and the SELECT for `existingRows` (`runIncremental.ts:52-63`) is a separate auto-commit query that runs before the UPDATE — they are NOT in the same transaction.

This means: between the SELECT and the UPDATE, another writer (e.g., `artist-identity-etl --poll` mode running concurrently, or the future E2-BS writer) could mutate the matching `artists` rows. The `COALESCE` and the column-flip filter in the UPDATE's `WHERE` are the safety net — even if the SELECT-snapshot data is stale, the UPDATE only writes a column whose live value is `NULL`.

`runIncremental` uses `getLastRunTimestamp` / `updateLastRun` (`runIncremental.ts:36, 41, 100, 152`) on the `cronjob_runs` table to track incremental progress. The watermark is updated AFTER the bulk UPDATE succeeds.

### Lock holding

- **No DDL.** UPDATE-only, plus a SELECT.
- **No `AccessExclusiveLock`.** Nothing escalates beyond per-row.
- **`RowExclusiveLock`** on `wxyc_schema.artists` for the duration of the bulk UPDATE.
- **Per-row `Tuple` locks** acquired briefly per matching artist row inside the UPDATE; released at commit (which is implicit auto-commit on the single statement, so the lock window is sub-statement).
- **Postgres's default `READ COMMITTED` isolation** for both the SELECT and the UPDATE. The two queries do not share a snapshot, hence the `COALESCE` defense.

The `RETURNING a.id` clause does not affect lock semantics; it only collects which rows the UPDATE actually touched.

### Idempotency

Fully restartable. The `getLastRunTimestamp` watermark advances only after a successful UPDATE (`runIncremental.ts:152`). On crash before that line, the next run picks up the same window via `lastRunMs`.

Interruption cases:

- SIGTERM mid-UPDATE: Postgres aborts the transaction; the bulk UPDATE rolls back atomically. `cronjob_runs.last_run` is unchanged. The next run re-fetches the same LML rows and retries.
- LML PG fetch failure: throws from `fetchLmlIdentities`; the run aborts; watermark unchanged.
- DB error mid-UPDATE: same as SIGTERM — transaction rollback, watermark unchanged, next run retries.

`--poll` mode (`job.ts:31-38`) wraps `runIncremental` in `runPollingLoop` from `@wxyc/database`; idempotency is per-iteration of the loop.

### Findings

**Compatible with the new writer.** `artist-identity-etl` writes ONLY to `wxyc_schema.artists`. The new `library_identity` writer (E2-BS step 1) writes to `library_identity` + `library_identity_source`. **Different tables; zero overlap.** Per-row locks are scoped to the row in each table independently.

The job is explicitly out of scope for E2 per §3.2.0.1. No refactor is required. It continues to fill `artists` rows from LML's `entity.identity` table while the new writer fills `library_identity` from LML's `/lookup` response — the two pipelines are independent.

## 3. Compatibility analysis vs. the new writer

The new dual-table writer per §3.2.2.2 performs, per `/lookup` response, an `INSERT … ON CONFLICT DO UPDATE` on `library_identity_source` (one row per source per library_id) and a follow-up `INSERT … ON CONFLICT DO UPDATE` on `library_identity` (one row per library_id, recomputed cross-source minimum confidence per §3.4.1.1 Rule 4). Both inserts are wrapped in a single `db.transaction(...)` — see §3.2.2.2 worked example.

**Lock-domain analysis under dual-write:**

| Writer                                                        | Table touched                                         | Lock                           | Concurrent with `library-canonical-entity-backfill`? | Concurrent with `artist-identity-etl`? |
| ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------ | ---------------------------------------------------- | -------------------------------------- |
| New `/lookup` writer                                          | `library_identity`, `library_identity_source`         | row-level, transaction-bounded | ✅ disjoint table                                    | ✅ disjoint table                      |
| `library-canonical-entity-backfill` (pre-refactor)            | `library.canonical_entity_*` columns                  | row-level, auto-commit         | n/a (one writer at a time per partition)             | ✅ disjoint table                      |
| `library-canonical-entity-backfill` (post-refactor, under E2) | `library_identity*` (instead of `canonical_entity_*`) | row-level, transaction-bounded | n/a                                                  | ✅ disjoint table                      |
| `artist-identity-etl`                                         | `artists`                                             | row-level, auto-commit         | ✅ disjoint table                                    | n/a                                    |

**Conclusion:** no shared lock domain between the new writer and either existing job. Dual-write window is safe.

**Two follow-up notes for the refactored job:**

1. **`library-canonical-entity-backfill` post-refactor must wrap the per-row INSERT into `library_identity_source` + UPDATE of `library_identity` in `db.transaction(...)`** — same as the new `/lookup` writer. Otherwise a crash between the two could leave the sidecar populated but the main row stale, violating §3.2.2.2's atomicity invariant. This is implementation guidance for E2-BS step 2 backfill (§4 step 2), not a flaw in the current pre-refactor code.
2. **Partitioning by `(id % count)` (the existing `PARTITION_INDEX` / `PARTITION_COUNT` knobs)** continues to work post-refactor. Different partitions write to disjoint library_id ranges, so per-row locks remain non-overlapping across containers. No coordination needed beyond what's already there.

## 4. Findings summary

| Item                                          | `library-canonical-entity-backfill`                          | `artist-identity-etl`                           |
| --------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| Per-row UPDATE shape                          | Single-row `UPDATE WHERE id=…` (two variants per outcome)    | Bulk `UPDATE … FROM (VALUES …)` once per run    |
| Batch shape                                   | Auto-commit per row, batches of 500, 100ms throttle          | One auto-commit UPDATE per run, watermark-gated |
| Lock holding                                  | Row-level only                                               | Row-level only                                  |
| `AccessExclusiveLock`?                        | No                                                           | No                                              |
| Idempotency                                   | Yes — WHERE filter excludes already-processed rows           | Yes — watermark advances only on success        |
| Conflicts with new `library_identity` writer? | No (disjoint tables; post-refactor uses transaction wrapper) | No (disjoint tables)                            |

**Gate decision: PASS.** §4 step 2 backfill apply is unblocked. No incompatibility found; no blocking issue filed. The two implementation notes above are guidance for E2-BS step 2's backfill author, not blockers for this audit.

## Plan reference

`WXYC/wiki/plans/library-hook-canonicalization-plan.md` §3.2.0.1 (existing identity jobs), §3.2.0.2 (this audit), §3.2.2.2 (new writer's dual-table semantics), §4 step 2 (backfill).
