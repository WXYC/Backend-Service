# Library ETL Job

Incremental synchronization of the music library from the legacy tubafrenzy MySQL database to PostgreSQL. The job connects to the remote MySQL server over SSH, fetches releases modified since the last run, normalizes the data, and inserts new artists and albums into the PostgreSQL database via Drizzle ORM.

## How It Works

1. Reads the last successful run timestamp from the `cronjob_runs` table.
2. SSH-tunnels into the legacy server and queries `LIBRARY_RELEASE` joined with `LIBRARY_CODE`, `GENRE`, and `FORMAT` for all releases modified since that timestamp. On the first run (no prior timestamp), all releases are fetched.
3. Parses the tab-delimited MySQL output into structured rows.
4. Within a single database transaction:
   - Syncs genres and formats from the legacy database into PostgreSQL (insert-only — existing records are unchanged).
   - Normalizes artist names (e.g., "Various Artists" variants are collapsed, "The Beatles" becomes "Beatles, The" for alphabetical sorting).
   - Normalizes code letters (2-3 character uppercase identifiers; `Z-*` codes map to `V/A`).
   - Parses format strings into canonical names (`cd`, `cdr`, `vinyl`, `vinyl 7"`, `vinyl 10"`, `vinyl 12"`) and disc quantities.
   - Inserts or looks up artists (with an in-memory cache to avoid redundant queries).
   - Ensures `genre_artist_crossreference` entries exist.
   - Inserts new albums into the `library` table, skipping duplicates.
5. Updates the `cronjob_runs` timestamp on success.

Rows with `db_only` genre, missing genre/format mappings, empty artist names, or empty album titles are skipped with a warning.

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

| Symptom                                       | Likely Cause                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error executing remote SQL command over SSH` | SSH credentials are wrong, the legacy server is unreachable, or MySQL credentials are invalid. Check `SSH_HOST`, `SSH_USERNAME`, `SSH_PASSWORD`, and the `REMOTE_DB_*` variables.                             |
| `Missing genre "X" for release Y`             | The legacy database has a referential integrity issue — a release references a genre that doesn't exist in the legacy `GENRE` table. This is a data quality issue in tubafrenzy, not a configuration problem. |
| `Missing format "X" for release Y`            | The legacy format string could not be parsed into a canonical format name (e.g., unsupported media type like cassette).                                                                                       |
| `No new legacy releases found`                | Normal when nothing has changed since the last run.                                                                                                                                                           |
| Job runs but inserts nothing                  | Check the `cronjob_runs` table — the `last_run` timestamp may already be ahead of all legacy data. To force a full re-sync, delete the row: `DELETE FROM cronjob_runs WHERE job_name = 'library-etl';`        |
