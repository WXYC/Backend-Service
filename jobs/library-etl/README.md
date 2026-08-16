# Library ETL Job

Incremental synchronization of the music library from the legacy tubafrenzy MySQL database to PostgreSQL. The job connects to the remote MySQL server over SSH, fetches releases modified since the last run, normalizes the data, and inserts new artists and albums into the PostgreSQL database via Drizzle ORM.

## How It Works

1. Reads the last successful run timestamp from the `cronjob_runs` table.
2. SSH-tunnels into the legacy server and queries `LIBRARY_RELEASE` joined with `LIBRARY_CODE`, `GENRE`, and `FORMAT` for all releases modified since that timestamp. On the first run (no prior timestamp), all releases are fetched.
3. Parses the tab-delimited MySQL output into structured rows.
4. Within a single database transaction:
   - Syncs genres and formats from the legacy database into PostgreSQL (insert-only — existing records are unchanged).
   - Loads the delete-denylist (`library_delete_denylist`) and skips every release listed there, re-checks it per release at the point of write, and reconciles once after the loop — see [Delete denylist](#delete-denylist).
   - Normalizes artist names (e.g., "Various Artists" variants are collapsed, "The Beatles" becomes "Beatles, The" for alphabetical sorting).
   - Normalizes code letters (2-3 character uppercase identifiers; `Z-*` codes map to `V/A`).
   - Parses format strings into canonical names (`cd`, `cdr`, `vinyl`, `vinyl 7"`, `vinyl 10"`, `vinyl 12"`) and disc quantities.
   - Inserts or looks up artists (with an in-memory cache to avoid redundant queries).
   - Ensures `genre_artist_crossreference` entries exist.
   - Inserts new albums into the `library` table, skipping duplicates.
5. Updates the `cronjob_runs` timestamp on success.

Rows with `db_only` genre, missing genre/format mappings, empty artist names, or empty album titles are skipped with a warning.

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
  DELETE FROM wxyc_schema.cronjob_runs WHERE job_name = 'library-etl';
  ```

  The next run has no watermark, so `buildReleaseQuery` emits no `TIME_LAST_MODIFIED` predicate and re-selects the entire upstream catalog in one pass. Every other release re-upserts idempotently (the `setWhere` guard means unchanged rows are not touched), so this is safe — it is just slow, and it is the same recipe the troubleshooting table below gives for a stuck watermark.

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
- A running PostgreSQL database with migrations applied. For local development, the runner script (`npm run etl:library`) handles this automatically — it starts Docker, launches the database container, and runs Drizzle migrations. If the database container already exists with stale settings, remove the volume first: `docker compose -f dev_env/docker-compose.yml --profile dev down -v`. The job automatically syncs genres and formats from the legacy database on each run, so no manual seeding is required.

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

| Symptom                                                                         | Likely Cause                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error executing remote SQL command over SSH`                                   | SSH credentials are wrong, the legacy server is unreachable, or MySQL credentials are invalid. Check `SSH_HOST`, `SSH_USERNAME`, `SSH_PASSWORD`, and the `REMOTE_DB_*` variables.                                                                                                                                                                                                                                                                                                                           |
| `Missing genre "X" for release Y`                                               | The legacy database has a referential integrity issue — a release references a genre that doesn't exist in the legacy `GENRE` table. This is a data quality issue in tubafrenzy, not a configuration problem.                                                                                                                                                                                                                                                                                               |
| `Missing format "X" for release Y`                                              | The legacy format string could not be parsed into a canonical format name (e.g., unsupported media type like cassette).                                                                                                                                                                                                                                                                                                                                                                                     |
| `No new legacy releases found`                                                  | Normal when nothing has changed since the last run.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Job runs but inserts nothing                                                    | Check the `cronjob_runs` table — the `last_run` timestamp may already be ahead of all legacy data. To force a full re-sync, delete the row: `DELETE FROM cronjob_runs WHERE job_name = 'library-etl';`. Releases in `library_delete_denylist` stay skipped across a full re-sync by design (see [Delete denylist](#delete-denylist)).                                                                                                                                                                       |
| Run exits non-zero with "denylisted release(s) are PRESENT in the library"      | A hard-deleted release is back in the catalog: either a resurrection that slipped through before the write-time re-check existed, or a row someone restored by hand without clearing its denylist row. The run does not repair it — dependents may have accrued. Decide which way it should go and either delete the library row through `DELETE /library/:id` or clear the denylist row (see [Restoring a release](#restoring-a-release)). The run keeps failing until one of those happens, deliberately. |
| A release deleted by mistake does not come back after clearing its denylist row | Expected: clearing the row is necessary but not sufficient. The upstream `TIME_LAST_MODIFIED` is older than the watermark, so the release is never re-selected. Follow [Restoring a release](#restoring-a-release).                                                                                                                                                                                                                                                                                         |
