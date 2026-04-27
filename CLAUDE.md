# Backend-Service

API and authentication service for WXYC applications. Provides endpoints for the DJ flowsheet, music library catalog, DJ management, scheduling, and song requests.

## Architecture

### Monorepo Layout

npm workspaces:

| Package                              | Path                                 | Purpose                                                                                                   |
| ------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `@wxyc/backend`                      | `apps/backend/`                      | Express API server (port 8080)                                                                            |
| `@wxyc/auth-service`                 | `apps/auth/`                         | better-auth server (port 8082)                                                                            |
| `@wxyc/database`                     | `shared/database/`                   | Drizzle ORM schema, client, migrations, ETL utilities                                                     |
| `@wxyc/authentication`               | `shared/authentication/`             | Auth middleware, roles, JWT verification                                                                  |
| `@wxyc/flowsheet-etl`                | `jobs/flowsheet-etl/`                | Flowsheet ETL: sync from tubafrenzy                                                                       |
| `@wxyc/rotation-etl`                 | `jobs/rotation-etl/`                 | Rotation ETL: sync from tubafrenzy                                                                        |
| `@wxyc/artist-identity-etl`          | `jobs/artist-identity-etl/`          | Artist identity ETL: sync from LML's `entity.identity`                                                    |
| `@wxyc/flowsheet-dj-name-backfill`   | `jobs/flowsheet-dj-name-backfill/`   | One-shot backfill: populate `flowsheet.dj_name` on legacy track rows after migration 0053                 |
| `@wxyc/library-artist-name-backfill` | `jobs/library-artist-name-backfill/` | One-shot backfill: populate `library.artist_name` from the `artists` join after migration 0058 (Epic A.2) |

### API Server (`apps/backend`)

Express 5 application with these route groups:

| Route           | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `/config`       | Public app bootstrap configuration                         |
| `/proxy`        | iOS proxy endpoints (anonymous auth + rate limit)          |
| `/library`      | Music library catalog                                      |
| `/flowsheet`    | V1 flowsheet (legacy)                                      |
| `/v2/flowsheet` | V2 flowsheet (uses `@wxyc/shared` DTOs)                    |
| `/djs`          | DJ profiles and management                                 |
| `/request`      | Song request line                                          |
| `/schedule`     | Schedule management                                        |
| `/events`       | SSE for real-time updates                                  |
| `/healthcheck`  | Health check                                               |
| `/internal`     | Internal endpoints (ETL notifications, tubafrenzy webhook) |

Code is organized as controllers (HTTP handling) -> services (business logic) -> database (Drizzle queries).

Key middleware:

- `requirePermissions` -- JWT auth with role-based access control
- `showMemberMiddleware` -- Validates user is part of the active show
- `activeShow` -- Checks for an active show
- `anonymousAuth` -- Validates better-auth session
- `rateLimiting` -- Rate limits on registration and song requests
- `errorHandler` -- Centralized error handling returning standardized responses
- Legacy mirror middleware -- Syncs flowsheet data to tubafrenzy. Show lifecycle (`startShow`, `endShow`) and entry CRUD (`addEntry`, `updateEntry`) use HTTP REST calls to tubafrenzy's mirror API. `deleteEntry` uses raw SQL via SSH. Show IDs are cached in-memory (`showIdMap`) and persisted to `shows.legacy_show_id` for restart resilience. Every entry mirror call includes `radioShowID` when available (cache → DB fallback → omit for auto-resolution).

Server timeout is 5 seconds globally; SSE routes have no timeout.

Swagger API docs are served at `/api-docs` from `app.yaml`.

### Auth Server (`apps/auth`)

Express wrapper around better-auth with these plugins: admin, username, anonymous, bearer, jwt, organization.

- Email+password auth only (no social auth)
- Email verification required
- Sign-up disabled (admin creates accounts)
- `POST /auth/admin/provision-user` -- Atomic user provisioning: creates user, credential account, and org membership in one call. Requires admin session. Accepts `organizationSlug` (resolved server-side) so the client never needs to map slugs to UUIDs. See `apps/auth/provision-user.ts`.
- `GET /auth/admin/resolve-organization?slug=<slug>` -- Resolves an organization slug to its UUID. Requires admin session. Returns `{ id, slug, name }`. Used by dj-site admin pages to avoid the fragile `getFullOrganization` SDK call which requires `orgSessionMiddleware`. See `apps/auth/resolve-organization.ts`.
- Default user creation from env vars when `CREATE_DEFAULT_USER=TRUE` (uses `provisionUser()` internally)
- Test-only endpoints (non-production): `/auth/test/verification-token`, `/auth/test/expire-session`

