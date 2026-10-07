# Backend-Service

API and authentication service for WXYC applications. Provides endpoints for the DJ flowsheet, music library catalog, DJ management, scheduling, and song requests.

## Topic guides

CLAUDE.md is a router for the always-loaded reference card. Topic depth lives in `docs/`:

- **[`docs/migrations.md`](docs/migrations.md)** — Drizzle migration rules: journal `when` recipe, parallel-PR collisions, IF NOT EXISTS, DDL-only, precondition guards, cross-cache-identity gates, attempt-at markers (flowsheet + rotation), drizzle-kit `applied-hashes.json` quirk, post-bulk-UPDATE ANALYZE
- **[`docs/bulk-update-playbook.md`](docs/bulk-update-playbook.md)** — Per-row cost on `flowsheet`, ANALYZE-after-UPDATE rule, async-commit + batch-size + partial-index recipe, infinite-loop pitfall, sync-gap remediation
- **[`docs/env-vars.md`](docs/env-vars.md)** — Full environment-variable reference (Backend, DB, Auth, Email, Sentry, Slack, ETL, mirror queue, cross-cache-identity flags)
- **[`docs/replication.md`](docs/replication.md)** — Local PostgreSQL logical-replication setup and operation
- **[`docs/cdc.md`](docs/cdc.md)** — CDC pipeline: triggers, per-process LISTEN, in-process consumers, fallback channels
- **[`docs/deploy.md`](docs/deploy.md)** — Deploy cadence, migration-chain risk, deploy-wedge anatomy, buildx registry layer caching (ECR manifest requirement, lifecycle policy) plus the shared builder image that replaced 56 per-target `npm ci` builds (`Dockerfile.deploy-builder`, BS#2718), CI workflow pin maintenance (permissions, gha/v1 pins, caller-callee permissions trap from #857), edge gzip (allowlist, the SSE guard, `/auth` opt-out)
- **[`docs/authentication.md`](docs/authentication.md)** — Roles, permissions matrix, JWT payload, `requirePermissions` middleware flow, `AUTH_BYPASS`, better-auth role-mismatch gotcha, auth server endpoints and bootstrap, role grant data and mock sync
- **[`docs/pii.md`](docs/pii.md)** — PII field registry: `real_name`/`email` vs `dj_name`/`name` classification, allowed read sites, the `wxyc/restricted-real-name` ESLint rule, DJ-name/real-name conflation history
- **[`docs/testing.md`](docs/testing.md)** — Unit + integration + CI-mock test setup, jest configs, CI workflow job list, mock drift
- **[`docs/dev-db-fixture.md`](docs/dev-db-fixture.md)** — Dev DB seed pipeline (`seed_db.sql` + `seed-clone.sql`), `LOAD_CLONE_FIXTURE` gate, `predev` rebuild hook, Compose project naming, `db:stop` vs `db:reset`
- **[`docs/ops-cron-scheduling.md`](docs/ops-cron-scheduling.md)** — LML-heavy cron spacing policy; heavy-drain vs light-touch vs hourly-safety-net; slot table; cron-liveness recipe (BS#2064 — Sentry cron monitor + `cronjob_runs` heartbeat + outcome check, with the per-monitor cost)
- **[`docs/jobs.md`](docs/jobs.md)** — Full per-job reference for every job in the Monorepo Layout table. Some `jobs/` directories have no entry yet; they are named in that file.
- **[`docs/packages.md`](docs/packages.md)** — Full reference for the long package rows
- **[`docs/api-routes.md`](docs/api-routes.md)** — Detailed route notes (`/album-reviews`, `/digital-archive`, ...), the no-`/v2/flowsheet` explanation, legacy mirror middleware history
- **[`docs/intake-and-reviews.md`](docs/intake-and-reviews.md)** — `/intake` and `/reviews` route rules, one bullet per rule (moved out of the route table; add new rules there)

For the org-wide cache-hierarchy reference (BS's `proxy.controller` LRUs in context with the upstream iOS caches and downstream LML caches), see [`WXYC/wiki/architecture/cache-hierarchy.md`](https://github.com/WXYC/wiki/blob/main/architecture/cache-hierarchy.md).

Read the relevant topic doc before doing work in that area.

## Architecture

### Monorepo Layout

npm workspaces:

| Package | Path | Purpose |
| --- | --- | --- |
| `@wxyc/backend` | `apps/backend/` | Express API server (port 8080) |
| `@wxyc/auth-service` | `apps/auth/` | better-auth server (port 8082) |
| `@wxyc/enrichment-worker` | `apps/enrichment-worker/` | CDC consumer: enriches new flowsheet track rows via LML (trust-gated). |
| `@wxyc/database` | `shared/database/` | Drizzle schema, client, migrations, ETL utilities. |
| `@wxyc/authentication` | `shared/authentication/` | Auth middleware, roles, JWT verification |
| `@wxyc/lml-client` | `shared/lml-client/` | HTTP client for LML: single chokepoint with limiter and breaker. |
| `@wxyc/observability` | Sentry filters/config (every `SENTRY_DATA_COLLECTION` field must stay spelled out; Sentry 11 defaults are PII-on); `./metrics` emitter never re-exported from the barrel. |

Jobs under `jobs/<name>/` (full text per job in [`docs/jobs.md`](docs/jobs.md)):

| Job | Summary |
| --- | --- |
| `@wxyc/flowsheet-etl` | **One-shot (retained, unscheduled).** **Refuses to run unless `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`**; overwrites Backend-canonical `shows`/`flowsheet`; watermark frozen. |
| `@wxyc/rotation-etl` | **One-shot (retained, unscheduled).** **Refuses to run unless `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`**; reverts tubafrenzy-origin `rotation` rows; watermark frozen. |
| `@wxyc/library-etl` | **One-shot (retained, unscheduled).** **Refuses to run unless `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1`**; reverts dj-site catalog edits, re-inserts deleted rows. |
| `@wxyc/legacy-linkage-resolve` | Cron `*/30`: links `flowsheet.album_id` / `rotation.album_id` once the `library` row exists. |
| `@wxyc/artist-identity-etl` | Sync artist identity from LML's `entity.identity`. |
| `@wxyc/flowsheet-dj-name-backfill` | **⛔ SUPERSEDED by `flowsheet-dj-name-scrub` — do not run** (reverses the BS#2281 scrub). |
| `@wxyc/flowsheet-dj-name-scrub` | One-shot, dry-run default: recompute historical `flowsheet.dj_name` and marker PII (BS#2281). |
| `@wxyc/legacy-dj-name-remediation` | **⛔ SUPERSEDED by `flowsheet-dj-name-scrub` — do not run** (reverses the BS#2281 scrub). |
| `@wxyc/library-artist-name-backfill` | One-shot: populate `library.artist_name` after migration 0058. |
| `@wxyc/flowsheet-metadata-backfill` | Hourly cron `10 * * * *`: gap-recovery enrichment of pending flowsheet rows the CDC consumer missed. |
| `@wxyc/library-artwork-url-backfill` | One-shot warm of `library.artwork_url` for Discogs-resolvable rows. |
| `@wxyc/library-identity-consumer` | One-shot: consume LML bulk-resolve verdicts into `library_identity`. |
| `@wxyc/album-metadata-backfill` | One-shot: populate `album_metadata` from enriched `flowsheet` rows. |
| `@wxyc/album-level-backfill` | One-shot drain: enrich ~35.7k pending album_ids via LML bulk, flip linked flowsheet rows. |
| `@wxyc/rotation-release-id-backfill` | Cron `17 */6 * * *`: trust-gated LML resolver for active rotation rows missing `discogs_release_id`. |
| `@wxyc/flowsheet-no-match-recheck` | Cron `47 */6 * * *`: TTL-gated re-ask of `enriched_no_match` flowsheet rows via LML. |
| `@wxyc/artist-search-alias-consumer` | Daily cron `15 4 * * *`: LML search aliases into `artist_search_alias`. |
| `@wxyc/venue-events-scraper` | Daily cron `0 5 * * *`: scrape Rockhouse Partners venue concerts into `concerts`. |
| `@wxyc/triangle-shows-etl` | Nightly cron `5 5 * * *`: mirror triangle-shows events for 16 venues into `concerts`. |
| `@wxyc/concerts-artist-resolver` | Daily cron `15 5 * * *`: sync support performers, resolve artists locally, recompute `has_resolved_support`. |
| `@wxyc/concerts-artist-lml-resolver` | Daily cron `35 5 * * *`: resolve touring headliners/support acts via LML. |
| `@wxyc/catalog-popularity-freetext-resolve` | Cron `45 4 * * *`: resolve free-text (artist, album) plays to Discogs releases. |
| `@wxyc/apple-music-url-backfill` | One-shot, dry-run default: refill NULL `apple_music_url` where a match signal exists. |
| `@wxyc/flowsheet-linked-reenrichment` | One-shot, dry-run default: re-enrich the BS#1443 linked `enriched_no_match` cohort. |
| `@wxyc/streaming-url-remediation` | One-shot, dry-run default: rewrite non-host-correct stored Spotify/Apple URLs; no LML. |
| `@wxyc/streaming-columns-drain` | One-shot, dry-run default: heal matched `album_metadata` rows with all five streaming URLs NULL. |
| `@wxyc/album-metadata-bio-fill` | One-shot, dry-run default: fill `artist_bio` for matched rows lacking one. |
| `@wxyc/artist-unicode-dedup` | One-shot, dry-run default: merge Unicode-duplicate `artists`; risky groups need `--include-risky`. |
| `@wxyc/artist-conflation-split` | One-shot, dry-run default: split wrongly merged artists; `--execute` needs `--identity-guard-live`. |
| `@wxyc/rotation-release-id-pollution-check` | Weekly cron `0 7 * * 1` (Python): read-only wrong-album release-id pollution audit. |
| `@wxyc/concerts-similar-artists-enrichment` | Nightly cron `55 5 * * *`: semantic-index affinity neighbors for concert headliners. |
| `@wxyc/concerts-poster-enrichment` | Nightly cron `05 6 * * *`: fill missing concert posters from Discogs artist images. |
| `@wxyc/album-reviews-etl` | Nightly cron `50 4 * * *`: mirror the Album Review Responses sheet into `album_review_submissions`. |
| `@wxyc/album-critic-reviews-etl` | Weekly cron `10 7 * * 0`: ingest research-data critic reviews into `album_critic_reviews`. |
| `@wxyc/uncovered-release-list` | Weekly cron `40 7 * * 0`: publish releases lacking critic reviews to research-data. |
| `@wxyc/flowsheet-ghost-row-sweep` | One-shot, dry-run default: delete flowsheet/rotation rows absent from the tubafrenzy keyspace; do not run against prod until BS#1083. |
| `@wxyc/flowsheet-april-gap-import` | One-shot, dry-run default: insert-only import of 399 dropped rows (Apr 16–20, 2026). |
| `@wxyc/va-apple-music-url-remediation` | One-shot, dry-run default: re-verify or invalidate V/A-blind Apple URLs (BS#2000); gated on LML#1139 + cache purge deployed. |
| `@wxyc/metadata-no-match-digest` | Daily cron `07 15 * * *`: email digest of new `enriched_no_match` rows. |
| `@wxyc/auth-user-name-backfill` | One-shot, dry-run default: rewrite `auth_user.name`; **never `--execute` before plan step 2a**. |
| `@wxyc/flowsheet-show-split` | One-shot repair, **writes by default (`--dry-run` to preview)**; requires `--show-id`; also stamps tubafrenzy `SIGNOFF_TIME`; not re-runnable. |
| `@wxyc/station-signup-review` | Daily cron: pending-signup digest plus the only automatic downgrade (`STATION_SIGNUP_DOWNGRADE_ENABLED`, default OFF). |
| `@wxyc/auth-log-prune` | Daily cron `27 15 * * *`: prune signup-attempt and account-audit tables. |
| `@wxyc/comp-letter-backfill` | One-shot, dry-run default (`--apply`): set `code_comp_letter` on 52 compilation slots. |

### API Server (`apps/backend`)

Express 5 application with these route groups:

| Route | Purpose |
| --- | --- |
| `/config` | Public app bootstrap configuration |
| `/proxy` | iOS proxy endpoints (anonymous auth + rate limit) |
| `/library` | Music library catalog |
| `/album-reviews` | Form-review archive reads (ADR 0011); role-gated `album_reviews:read` (dj+). Detail: [`docs/api-routes.md`](docs/api-routes.md) |
| `/digital-archive` | Presigned playback manifests (BS#2320, ADR 0014); `digital_archive:listen` (dj+) and flag-gated. Detail: [`docs/api-routes.md`](docs/api-routes.md) |
| `/intake` | DJ album-review intake; `reviews:*` role-gated. Rules: [`docs/intake-and-reviews.md`](docs/intake-and-reviews.md#intake) |
| `/reviews` | In-app DJ reviews; `reviews:*` role-gated. Rules: [`docs/intake-and-reviews.md`](docs/intake-and-reviews.md#reviews) |
| `/fcc-notes` | FCC notes on the record; `reviews:*` role-gated. Rules: [`docs/intake-and-reviews.md`](docs/intake-and-reviews.md#fcc-notes) |
| `/flowsheet` | Flowsheet — serves both the V1 shape and the V2 projection; there is no `/v2/flowsheet` route (see [`docs/api-routes.md`](docs/api-routes.md#flowsheet-and-the-v2-projection)) |
| `/djs` | DJ bin and playlists |
| `/request` | Song request line |
| `/schedule` | Schedule management |
| `/events` | SSE for real-time updates |
| `/healthcheck` | Health check |
| `/internal` | Internal endpoints (ETL notifications, tubafrenzy flowsheet webhook) |

Code is organized as controllers (HTTP handling) → services (business logic) → database (Drizzle queries).

Key middleware:

- `requirePermissions` — JWT auth with role-based access control
- `showMemberMiddleware` — Validates user is part of the active show
- `activeShow` — Checks for an active show
- `anonymousAuth` — Validates better-auth session
- `rateLimiting` — Rate limits on registration and song requests
- `errorHandler` — Centralized error handling returning standardized responses
- ~~Legacy mirror middleware~~ — Removed in BS#2403; the inbound `POST /internal/flowsheet-webhook` stays live, the rotation webhook is retired. Detail: [`docs/api-routes.md`](docs/api-routes.md#middleware-notes).

Server timeout is 35 seconds globally (strictly greater than the LML client's 30 s `AbortController`); SSE routes opt out. Detail: [`docs/api-routes.md`](docs/api-routes.md#server-timeout).

### Auth Server (`apps/auth`)

Express wrapper around better-auth with these plugins: admin, username, anonymous, bearer, jwt, organization, deviceAuthorization.

- Email+password auth only (no social auth)
- Email verification required
- Sign-up disabled (admin creates accounts)
- Endpoints and bootstrap: admin `provision-user` / `resolve-organization`, `complete-onboarding`, QR device sign-in (ADR 0008), default and Auto-DJ users, test-only endpoints. Full list in [`docs/authentication.md`](docs/authentication.md#auth-server-appsauth).

### Database (`shared/database`)

Drizzle ORM with PostgreSQL (`postgres-js` driver).

**Correlated select fields:** reference the outer row's column only through `outerRef(column)` (`apps/backend/utils/sql-fragments.ts`); detail in [`docs/packages.md`](docs/packages.md#database-shareddatabase-notes).

<!-- auth-tables-list:begin -->

**Auth tables** (managed by better-auth): `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_jwks`, `auth_organization`, `auth_member`, `auth_invitation`, `auth_device_code` (ADR 0008 QR sign-in), `auth_oauth_application` / `auth_oauth_access_token` / `auth_oauth_consent` (better-auth `oidcProvider` plugin substrate).

<!-- auth-tables-list:end -->

The list above is enforced against every `.ts` file under `shared/database/src/` by `scripts/check-auth-tables-doc.mjs` (BS#1573). Adding a new `auth_*` `pgTable(...)` — in `schema.ts` today or a sibling file if the schema is ever split (BS#1581) — requires updating the sentinel-fenced line; the CI job will fail otherwise.

**Domain tables** (custom schema): `dj_stats`, `schedule`, `shift_covers`, `artists`, and flowsheet-related tables.

Schema is in `shared/database/src/schema.ts`. Migrations are in `shared/database/src/migrations/`.

**Test isolation**: Each Jest worker gets its own PostgreSQL schema via the `WXYC_SCHEMA_NAME` env var (defaults to `wxyc_schema`).

**Mock drift**: the unit suite's `@wxyc/database` double is hand-maintained; `npm run check:db-mock-sync` (hard-fail in pre-push and CI) notices drift. Detail: [`docs/testing.md`](docs/testing.md#mock-drift).

**Migration workflow**:

```bash
npm run drizzle:generate   # Generate SQL migration from schema changes
npm run drizzle:migrate    # Apply migrations to database
npm run drizzle:drop       # Delete a migration file
```

**Read [`docs/migrations.md`](docs/migrations.md) before authoring any migration.** It covers the journal `when` recipe, collisions, DDL-only and precondition-guard rules, and the attempt-at markers; the full scope list is in [`docs/migrations.md`](docs/migrations.md#claudemd-scope-list).

### Authentication (`shared/authentication`)

better-auth wrapper providing JWT verification + role-based access control; roles form a chain (member < dj < musicDirector < stationManager) that is a CI-enforced invariant on the grant data, not a runtime fallback. `auth.roles.ts` owns the only grant matrix; `npm run check:better-auth-mock-sync` is hard-fail in pre-push and CI. Detail: [`docs/authentication.md`](docs/authentication.md#role-grant-data-and-mock-sync).

See **[`docs/authentication.md`](docs/authentication.md)** for the permissions matrix, JWT payload shape, `requirePermissions` middleware flow, `AUTH_BYPASS` test hook, and the better-auth role-mismatch gotcha.

## Development

### Running locally

```bash
npm install              # Install all workspace dependencies
npm run db:start         # Start PostgreSQL in Docker (port 5432)
npm run dev              # Start auth (8082) + backend (8080) concurrently with hot reload
```

`npm run dev` rebuilds `@wxyc/database` + `@wxyc/authentication` first (`predev` hook). `npm run db:stop` keeps the `pg-data` volume; `npm run db:reset` is the destructive form that drops it. Detail in [`docs/dev-db-fixture.md`](docs/dev-db-fixture.md#dev-commands-moved-from-claudemd).

See **[`docs/dev-db-fixture.md`](docs/dev-db-fixture.md)** for the seed pipeline (`seed_db.sql` + `seed-clone.sql`), the `LOAD_CLONE_FIXTURE` gate distinguishing dev from CI, the `predev` rebuild rationale, and how to refresh the clone.

### One-time per-clone setup

Register the journal merge driver so concurrent migration PRs auto-resolve their `_journal.json` appends. Steps in [`docs/migrations.md`](docs/migrations.md#one-time-per-clone-setup).

### Code Quality

Pre-push hook (husky) runs automatically:

```bash
npm run typecheck        # tsc --noEmit, but only @wxyc/database + shared/** + apps/** -- jobs/** and tests/** are NOT covered
npm run lint             # ESLint with TypeScript + security rules
```

Other quality commands:

```bash
npm run format           # Prettier formatting
npm run format:check     # Verify formatting (used in CI)
npm run build            # Compile all workspaces
```

**Schema-first rule:** a new public endpoint's request/response shape goes into `wxyc-shared/api.yaml` (the cross-repo SSOT whose codegen feeds this repo, dj-site, iOS, and Android) first, before or alongside the private TS type. `apps/backend/app.yaml` is Swagger-UI docs only — not a codegen source — so a shape that lives only there (or only as a private TS type) is invisible to SSOT consumers and the specs drift.

### Doc hygiene

CLAUDE.md is the always-loaded reference card; topic depth lives in `docs/*.md`. Four checks run in `.husky/pre-push` — two warn-only, two hard-fail:

- `npm run check:doc-budget` — **warn-only.** Warns if CLAUDE.md exceeds its char budget. When it fires, extract to `docs/` rather than growing CLAUDE.md.
- `npm run check:doc-rules` — **warn-only.** Surfaces `<!-- @rule -->` markers in `docs/*.md` that are stale (unenforced + old, enforced + verbose, or past `review-after`). Convention documented in [`docs/migrations.md`](docs/migrations.md#rule-annotation-convention).
- `npm run check:auth-tables-doc` — **hard-fail.** Enforces the sentinel-fenced `auth_*` table list in CLAUDE.md against every `.ts` file under `shared/database/src/` (BS#1581 tree walk; skips only `migrations/`). A mismatch is always a bug (see BS#1573 for the drift incidents that motivated it); do not paper over failures with `|| true` in the hook. If your diff legitimately changes the set of auth tables, edit the sentinel-fenced line in CLAUDE.md to match the schema.
- `npm run check:sql-claim-docs` — **hard-fail.** Static half of the docs `sql-claim` check (BS#2737); what it checks is in `scripts/check-sql-claim-docs.mjs`'s header.

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

Hosted on EC2; CI/CD via GitHub Actions. Push to `main` auto-triggers `deploy-auto.yml`, which delegates to the reusable `deploy-base.yml`. `deploy-manual.yml` (`workflow_dispatch` with `target` + `version`, or `rebuild=true` to build a fresh image from `main`) is the lever for re-deploying a specific tag, rolling back, or rebuilding a target. Docker images built with `node:24-alpine`, stored in ECR.

**Cadence rule**: every merge already triggers an auto-deploy, but when a PR that touches `shared/database/src/migrations/**` merges, verify the auto-deploy succeeded — if it didn't, run Manual Build & Deploy within 24 hours. Migration-chain risk accumulates when deploys fail silently. See [`docs/deploy.md`](docs/deploy.md) for the 2026-05-04 wedge case study and the project-#26 hardening defenses.

## Relationship to Other Repos

- **[dj-site](https://github.com/WXYC/dj-site)** — React frontend that consumes this API
- **[@wxyc/shared](https://github.com/WXYC/wxyc-shared)** — Shared DTOs, auth client, validation. V2 flowsheet endpoints use `@wxyc/shared` types.
- **[library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup)** — Discogs metadata service with 3-tier caching. All Discogs access (proxy endpoints, metadata enrichment, track search, artwork discovery) routes through LML via `LIBRARY_METADATA_URL`. The backend makes no direct Discogs API calls.
- **[tubafrenzy](https://github.com/WXYC/tubafrenzy)** — Legacy Java system this service is replacing. Both read/write the same underlying data.
