# Backend-Service

API and authentication service for WXYC applications. Provides endpoints for the DJ flowsheet, music library catalog, DJ management, scheduling, and song requests.

## Topic guides

CLAUDE.md is a router for the always-loaded reference card. Topic depth lives in `docs/`:

- **[`docs/migrations.md`](docs/migrations.md)** — Drizzle migration rules: journal `when` recipe, parallel-PR collisions, IF NOT EXISTS, DDL-only, precondition guards, cross-cache-identity gates, attempt-at markers, post-bulk-UPDATE ANALYZE
- **[`docs/bulk-update-playbook.md`](docs/bulk-update-playbook.md)** — Per-row cost on `flowsheet`, ANALYZE-after-UPDATE rule, async-commit + batch-size + partial-index recipe, infinite-loop pitfall, sync-gap remediation
- **[`docs/env-vars.md`](docs/env-vars.md)** — Full environment-variable reference (Backend, DB, Auth, Email, Sentry, Slack, ETL, mirror queue, cross-cache-identity flags)
- **[`docs/replication.md`](docs/replication.md)** — Local PostgreSQL logical-replication setup and operation
- **[`docs/cdc.md`](docs/cdc.md)** — CDC WebSocket endpoint, event format, reconciliation monitor
- **[`docs/deploy.md`](docs/deploy.md)** — Deploy cadence, migration-chain risk, deploy-wedge anatomy, CI workflow pin maintenance (permissions, gha/v1 pins, caller-callee permissions trap from #857)
- **[`docs/authentication.md`](docs/authentication.md)** — Roles, permissions matrix, JWT payload, `requirePermissions` middleware flow, `AUTH_BYPASS`, better-auth role-mismatch gotcha
- **[`docs/testing.md`](docs/testing.md)** — Unit + integration + CI-mock test setup, jest configs, CI workflow job list
- **[`docs/dev-db-fixture.md`](docs/dev-db-fixture.md)** — Dev DB seed pipeline (`seed_db.sql` + `seed-clone.sql`), `LOAD_CLONE_FIXTURE` gate, `predev` rebuild hook, `db:stop` volume drop

For the org-wide cache-hierarchy reference (BS's `proxy.controller` LRUs in context with the upstream iOS caches and downstream LML caches), see [`WXYC/wiki/architecture/cache-hierarchy.md`](https://github.com/WXYC/wiki/blob/main/architecture/cache-hierarchy.md).

Read the relevant topic doc before doing work in that area.

## Architecture

### Monorepo Layout

npm workspaces:

| Package                              | Path                                 | Purpose                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@wxyc/backend`                      | `apps/backend/`                      | Express API server (port 8080)                                                                                                                                                                                                                                                                                                                                                                               |
| `@wxyc/auth-service`                 | `apps/auth/`                         | better-auth server (port 8082)                                                                                                                                                                                                                                                                                                                                                                               |
| `@wxyc/enrichment-worker`            | `apps/enrichment-worker/`            | Long-running CDC consumer: claims new flowsheet track rows (`metadata_status='pending'`) and enriches via LML. N×N idempotent-claim (BS#892 / Epic C C2). C6 (BS#895) cron is the gap-recovery safety net.                                                                                                                                                                                                   |
| `@wxyc/database`                     | `shared/database/`                   | Drizzle ORM schema, client, migrations, ETL utilities                                                                                                                                                                                                                                                                                                                                                        |
| `@wxyc/authentication`               | `shared/authentication/`             | Auth middleware, roles, JWT verification                                                                                                                                                                                                                                                                                                                                                                     |
| `@wxyc/lml-client`                   | `shared/lml-client/`                 | HTTP client for library-metadata-lookup (LML). Single chokepoint — `lookupMetadata` wraps `Sentry.startSpan` + `Semaphore(5)` + `TokenBucket(50/min)` mirroring LML's Discogs ceilings (BS#906/G4). Used by `apps/backend` runtime path and `jobs/flowsheet-metadata-backfill`.                                                                                                                              |
| `@wxyc/flowsheet-etl`                | `jobs/flowsheet-etl/`                | Flowsheet ETL: sync from tubafrenzy                                                                                                                                                                                                                                                                                                                                                                          |
| `@wxyc/rotation-etl`                 | `jobs/rotation-etl/`                 | Rotation ETL: sync from tubafrenzy                                                                                                                                                                                                                                                                                                                                                                           |
| `@wxyc/artist-identity-etl`          | `jobs/artist-identity-etl/`          | Artist identity ETL: sync from LML's `entity.identity`                                                                                                                                                                                                                                                                                                                                                       |
| `@wxyc/flowsheet-dj-name-backfill`   | `jobs/flowsheet-dj-name-backfill/`   | One-shot backfill: populate `flowsheet.dj_name` on legacy track + marker rows (show_start, show_end, dj_join, dj_leave) after migration 0053 / #952                                                                                                                                                                                                                                                          |
| `@wxyc/library-artist-name-backfill` | `jobs/library-artist-name-backfill/` | One-shot backfill: populate `library.artist_name` from the `artists` join after migration 0058 (Epic A.2)                                                                                                                                                                                                                                                                                                    |
| `@wxyc/flowsheet-metadata-backfill`  | `jobs/flowsheet-metadata-backfill/`  | Recurring metadata drift-repair: enrich `flowsheet` track rows where LML metadata enrichment never ran (#631 / #638 / #641). Cron-registered via deploy-base; default schedule `0 6 * * *` UTC (02:00 ET) from `package.json` `cron-schedule`, overridable per-deploy via the `BACKFILL_CRON_SCHEDULE` GHA repository variable (BS#914). Orchestrator's cooperative pause (#735) defers when DJs are active. |
| `@wxyc/library-artwork-url-backfill` | `jobs/library-artwork-url-backfill/` | One-shot warm: populate `library.artwork_url` for Discogs-resolvable rows (joined to `artists.discogs_artist_id`) so search-time `enrichWithArtwork` short-circuits (#637).                                                                                                                                                                                                                                  |
| `@wxyc/library-identity-consumer`    | `jobs/library-identity-consumer/`    | One-shot ETL: consume LML's `POST /api/v1/identity/bulk-resolve-libraries` and UPSERT verdicts into `library_identity` + `library_identity_source` (post-#800 cross-cache-identity pivot: LML is sole composer; Backend is thin writer).                                                                                                                                                                     |
| `@wxyc/album-metadata-backfill`      | `jobs/album-metadata-backfill/`      | One-shot historical backfill: populate `album_metadata` from the enriched subset of `flowsheet` (Epic D / #898). `INSERT … SELECT DISTINCT ON (album_id) … ON CONFLICT DO NOTHING` — idempotent. Bridges D1 (#897) schema and D3 (#899) writer cutover.                                                                                                                                                      |
| `@wxyc/album-level-backfill`         | `jobs/album-level-backfill/`         | One-shot historical drain (#1041): enrich the ~35,692 unique pending album_ids via LML's bulk endpoint (LML#368, `POST /api/v1/lookup/bulk`) and flip the ~857k linked-pending flowsheet rows in a paired post-pass UPDATE. Race-guarded UPSERT into `album_metadata` mirrors the worker's shape. Companion to `flowsheet-metadata-backfill` (per-row drain handles the 744k no-album_id residual).          |

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
- Legacy mirror middleware — Syncs flowsheet data to tubafrenzy. Show lifecycle (`startShow`, `endShow`) and entry CRUD (`addEntry`, `updateEntry`) use HTTP REST calls to tubafrenzy's mirror API. `deleteEntry` uses raw SQL via SSH. Show IDs live in two places: an in-memory `showIdMap` (process-local, populated lazily by `cacheShowId`, cleared on process exit) and the persisted `shows.legacy_show_id` column (written alongside the cache after `mirrorCreateShow`). On BS restart the map starts empty; read paths fall back to the persisted column, paying one extra DB round-trip on the first lookup per show.

Server timeout is 35 seconds globally — strictly greater than the LML client's 30 s `AbortController` (`@wxyc/lml-client`, `shared/lml-client/src/index.ts`) so a slow LML lookup's catch path can flush a 200-with-fallback response instead of racing the socket teardown to a CORS-less 502. SSE routes opt out via `res.setTimeout(0)`. Swagger API docs are served at `/api-docs` from `app.yaml`.

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

better-auth wrapper providing JWT verification + role-based access control. Roles (hierarchical): member < dj < musicDirector < stationManager.

See **[`docs/authentication.md`](docs/authentication.md)** for the permissions matrix, JWT payload shape, `requirePermissions` middleware flow, `AUTH_BYPASS` test hook, and the better-auth role-mismatch gotcha.

## Development

### Running locally

```bash
npm install              # Install all workspace dependencies
npm run db:start         # Start PostgreSQL in Docker (port 5432)
npm run dev              # Start auth (8082) + backend (8080) concurrently with hot reload
```

`npm run dev` rebuilds `@wxyc/database` + `@wxyc/authentication` first via the `predev` lifecycle hook so the backend doesn't serve a stale schema export. Stop the database with `npm run db:stop` (drops the `pg-data` volume; next `db:start` is a fresh DB).

See **[`docs/dev-db-fixture.md`](docs/dev-db-fixture.md)** for the seed pipeline (`seed_db.sql` + `seed-clone.sql`), the `LOAD_CLONE_FIXTURE` gate distinguishing dev from CI, the `predev` rebuild rationale, and how to refresh the clone.

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

Three test suites: `npm run test:unit` (mocked DB), `npm run test:integration` (requires `npm run db:start`, runs `--runInBand` because tests share show/DJ/flowsheet state), `npm run ci:testmock` (Docker-isolated mirror of CI).

See **[`docs/testing.md`](docs/testing.md)** for jest configs, locations, setup files, and the GitHub Actions workflow (`.github/workflows/test.yml`) job list (detect-changes → lint-and-typecheck → unit-tests → integration-tests → migrate-dryrun).

## Deployment

Hosted on EC2; CI/CD via GitHub Actions. Push to `main` auto-triggers `deploy-auto.yml`, which delegates to the reusable `deploy-base.yml`. `deploy-manual.yml` (`workflow_dispatch` with `target` + `version`) is the lever for re-deploying a specific tag or rolling back. Docker images built with `node:24-alpine`, stored in ECR.

**Cadence rule**: every merge already triggers an auto-deploy, but when a PR that touches `shared/database/src/migrations/**` merges, verify the auto-deploy succeeded — if it didn't, run Manual Build & Deploy within 24 hours. Migration-chain risk accumulates when deploys fail silently. See [`docs/deploy.md`](docs/deploy.md) for the 2026-05-04 wedge case study and the project-#26 hardening defenses.

## Relationship to Other Repos

- **[dj-site](https://github.com/WXYC/dj-site)** — React frontend that consumes this API
- **[@wxyc/shared](https://github.com/WXYC/wxyc-shared)** — Shared DTOs, auth client, validation. V2 flowsheet endpoints use `@wxyc/shared` types.
- **[library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup)** — Discogs metadata service with 3-tier caching. All Discogs access (proxy endpoints, metadata enrichment, track search, artwork discovery) routes through LML via `LIBRARY_METADATA_URL`. The backend makes no direct Discogs API calls.
- **[tubafrenzy](https://github.com/WXYC/tubafrenzy)** — Legacy Java system this service is replacing. Both read/write the same underlying data.
