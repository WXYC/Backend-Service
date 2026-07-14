# Backend-Service

API and authentication service for WXYC applications. Provides endpoints for the DJ flowsheet, music library catalog, DJ management, scheduling, and song requests.

## Topic guides

CLAUDE.md is a router for the always-loaded reference card. Topic depth lives in `docs/`:

- **[`docs/migrations.md`](docs/migrations.md)** — Drizzle migration rules: journal `when` recipe, parallel-PR collisions, IF NOT EXISTS, DDL-only, precondition guards, cross-cache-identity gates, attempt-at markers (flowsheet + rotation), drizzle-kit `applied-hashes.json` quirk, post-bulk-UPDATE ANALYZE
- **[`docs/bulk-update-playbook.md`](docs/bulk-update-playbook.md)** — Per-row cost on `flowsheet`, ANALYZE-after-UPDATE rule, async-commit + batch-size + partial-index recipe, infinite-loop pitfall, sync-gap remediation
- **[`docs/env-vars.md`](docs/env-vars.md)** — Full environment-variable reference (Backend, DB, Auth, Email, Sentry, Slack, ETL, mirror queue, cross-cache-identity flags)
- **[`docs/replication.md`](docs/replication.md)** — Local PostgreSQL logical-replication setup and operation
- **[`docs/cdc.md`](docs/cdc.md)** — CDC WebSocket endpoint, event format, reconciliation monitor
- **[`docs/deploy.md`](docs/deploy.md)** — Deploy cadence, migration-chain risk, deploy-wedge anatomy, CI workflow pin maintenance (permissions, gha/v1 pins, caller-callee permissions trap from #857)

For the org-wide cache-hierarchy reference (BS's `proxy.controller` LRUs in context with the upstream iOS caches and downstream LML caches), see [`WXYC/wiki/architecture/cache-hierarchy.md`](https://github.com/WXYC/wiki/blob/main/architecture/cache-hierarchy.md).

Read the relevant topic doc before doing work in that area.

## Architecture

### Monorepo Layout

npm workspaces:

| Package                                     | Path                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@wxyc/backend`                             | `apps/backend/`                             | Express API server (port 8080)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@wxyc/auth-service`                        | `apps/auth/`                                | better-auth server (port 8082)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `@wxyc/enrichment-worker`                   | `apps/enrichment-worker/`                   | Long-running CDC consumer: claims new flowsheet track rows (`metadata_status='pending'`) and enriches via LML. N×N idempotent-claim (BS#892 / Epic C C2). C6 (BS#895) cron is the gap-recovery safety net.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@wxyc/database`                            | `shared/database/`                          | Drizzle ORM schema, client, migrations, ETL utilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@wxyc/authentication`                      | `shared/authentication/`                    | Auth middleware, roles, JWT verification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@wxyc/lml-client`                          | `shared/lml-client/`                        | HTTP client for library-metadata-lookup (LML). Single chokepoint — `lookupMetadata` wraps `Sentry.startSpan` + `Semaphore(5)` + `TokenBucket(50/min)` mirroring LML's Discogs ceilings (BS#906/G4). Used by `apps/backend` runtime path and `jobs/flowsheet-metadata-backfill`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@wxyc/flowsheet-etl`                       | `jobs/flowsheet-etl/`                       | Flowsheet ETL: sync from tubafrenzy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@wxyc/rotation-etl`                        | `jobs/rotation-etl/`                        | Rotation ETL: sync from tubafrenzy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@wxyc/artist-identity-etl`                 | `jobs/artist-identity-etl/`                 | Artist identity ETL: sync from LML's `entity.identity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@wxyc/flowsheet-dj-name-backfill`          | `jobs/flowsheet-dj-name-backfill/`          | One-shot backfill: populate `flowsheet.dj_name` on legacy track + marker rows (show_start, show_end, dj_join, dj_leave) after migration 0053 / #952                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@wxyc/legacy-dj-name-remediation`          | `jobs/legacy-dj-name-remediation/`          | One-shot PII remediation: scrub `shows.legacy_dj_name` of values pulled from the wrong tubafrenzy column (DJ_NAME → DJ_HANDLE) and re-resolve `flowsheet.dj_name` on marker rows whose value came from the polluted fallback. Companion to the ETL source fix in `fetch-legacy.ts` + `backfill-legacy-ids.ts` + the bulk-load tuple position in `flowsheet-etl/job.ts`. Idempotent; supports `--dry-run`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@wxyc/library-artist-name-backfill`        | `jobs/library-artist-name-backfill/`        | One-shot backfill: populate `library.artist_name` from the `artists` join after migration 0058 (Epic A.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@wxyc/flowsheet-metadata-backfill`         | `jobs/flowsheet-metadata-backfill/`         | Recurring metadata drift-repair: enrich `flowsheet` track rows where LML metadata enrichment never ran (#631 / #638 / #641). Cron-registered via deploy-base; default schedule `0 6 * * *` UTC (02:00 ET) from `package.json` `cron-schedule`, overridable per-deploy via the `BACKFILL_CRON_SCHEDULE` GHA repository variable (BS#914). Orchestrator's cooperative pause (#735) defers when DJs are active.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@wxyc/library-artwork-url-backfill`        | `jobs/library-artwork-url-backfill/`        | One-shot warm: populate `library.artwork_url` for Discogs-resolvable rows (joined to `artists.discogs_artist_id`) so search-time `enrichWithArtwork` short-circuits (#637).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@wxyc/library-identity-consumer`           | `jobs/library-identity-consumer/`           | One-shot ETL: consume LML's `POST /api/v1/identity/bulk-resolve-libraries` and UPSERT verdicts into `library_identity` + `library_identity_source` (post-#800 cross-cache-identity pivot: LML is sole composer; Backend is thin writer).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@wxyc/album-metadata-backfill`             | `jobs/album-metadata-backfill/`             | One-shot historical backfill: populate `album_metadata` from the enriched subset of `flowsheet` (Epic D / #898). `INSERT … SELECT DISTINCT ON (album_id) … ON CONFLICT DO NOTHING` — idempotent. Bridges D1 (#897) schema and D3 (#899) writer cutover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@wxyc/album-level-backfill`                | `jobs/album-level-backfill/`                | One-shot historical drain (#1041): enrich the ~35,692 unique pending album_ids via LML's bulk endpoint (LML#368, `POST /api/v1/lookup/bulk`) and flip the ~857k linked-pending flowsheet rows in a paired post-pass UPDATE. Race-guarded UPSERT into `album_metadata` mirrors the worker's shape. Companion to `flowsheet-metadata-backfill` (per-row drain handles the 744k no-album_id residual).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@wxyc/rotation-release-id-backfill`        | `jobs/rotation-release-id-backfill/`        | One-shot ETL (BS#1029): pre-resolve `rotation.discogs_release_id` for ~310 active rows via LML so the dj-site rotation-tracks picker becomes a deterministic SQL JOIN. Writes `discogs_release_id_source = 'lml_offline_backfill'` (migration 0085); rotation-etl's COALESCE+CASE upsert preserves the backfill's writes against subsequent ticks. Idempotent SELECT/WHERE on `IS NULL`. Unblocks BS#1030 (revert the runtime LML cascade introduced in PR #987 / BS#986).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@wxyc/artist-search-alias-consumer`        | `jobs/artist-search-alias-consumer/`        | Daily cron ETL (BS#1266 / artist-search-alias plan PR 4): consume LML's `POST /api/v1/artists/search-aliases/bulk` and UPSERT composed alias variants into `artist_search_alias` (migration 0089), with a shadow-ingest of `library.alternate_artist_name` tagged as `wxyc_library_alt`. Reconcile is scoped to `sources_present` so a partial-composer response can't wipe rows from other sources. Populates the substrate that PR 5's alias-aware catalog LATERAL JOIN reads. Default schedule `15 4 * * *` UTC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@wxyc/venue-events-scraper`                | `jobs/venue-events-scraper/`                | Daily scraper: pull upcoming concerts from Rockhouse Partners-powered Triangle venue sites (catscradle.com, local506.com — extensible) by parsing schema.org `Event` JSON-LD; UPSERT into the `concerts` table (migration 0091) keyed on `(source='rhp_scrape', source_id=event-page-pathname)`. First source for the touring-events feature; future sources extend `concert_source_enum` rather than this job. Bandsintown lives on a separate live-fetch path because its Data Applications Terms forbid persistent caching. Default schedule `0 5 * * *` UTC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@wxyc/triangle-shows-etl`                  | `jobs/triangle-shows-etl/`                  | Nightly pull ETL (BS#1589 / BS#1570 Phase 1): mirror [triangle-shows](https://github.com/WXYC/triangle-shows) events for the 16 venues the venue-events-scraper doesn't cover into `venues`/`concerts`, keyed on `(source='triangle_shows', source_id='<venue_slug>:'+source_key)` (venue-qualified — bare `source_key` is only unique per-venue). Full-snapshot pull (`dedup=false&include_removed=true`, back-dated `start`), source-authoritative `status`/`removed_at` refreshed both directions (deliberate divergence from `rhp_scrape`'s admin-managed status), 5 double-covered RHP slugs excluded with startup drift assertions. Resolver stamps new rows same cycle, no changes. Default schedule `5 5 * * *` UTC (between the 05:00 scraper and 05:15 resolver).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@wxyc/concerts-artist-lml-resolver`        | `jobs/concerts-artist-lml-resolver/`        | Daily cron (BS#1614): resolve clean unresolved `concerts.headlining_artist_raw` names to Discogs artist ids via LML's verify-before-mint `POST /api/v1/artists/resolve/bulk` (LML#759) — the touring artists absent from the WXYC library that `concerts-artist-resolver`'s pure-SQL strict/alias arms can never FK. Gate: `isCleanHeadliner` imported from `jobs/triangle-shows-etl/headliner.ts` (API-budget filter, not correctness — verify-before-mint makes a dirty name a wasted call, never a wrong mint). Writes `headlining_discogs_artist_id` + `_source='lml_artist_resolve'` + the `artist_resolve_attempted_at` marker (stamped ONLY on responded verdicts; `escalation_unavailable`/transport errors stay NULL-retryable), FK-loop-closes `headlining_artist_id` on a singleton `artists.discogs_artist_id` match, and either resolution lane now satisfies the curated feed (migration 0116 widened `concerts_curated_starts_on_idx` + `buildWhere`). Role-agnostic `(raw_name → verdict → row targets)` structure so BS#1618 Phase D adds `concert_performers` targets without restructuring. Upcoming-only candidates; cooperative pause; serial pages with a job-owned limiter. Default schedule `35 5 * * *` UTC (after the 05:05 triangle-shows pull and 05:15 SQL resolver). |
| `@wxyc/catalog-popularity-freetext-resolve` | `jobs/catalog-popularity-freetext-resolve/` | Recurring cron (BS#1491 / catalog-popularity Phase-2 Track 1): resolve every distinct free-text `(artist, album)` pair from unlinked plays (`flowsheet.album_id IS NULL`, ~43% of music plays) to a Discogs release via LML `bulkLookupMetadata`, UPSERTing verdicts into `flowsheet_freetext_resolution` (migration 0106) keyed on the normalized `(norm_artist, norm_album)` pair (`normalizeArtistName` + `normalizeAlbumTitle`). `attempt_at` marker + no-match TTL retry: re-attempts `attempt_at IS NULL` rows and no-match rows past the TTL. Track 2's popularity collapse reads this table to attribute the free-text plays the linked-only `album_plays` signal can't see. Cooperative pause defers when DJs are active. Default schedule `45 4 * * *` UTC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@wxyc/apple-music-url-backfill`            | `jobs/apple-music-url-backfill/`            | One-shot remediation (BS#1631): re-query LML for `album_metadata` + `flowsheet` rows where `apple_music_url IS NULL` despite a positive match signal (`discogs_url` present OR linked `library.on_streaming`), filling ONLY still-null rows (`WHERE ... AND apple_music_url IS NULL` guard in the UPDATE itself). Dry-run by default (`--execute` to write); up to two LML lookups per candidate (second pass catches LML#706's eventually-consistent fill); in-run URL dedup keyed on artist+album+track (BS#1192 — apple URLs are track-aware). Gated on LML#782; run off-peak, never alongside the 06:00 UTC cron. Resume via `BACKFILL_ALBUM_AFTER_ID` / `BACKFILL_FLOWSHEET_AFTER_ID`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `@wxyc/rotation-release-id-pollution-check` | `jobs/rotation-release-id-pollution-check/` | Weekly cron (BS#1522) — **first Python job in the fleet** (deploy pipeline treats jobs as opaque Docker targets). Re-runs the #1517 wrong-album pollution audit against active `lml_offline_backfill`/`discogs_direct_backfill` rotation rows via `pollution_engine.py` (the #1520/#1524 auditor, relocated here so the scheduled check imports the scoring literally; `scripts/audit/bs_rotation_release_id_pollution.py` is now a thin wrapper). Alerts per-`rotation_id`-fingerprinted Sentry warnings on `mismatch` only (60–79 `suspect` band calibrated 100% false-positive) plus a provenance-anomaly branch for any `discogs_direct_backfill` stamp outside the frozen baseline (#1521 retirement invariant). Read-only; remediation stays manual per the #1517 recipe. Cooperative pause; BS#995 LML pacing. Default schedule `0 7 * * 1` UTC.                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

Server timeout is 35 seconds globally — strictly greater than the LML client's 30 s `AbortController` (`@wxyc/lml-client`, `shared/lml-client/src/index.ts`) so a slow LML lookup's catch path can flush a 200-with-fallback response instead of racing the socket teardown to a CORS-less 502. SSE routes opt out via `res.setTimeout(0)`. Swagger API docs are served at `/api-docs` from `app.yaml` — Swagger-UI display only, **not** a codegen source; the cross-repo SSOT is `wxyc-shared/api.yaml` (see Code Quality).

### Auth Server (`apps/auth`)

Express wrapper around better-auth with these plugins: admin, username, anonymous, bearer, jwt, organization, deviceAuthorization.

- Email+password auth only (no social auth)
- Email verification required
- Sign-up disabled (admin creates accounts)
- `POST /auth/admin/provision-user` — Atomic user provisioning: creates user, credential account, and org membership in one call. Requires admin session. Accepts `organizationSlug` (resolved server-side) so the client never needs to map slugs to UUIDs. Password is not accepted — new DJs set their password via the invite onboarding flow. See `apps/auth/provision-user.ts`.
- `GET /auth/admin/resolve-organization?slug=<slug>` — Resolves an organization slug to its UUID. Requires admin session. Returns `{ id, slug, name }`. Used by dj-site admin pages to avoid the fragile `getFullOrganization` SDK call which requires `orgSessionMiddleware`. See `apps/auth/resolve-organization.ts`.
- `POST /auth/wxyc/complete-onboarding` — Public onboarding completion for admin-provisioned DJs. Invite mode accepts the setup token from the invite email plus `newPassword` and optional profile fields; session mode accepts profile fields only for a signed-in incomplete user. See `apps/auth/complete-onboarding.ts` and `wxyc-shared/api.yaml`.
- QR sign-in (ADR 0008, RFC 8628): `POST /auth/device/code`, `GET /auth/device?user_code=…`, `POST /auth/device/approve`, `POST /auth/device/deny`, `POST /auth/device/token`. Browser at dj.wxyc.org polls `/device/token`; the DJ scans the QR with the iOS app and approves via `/device/approve` (gated to roles ≥ `dj`); resulting browser session is clamped to 12h. The 12h cap is enforced by `auth_session.device_flow_expires_at` + a `databaseHooks.session.update.before` clamp, so better-auth's rolling `getSession` refresh (7d default) cannot walk a device-flow session past the ceiling. A rejected member's claim on the `auth_device_code` row is reset to NULL so a legitimate DJ can still approve the same user_code before it TTLs. See `shared/authentication/src/device-authorization.ts` for the three extracted helpers and `docs/adr/0008-qr-device-authorization-shared-computer-signin.md` for the design.
- Default user creation from env vars when `CREATE_DEFAULT_USER=TRUE` (uses `provisionUser()` internally)
- Test-only endpoints (non-production): `/auth/test/verification-token`, `/auth/test/expire-session`, `/auth/test/confirm-user`, `/auth/test/reset-incomplete-user`

### Database (`shared/database`)

Drizzle ORM with PostgreSQL (`postgres-js` driver).

<!-- auth-tables-list:begin -->

**Auth tables** (managed by better-auth): `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `auth_jwks`, `auth_organization`, `auth_member`, `auth_invitation`, `auth_device_code` (ADR 0008 QR sign-in), `auth_oauth_application` / `auth_oauth_access_token` / `auth_oauth_consent` (better-auth `oidcProvider` plugin substrate).

<!-- auth-tables-list:end -->

The list above is enforced against every `.ts` file under `shared/database/src/` by `scripts/check-auth-tables-doc.mjs` (BS#1573). Adding a new `auth_*` `pgTable(...)` — in `schema.ts` today or a sibling file if the schema is ever split (BS#1581) — requires updating the sentinel-fenced line; the CI job will fail otherwise.

**Domain tables** (custom schema): `dj_stats`, `schedule`, `shift_covers`, `artists`, and flowsheet-related tables.

Schema is in `shared/database/src/schema.ts`. Migrations are in `shared/database/src/migrations/`.

**Test isolation**: Each Jest worker gets its own PostgreSQL schema via the `WXYC_SCHEMA_NAME` env var (defaults to `wxyc_schema`).

**Migration workflow**:

```bash
npm run drizzle:generate   # Generate SQL migration from schema changes
npm run drizzle:migrate    # Apply migrations to database
npm run drizzle:drop       # Delete a migration file
```

**Read [`docs/migrations.md`](docs/migrations.md) before authoring any migration.** It covers the journal `when`-bumping recipe, the parallel-PR collision case, the `IF NOT EXISTS` index pattern, the DDL-only rule, the constraint-precondition-guard pattern, and the cross-cache-identity gate. Also documents the `flowsheet.legacy_link_attempted_at`, `flowsheet.metadata_attempt_at`, and `rotation.tracklist_lookup_attempted_at` attempt-at markers and the jobs that stamp them.

### Authentication (`shared/authentication`)

**Key files:**

- `auth.definition.ts` — better-auth config with plugins and hooks
- `auth.roles.ts` — Role definitions and access control rules
- `auth.middleware.ts` — JWT verification and permission checking
- `auth.client.ts` — Client-side better-auth initialization
- `oidc-trusted-clients.ts` — `buildTrustedClients(env)` for the better-auth `oidcProvider` plugin. Each downstream WXYC app (Wiki.js, Flowsheet verifier) is gated behind its full env-var set, including a non-empty parsed redirect-URL list, so partial configs are omitted rather than pushed broken. Env contract in [`docs/env-vars.md`](docs/env-vars.md#oidc-trustedclients-better-auth-oidcprovider).
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

`npm run dev` automatically rebuilds `@wxyc/database` + `@wxyc/authentication` first via the `predev` lifecycle hook (BS#968). Without this, a fresh clone or a pull that touches `shared/database/src/schema.ts` would serve a stale schema export to the running backend — typically surfacing as a `TypeError: Cannot convert undefined or null to object` deep inside `drizzle-orm/utils.js` with no column name to chase. `apps/backend`'s own `tsup --watch` already rebuilds its own sources, but it doesn't follow workspace dep dists; `predev` covers that gap.

Stop the database with `npm run db:stop` (this runs `docker compose down -v` — the `-v` drops the `pg-data` named volume, so the dev DB is recreated from scratch on the next `db:start`).

**Dev DB fixture**: `db:start` seeds the dev DB from two files, in order: `dev_env/seed_db.sql` (auth fixtures, test users, genres/formats with fixed IDs — identical to CI) and `dev_env/seed-clone.sql` (a ~14 MB `pg_dump` snapshot of prod's `artists / library / rotation / format / genre_artist_crossreference`, taken via the staging postgres clone — TRUNCATEs the small fixtures from the first file in the same transaction before loading). The clone gives realistic data for UI/feature work; CI keeps running against the small seed and the fixed IDs they assume. The dev/CI distinction is gated explicitly via `LOAD_CLONE_FIXTURE=true` set on the dev-profile `db-init` service in `docker-compose.yml` (BS#951): CI's bare `node dev_env/init-db.mjs` invocation skips the clone regardless of whether the .sql file exists in the checkout. To refresh the clone, follow the recipe in the comment at the top of `dev_env/seed-clone.sql`.

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

**Schema-first rule:** a new public endpoint's request/response shape goes into `wxyc-shared/api.yaml` (the cross-repo SSOT whose codegen feeds this repo, dj-site, iOS, and Android) first, before or alongside the private TS type. `apps/backend/app.yaml` is Swagger-UI docs only — not a codegen source — so a shape that lives only there (or only as a private TS type) is invisible to SSOT consumers and the specs drift.

### Doc hygiene

CLAUDE.md is the always-loaded reference card; topic depth lives in `docs/*.md`. Three checks run in `.husky/pre-push` — two warn-only, one hard-fail:

- `npm run check:doc-budget` — **warn-only.** Warns if CLAUDE.md exceeds its char budget. When it fires, extract to `docs/` rather than growing CLAUDE.md.
- `npm run check:doc-rules` — **warn-only.** Surfaces `<!-- @rule -->` markers in `docs/*.md` that are stale (unenforced + old, enforced + verbose, or past `review-after`). Convention documented in [`docs/migrations.md`](docs/migrations.md#rule-annotation-convention).
- `npm run check:auth-tables-doc` — **hard-fail.** Enforces the sentinel-fenced `auth_*` table list in CLAUDE.md against every `.ts` file under `shared/database/src/` (BS#1581 tree walk; skips only `migrations/`). A mismatch is always a bug (see BS#1573 for the drift incidents that motivated it); do not paper over failures with `|| true` in the hook. If your diff legitimately changes the set of auth tables, edit the sentinel-fenced line in CLAUDE.md to match the schema.

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
- 30-second timeout per test
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

Hosted on EC2; CI/CD via GitHub Actions. Push to `main` auto-triggers `deploy-auto.yml`, which delegates to the reusable `deploy-base.yml`. `deploy-manual.yml` (`workflow_dispatch` with `target` + `version`) is the lever for re-deploying a specific tag or rolling back. Docker images built with `node:24-alpine`, stored in ECR.

**Cadence rule**: every merge already triggers an auto-deploy, but when a PR that touches `shared/database/src/migrations/**` merges, verify the auto-deploy succeeded — if it didn't, run Manual Build & Deploy within 24 hours. Migration-chain risk accumulates when deploys fail silently. See [`docs/deploy.md`](docs/deploy.md) for the 2026-05-04 wedge case study and the project-#26 hardening defenses.

## Relationship to Other Repos

- **[dj-site](https://github.com/WXYC/dj-site)** — React frontend that consumes this API
- **[@wxyc/shared](https://github.com/WXYC/wxyc-shared)** — Shared DTOs, auth client, validation. V2 flowsheet endpoints use `@wxyc/shared` types.
- **[library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup)** — Discogs metadata service with 3-tier caching. All Discogs access (proxy endpoints, metadata enrichment, track search, artwork discovery) routes through LML via `LIBRARY_METADATA_URL`. The backend makes no direct Discogs API calls.
- **[tubafrenzy](https://github.com/WXYC/tubafrenzy)** — Legacy Java system this service is replacing. Both read/write the same underlying data.
