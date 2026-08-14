# flowsheet-ghost-row-sweep

One-shot ghost-row sweep for BS#1887 (the mechanism slice of the BS#1083 cleanup). Anti-joins `flowsheet.legacy_entry_id` / `rotation.legacy_rotation_id` against a pluggable authoritative keyspace source and DELETEs the orphans. **Dry-run is the default; writes require `--execute`.** This issue builds and tests the mechanism only — it never runs against production data or the real tubafrenzy dump; that run is BS#1083.

## Problem

`jobs/flowsheet-etl` and `jobs/rotation-etl` are upsert-only: each tick reconciles tubafrenzy rows into Backend-Service via `ON CONFLICT (legacy_entry_id) DO UPDATE` / `ON CONFLICT (legacy_rotation_id) DO UPDATE`. Neither ETL deletes a BS row when tubafrenzy deletes (or never had) the corresponding upstream row, and tubafrenzy's own delete webhook is fire-and-forget — a failed delivery leaves a permanent ghost. BS#1083 tracks the cleanup; this job is the reconciliation pass neither ETL performs.

## Why this ships before BS#1083's dump access is decided

BS#1083 is blocked on the final tubafrenzy `mysqldump` (WXYC/wiki#86, ~2026-08-31) and on deciding how BS gets an authoritative live keyspace out of it (SSH mirror? restored MySQL? extracted id file? — BS#1543 item 2, undecided). Neither blocker touches the _mechanism_: the batched anti-join-and-DELETE logic can be built and tested today against a fixture keyspace. This package is that mechanism. BS#1083 stays the run/close gate — it points the finished tool at the real dump, reviews the log-only counts, and executes the prod DELETEs.

## The `LegacyKeyspaceSource` seam

```ts
interface LegacyKeyspaceSource {
  loadFlowsheetIds(): Promise<Set<number>>;
  loadRotationIds(): Promise<Set<number>>;
}
```

`FileKeyspaceSource` (`keyspace-source.ts`) is the only implementation shipped here: a newline-delimited integer id file per table (`#`-comments and blank lines allowed). That keeps this package decoupled from the dump format entirely — it never parses SQL or talks to MySQL. Point it at a plain id file for tests today; the same file-backed adapter is exactly what a human operator would use for the BS#1083 prod run once that issue's preprocessing step produces an extracted id file. A prod adapter that reads the dump (or a live mirror) directly some other way is a documented seam, not a stub shipped here — add a new `LegacyKeyspaceSource` implementation in BS#1083 once the extraction mechanism is decided; `orchestrate.ts` takes the interface, not a concrete class, so no sweep code changes.

## How the anti-join works

Unlike a SQL-evaluable predicate (`NOT ILIKE`, `NOT IN (<literal list>)`), "not a member of a Set loaded from an external source" isn't cheaply expressible in SQL without shipping a giant literal. Per the issue's implementation note, the membership test happens **in-process**:

1. Page every row with a non-null legacy id, id-cursor, `ORDER BY id`: `WHERE legacy_id IS NOT NULL AND id > afterId ORDER BY id LIMIT batchSize`.
2. For each row, test `keyspace.has(row.legacy_id)` in memory. Absent → ghost.

This means there's no cheap SQL-side "candidates" COUNT the way a SQL-predicate job would have — the ghost count is a running total produced by the scan itself, reported once the pass (or a stop) completes.

## Blast radius (verified against schema)

- **`flowsheet` → `flowsheet_linkage_review`**: `ON DELETE CASCADE` (migration 0067). A ghost flowsheet row's linkage-review queue entry dies with it — no explicit child cleanup needed.
- **`rotation` → `flowsheet.rotation_id`**: `ON DELETE SET NULL` (migration 0097). A legit flowsheet row that happens to reference a ghost rotation row is never blocked or deleted by the sweep; its `rotation_id` just goes NULL.

Both are the intended semantics. The integration suite (`tests/integration/flowsheet-ghost-row-sweep.spec.js`) exercises both.