### Database (`shared/database`)

Drizzle ORM with PostgreSQL (`postgres-js` driver).

**Auth tables** (managed by better-auth): `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_jwks`, `auth_organization`, `auth_member`, `auth_invitation`.

**Domain tables** (custom schema): `dj_stats`, `schedule`, `shift_covers`, `artists`, and flowsheet-related tables.

Schema is in `shared/database/src/schema.ts`. Migrations are in `shared/database/src/migrations/`.

**Test isolation**: Each Jest worker gets its own PostgreSQL schema via the `WXYC_SCHEMA_NAME` env var (defaults to `wxyc_schema`).

Migration workflow:

```bash
npm run drizzle:generate   # Generate SQL migration from schema changes
npm run drizzle:migrate    # Apply migrations to database
npm run drizzle:drop       # Delete a migration file
```

**Migrations are DDL-only.** Bulk DML (rewrites of more than ~10k rows) does not belong inside a migration file because the DDL portion takes an `AccessExclusiveLock` that is held until the transaction commits, and a long DML can wedge the table for hours. Put the rewrite in a one-shot backfill job under `jobs/<name>-backfill/` (declared with `"job-type": "one-shot"` in `package.json`). The build pipeline pushes the image to ECR; a human invokes it via `docker run --rm --env-file .env <image>` during a low-traffic window. If a downstream migration depends on the backfill having run, gate it with a `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard at the top of the file. See `0053_flowsheet-dj-name-column.sql` + `jobs/flowsheet-dj-name-backfill/` + `0054_flowsheet-search-doc-with-dj-name.sql` for the canonical pattern, and issue #511 for the incident this rule was learned from.

### Authentication (`shared/authentication`)

**Key files:**

- `auth.definition.ts` -- better-auth config with plugins and hooks
- `auth.roles.ts` -- Role definitions and access control rules
- `auth.middleware.ts` -- JWT verification and permission checking
- `auth.client.ts` -- Client-side better-auth initialization
- `email.ts` -- SES email sending (password reset, verification)

**Roles** (hierarchical): member < dj < musicDirector < stationManager

**Permissions per role:**

| Role           | bin        | catalog    | flowsheet   |
| -------------- | ---------- | ---------- | ----------- |
| member         | read/write | read       | read        |
| dj             | read/write | read       | read/write  |
| musicDirector  | read/write | read/write | read/write  |
| stationManager | all        | all        | all + admin |

**JWT payload**: `sub` (user ID), `email`, `role` (queried from the organization member table, not `user.role`).

**`requirePermissions` middleware flow:**

1. Extract Bearer token from `Authorization` header
2. Verify against JWKS endpoint (`BETTER_AUTH_JWKS_URL`)
3. Check issuer and audience claims
4. Validate role exists in `WXYCRoles`
5. Check permissions using the role's authorize function
6. 403 if role invalid or permissions insufficient

**Auth bypass**: Set `AUTH_BYPASS=true` to skip JWT verification in tests. Rate limiting is disabled when `NODE_ENV=test`.

**Role mismatch gotcha**: better-auth's organization plugin has built-in roles (`owner`, `admin`, `member`) that overlap with WXYC's custom roles. If a user's `member.role` is set to a value not in `WXYCRoles`, the middleware returns 403 on every request. Organization hooks sync `stationManager`/`admin`/`owner` to `user.role='admin'` for the better-auth admin plugin.

## Development

### Running Locally

```bash
npm install              # Install all workspace dependencies
npm run db:start         # Start PostgreSQL in Docker (port 5432)
npm run dev              # Start auth (8082) + backend (8080) concurrently with hot reload
```

Stop the database with `npm run db:stop`.

### One-time per-clone: register the journal merge driver

`shared/database/src/migrations/meta/_journal.json` is an append-only Drizzle index. Every PR that adds a migration appends an entry; concurrent PRs collide on the array even when the new entries don't overlap. The repo ships `.gitattributes` with `merge=journal`, but the actual merge driver lives in `.git/config` and isn't checked in — each collaborator must register it once after cloning:

```bash
npx git-merge-append install \
  --name journal \
  --array-path entries --key idx --sort-by idx \
  -- shared/database/src/migrations/meta/_journal.json
