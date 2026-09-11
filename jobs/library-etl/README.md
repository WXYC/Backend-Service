# Library ETL Job

Incremental synchronization of the music library from the legacy tubafrenzy MySQL database to PostgreSQL. The job connects to the remote MySQL server over SSH, fetches releases modified since the last run, normalizes the data, and inserts new artists and albums into the PostgreSQL database via Drizzle ORM.

## How It Works

The run has **two phases**, in two separate transactions. Every legacy MySQL read happens with no Postgres transaction open.

### Phase 1 — the release import

1. Reads the last successful run timestamp from the `cronjob_runs` table (`job_name = 'library-etl'`).
2. SSH-tunnels into the legacy server and queries `LIBRARY_RELEASE` joined with `LIBRARY_CODE`, `GENRE`, and `FORMAT` for all releases modified since that timestamp. On the first run (no prior timestamp), all releases are fetched.
3. Parses the tab-delimited MySQL output into structured rows, and fetches the legacy `GENRE` / `FORMAT` reference tables.
4. Within a single database transaction:
   - Syncs genres and formats from the legacy database into PostgreSQL (insert-only — existing records are unchanged).
   - Loads the delete-denylist (`library_delete_denylist`) and skips every release listed there, re-checks it per release at the point of write, and reconciles once after the loop — see [Delete denylist](#delete-denylist).
   - Normalizes artist names (e.g., "Various Artists" variants are collapsed, "The Beatles" becomes "Beatles, The" for alphabetical sorting).
   - Normalizes code letters (2-3 character uppercase identifiers; `Z-*` codes map to `V/A`).
   - Parses format strings into canonical names (`cd`, `cdr`, `vinyl`, `vinyl 7"`, `vinyl 10"`, `vinyl 12"`) and disc quantities.
   - Inserts or looks up artists (with an in-memory cache to avoid redundant queries).
   - Ensures `genre_artist_crossreference` entries exist.
   - Inserts new albums into the `library` table, skipping duplicates.
   - Updates the `library-etl` `cronjob_runs` timestamp.

When the release delta is empty — roughly 98% of runs — phase 1 collapses to the denylist reconcile sweep plus the watermark write.

### Phase 2 — the secondary imports

Runs on **every** pass, idle ones included, strictly after phase 1's transaction commits, in its own transaction: artist cross-references, release cross-references, compilation-track credits. Each is delta-bounded against its own watermark. See [Delta bounds and watermarks](#delta-bounds-and-watermarks).

Rows with `db_only` genre, missing genre/format mappings, empty artist names, or empty album titles are skipped with a warning.

## Delta bounds and watermarks

Four `cronjob_runs` rows, not one. The job-wide `library-etl` row bounds the release import; the three `library-etl:*` rows bound the secondary imports; a fourth is a clock rather than a bound.

| `cronjob_runs.job_name`          | bounds                         | how                                                                            |
| -------------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `library-etl`                    | `LIBRARY_RELEASE`              | `WHERE lr.TIME_LAST_MODIFIED > <watermark>`                                    |
| `library-etl:artist-crossref`    | `LIBRARY_CODE_CROSS_REFERENCE` | `WHERE (cr.TIME_LAST_MODIFIED IS NULL OR cr.TIME_LAST_MODIFIED > <watermark>)` |
| `library-etl:release-crossref`   | `RELEASE_CROSS_REFERENCE`      | same, on that table                                                            |
| `library-etl:compilation-tracks` | `COMPILATION_TRACK_ARTIST`     | `WHERE LIBRARY_RELEASE_ID IN (…)` — see below                                  |
| `library-etl:secondary-full`     | nothing                        | the "last full reconciliation" clock, not a delta bound                        |

**Why the secondary imports cannot reuse the job-wide watermark.** The idle path advances `library-etl` _before_ the secondary imports run, and that is the path ~98% of runs take. Bound on that row, a cross-reference an MD adds in `/wxycdb` during any half hour with no `LIBRARY_RELEASE` edit would be skipped at that run (nothing else ran) and then excluded forever (the watermark had already moved past it). Each secondary import therefore owns its watermark and advances it only on its own success — which is also what makes phase 2's failure mode benign: a cross-reference failure no longer rolls back the release import, it just leaves that import's watermark where it was so the next run retries exactly the failed part.

**`COMPILATION_TRACK_ARTIST` is bounded differently, because it has to be.** The table is four columns with no timestamp and no surrogate key, so there is nothing to compare a watermark against. It is bounded instead on the set of `LIBRARY_RELEASE_ID`s whose release row changed since `library-etl:compilation-tracks` — one extra small MySQL query per run, returning zero rows on an idle pass. Above 500 delta ids (a full re-sync, or an unusually large librarian batch) the `IN` list is dropped in favour of a full fetch: the same work, without a 50k-element list in a heredoc. That fallback only widens the **MySQL** read — the Postgres-side `legacy_release_id -> library.id` lookup is derived from the fetched rows themselves, so it is bounded to the ~2,586 releases that actually carry compilation tracks on every path, including the full pass, and never degrades to a scan of all ~64k `library` rows inside the held-lock window. The write itself is **batched** — chunked multi-row `INSERT … ON CONFLICT DO NOTHING` at 1,000 rows per statement, so a full pass is ~141 statements rather than ~140,617 (BS#2424; that loop was 12-15 minutes of held write transaction per working run, and the root cause of BS#2413).

**That release-id set is a proxy, and it is blind to the only writer this table has.** tubafrenzy never writes `COMPILATION_TRACK_ARTIST` — it only reads it, for the Lucene index. The rows are generated out of band by library-metadata-lookup's `scripts/va_disambiguate` SQL writer, which emits bare `INSERT INTO COMPILATION_TRACK_ARTIST` statements and never touches `LIBRARY_RELEASE`, so a freshly disambiguated batch moves no release's `TIME_LAST_MODIFIED` and the delta never sees it. In practice **new compilation-track credits arrive on the daily full reconciliation pass, not within 30 minutes** — a real latency change from before BS#2424, bounded at a day. After running the VA disambiguation script, delete `library-etl:secondary-full` to pull the credits in on the next pass instead of waiting.

### The backfill gap, and how it is covered

A timestamp bound on the two cross-reference tables would freeze **100%** of their unresolved-row gap, immediately. The newest upstream `LIBRARY_CODE_CROSS_REFERENCE` edit is 17 months old and the newest `RELEASE_CROSS_REFERENCE` edit is 18 _years_ old, so the deltas are permanently empty in steady state — and the unbounded re-import had been quietly doubling as a retry, re-attempting rows that previously failed to resolve. That retry is what has been narrowing the shortfall BS#2386 measures (78 rows against tubafrenzy's 119, and 22 against 35).

The cover is a **periodic full reconciliation pass**, chosen over recording unresolved pairs: when `library-etl:secondary-full` is missing or older than 24 hours, all three secondary imports drop their bounds and run unbounded, exactly as every run used to. It is cheap — a full cross-reference pass is ~300 Postgres statements, and a full compilation-track pass is ~141 batched ones — and it also covers the clock-skew hole any timestamp bound has (the watermark is Backend's clock, `TIME_LAST_MODIFIED` is tubafrenzy's), bounding that exposure to a day rather than forever.

A missing watermark row means an unbounded fetch for exactly that import, which is the first-run backfill.

24 hours is **not** a reduction in the BS#2386 retry cadence, despite the job running every 30 minutes: the old retry already sat behind the release-delta early return, so it ran only on work slots — measured at ~1.15 per day. To force a pass immediately, without a deploy:

```sql
DELETE FROM wxyc_schema.cronjob_runs WHERE job_name = 'library-etl:secondary-full';
```

The opposite lever exists too and needs no deploy either. `isSecondaryFullPassDue` compares `now - last_run` against the interval, so a **future** `last_run` suppresses the pass until the clock catches up — useful if a full pass is ever implicated in contention and you need to stand it down while you investigate:

```sql
UPDATE wxyc_schema.cronjob_runs SET last_run = now() + interval '7 days' WHERE job_name = 'library-etl:secondary-full';
```

It is self-clearing: the next pass that does run overwrites the row with its own start time. Suppressing it for long is not free — the full pass is the only thing that retries unresolved cross-references and the only thing that ever sees new compilation-track credits.

### What the bounds cannot recover

**Deletions.** tubafrenzy's `delete(int id)` is a hard `DELETE` with no tombstone in both cross-reference repositories, so no timestamp bound and no full _upsert_ pass can see a removal. This import has always been upsert-only and has never propagated deletions; that is unchanged by the bounds, not regressed by them. Recovering a deleted cross-reference would need an explicit diff-and-delete pass, which this job does not have.

### Reading the log counters

`Artist cross-references: imported N, skipped M` and its two siblings mean the same thing they meant before the bounds landed, deliberately — the BS#2413 correlation was measured against these lines. In particular, `Compilation track artists: imported N` counts rows that **resolved to a `library` row and were handed to the insert**, _not_ rows actually written; `ON CONFLICT DO NOTHING` may write fewer. The batch count is reported separately on the same line. What _does_ change is the magnitude: on a bounded run these numbers reflect the delta, so a full pass's `imported 139748, skipped 869` is now a once-a-day figure rather than a once-a-work-slot one.

## Delete denylist

This job is the **only** consumer of `wxyc_schema.library_delete_denylist` (migration 0146, BS#2112). One row is written there, inside the delete's own transaction, for every release a librarian hard-deletes through `DELETE /library/:id`.

It exists because a Backend-side delete does not reach tubafrenzy. The upstream `LIBRARY_RELEASE` row survives, so whenever a pass re-selects it this job finds no `library` row carrying its `legacy_release_id` and takes the INSERT branch of `ON CONFLICT (legacy_release_id) DO UPDATE` — bringing the release back under a **new** `library.id`, stripped of the `rotation` (binning history, `kill_date`, LML-resolved `discogs_release_id`), `album_metadata`, `reviews` and `album_critic_reviews` rows that cascade-deleted against the old id and that this job never imports. `legacy_release_id` is ~99.88% populated, so effectively the whole catalog is resurrection-eligible without the denylist.

**The trigger is an upstream edit or a full re-sync, not the clock.** `buildReleaseQuery` filters `WHERE lr.TIME_LAST_MODIFIED > <last run>` and a Backend-side delete leaves that timestamp alone, so a deleted release nobody touches upstream is not re-selected by the next half-hourly pass, or by any number of them. What re-selects it is a librarian saving that release in `/wxycdb`, or an operator forcing a full re-sync. The exposure is open-ended rather than half an hour wide — do not read the cron schedule as a countdown in either direction. (It also means a deleted release is _not_ reliably restored by removing its denylist row alone; see [Restoring a release](#restoring-a-release) below.)

### Three checks, not one

A single snapshot of the denylist is not enough, because the import runs inside one long `db.transaction()` at READ COMMITTED: the snapshot is fixed at the statement that took it while every later statement sees a fresh one, so a delete committing mid-run is invisible to it. The job therefore checks three times:

1. **A run-start in-memory pre-filter** (`loadDeleteDenylist`), consulted first in the per-release loop. Costs nothing and keeps the common case — a denylisted release re-selected on every full re-sync — from paying a round trip.
2. **A fresh per-release read at the point of write** (`isDeniedAtWriteTime`), taken _ahead of_ `findExistingRelease`. Ahead, because that call's canonical-tuple match can back-stamp a deleted release's `legacy_release_id` onto a different `library` row — a resurrection by a second door that a check at the INSERT alone would miss.
3. **A reconcile sweep after the loop** (`reconcileDenylistedInserts`), joining the denylist to `library`. A delete can still commit in the one-statement gap between (2) and the upsert; this catches that. Rows **this run inserted** are deleted — safe because they were created by the same uncommitted transaction, so nothing has seen them and no dependent can have accrued. Rows that were **already there** are not deleted (dependents may have accrued, and an ETL removing catalog rows it did not create is a worse failure than the one it reports); they are logged as an error and the run exits non-zero.

Without (2) and (3) the failure is terminal and self-concealing: a resurrected row is never updated and never removed, because every later run consults the denylist, finds the id, and skips — logging `skipped as deleted` for a release sitting in the catalog.

Two further properties are load-bearing:

- **The denylist load has no delta predicate**, and must never grow one. The full-re-sync recipe below deletes this job's `cronjob_runs` watermark, which drops the `TIME_LAST_MODIFIED >` filter and re-selects the entire upstream catalog in one pass; a windowed denylist would let that single run resurrect every release ever deleted.
- **The reconcile sweep runs on idle passes too.** A delta pass that finds no new releases is the common case, so skipping the check there would make detection depend on the next run that happens to have work.

Denylisted releases are counted separately in the completion log (`skipped as deleted N (+M caught at write time)`), not folded into the ordinary `skipped` counter, and undone resurrections get their own counter.

### Restoring a release

Clearing the denylist row is necessary but **not sufficient**. This job only looks at releases whose upstream `TIME_LAST_MODIFIED` is newer than its `cronjob_runs` watermark, and the Backend-side delete never touched that timestamp — it is older than every subsequent watermark, so the release is never re-selected and never comes back. The release has to be pushed back into the candidate set as well.

```sql
-- 1. Lift the denylist (necessary, not sufficient).
DELETE FROM wxyc_schema.library_delete_denylist WHERE legacy_release_id = <id>;
```

Then **one** of:

- **Preferred — an upstream edit.** Have a librarian open that release in tubafrenzy's `/wxycdb` and save it. That bumps `TIME_LAST_MODIFIED`, so the next half-hourly pass re-selects exactly that release and nothing else.
- **Fallback — force a full re-sync**, when no upstream edit is possible:

  ```sql
  DELETE FROM wxyc_schema.cronjob_runs WHERE job_name = 'library-etl' OR job_name LIKE 'library-etl:%';
  ```

  The next run has no watermark, so `buildReleaseQuery` emits no `TIME_LAST_MODIFIED` predicate and re-selects the entire upstream catalog in one pass. Every other release re-upserts idempotently (the `setWhere` guard means unchanged rows are not touched), so this is safe — it is just slow, and it is the same recipe the troubleshooting table below gives for a stuck watermark.

  **Both clauses, not just the `=`.** The secondary imports carry their own `library-etl:*` watermark rows ([Delta bounds and watermarks](#delta-bounds-and-watermarks)). Deleting only the exact `library-etl` row leaves those in place, so the cross-reference and compilation-track imports stay bounded and the operator gets a release-only pass while believing they forced a full one. The predicate is written `= 'library-etl' OR LIKE 'library-etl:%'` rather than the looser `LIKE 'library-etl%'` so that a future job named `library-etl-something` is not swept up by an operator running this recipe — `:` is the namespace separator, and no job name elsewhere in `jobs/` contains one.

Either way the release returns under a **fresh `library.id`**, without the `rotation`, `album_metadata`, `reviews` or `album_critic_reviews` rows that cascade-destroyed against the old one. Those are not recoverable from tubafrenzy and this job does not import them; if they matter, restore them from a database backup rather than from an ETL pass.

Verify the restore actually landed — the failure mode is silent:

```sql
SELECT id, legacy_release_id, album_title FROM wxyc_schema.library WHERE legacy_release_id = <id>;
```

## Environment Variables

The job requires two sets of credentials: one for the SSH tunnel to the legacy server, and one for the target PostgreSQL database.

### SSH Tunnel (legacy server access)

| Variable       | Required | Default | Description                   |
| -------------- | -------- | ------- | ----------------------------- |
| `SSH_HOST`     | Yes      | —       | Hostname of the legacy server |
| `SSH_PORT`     | No       | `22`    | SSH port                      |
| `SSH_USERNAME` | Yes      | —       | SSH login username            |
| `SSH_PASSWORD` | Yes      | —       | SSH login password            |

### Remote MySQL (queried over SSH)

| Variable             | Required | Default | Description                              |
| -------------------- | -------- | ------- | ---------------------------------------- |
| `REMOTE_DB_HOST`     | Yes      | —       | MySQL host (as seen from the SSH server) |
| `REMOTE_DB_PORT`     | No       | `3306`  | MySQL port                               |
| `REMOTE_DB_USER`     | Yes      | —       | MySQL username                           |
| `REMOTE_DB_PASSWORD` | Yes      | —       | MySQL password                           |
| `REMOTE_DB_NAME`     | Yes      | —       | MySQL database name                      |

### Target PostgreSQL (Drizzle ORM)

| Variable           | Required | Default       | Description              |
| ------------------ | -------- | ------------- | ------------------------ |
| `DB_HOST`          | Yes      | —             | PostgreSQL host          |
| `DB_PORT`          | No       | `5432`        | PostgreSQL port          |
| `DB_NAME`          | Yes      | —             | PostgreSQL database name |
| `DB_USERNAME`      | Yes      | —             | PostgreSQL username      |
| `DB_PASSWORD`      | Yes      | —             | PostgreSQL password      |
| `WXYC_SCHEMA_NAME` | No       | `wxyc_schema` | PostgreSQL schema name   |

## Prerequisites

- Node.js 22+
- Docker (for local development database; the runner script starts Docker and the database container automatically if needed)
- Network access to the legacy SSH server
- A running PostgreSQL database with migrations applied. For local development, the runner script (`npm run etl:library`) handles this automatically — it starts Docker, launches the database container, and runs Drizzle migrations. If the database container already exists with stale settings, remove the volume first with `npm run db:reset`. The job automatically syncs genres and formats from the legacy database on each run, so no manual seeding is required.

## Building

From the repo root:

```bash
npm run build --workspace=@wxyc/library-etl
```

Or from within `jobs/library-etl/`:

```bash
npm run build
```

This compiles `job.ts` with tsup (esbuild) into `dist/job.js`.

## Running

### Locally

The runner script validates your environment, checks database connectivity, builds if needed, and runs the job with clear error messages if anything is wrong:

```bash
npm run etl:library
```

This is the recommended way to run the job locally. It handles `.env` loading via `dotenvx` automatically.

### Development (watch mode)

Rebuilds and re-runs the job on every file change:

```bash
npm run dev --workspace=@wxyc/library-etl
```

### Docker

Build and run the production container:

```bash
# Build (from repo root)
npm run docker:build --workspace=@wxyc/library-etl

# Run
docker run --env-file .env wxyc_library_etl:ci
```

### Scheduled Execution

The job is designed to run every 30 minutes (see `cron-schedule` in `package.json`). In production, an external scheduler (e.g., Kubernetes CronJob, AWS ECS Scheduled Task, or cron) should invoke:

```
npm start --workspace=@wxyc/library-etl
```

The job is safe to run on a schedule because it is incremental (only processes releases modified since the last run) and idempotent (duplicate albums are detected and skipped).

## Testing

Unit tests for the parsing and normalization functions:

```bash
npm run test:unit -- --testPathPatterns=library-etl
```

## Troubleshooting

| Symptom                                                                                    | Likely Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error executing remote SQL command over SSH`                                              | SSH credentials are wrong, the legacy server is unreachable, or MySQL credentials are invalid. Check `SSH_HOST`, `SSH_USERNAME`, `SSH_PASSWORD`, and the `REMOTE_DB_*` variables.                                                                                                                                                                                                                                                                                                                                 |
| `Missing genre "X" for release Y`                                                          | The legacy database has a referential integrity issue — a release references a genre that doesn't exist in the legacy `GENRE` table. This is a data quality issue in tubafrenzy, not a configuration problem.                                                                                                                                                                                                                                                                                                     |
| `Missing format "X" for release Y`                                                         | The legacy format string could not be parsed into a canonical format name (e.g., unsupported media type like cassette).                                                                                                                                                                                                                                                                                                                                                                                           |
| `No new legacy releases found`                                                             | Normal when nothing has changed since the last run.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Job runs but inserts nothing                                                               | Check the `cronjob_runs` table — the `last_run` timestamp may already be ahead of all legacy data. To force a full re-sync, delete the job-wide row **and** its `library-etl:*` siblings: `DELETE FROM cronjob_runs WHERE job_name = 'library-etl' OR job_name LIKE 'library-etl:%';` — the second clause matters, see [Delta bounds and watermarks](#delta-bounds-and-watermarks). Releases in `library_delete_denylist` stay skipped across a full re-sync by design (see [Delete denylist](#delete-denylist)). |
| Run exits non-zero with "denylisted release(s) are PRESENT in the library"                 | A hard-deleted release is back in the catalog: either a resurrection that slipped through before the write-time re-check existed, or a row someone restored by hand without clearing its denylist row. The run does not repair it — dependents may have accrued. Decide which way it should go and either delete the library row through `DELETE /library/:id` or clear the denylist row (see [Restoring a release](#restoring-a-release)). The run keeps failing until one of those happens, deliberately.       |
| `Cross-reference` / `Compilation track artists` counters much smaller than they used to be | Expected since BS#2424: the secondary imports are delta-bounded now and only the daily full reconciliation pass reports whole-corpus figures. Check `library-etl:secondary-full` in `cronjob_runs` — if it is advancing daily, coverage is intact. See [Delta bounds and watermarks](#delta-bounds-and-watermarks).                                                                                                                                                                                               |
| A cross-reference edited in `/wxycdb` has not appeared                                     | It should arrive within 30 minutes even if no release changed — phase 2 runs on idle passes. If it has not, check `library-etl:artist-crossref` / `library-etl:release-crossref` in `cronjob_runs`: a watermark that stopped advancing means phase 2 is throwing, which also leaves a non-zero exit. A watermark ahead of the edit's `TIME_LAST_MODIFIED` (clock skew between Backend and tubafrenzy) is recovered by the next daily full pass, or immediately by deleting `library-etl:secondary-full`.          |
| A release deleted by mistake does not come back after clearing its denylist row            | Expected: clearing the row is necessary but not sufficient. The upstream `TIME_LAST_MODIFIED` is older than the watermark, so the release is never re-selected. Follow [Restoring a release](#restoring-a-release).                                                                                                                                                                                                                                                                                               |