## Batching, resume, safety

- **Batched DELETE + `ANALYZE`-after** per the bulk-update playbook (`docs/bulk-update-playbook.md`) — one `id = ANY(...)` statement per page, `ANALYZE` on a target's table after its write pass (skipped on dry-run / no-op).
- **Id-cursor resume** per target (`GHOST_SWEEP_FLOWSHEET_AFTER_ID` / `GHOST_SWEEP_ROTATION_AFTER_ID`). The cursor advances only after a page's DELETE call returns successfully — a failure the client sees (a thrown error) never strands unswept ghosts behind the logged cursor; a re-run from the previous cursor re-selects and re-tests them.
- **Empty keyspace floor** (`GHOST_SWEEP_MIN_KEYSPACE_SIZE`, default 1). A `LegacyKeyspaceSource` that returns an empty `Set` — a missing file, a wholly failed extraction, a misconfigured path — would anti-join every row as a ghost. The run refuses outright rather than risk `--execute` emptying a live table over a bad path. This floor only catches a _fully empty_ keyspace; the ghost-fraction ceiling below is its companion for a partially-truncated one. Set to `0` only for a deliberate tiny/empty-fixture test run.
- **Ghost-fraction ceiling** (`GHOST_SWEEP_MAX_GHOST_RATIO`, default 0.5). A keyspace truncated to a small-but-nonzero fraction of its real size passes the empty floor yet would still flag the majority of a live table as ghosts. Once a full page has been scanned, if the running ghost fraction (`ghosts / scanned`) exceeds the ceiling, the target aborts — checked _before_ that page's DELETE, so a truncated keyspace trips with zero rows removed. A healthy sweep clears a small residual of failed-webhook orphans, never most of the table. Evaluated in dry-run too, so it surfaces during the mandatory dry-run review. Set to `1` to disable (a deliberate large-sweep run only).
- **Post-run ghost-free verification** (execute + clean finish that actually deleted). Async commit (`DB_SYNCHRONOUS_COMMIT=off`, set by the Dockerfile) means a page's DELETE can appear to succeed to the Node client and then be lost to a Postgres crash inside the fsync window, with the id-cursor already past it — a resumed follow-up run using the logged cursor would never re-select that row. After a target's main sweep finishes cleanly, the same `[afterId, end]` range it just swept is re-scanned read-only; any ghost still present fails the run loudly (`remaining` in the summary) instead of silently leaving a permanent leftover. Skipped for a target that deleted nothing (no lost-durability window to check). Scope note: the guarded hazard is a Postgres _crash_, which breaks the client connection and ends the run as `failed` (not a clean `stopped`), so a range swept by an earlier clean stop never carried an undetected lost DELETE; a single run from `afterId=0` verifies the whole table, and after a _failed_ run you should resume from a conservative cursor rather than the last logged one.
- **Cooperative pause + SIGTERM graceful stop** — mirrors the sibling jobs' `checkLiveActivity` pause and signal handling (`jobs/streaming-url-remediation` is the structural donor). The sweep deletes from the live `flowsheet` table, so it defers when DJs are active.

## Local dry-run against a fixture

```bash
GHOST_SWEEP_FLOWSHEET_KEYSPACE_FILE=./flowsheet-ids.txt \
GHOST_SWEEP_ROTATION_KEYSPACE_FILE=./rotation-ids.txt \
  npm start
```

Each keyspace file is a newline-delimited list of surviving upstream ids, e.g.:

```
# tubafrenzy FLOWSHEET ids still present upstream
100234
100235
100240
```

Pass `--execute` to write (guard it against a test schema — see Constraints below).

## Constraints (this issue)

- **No production access, no real DELETEs.** `--execute` is exercised only against a test schema / fixture. A bare invocation (no flags) is dry-run — a no-op read.
- Doesn't touch `flowsheet-etl` / `rotation-etl` — the fix is a separate sweep, per BS#1083's disposition (no recurring reconcile inside the ETL).

