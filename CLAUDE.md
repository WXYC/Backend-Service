# Backend-Service

API and authentication service for WXYC applications. Provides endpoints for the DJ flowsheet, music library catalog, DJ management, scheduling, and song requests.

## Topic guides

CLAUDE.md is a router for the always-loaded reference card. Topic depth lives in `docs/`:

- **[`docs/migrations.md`](docs/migrations.md)** — Drizzle migration rules: journal `when` recipe, parallel-PR collisions, IF NOT EXISTS, DDL-only, precondition guards, cross-cache-identity gates, attempt-at markers
- **[`docs/env-vars.md`](docs/env-vars.md)** — Full environment-variable reference (Backend, DB, Auth, Email, Sentry, Slack, ETL, mirror queue, cross-cache-identity flags)
- **[`docs/replication.md`](docs/replication.md)** — Local PostgreSQL logical-replication setup and operation
- **[`docs/cdc.md`](docs/cdc.md)** — CDC WebSocket endpoint, event format, reconciliation monitor
- **[`docs/deploy.md`](docs/deploy.md)** — Deploy cadence, migration-chain risk, deploy-wedge anatomy

Read the relevant topic doc before doing work in that area.

## Architecture

### Monorepo Layout

npm workspaces:

| Package                              | Path                                 | Purpose                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wxyc/backend`                      | `apps/backend/`                      | Express API server (port 8080)                                                                                                                                                                                                                                         |
| `@wxyc/auth-service`                 | `apps/auth/`                         | better-auth server (port 8082)                                                                                                                                                                                                                                         |
| `@wxyc/database`                     | `shared/database/`                   | Drizzle ORM schema, client, migrations, ETL utilities                                                                                                                                                                                                                  |
| `@wxyc/authentication`               | `shared/authentication/`             | Auth middleware, roles, JWT verification                                                                                                                                                                                                                               |
| `@wxyc/flowsheet-etl`                | `jobs/flowsheet-etl/`                | Flowsheet ETL: sync from tubafrenzy                                                                                                                                                                                                                                    |
| `@wxyc/rotation-etl`                 | `jobs/rotation-etl/`                 | Rotation ETL: sync from tubafrenzy                                                                                                                                                                                                                                     |
| `@wxyc/artist-identity-etl`          | `jobs/artist-identity-etl/`          | Artist identity ETL: sync from LML's `entity.identity`                                                                                                                                                                                                                 |
| `@wxyc/flowsheet-dj-name-backfill`   | `jobs/flowsheet-dj-name-backfill/`   | One-shot backfill: populate `flowsheet.dj_name` on legacy track rows after migration 0053                                                                                                                                                                              |
| `@wxyc/library-artist-name-backfill` | `jobs/library-artist-name-backfill/` | One-shot backfill: populate `library.artist_name` from the `artists` join after migration 0058 (Epic A.2)                                                                                                                                                              |
| `@wxyc/flowsheet-metadata-backfill`  | `jobs/flowsheet-metadata-backfill/`  | Recurring metadata drift-repair: enrich `flowsheet` track rows where LML metadata enrichment never ran (#631 / #638 / #641). Cron-registered via deploy-base, schedule `0 6 * * *` UTC (02:00 ET); orchestrator's cooperative pause (#735) defers when DJs are active. |
| `@wxyc/library-artwork-url-backfill` | `jobs/library-artwork-url-backfill/` | One-shot warm: populate `library.artwork_url` for Discogs-resolvable rows (joined to `artists.discogs_artist_id`) so search-time `enrichWithArtwork` short-circuits (#637).                                                                                            |
| `@wxyc/library-identity-backfill`    | `jobs/library-identity-backfill/`    | One-shot backfill: populate `library_identity` + `library_identity_source` from existing identity artifacts (cross-cache-identity §4 step 2). Sub-PR 2.0 covers S1 (Backend `canonical_entity_id`); 2.1-2.4 add LML, discogs-cache, and semantic-index sources.        |

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

Code is organized as controllers (HTTP handling) → services (business logic) → database (Drizzle queries).

Key middleware:

- `requirePermissions` — JWT auth with role-based access control
- `showMemberMiddleware` — Validates user is part of the active show
- `activeShow` — Checks for an active show
- `anonymousAuth` — Validates better-auth session
- `rateLimiting` — Rate limits on registration and song requests
- `errorHandler` — Centralized error handling returning standardized responses
- Legacy mirror middleware — Syncs flowsheet data to tubafrenzy. Show lifecycle (`startShow`, `endShow`) and entry CRUD (`addEntry`, `updateEntry`) use HTTP REST calls to tubafrenzy's mirror API. `deleteEntry` uses raw SQL via SSH. Show IDs are cached in-memory (`showIdMap`) and persisted to `shows.legacy_show_id` for restart resilience.

Server timeout is 5 seconds globally; SSE routes have no timeout. Swagger API docs are served at `/api-docs` from `app.yaml`.

### Auth Server (`apps/auth`)

Express wrapper around better-auth with these plugins: admin, username, anonymous, bearer, jwt, organization.

- Email+password auth only (no social auth)
- Email verification required
- Sign-up disabled (admin creates accounts)
- `POST /auth/admin/provision-user` — Atomic user provisioning: creates user, credential account, and org membership in one call. Requires admin session. Accepts `organizationSlug` (resolved server-side) so the client never needs to map slugs to UUIDs. See `apps/auth/provision-user.ts`.
- `GET /auth/admin/resolve-organization?slug=<slug>` — Resolves an organization slug to its UUID. Requires admin session. Returns `{ id, slug, name }`. Used by dj-site admin pages to avoid the fragile `getFullOrganization` SDK call which requires `orgSessionMiddleware`. See `apps/auth/resolve-organization.ts`.
- Default user creation from env vars when `CREATE_DEFAULT_USER=TRUE` (uses `provisionUser()` internally)
- Test-only endpoints (non-production): `/auth/test/verification-token`, `/auth/test/expire-session`

### Database (`shared/database`)

Drizzle ORM with PostgreSQL (`postgres-js` driver).

**Auth tables** (managed by better-auth): `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_jwks`, `auth_organization`, `auth_member`, `auth_invitation`.

**Domain tables** (custom schema): `dj_stats`, `schedule`, `shift_covers`, `artists`, and flowsheet-related tables.

Schema is in `shared/database/src/schema.ts`. Migrations are in `shared/database/src/migrations/`.

**Test isolation**: Each Jest worker gets its own PostgreSQL schema via the `WXYC_SCHEMA_NAME` env var (defaults to `wxyc_schema`).

**Migration workflow**:

```bash
npm run drizzle:generate   # Generate SQL migration from schema changes
npm run drizzle:migrate    # Apply migrations to database
npm run drizzle:drop       # Delete a migration file
```

**Read [`docs/migrations.md`](docs/migrations.md) before authoring any migration.** It covers the journal `when`-bumping recipe, the parallel-PR collision case, the `IF NOT EXISTS` index pattern, the DDL-only rule, the constraint-precondition-guard pattern, and the cross-cache-identity gate. Also documents the `flowsheet.legacy_link_attempted_at` and `metadata_attempt_at` markers and the jobs that stamp them.

### Authentication (`shared/authentication`)

**Key files:**

- `auth.definition.ts` — better-auth config with plugins and hooks
- `auth.roles.ts` — Role definitions and access control rules
- `auth.middleware.ts` — JWT verification and permission checking
- `auth.client.ts` — Client-side better-auth initialization
- `email.ts` — SES email sending (password reset, verification)

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

### Running locally

```bash
npm install              # Install all workspace dependencies
npm run db:start         # Start PostgreSQL in Docker (port 5432)
npm run dev              # Start auth (8082) + backend (8080) concurrently with hot reload
```

Stop the database with `npm run db:stop`.

### One-time per-clone setup

Register the journal merge driver so concurrent migration PRs auto-resolve their `_journal.json` appends. Steps in [`docs/migrations.md`](docs/migrations.md#one-time-per-clone-setup).

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

### Doc hygiene

CLAUDE.md is the always-loaded reference card; topic depth lives in `docs/*.md`. Two warn-only checks run in `.husky/pre-push`:

- `npm run check:doc-budget` — warns if CLAUDE.md exceeds its char budget. When it fires, extract to `docs/` rather than growing CLAUDE.md.
- `npm run check:doc-rules` — surfaces `<!-- @rule -->` markers in `docs/*.md` that are stale (unenforced + old, enforced + verbose, or past `review-after`). Convention documented in [`docs/migrations.md`](docs/migrations.md#rule-annotation-convention).

### Branching

Feature branches off `main`. Naming conventions:

- `feature/description` or `feature/issue-123`
- `task/description`
- `bugfix/description` or `bugfix/issue-123`

Descriptions in kebab-case. Keep them short.

## Testing

### Unit tests

```bash
npm run test:unit
```

- Config: `jest.unit.config.ts`
- Location: `tests/unit/**/*.test.ts`
- Setup: `tests/setup/unit.setup.ts`
- Database is mocked via `tests/mocks/database.mock.ts`
- No external dependencies required

### Integration tests

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

### CI mock

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

1. **detect-changes** — Paths-filter identifies what changed (apps, jobs, shared, tests, db-init)
2. **lint-and-typecheck** — `typecheck` + `lint` + `format:check` + `build`
3. **unit-tests** — Runs affected tests only (`--changedSince=origin/<base>` on PRs)
4. **integration-tests** — Only if apps/jobs/shared/tests change. Docker images cached by commit SHA in ECR.
5. **migrate-dryrun** — Only when `db-init` paths change. Restores latest RDS snapshot, runs `dryrun-migrate.mjs`, tears down. Catches data-shape preconditions at PR-review time. Detail in [`docs/deploy.md`](docs/deploy.md).

## Deployment

Hosted on EC2; CI/CD via GitHub Actions (manual trigger). Docker images built with `node:25-alpine`, stored in ECR.

**Cadence rule**: when a PR that touches `shared/database/src/migrations/**` merges, run Manual Build & Deploy within 24 hours. Long deploy gaps accumulate migration-chain risk. See [`docs/deploy.md`](docs/deploy.md) for the 2026-05-04 wedge case study and the project-#26 hardening defenses.

## Relationship to Other Repos

- **[dj-site](https://github.com/WXYC/dj-site)** — React frontend that consumes this API
- **[@wxyc/shared](https://github.com/WXYC/wxyc-shared)** — Shared DTOs, auth client, validation. V2 flowsheet endpoints use `@wxyc/shared` types.
- **[library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup)** — Discogs metadata service with 3-tier caching. All Discogs access (proxy endpoints, metadata enrichment, track search, artwork discovery) routes through LML via `LIBRARY_METADATA_URL`. The backend makes no direct Discogs API calls.
- **[tubafrenzy](https://github.com/WXYC/tubafrenzy)** — Legacy Java system this service is replacing. Both read/write the same underlying data.
