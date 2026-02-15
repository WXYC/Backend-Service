# Backend-Service

API and authentication service for WXYC applications. Provides endpoints for the DJ flowsheet, music library catalog, DJ management, scheduling, and song requests.

## Architecture

### Monorepo Layout

npm workspaces with four packages:

| Package | Path | Purpose |
|---------|------|---------|
| `@wxyc/backend` | `apps/backend/` | Express API server (port 8080) |
| `@wxyc/auth-service` | `apps/auth/` | better-auth server (port 8082) |
| `@wxyc/database` | `shared/database/` | Drizzle ORM schema, client, migrations |
| `@wxyc/authentication` | `shared/authentication/` | Auth middleware, roles, JWT verification |

### API Server (`apps/backend`)

Express 5 application with these route groups:

| Route | Purpose |
|-------|---------|
| `/library` | Music library catalog |
| `/flowsheet` | V1 flowsheet (legacy) |
| `/v2/flowsheet` | V2 flowsheet (uses `@wxyc/shared` DTOs) |
| `/djs` | DJ profiles and management |
| `/request` | Song request line |
| `/schedule` | Schedule management |
| `/events` | SSE for real-time updates |
| `/healthcheck` | Health check |

Code is organized as controllers (HTTP handling) -> services (business logic) -> database (Drizzle queries).

Key middleware:
- `requirePermissions` -- JWT auth with role-based access control
- `showMemberMiddleware` -- Validates user is part of the active show
- `activeShow` -- Checks for an active show
- `anonymousAuth` -- Validates better-auth session
- `rateLimiting` -- Rate limits on registration and song requests
- `errorHandler` -- Centralized error handling returning standardized responses
- Legacy mirror middleware -- Compatibility layer for old frontend

Server timeout is 5 seconds globally; SSE routes have no timeout.

Swagger API docs are served at `/api-docs` from `app.yaml`.

### Auth Server (`apps/auth`)

Express wrapper around better-auth with these plugins: admin, username, anonymous, bearer, jwt, organization.

- Email+password auth only (no social auth)
- Email verification required
- Sign-up disabled (admin creates accounts)
- Default user creation from env vars when `CREATE_DEFAULT_USER=TRUE`
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

### Authentication (`shared/authentication`)

**Key files:**
- `auth.definition.ts` -- better-auth config with plugins and hooks
- `auth.roles.ts` -- Role definitions and access control rules
- `auth.middleware.ts` -- JWT verification and permission checking
- `auth.client.ts` -- Client-side better-auth initialization
- `email.ts` -- SES email sending (password reset, verification)

**Roles** (hierarchical): member < dj < musicDirector < stationManager

**Permissions per role:**

| Role | bin | catalog | flowsheet |
|------|-----|---------|-----------|
| member | read/write | read | read |
| dj | read/write | read | read/write |
| musicDirector | read/write | read/write | read/write |
| stationManager | all | all | all + admin |

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

1. **detect-changes** -- Paths-filter identifies what changed (backend, auth, shared, tests, db-init)
2. **lint-and-typecheck** -- `typecheck` + `lint` + `format:check` + `build`
3. **unit-tests** -- Runs affected tests only (`--changedSince=origin/<base>` on PRs)
4. **integration-tests** -- Only if backend/auth/shared/tests changed. Docker images cached by commit SHA in ECR.

## Deployment

- Hosted on EC2
- CI/CD via GitHub Actions (manual trigger: Actions tab -> CI/CD Pipeline -> Run Workflow)
- Docker images built with multi-stage Dockerfile (`node:22-alpine`), stored in Amazon ECR

## Environment Variables

### Backend Service
- `PORT` (default 8080)
- `CI_PORT` (default 8081)

### Database
- `DB_HOST`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` (required)
- `DB_PORT` (default 5432)
- `CI_DB_PORT` (default 5433)
- `WXYC_SCHEMA_NAME` (default `wxyc_schema`)

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

### Metadata Services
- `DISCOGS_API_KEY`, `DISCOGS_API_SECRET`
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`

### Slack
- `SLACK_WXYC_REQUESTS_APP_ID`, `SLACK_WXYC_REQUESTS_CLIENT_ID`
- `SLACK_WXYC_REQUESTS_CLIENT_SECRET`, `SLACK_WXYC_REQUESTS_SIGNING_SECRET`
- `SLACK_WXYC_REQUESTS_WEBHOOK`

## Relationship to Other Repos

- **[dj-site](https://github.com/WXYC/dj-site)** -- React frontend that consumes this API
- **[@wxyc/shared](https://github.com/WXYC/wxyc-shared)** -- Shared DTOs, auth client, validation. V2 flowsheet endpoints use `@wxyc/shared` types.
- **[tubafrenzy](https://github.com/WXYC/tubafrenzy)** -- Legacy Java system this service is replacing. Both read/write the same underlying data.