```

After this, `git rebase` / `git merge` resolve concurrent journal appends automatically. If you skipped the install and are mid-rebase with `<<<<<<<` in `_journal.json`, run `npx git-merge-append resolve --array-path entries --key idx --sort-by idx -- shared/database/src/migrations/meta/_journal.json` to fix it post-hoc. See [git-merge-append](https://github.com/jakebromberg/git-merge-append) for details.

### Code Quality

Pre-push hook (husky) runs automatically:

```bash
npm run typecheck        # tsc --noEmit across all workspaces
npm run lint             # ESLint with TypeScript + security rules
```

Other quality commands:

```bash
npm run format           # Prettier formatting
npm run format:check     # Verify formatting (used in CI)
npm run build            # Compile all workspaces
```

### Branching

Feature branches off `main`. Naming conventions:

- `feature/description` or `feature/issue-123`
- `task/description`
- `bugfix/description` or `bugfix/issue-123`

Descriptions in kebab-case. Keep them short.

## Testing

### Unit Tests

```bash
npm run test:unit
```

- Config: `jest.unit.config.ts`
- Location: `tests/unit/**/*.test.ts`
- Setup: `tests/setup/unit.setup.ts`
- Database is mocked via `tests/mocks/database.mock.ts`
- No external dependencies required

### Integration Tests

```bash
npm run db:start         # Requires Docker DB
npm run test:integration
```

- Config: `jest.config.json`
- Location: `tests/integration/**/*.spec.js`
- Setup: `tests/setup/integration.setup.js` with `tests/setup/globalSetup.js`
- Tests run sequentially (`--runInBand`) because they share show state, DJ sessions, and flowsheet entries
- 30-second timeout per test, bail on first failure
- Generates HTML report at `tests/report/report.html`

### CI Mock

```bash
npm run ci:testmock      # Sets up Docker env, runs tests, cleans up
```

Or manually:

```bash
npm run ci:env           # Start sandboxed Docker environment
npm run ci:test          # Run tests against CI environment
npm run ci:clean         # Tear down containers, volumes, networks
```

The CI environment uses `dev_env/docker-compose.yml` with Docker profiles (`ci`, `e2e`).

## CI/CD

GitHub Actions workflow (`.github/workflows/test.yml`) runs on PRs to `main`:

1. **detect-changes** -- Paths-filter identifies what changed (apps, jobs, shared, tests, db-init)
2. **lint-and-typecheck** -- `typecheck` + `lint` + `format:check` + `build`
3. **unit-tests** -- Runs affected tests only (`--changedSince=origin/<base>` on PRs)
4. **integration-tests** -- Only if apps/jobs/shared/tests change. Docker images cached by commit SHA in ECR.

## Deployment

- Hosted on EC2
- CI/CD via GitHub Actions (manual trigger: Actions tab -> CI/CD Pipeline -> Run Workflow)
- Docker images built with multi-stage Dockerfile (`node:25-alpine`), stored in Amazon ECR

## Database Replication (Local Sync)

PostgreSQL logical replication keeps a local database clone in sync with production RDS in real time. Changes stream continuously with guaranteed delivery — the replication slot retains WAL even if the subscriber is offline.

### Setup

```bash
# One-time: enable rds.logical_replication=1 in the RDS parameter group (requires reboot)
# Then:
./scripts/sync/setup-replication.sh    # Opens tunnel, creates publication + subscription
```

### Daily use

```bash
./scripts/sync/tunnel.sh               # Open tunnel (must stay open for replication)
./scripts/sync/tunnel.sh --kill        # Close tunnel
./scripts/sync/teardown-replication.sh # Remove subscription + close tunnel
```

### Monitor replication status

```sql
-- On local database:
SELECT * FROM pg_stat_subscription;     -- srsubstate = 'r' means ready
SELECT * FROM pg_subscription;          -- shows connection info
```

### Prerequisites

- RDS parameter group: `rds.logical_replication = 1` (one-time, requires instance reboot)
- `rds_replication` role granted to the RDS user
- SSH access via `ssh wxyc-ec2`
- Local PostgreSQL running (`npm run db:start`)
- `psql` installed (`brew install libpq`)

## CDC WebSocket Endpoint

WebSocket endpoint at `/cdc` that broadcasts all database changes via PostgreSQL LISTEN/NOTIFY triggers. Used by the reconciliation monitor for cross-database verification.

### Endpoint

`ws://host:8080/cdc?key=<CDC_SECRET>` — requires `CDC_SECRET` environment variable.

