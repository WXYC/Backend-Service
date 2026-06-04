# Environment Variables

Full reference. CLAUDE.md links here. Variables marked _required_ have no default; the service refuses to start without them.

## Backend Service (`apps/backend`)

- `PORT` (default `8080`)
- `CI_PORT` (default `8081`)
- `ROM_INTERNAL_KEY` _required for `/internal/banned-fingerprints`_ — Shared secret matched against the `X-Internal-Key` header on the `/internal/banned-fingerprints` CRUD surface (BS#1261). Distinct from `ETL_NOTIFY_KEY` so rotating one doesn't disrupt the other — different caller (request-o-matic), different blast radius. The CRUD endpoints reject the request when the header value doesn't match. Note: the read-only sibling `POST /auth/check-request-ban` is intentionally public — callers authenticate per-request via JWT and/or X-Device-Fingerprint, and per-IP rate limiting on the path bounds DoS risk. Generate with `openssl rand -base64 32`.
- `MUTATION_4XX_METRICS_DISABLED` (default unset / enabled) — Set to `true` to short-circuit the `apps/backend/middleware/responseMetrics.ts` middleware that emits the `WXYC/BackendService` `MutationClientError` CloudWatch metric for `POST/PATCH/DELETE /flowsheet/*` responses with `400 ≤ status < 500` (replacement signal post-#691, since Sentry no longer auto-captures 4xx). Disable in CI / local dev where AWS credentials aren't present so a noisy `PutMetricData` rejection doesn't pollute logs. The middleware is otherwise self-clamping (in-memory ring buffer flushed every 30s or every 10 errors, whichever comes first; `PutMetricData` failures are logged + swallowed and never block the response).
- `SSE_METRICS_DISABLED` (default unset / enabled) — Set to `true` to short-circuit the `apps/backend/services/sse/sse-metrics.ts` module that emits the `WXYC/BackendService` `SSE/ClientCount` (gauge), `SSE/EventsBroadcast` (counter), and `SSE/BroadcastFailures` (counter) CloudWatch metrics. `ClientCount` and `BroadcastFailures` ship both a dimensioned per-`Topic` series and a dimensionless companion (alarm input) per the org's "CloudWatch Metric & Alarm Conventions" rule; `EventsBroadcast` ships dimensioned only. Disable in CI / local dev where AWS credentials aren't present. The module is otherwise self-clamping (in-memory counter buffer flushed every 60s or every 100 events, whichever comes first; `PutMetricData` failures are logged + swallowed). The interval is overridable via `SSE_METRICS_INTERVAL_MS` for testing.
- `SSE_METRICS_INTERVAL_MS` (default `60000`) — Periodic tick for the SSE metrics module's counter flush + `ClientCount` gauge snapshot. Lower for development against a CloudWatch endpoint that costs nothing in test; leave at the default in production so PutMetricData volume stays bounded.

## Database (`shared/database`)

- `DB_HOST`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` _required_
- `DB_PORT` (default `5432`)
- `CI_DB_PORT` (default `5433`)
- `WXYC_SCHEMA_NAME` (default `wxyc_schema`)
- `DB_STATEMENT_TIMEOUT_MS` (default `5000` / 5s) — Server-enforced per-statement timeout on every postgres-js connection. Backend and auth inherit the default — any HTTP-handler query that runs longer than 5s is by definition an orphan (Express's request timeout has already fired). ETLs override to `300000` (5 min) in their Dockerfiles because their bulk passes can legitimately take tens of seconds. Backfills override similarly. Set `0` to disable (use only for unit-test fixtures).
- `DB_APPLICATION_NAME` (default `wxyc-backend`) — Sets `application_name` on the postgres connection so `pg_stat_activity` makes the source obvious during incident triage. Each Dockerfile overrides this with its own service name (`wxyc-backend`, `wxyc-auth`, `wxyc-flowsheet-etl`, etc.).
- `DB_SYNCHRONOUS_COMMIT` (default `on`) — Per-connection `synchronous_commit` setting. Default `on` preserves Postgres's full durability guarantee for the API and ETLs. Bulk backfills set this to `off` in their Dockerfile so each per-batch COMMIT returns as soon as the WAL is in the OS buffer, rather than waiting for fsync. Safe because backfills are idempotent (`WHERE col IS NULL` filters naturally resume any work lost to an RDS crash). Accepted values: `on`, `off`, `local`, `remote_write`, `remote_apply`.
- `BACKFILL_BATCH_SIZE` (default `5000`, used by `flowsheet-dj-name-backfill`) — Rows updated per individually-committed UPDATE inside the backfill loop. The default keeps each batch well under the per-statement timeout on a healthy host. Operators can pass e.g. `BACKFILL_BATCH_SIZE=20000` at `docker run -e ...` when the prod instance has IOPS headroom and async commit is in play — larger batches amortize per-tx overhead and reduce the number of trigger-firing dispatches.
- `LIVE_ACTIVITY_LOOKBACK_SECONDS` (default `60`, used by `flowsheet-metadata-backfill`) — Cooperative-pause lookback for the `flowsheet` track-insert probe. Before each batch the orchestrator queries the partial index from migration 0050 (`add_time DESC WHERE entry_type='track'`) for any row added within this window; a hit means a DJ is actively managing the playout and the batch is deferred. Set `0` to disable the probe entirely (catch-up runs).
- `LIVE_ACTIVITY_PAUSE_MS` (default `30000` / 30 s, used by `flowsheet-metadata-backfill`) — Sleep between cooperative-pause re-probes when activity is detected. There's no defer cap; the cron's outer `timeout` is the effective ceiling and the next run resumes via the `metadata_attempt_at IS NULL` predicate.
- `WARM_LIVE_ACTIVITY_LOOKBACK_SECONDS` (default `60`, used by `apps/backend/services/rotation-tracks-cache-warm.service.ts`, #1240) — Same shape as `LIVE_ACTIVITY_LOOKBACK_SECONDS` but for the rotation-tracks-cache-warm boot walker. Separate env var so operators can disable one without the other (`0` = disable). Walker also enforces `PER_ROW_PAUSE_BUDGET_MS` (hardcoded 10 min) so a single stuck row can't consume the whole `WARM_PASS_BUDGET_MS` (30 min) on a long continuous show.
- `BACKFILL_CRON_SCHEDULE` (deploy-time variable, used only by `flowsheet-metadata-backfill`) — Optional override for the cron schedule installed on the EC2 host. Set as a GitHub Actions repository variable (Settings → Variables → Actions, not Secrets — the cadence is not sensitive). If unset or empty, the deploy reads the `cron-schedule` field from `jobs/flowsheet-metadata-backfill/package.json` (currently `0 6 * * *`, 06:00 UTC daily) — same behavior as before BS#914. The override scope is narrow on purpose: only this job consults the var, so a stale value can't fan out across the deploy matrix. Resolution lives in `scripts/resolve-cron-schedule.sh`; takes effect on the next run of `Manual Build & Deploy` or `Auto Build & Deploy` targeting `flowsheet-metadata-backfill`. Use case: dial the cadence up for the C6 retune (Epic C, [#895](https://github.com/WXYC/Backend-Service/issues/895)) without a code-change deploy.
- `ALBUM_PLAYS_REFRESH_INTERVAL_MS` (default `3600000` / 1 hour) — Cadence at which `apps/backend/services/album-plays-refresh.service.ts` rebuilds the `album_plays` materialized view that feeds the catalog search ranker.
- `ALBUM_PLAYS_REFRESH_TIMEOUT_MS` (default `300000` / 5 min) — Per-statement timeout for the refresh's dedicated postgres-js client (`max: 1`, `application_name = wxyc-album-plays-refresh`). The API container's connection-level `DB_STATEMENT_TIMEOUT_MS=5000` is too tight for `REFRESH MATERIALIZED VIEW CONCURRENTLY` on prod, but loosening it globally would defeat the orphan-query protection it exists for. The dedicated client sidesteps that by carrying its own `statement_timeout` while the shared pool keeps the tight default. Set to a positive integer; non-numeric or non-positive values fall back to the default.
- `ALBUM_METADATA_BACKFILL_VERIFY_TIMEOUT_MS` (default `120000` / 120 s, used by `jobs/album-metadata-backfill`) — `SET LOCAL statement_timeout` applied inside the transaction that runs the post-INSERT dual-count verify. The partial index from [#660](https://github.com/WXYC/Backend-Service/pull/660) (`idx_flowsheet_metadata_drain`) covers the `metadata_attempt_at IS NULL` partition only; the verify walks the opposite `IS NOT NULL` partition (~2.6M rows, no covering index) and would otherwise trip the backend's 5 s default ([BS#1019](https://github.com/WXYC/Backend-Service/issues/1019) / [BS#1022](https://github.com/WXYC/Backend-Service/issues/1022)). Must be a positive integer (milliseconds); empty or unset falls back to the default; non-numeric or non-positive values raise at job startup rather than silently defaulting.

## better-auth (`apps/auth`)

- `BETTER_AUTH_URL` — e.g. `http://localhost:8082/auth`
- `BETTER_AUTH_JWKS_URL` — e.g. `http://localhost:8082/auth/jwks`
- `BETTER_AUTH_ISSUER` — e.g. `http://localhost:8082`
- `BETTER_AUTH_AUDIENCE` — e.g. `http://localhost:8082`
- `BETTER_AUTH_TRUSTED_ORIGINS` — Comma-separated CORS origins
- `FRONTEND_SOURCE` — Frontend origin for CORS and redirects

## Email (SES)

- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- `SES_FROM_EMAIL`
- `SES_CONFIGURATION_SET_NAME` — Configuration set passed on every `SendEmailCommand`. Optional. Production value: `my-first-configuration-set`. The `wxyc.org` domain identity lists this as its default, so sends from `hello@wxyc.org` (or any other `*@wxyc.org` without its own email-level identity) pick it up automatically. Passing it explicitly here is belt-and-suspenders against the identity-precedence trap — if a future email-level identity for the from address is added without the config set attached, the EventDestination would silently stop seeing OTP / verification / reset traffic, the trap BS#1070 fixed for the legacy `no-reply@wxyc.org` email-level identity.
- `PASSWORD_RESET_REDIRECT_URL`, `EMAIL_VERIFICATION_REDIRECT_URL`

### SES delivery events (`POST /internal/ses-events`)

- `SES_EVENTS_SNS_TOPIC_ARN` — ARN of the SNS topic that the `wxyc.org` SES Configuration Set publishes Send/Delivery/Bounce/Complaint/Reject/DeliveryDelay events to. The receiving route pins this ARN and rejects messages whose `TopicArn` does not match (signature validation also checks the AWS X.509 cert chain). Production value: `arn:aws:sns:us-east-1:203767826763:ses-delivery-events-prod`. Leave unset locally — the route returns 400 for every POST when the env var is missing, by design, so a missing config is observable rather than a startup crash.

The Backend container does not call SES, so no additional AWS credentials are needed for this route — SNS signature validation only requires the public cert fetched from SNS's `SigningCertURL`.

## Testing

- `AUTH_BYPASS` — Set `true` to skip JWT verification in tests
- `AUTH_USERNAME`, `AUTH_PASSWORD` — Test account credentials (when `AUTH_BYPASS=false`)
- `TEST_HOST` — Test server host

## Sentry

- `SENTRY_DSN` — Sentry project DSN (required for error reporting). Without this, Sentry silently disables itself.
- `SENTRY_RELEASE` — Set automatically by the deploy action to `<app>@<tag>`
- `SENTRY_TRACES_SAMPLE_RATE` — Per-process tracing sample rate, honored by both runtime API containers and per-job loggers. Defaults differ by consumer: runtime defaults to `1.0` (so HTTP transactions keep flowing post-#767), jobs default to `0` (so steady-state ETL runs don't pay the sampling overhead). Operators set this on `docker run --env-file .env -e SENTRY_TRACES_SAMPLE_RATE=<rate> ...` to downshift runtime sampling without a code change, or to flip a one-shot job pilot up to `1.0` for span/trace data (see #640). Malformed or out-of-range values fall back to the consumer's documented default. Consumers: `apps/auth/sentry-config.ts`, `apps/backend/sentry-config.ts`, `jobs/flowsheet-etl/logger.ts`, `jobs/flowsheet-metadata-backfill/logger.ts`.

### Observability tags (Phase A contract)

ETL/backfill jobs that opt into the Phase A observability contract emit JSON log lines on stdout (errors on stderr) and tag every Sentry event with the same four fields:

| Tag      | Value                                                        |
| -------- | ------------------------------------------------------------ |
| `repo`   | `Backend-Service`                                            |
| `tool`   | `<job-name> <subcommand>` (e.g. `flowsheet-etl incremental`) |
| `step`   | Per-call: `started`, `bulk-load-shows`, `failed`, etc.       |
| `run_id` | UUID generated at entrypoint init (one per process)          |

The wireup is per-job: see `jobs/flowsheet-etl/logger.ts` for the canonical pattern (issue #538). The shared Rust/Python `wxyc_etl::logger` foundation lives in the `wxyc-etl` repo and targets non-Node ETLs; Backend-Service mirrors the same tag contract directly so the dashboards in Sentry / log queries are uniform across runtimes. `SENTRY_DSN` is still optional — when unset the SDK no-ops and JSON logging continues to work.

> TODO (separate child task): provision `SENTRY_DSN` for the flowsheet-etl cron in EC2 / GitHub Actions secrets.

## Legacy mirror queue (`apps/backend/middleware/legacy/commandqueue.mirror.ts`)

Bounded ring-buffer reports written under `mirror-logs/`. Reports never include raw SQL — only length, sha256, and statement count.

- `MIRROR_FATAL_REPORTS_MAX` (default `10`) — Number of ring slots for fatal reports. Total disk = max × `MIRROR_REPORT_MAX_BYTES`.
- `MIRROR_FATAL_REPORTS_INTERVAL_MS` (default `900000` / 15 min) — Bucket width for the fatal ring index. Reports in the same bucket overwrite the same slot.
- `MIRROR_SECONDARY_REPORTS_MAX` (default `10`) — Same scheme for first-failure secondary reports. Set to `0` to disable secondaries.
- `MIRROR_SECONDARY_REPORTS_INTERVAL_MS` (default `600000` / 10 min) — Bucket width for secondary ring.
- `MIRROR_SECONDARY_REPORT_ON_ATTEMPT` (default `1`) — Attempt number that triggers a secondary report.
- `MIRROR_REPORT_MAX_BYTES` (default `65536` / 64 KiB) — Per-file JSON cap. Oversize payloads are replaced with a `truncated: true` summary.
- `MIRROR_PENDING_QUEUE_SUMMARIES_MAX` (default `20`) — Max number of pending-queue summaries embedded in a fatal report.

## Metadata Services

- `LIBRARY_METADATA_URL` — library-metadata-lookup base URL (e.g. `http://localhost:8001`). Required for proxy endpoints, metadata enrichment, and track search. All Discogs access is routed through LML. Do not include the `/api/v1` path prefix; the LML client adds it automatically.
- `LML_API_KEY` — Bearer token sent on every LML request. Must match LML's `LML_API_KEY`. Optional in dev; required in production once LML's `LML_REQUIRE_AUTH` is flipped to `true`. Injected at the single `lmlFetch` chokepoint in `@wxyc/lml-client` (`shared/lml-client/src/index.ts`).
- `LML_CLIENT_MAX_CONCURRENT` — Maximum concurrent in-flight `/api/v1/lookup` calls; gates BS's fan-out at the chokepoint so back-pressure surfaces on the BS side instead of queueing inside LML. Mirrors LML's `discogs_max_concurrent` (default `5`). Set lower in production to leave headroom for other LML callers (request-o-matic, tubafrenzy).
- `LML_CLIENT_RATE_PER_MIN` — Token-bucket refill rate (and capacity) for `/api/v1/lookup` calls per minute. Mirrors LML's `discogs_rate_limit` (default `50`). Tune downward in production to leave headroom for other LML callers.

### Backfill LML rate gating (`jobs/flowsheet-metadata-backfill`, `jobs/rotation-release-id-backfill`)

Stricter ceilings for backfill-class LML callers, since one in-flight LML call held for the full per-call timeout saturates LML's serialized Discogs fan-out and starves real-time iOS/dj-site clients (BS#994 / BS#995). The first two are read at module load by each job's `lml-limiter.ts:createLmlLimiter`; the third by `lml-fetch.ts`. All three are positive integers; non-positive or unparseable values fall back to the default with a `console.warn`. Mutating `process.env` after first import does NOT reconfigure the singletons — restart the container to change a value. Each job creates its own `defaultLmlLimiter` so the same env name applied to one container does not lock-step the other.

- `BACKFILL_LML_MAX_CONCURRENT` (default `1`) — Maximum concurrent in-flight backfill `/api/v1/lookup` calls. Tighter than runtime `LML_CLIENT_MAX_CONCURRENT=5` because backfills have no human-facing latency budget; serializing keeps blast radius bounded. The semaphore is belt-and-suspenders defense in case an orchestrator ever becomes concurrent.
- `BACKFILL_LML_RATE_PER_MIN` (default `20`) — Token-bucket refill rate (and capacity) for backfill LML calls per minute. Tighter than runtime `LML_CLIENT_RATE_PER_MIN=50` to leave headroom for real-time traffic.
- `BACKFILL_LML_PER_CALL_TIMEOUT_MS` (default `35000`) — Per-call abort budget. Sized to clear LML#370's 25.25 s per-item cascade-exhaustion cap (deployed to LML prod 2026-05-25) plus ~10 s of headroom for LML queue contention with the live backend + ROM. The prior 8000 ms default (BS#994, retro 2026-05-23) was set against the pre-LML#370 topology and aborted before LML could return its `{timeout:true, results:[]}` body for cascade-bait rows — those rows stayed `metadata_attempt_at IS NULL` and the cron re-failed them every pass. BS#1064 / BS#1180 empirical re-validation showed the 35 s budget lets that body reach the empty-results branch so rows drain as `enriched_no_match` instead of looping (per-row `lml_error` rate dropped from ~86% to ~23%). Steady-state floor is drained by BS#1199's planned retry cap. Mirrors BS#992's per-caller `timeoutMs` pattern for the rotation picker.

### Rotation Discogs release backfill (`jobs/rotation-release-id-backfill`)

One-shot ETL for BS#1029. Reuses `BACKFILL_LML_*` (above) and adds:

- `DRY_RUN` (default unset / `false`) — when `'true'` or `'1'`, the orchestrator skips every UPDATE and increments `rows_resolved_dry` instead of `rows_resolved`. Each planned write is still logged. Useful for confirming the candidate set before a real run; harmless to forget — the `discogs_release_id IS NULL` SELECT predicate is idempotent across reruns.

### Bulk backfill (`jobs/album-level-backfill`)

Knobs for the one-shot album-level historical backfill (BS#1041). Separate from `BACKFILL_LML_*` above because this job calls LML's bulk endpoint (`/api/v1/lookup/bulk`, LML#368), where the natural unit is the batch, not the row. Defaults are tuned to let this job run concurrently with the per-row drain cron without saturating LML's serial Discogs fan-out. All are positive integers; non-positive or unparseable values throw at job startup.

- `BACKFILL_BULK_BATCH_SIZE` (default `50`) — Items per LML bulk-lookup request. LML's hard cap is 100 (LML#368). 50 is a conservative compromise between roundtrip amortization (one HTTP roundtrip per N items vs. N roundtrips) and per-batch blast radius if a single Discogs cascade goes pathological.
- `BACKFILL_BULK_RATE_PER_MIN` (default `1`) — Batches per minute. At the default 50-item batch size this is 50 items/min sustained — comparable to the per-row cron's `BACKFILL_LML_RATE_PER_MIN=20` items/min plus headroom. The two jobs can run concurrently without contending on LML's serial Discogs fan-out (LML caps Discogs at 50/min globally). Raise to 2–4 for an overnight catch-up window when no other LML traffic is running.
- `BACKFILL_BULK_BUDGET_MS` (default `25000`) — Forwarded to LML as `X-Caller-Budget-Ms`. LML's per-item `perform_lookup` uses this as `min(header, LML_SEARCH_BUDGET_MS)` (A8 / LML#345). 25 s leaves headroom under the 30 s lml-client `AbortController` timeout for HTTP overhead + JSON encode/decode of a 50-item batch.
- `ALBUM_LEVEL_BACKFILL_POST_PASS_TIMEOUT_MS` (default `14400000` / 4 h) — `SET LOCAL statement_timeout` for the post-pass UPDATE that flips ~857k flowsheet rows from `metadata_status='pending'` to `enriched_match`. The 2026-05-23 drain-accel SQL flipped 309k rows in 80 min; 857k is ~3 h; 4 h gives a 30% margin. Scoped to the UPDATE's transaction only — does not affect any other statement on the same connection.
- `ALBUM_LEVEL_BACKFILL_READ_TIMEOUT_MS` (default `300000` / 5 min) — `SET LOCAL statement_timeout` for the enumerate scan over `flowsheet` and the per-batch `resolveAlbums` library + artists JOIN. The `metadata_status = 'pending'` predicate isn't covered by the partial index `idx_flowsheet_metadata_drain` (which covers `metadata_attempt_at IS NULL`), so the planner falls back to a seq scan + sort that exceeds the backend's default 5 s — verified empirically on the 2026-05-24 prod dry-run. 5 min covers observed timing with comfortable margin. Mirrors `album-metadata-backfill#verifyComplete`.

- `DISCOGS_API_KEY`, `DISCOGS_API_SECRET` — Served to dj-site via `/config/secrets` endpoint. Not used by the backend itself (Discogs access goes through LML).
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`

### Catalog track search

Feature flags for the 0-hit fallback cascade in `searchLibrary` (`apps/backend/services/library.service.ts`). When the primary tsvector + trigram search returns no rows, each enabled layer runs in order and the first non-empty result wins. Both default `false` so production behavior is unchanged until an operator opts in. Loaded by `apps/backend/config/catalogTrackSearch.ts`. Plan: [catalog-track-search](https://github.com/WXYC/wiki/blob/main/plans/catalog-track-search.md).

- `CATALOG_TRACK_SEARCH_CTA_ENABLED` (default `false`) — Track 1: probe the compilation-track-artist (CTA) fuzzy fallback so queries like `"Call Your Name"` match the track listed on a V/A compilation. Set `true` once Phase 1d audit shows healthy coverage.
- `CATALOG_TRACK_SEARCH_DISCOGS_ENABLED` (default `false`) — Track 2: probe LML's Discogs `/lookup` endpoint and bridge any matched releases back to library rows the CTA layer didn't already cover. Set `true` after Track 1 has soaked.

Strict-`true` gating: only the literal string `'true'` enables a layer. Any other value (including `1`, `TRUE`, missing) reads as `false`.

## Slack

- `SLACK_WXYC_REQUESTS_APP_ID`, `SLACK_WXYC_REQUESTS_CLIENT_ID`
- `SLACK_WXYC_REQUESTS_CLIENT_SECRET`, `SLACK_WXYC_REQUESTS_SIGNING_SECRET`
- `SLACK_WXYC_REQUESTS_WEBHOOK` — Webhook path (e.g. `/services/T00000/B00000/XXXX`)
- `SLACK_WEBHOOK_URL` — Base URL override for Slack webhook (e.g. `http://mock-api:9090`). When set, uses `fetch()` instead of `https.request` to `hooks.slack.com`. Used in CI to route webhooks to the mock API server.

## ETL Jobs

The library ETL (`scripts/run-library-etl.sh`) syncs the music library from the legacy MySQL database into PostgreSQL. The flowsheet ETL (`jobs/flowsheet-etl/`) syncs flowsheet entries and shows from tubafrenzy. The rotation ETL (`jobs/rotation-etl/`) syncs rotation releases from tubafrenzy. All three require the standard database variables above plus these for SSH tunneling to the legacy server:

- `SSH_HOST` — Hostname of the legacy server
- `SSH_USERNAME` — SSH login username
- `SSH_PASSWORD` — SSH login password
- `REMOTE_DB_HOST` — MySQL host on the legacy server (typically `localhost` from inside the tunnel)
- `REMOTE_DB_USER` — MySQL username
- `REMOTE_DB_PASSWORD` — MySQL password
- `REMOTE_DB_NAME` — MySQL database name

The flowsheet ETL supports two run modes: one-shot (`npm start`) for cron invocation, and continuous polling (`npm run start:poll` or `node dist/job.js --poll`) for real-time sync. In polling mode, it queries tubafrenzy every `ETL_POLL_INTERVAL_MS` (default 30 seconds) for new or modified entries and upserts them into PostgreSQL. After importing changes, it notifies the Backend-Service via `POST /internal/flowsheet-sync-notify` so connected dj-site clients receive an SSE refetch event.

- `ETL_POLL_INTERVAL_MS` — Poll interval in milliseconds (default `30000`)
- `BACKEND_SERVICE_URL` — Backend-Service URL for SSE notifications (default `http://localhost:8080`)
- `ETL_NOTIFY_KEY` — Shared secret for internal endpoints: ETL sync notification and tubafrenzy webhook (required in production)

The rotation ETL supports the same two run modes as the flowsheet ETL: one-shot (`npm start`) for cron invocation, and continuous polling (`npm run start:poll` or `node dist/job.js --poll`) for real-time sync. In polling mode, it queries tubafrenzy every `ETL_POLL_INTERVAL_MS` for new or modified rotation releases and upserts them into PostgreSQL. It uses the same SSH tunnel, `ETL_POLL_INTERVAL_MS`, `BACKEND_SERVICE_URL`, and `ETL_NOTIFY_KEY` variables as the flowsheet ETL. After importing changes, it notifies the Backend-Service via `POST /internal/rotation-sync-notify`.

The artist identity ETL (`jobs/artist-identity-etl/`) populates the six reconciled-identity columns on `artists` (`discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`, `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id`) from library-metadata-lookup's `entity.identity` PostgreSQL table. Unlike the flowsheet/rotation ETLs, it does not use the SSH tunnel: it reads directly from the discogs-cache PostgreSQL database via `DATABASE_URL_DISCOGS`. Update strategy is null-fill only — existing non-null values are never overwritten, so any value entered by library staff wins over an LML-derived one. Conflicts (existing non-null differs from LML's value) are logged but skipped. Supports the same one-shot / `--poll` modes as the other ETLs.

- `DATABASE_URL_DISCOGS` — PostgreSQL URL for LML's discogs-cache database, where `entity.identity` lives. Required for the artist-identity ETL.

### One-shot backfill jobs

One-shot backfill jobs under `jobs/*-backfill/` run via `Manual Build & Deploy` and `docker run`. They share a small set of operator knobs:

- `BATCH_SIZE` — Rows fetched per SELECT cursor batch (default `500`, capped at `1000` for `library-identity-consumer` to match LML's bulk-resolve cap). Used by `library-identity-consumer`. Other backfills accept the variant `BACKFILL_BATCH_SIZE` (`flowsheet-metadata-backfill`, `flowsheet-dj-name-backfill`); the existing variant is preserved in those jobs for log-tail compatibility.
- `THROTTLE_MS` — Inter-batch sleep, milliseconds (default `100`). Used by `library-identity-consumer`. The variant `BACKFILL_THROTTLE_MS` is what `flowsheet-metadata-backfill` accepts; same purpose.
- `PARTITION_INDEX`, `PARTITION_COUNT` — N-container parallel deploy. Each partition processes rows where `id % PARTITION_COUNT = PARTITION_INDEX`. Default is `0/1` (single container, no-op). Used by `library-identity-consumer`, `library-canonical-entity-backfill`, `flowsheet-metadata-backfill`.
- `STALE_THRESHOLD_DAYS` — Days before a `library_identity` row is re-fetched by `library-identity-consumer` (default `7`). The SELECT predicate includes rows whose `library_identity.last_verified_at` is older than this threshold.
- `LIBRARY_METADATA_URL`, `LML_API_KEY` — LML base URL (required) and bearer token for `library-identity-consumer`'s `bulk-resolve-libraries` POST. Trailing `/api/v1` is stripped; bearer is sent as `Authorization: Bearer …` only when the env var is set. LML enforces auth in production.
- `DRY_RUN` — Locked truthy values: `true`, `1`, `TRUE`. When set, `library-identity-consumer` still calls LML (so resolve / unresolved / error counts are honest predictions) but suppresses all DB writes; emits a single JSON object on stdout with the locked schema documented in `jobs/library-identity-consumer/README.md`. Other backfills do not currently honor this flag.
- `WXYC_SCHEMA_NAME` — PostgreSQL schema name (default `wxyc_schema`). Override only for parallel Jest workers / integration test harnesses; production sticks with the default.

Job-specific backfill knobs are documented in each job's README.

## Cross-cache-identity feature flags (canonical inventory)

This is the **single source of truth** for the cross-cache-identity project's feature flags (plan §4.2). Consumer repos cross-reference this section in their own `.env.example` / CLAUDE.md. When a flag is renamed or its default changes, both the canonical entry here AND the consumer repo's local doc must update in the same PR.

The naming convention is asymmetric on purpose: `*_USE_NEW_HOOK_*` (LML, semantic-index, per-cache) toggles which `wxyc_library` hook table the consumer reads. `BS_USE_LIBRARY_IDENTITY*` (Backend, global) toggles whether Backend reads/writes the new `library_identity` table at all. A unified prefix would be misleading — the LML/SI flags pick a hook to read; the BS flags toggle a brand-new schema.

**Cache repos do NOT use these flags.** `discogs-etl`, `musicbrainz-cache`, and `wikidata-cache` write to BOTH the legacy and new hook tables unconditionally during the dual-run window. Per §4.2: feature flags fit live request paths (LML, SI, Backend); cache loaders are batch ETLs and roll back via redeploy of the prior image. Cache repos therefore intentionally have no cross-cache-identity flags to document.

| Flag                                 | Owning repo             | Scope     | Default | Set true when                                                                      |
| ------------------------------------ | ----------------------- | --------- | ------- | ---------------------------------------------------------------------------------- |
| `LML_USE_NEW_HOOK_DISCOGS`           | library-metadata-lookup | per-cache | `false` | Docker discogs cache parity-check passes 7 consecutive days                        |
| `LML_USE_NEW_HOOK_DISCOGS_FULL`      | library-metadata-lookup | per-cache | `false` | Homebrew (full) discogs cache parity-check passes 7 consecutive days               |
| `LML_USE_NEW_HOOK_MUSICBRAINZ`       | library-metadata-lookup | per-cache | `false` | musicbrainz cache parity-check passes 7 consecutive days                           |
| `LML_USE_NEW_HOOK_WIKIDATA`          | library-metadata-lookup | per-cache | `false` | wikidata cache parity-check passes 7 consecutive days                              |
| `SI_USE_NEW_HOOK_DISCOGS`            | semantic-index          | per-cache | `false` | LML cuts over for that cache + 7 days clean                                        |
| `SI_USE_NEW_HOOK_MUSICBRAINZ`        | semantic-index          | per-cache | `false` | (same — per cache)                                                                 |
| `SI_USE_NEW_HOOK_WIKIDATA`           | semantic-index          | per-cache | `false` | (same — per cache)                                                                 |
| `BS_USE_LIBRARY_IDENTITY`            | Backend-Service         | global    | `false` | All four caches cut over (LML + semantic-index both on new hook)                   |
| `BS_USE_LIBRARY_IDENTITY_WRITES`     | Backend-Service         | global    | `false` | After 30-day dual-run with `BS_USE_LIBRARY_IDENTITY=true` reads showing clean      |
| `LML_MANUAL_OVERRIDE_CHECK_DISABLED` | library-metadata-lookup | global    | `false` | Emergency rollback only — disables the §3.2.2.1 manual-override skip endpoint call |

**Backend phase state machine** (the two BS flags compose to define four behavioral states):

| Phase                            | `BS_USE_LIBRARY_IDENTITY` | `BS_USE_LIBRARY_IDENTITY_WRITES` | Reads                                                  | Writes                                                    |
| -------------------------------- | ------------------------- | -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| 1 — substrate landed, no use     | false                     | false                            | `canonical_entity_id` columns only                     | `canonical_entity_id` columns only (new writer gated off) |
| 2 — read new, write legacy       | true                      | false                            | `library_identity` with `canonical_entity_id` fallback | `canonical_entity_id` columns only                        |
| 3 — read new, write both         | true                      | true                             | (same as Phase 2)                                      | DUAL-WRITE in one DB transaction                          |
| 4 — drop legacy (post §4 step 5) | true                      | true                             | `library_identity` only                                | `library_identity` only                                   |

**Flag mechanism (locked):** all flags above are environment variables read via the standard per-language pattern (`process.env.X` in Node.js, `os.getenv()` in Python). No application-level config singleton or feature-flag service. Each repo's `.env.example` (or CLAUDE.md, where `.env.example` doesn't apply) documents the local flags.

**Production locations and approval gates** (per §4.2 rollout checklist):

| Flag                                 | Production location                                  | Updater                                                       | Approval gate                                                    |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `LML_USE_NEW_HOOK_*`                 | Railway environment variables for the LML service    | Jake via Railway dashboard                                    | 7 consecutive days of clean parity-check audit (E5 daily report) |
| `SI_USE_NEW_HOOK_*`                  | EC2 systemd unit env file                            | Jake via SSH + edit env file + restart                        | LML for that cache cut over for 7 days                           |
| `BS_USE_LIBRARY_IDENTITY`            | EC2 backend container env (`.env` mounted at deploy) | Jake via SSH + edit `.env` + `docker compose restart backend` | All 4 caches cut over (LML + SI both on new hook for all caches) |
| `BS_USE_LIBRARY_IDENTITY_WRITES`     | (same)                                               | (same)                                                        | 30-day clean dual-run with `BS_USE_LIBRARY_IDENTITY=true`        |
| `LML_MANUAL_OVERRIDE_CHECK_DISABLED` | Railway environment variables                        | Jake via Railway dashboard                                    | Used only for emergency rollback (no scheduled flip)             |

**No automation flips production flags.** The audit job (E5) reports when a gate's preconditions are met (e.g., `LML_USE_NEW_HOOK_DISCOGS eligible: 7 days clean since 2026-05-15`); Jake then chooses to flip. This matches the project's no-auto-default principle (§4 step 0).

**Sync mechanism (CI grep-assert, per repo):** every repo that documents one or more flags ships a CI check that asserts (a) every flag named in this canonical table appears in the consumer's local doc, and (b) every flag named in the consumer's local doc appears here. The Backend-side script is `scripts/check-cross-cache-identity-flags.sh`; it runs in the existing CI pipeline (`.github/workflows/test.yml`) as a `Cross-cache-identity flag-doc consistency` job. A second-tier check (every flag named in code matches the doc) ships with the E2-BS substrate PR, since the code references don't exist yet at this PR's open time.

**Audit (post-launch).** A quarterly task tracked under `cross-cache-identity-followup` diffs the canonical Backend list against actual code references in each consumer repo.