## Environment variables

| Variable                              | Default    | Notes                                                                                                                                                                                                                                              |
| ------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHOST_SWEEP_FLOWSHEET_KEYSPACE_FILE` | (required) | Path to the newline-delimited flowsheet id file                                                                                                                                                                                                    |
| `GHOST_SWEEP_ROTATION_KEYSPACE_FILE`  | (required) | Path to the newline-delimited rotation id file                                                                                                                                                                                                     |
| `GHOST_SWEEP_BATCH_SIZE`              | 5000       | Rows per SELECT page / DELETE statement (bulk-update playbook default)                                                                                                                                                                             |
| `GHOST_SWEEP_DELETE_TIMEOUT_MS`       | 300000     | `SET LOCAL statement_timeout` around each batch DELETE                                                                                                                                                                                             |
| `GHOST_SWEEP_ANALYZE_TIMEOUT_MS`      | 300000     | `SET LOCAL statement_timeout` around each post-pass `ANALYZE`                                                                                                                                                                                      |
| `GHOST_SWEEP_SAMPLE_SIZE`             | 20         | Orphan ids carried in each target's summary; 0 to omit                                                                                                                                                                                             |
| `GHOST_SWEEP_MIN_KEYSPACE_SIZE`       | 1          | Refuses the run if either loaded keyspace is smaller than this; 0 to disable (deliberate tiny/empty-fixture runs only)                                                                                                                             |
| `GHOST_SWEEP_MAX_GHOST_RATIO`         | 0.5        | Aborts a target once its running ghost fraction exceeds this (after the first full page); 1 to disable                                                                                                                                             |
| `GHOST_SWEEP_FLOWSHEET_AFTER_ID`      | 0          | Resume cursor for the flowsheet target                                                                                                                                                                                                             |
| `GHOST_SWEEP_ROTATION_AFTER_ID`       | 0          | Resume cursor for the rotation target                                                                                                                                                                                                              |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`      | 60         | Set 0 to disable the cooperative pause                                                                                                                                                                                                             |
| `LIVE_ACTIVITY_PAUSE_MS`              | 30000      | Pause duration when DJ activity detected (ms). Must be >= 1000 (BS#2147) — a sub-floor value, including 0, is rejected at init rather than silently disabling the pause.                                                                           |
| `LIVE_ACTIVITY_MAX_PAUSE_MS`          | 1800000    | Cumulative cooperative-pause budget for the whole run; 0 = uncapped. On exhaustion the run **aborts** (`LiveActivityPauseCeilingExceededError`, non-zero exit) rather than pausing indefinitely (BS#2147 review round 2) — see `docs/env-vars.md`. |
| `SENTRY_DSN`                          | (optional) | Sentry error reporting                                                                                                                                                                                                                             |

CLI flags: `--execute` (write mode), `--dry-run` (explicit no-op, the default; passing both fails fast).

## Testing

- `tests/unit/jobs/flowsheet-ghost-row-sweep/orchestrate.test.ts` — mocked-db unit coverage of the loop: batching, id-cursor advance, dry-run vs. `--execute`, delete-failure cursor safety, keyspace-load failure, the empty/undersized-keyspace floor, and post-run verification (both a clean re-scan and a caught residual ghost).
- `tests/unit/jobs/flowsheet-ghost-row-sweep/keyspace-source.test.ts` — `parseIdFile` + `FileKeyspaceSource` against real temp files.
- `tests/integration/flowsheet-ghost-row-sweep.spec.js` — real PostgreSQL: the anti-join SELECT + DELETE mirror `orchestrate.ts`'s SQL, and both blast-radius behaviors (cascade + SET NULL) are asserted against the actual schema.

## What's out of scope (BS#1083)

- The production dump-access mechanism / prod `LegacyKeyspaceSource` adapter.
- Running the sweep against production data.
- Reviewing the log-only dry-run counts and executing the prod DELETEs.