### Event format

```json
{
  "table": "flowsheet",
  "schema": "wxyc_schema",
  "action": "INSERT",
  "data": { ...full row as JSON... },
  "timestamp": 1714000000000
}
```

### Architecture

PostgreSQL triggers (`cdc_notify()`) fire `pg_notify('cdc', payload)` on every INSERT/UPDATE/DELETE. A dedicated LISTEN connection in Node.js receives notifications and broadcasts them to WebSocket clients. Zero application code instrumentation — captures all changes including ETL, auth, and direct SQL.

### Key files

- `shared/database/src/migrations/0045_cdc_notify_triggers.sql` — trigger function + per-table triggers
- `shared/database/src/cdc-listener.ts` — dedicated LISTEN connection and event dispatch
- `apps/backend/services/cdc/cdc-websocket.ts` — WebSocket server with auth and heartbeat

### Reconciliation monitor

```bash
CDC_SECRET=xxx npx tsx scripts/sync/reconcile.ts
```

Connects to tubafrenzy's CDC WebSocket and verifies changes land in Backend-Service's PostgreSQL. Reports matches, mismatches, and missing records in real time.

## Environment Variables

### Backend Service

- `PORT` (default 8080)
- `CI_PORT` (default 8081)

### Database

- `DB_HOST`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` (required)
- `DB_PORT` (default 5432)
- `CI_DB_PORT` (default 5433)
- `WXYC_SCHEMA_NAME` (default `wxyc_schema`)
- `DB_STATEMENT_TIMEOUT_MS` (default `5000` / 5s) -- Server-enforced per-statement timeout on every postgres-js connection. Backend and auth inherit the default — any HTTP-handler query that runs longer than 5s is by definition an orphan (Express's request timeout has already fired). ETLs override to `300000` (5min) in their Dockerfiles because their bulk passes can legitimately take tens of seconds. Backfills override similarly. Set `0` to disable (use only for unit-test fixtures).
- `DB_APPLICATION_NAME` (default `wxyc-backend`) -- Sets `application_name` on the postgres connection so `pg_stat_activity` makes the source obvious during incident triage. Each Dockerfile overrides this with its own service name (`wxyc-backend`, `wxyc-auth`, `wxyc-flowsheet-etl`, etc.).
- `DB_SYNCHRONOUS_COMMIT` (default `on`) -- Per-connection `synchronous_commit` setting. Default `on` preserves Postgres's full durability guarantee for the API and ETLs. Bulk backfills set this to `off` in their Dockerfile so each per-batch COMMIT returns as soon as the WAL is in the OS buffer, rather than waiting for fsync. Safe because backfills are idempotent (`WHERE col IS NULL` filters naturally resume any work lost to an RDS crash). Accepted values: `on`, `off`, `local`, `remote_write`, `remote_apply`.

### better-auth

- `BETTER_AUTH_URL` -- e.g. `http://localhost:8082/auth`
- `BETTER_AUTH_JWKS_URL` -- e.g. `http://localhost:8082/auth/jwks`
- `BETTER_AUTH_ISSUER` -- e.g. `http://localhost:8082`
- `BETTER_AUTH_AUDIENCE` -- e.g. `http://localhost:8082`
- `BETTER_AUTH_TRUSTED_ORIGINS` -- Comma-separated CORS origins
- `FRONTEND_SOURCE` -- Frontend origin for CORS and redirects

### Email (SES)

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- `SES_FROM_EMAIL`
- `PASSWORD_RESET_REDIRECT_URL`, `EMAIL_VERIFICATION_REDIRECT_URL`

### Testing

- `AUTH_BYPASS` -- Set `true` to skip JWT verification in tests
- `AUTH_USERNAME`, `AUTH_PASSWORD` -- Test account credentials (when `AUTH_BYPASS=false`)
- `TEST_HOST` -- Test server host

### Sentry

- `SENTRY_DSN` -- Sentry project DSN (required for error reporting). Without this, Sentry silently disables itself.
- `SENTRY_RELEASE` -- Set automatically by the deploy action to `<app>@<tag>`

#### Observability tags (Phase A contract)

ETL/backfill jobs that opt into the Phase A observability contract emit JSON log lines on stdout (errors on stderr) and tag every Sentry event with the same four fields:

| Tag      | Value                                                        |
| -------- | ------------------------------------------------------------ |
| `repo`   | `Backend-Service`                                            |
| `tool`   | `<job-name> <subcommand>` (e.g. `flowsheet-etl incremental`) |
| `step`   | Per-call: `started`, `bulk-load-shows`, `failed`, etc.       |
| `run_id` | UUID generated at entrypoint init (one per process)          |

The wireup is per-job: see `jobs/flowsheet-etl/logger.ts` for the canonical pattern (issue #538). The shared Rust/Python `wxyc_etl::logger` foundation lives in the `wxyc-etl` repo and targets non-Node ETLs; Backend-Service mirrors the same tag contract directly so the dashboards in Sentry / log queries are uniform across runtimes. `SENTRY_DSN` is still optional — when unset the SDK no-ops and JSON logging continues to work.

> TODO (separate child task): provision `SENTRY_DSN` for the flowsheet-etl cron in EC2 / GitHub Actions secrets.

### Legacy mirror queue (`apps/backend/middleware/legacy/commandqueue.mirror.ts`)

Bounded ring-buffer reports written under `mirror-logs/`. Reports never include raw SQL — only length, sha256, and statement count.

- `MIRROR_FATAL_REPORTS_MAX` (default `10`) -- Number of ring slots for fatal reports. Total disk = max × `MIRROR_REPORT_MAX_BYTES`.
- `MIRROR_FATAL_REPORTS_INTERVAL_MS` (default `900000` / 15 min) -- Bucket width for the fatal ring index. Reports in the same bucket overwrite the same slot.
- `MIRROR_SECONDARY_REPORTS_MAX` (default `10`) -- Same scheme for first-failure secondary reports. Set to `0` to disable secondaries.
- `MIRROR_SECONDARY_REPORTS_INTERVAL_MS` (default `600000` / 10 min) -- Bucket width for secondary ring.
- `MIRROR_SECONDARY_REPORT_ON_ATTEMPT` (default `1`) -- Attempt number that triggers a secondary report.
- `MIRROR_REPORT_MAX_BYTES` (default `65536` / 64 KiB) -- Per-file JSON cap. Oversize payloads are replaced with a `truncated: true` summary.
- `MIRROR_PENDING_QUEUE_SUMMARIES_MAX` (default `20`) -- Max number of pending-queue summaries embedded in a fatal report.

### Metadata Services

- `LIBRARY_METADATA_URL` -- library-metadata-lookup base URL (e.g. `http://localhost:8001`). Required for proxy endpoints, metadata enrichment, and track search. All Discogs access is routed through LML. Do not include the `/api/v1` path prefix; the LML client adds it automatically.
- `LML_API_KEY` -- Bearer token sent on every LML request. Must match LML's `LML_API_KEY`. Optional in dev; required in production once LML's `LML_REQUIRE_AUTH` is flipped to `true`. Injected at the single `lmlFetch` chokepoint in `apps/backend/services/lml/lml.client.ts`.
- `DISCOGS_API_KEY`, `DISCOGS_API_SECRET` -- Served to dj-site via `/config/secrets` endpoint. Not used by the backend itself (Discogs access goes through LML).
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`

### Slack

- `SLACK_WXYC_REQUESTS_APP_ID`, `SLACK_WXYC_REQUESTS_CLIENT_ID`
- `SLACK_WXYC_REQUESTS_CLIENT_SECRET`, `SLACK_WXYC_REQUESTS_SIGNING_SECRET`
- `SLACK_WXYC_REQUESTS_WEBHOOK` -- Webhook path (e.g. `/services/T00000/B00000/XXXX`)
- `SLACK_WEBHOOK_URL` -- Base URL override for Slack webhook (e.g. `http://mock-api:9090`). When set, uses `fetch()` instead of `https.request` to `hooks.slack.com`. Used in CI to route webhooks to the mock API server.

### ETL Jobs

The library ETL (`scripts/run-library-etl.sh`) syncs the music library from the legacy MySQL database into PostgreSQL. The flowsheet ETL (`jobs/flowsheet-etl/`) syncs flowsheet entries and shows from tubafrenzy. The rotation ETL (`jobs/rotation-etl/`) syncs rotation releases from tubafrenzy. All three require the standard database variables above plus these for SSH tunneling to the legacy server:

- `SSH_HOST` -- Hostname of the legacy server
- `SSH_USERNAME` -- SSH login username
- `SSH_PASSWORD` -- SSH login password
- `REMOTE_DB_HOST` -- MySQL host on the legacy server (typically `localhost` from inside the tunnel)
- `REMOTE_DB_USER` -- MySQL username
- `REMOTE_DB_PASSWORD` -- MySQL password
- `REMOTE_DB_NAME` -- MySQL database name

The flowsheet ETL supports two run modes: one-shot (`npm start`) for cron invocation, and continuous polling (`npm run start:poll` or `node dist/job.js --poll`) for real-time sync. In polling mode, it queries tubafrenzy every `ETL_POLL_INTERVAL_MS` (default 30 seconds) for new or modified entries and upserts them into PostgreSQL. After importing changes, it notifies the Backend-Service via `POST /internal/flowsheet-sync-notify` so connected dj-site clients receive an SSE refetch event.

- `ETL_POLL_INTERVAL_MS` -- Poll interval in milliseconds (default `30000`)
- `BACKEND_SERVICE_URL` -- Backend-Service URL for SSE notifications (default `http://localhost:8080`)
- `ETL_NOTIFY_KEY` -- Shared secret for internal endpoints: ETL sync notification and tubafrenzy webhook (required in production)

The rotation ETL supports the same two run modes as the flowsheet ETL: one-shot (`npm start`) for cron invocation, and continuous polling (`npm run start:poll` or `node dist/job.js --poll`) for real-time sync. In polling mode, it queries tubafrenzy every `ETL_POLL_INTERVAL_MS` for new or modified rotation releases and upserts them into PostgreSQL. It uses the same SSH tunnel, `ETL_POLL_INTERVAL_MS`, `BACKEND_SERVICE_URL`, and `ETL_NOTIFY_KEY` variables as the flowsheet ETL. After importing changes, it notifies the Backend-Service via `POST /internal/rotation-sync-notify`.

The artist identity ETL (`jobs/artist-identity-etl/`) populates the six reconciled-identity columns on `artists` (`discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`, `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id`) from library-metadata-lookup's `entity.identity` PostgreSQL table. Unlike the flowsheet/rotation ETLs, it does not use the SSH tunnel: it reads directly from the discogs-cache PostgreSQL database via `DATABASE_URL_DISCOGS`. Update strategy is null-fill only — existing non-null values are never overwritten, so any value entered by library staff wins over an LML-derived one. Conflicts (existing non-null differs from LML's value) are logged but skipped. Supports the same one-shot / `--poll` modes as the other ETLs.

- `DATABASE_URL_DISCOGS` -- PostgreSQL URL for LML's discogs-cache database, where `entity.identity` lives. Required for the artist-identity ETL.

## Relationship to Other Repos

- **[dj-site](https://github.com/WXYC/dj-site)** -- React frontend that consumes this API
- **[@wxyc/shared](https://github.com/WXYC/wxyc-shared)** -- Shared DTOs, auth client, validation. V2 flowsheet endpoints use `@wxyc/shared` types.
- **[library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup)** -- Discogs metadata service with 3-tier caching. All Discogs access (proxy endpoints, metadata enrichment, track search, artwork discovery) routes through LML via `LIBRARY_METADATA_URL`. The backend makes no direct Discogs API calls.
- **[tubafrenzy](https://github.com/WXYC/tubafrenzy)** -- Legacy Java system this service is replacing. Both read/write the same underlying data.
