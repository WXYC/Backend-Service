# rotation-artist-backfill

Daily cron job that refreshes LML's artist cache rows for artists credited on releases currently in BS rotation. Closes [BS#1361](https://github.com/WXYC/Backend-Service/issues/1361).

## Why this exists

LML's monthly Discogs cache rebuild populates `artist.profile`, `artist_alias`, `artist_name_variation`, `artist_member`, and `artist_url` from the Discogs artists dump. Existing rows in LML's cache that pre-date the rebuild keep their stub values (mostly NULL `profile`) until the next monthly rebuild lands. For artists most-visible to users — those credited on releases currently in rotation — that's an unnecessarily long fix-to-visibility delay.

This cron targets the user-visible loop (DJs see the same rotation artists repeatedly) and cuts the backfill from ~190k Discogs calls to roughly hundreds.

## Mechanism

Two-tier loop:

```
for release_id in active_rotation_release_ids():
  release = GET {LIBRARY_METADATA_URL}/api/v1/discogs/release/{release_id}
  for artist_id in extract_phase1(release):
    GET {LIBRARY_METADATA_URL}/api/v1/discogs/artist/{artist_id}
```

Both endpoints route through LML's fallthrough seam. The artist endpoint hits the `fetched_at`-based stub discriminator landed in [LML#503](https://github.com/WXYC/library-metadata-lookup/pull/503): a row with `fetched_at IS NULL` is treated as a cache miss, so `_api_fetch` + write-back fires transparently and the next call to that endpoint returns the rich profile. [LML#510](https://github.com/WXYC/library-metadata-lookup/pull/510) tombstones 404s, so re-runs become pure PG hits — even for artists whose Discogs entry is gone.

### Phase 1 scope

Main-credit artists only — the `release.artists` array and the singular `release.artist_id`. `extra_artists` (producers, engineers) and per-track artists on VA comps are out of scope; Phase 2 will iterate `release.tracklist[*].artists` once we've measured how much of active rotation is VA. See the issue's "VA scope" section.

## Deploy gate

The job aborts unless LML's `/health` returns a `commit_sha` that is `3e54907` (LML#503) or a descendant of it. Without that discriminator, this cron is a no-op — every call hits the stub row, succeeds, and we never write back the rich data. See `deploy-guard.ts`.

Local dev: set `LOCAL_DEV=1` to skip the gate when `commit_sha` is null (Railway only injects `RAILWAY_GIT_COMMIT_SHA` in deployed environments).

## Configuration

| Env var                       | Default    | Purpose                                                                                                                                                                    |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`        | (required) | LML base URL.                                                                                                                                                              |
| `LML_API_KEY`                 | (required) | Bearer token for LML's `_lml_protected` endpoints. Required in staging/prod (matches sibling backfill jobs); `LOCAL_DEV=1` is the BS-side escape hatch for dev/CI.         |
| `BACKFILL_LML_MAX_CONCURRENT` | `3`        | Local semaphore + orchestrator concurrency.                                                                                                                                |
| `BACKFILL_LML_RATE_PER_MIN`   | `20`       | Token bucket refill rate per minute.                                                                                                                                       |
| `DRY_RUN`                     | unset      | When `1`/`true`/`True`/`TRUE`: enumerate release + artist cardinality, skip artist calls.                                                                                  |
| `LOCAL_DEV`                   | unset      | When `1`: permits null `commit_sha` on `/health` AND skips the `LML_API_KEY` pre-flight check (single dev/CI escape hatch for both gates).                                 |
| `GITHUB_TOKEN`                | unset      | Sent on the GitHub compare API call for the deploy gate (60→5000 req/h tier).                                                                                              |
| `SENTRY_DSN`                  | unset      | When set, observability + error capture surface. The `${JOB_NAME}.run` parent span, per-call `lml.get_*` spans, and the `${JOB_NAME}.run.totals` summary span all need it. |
| `SENTRY_RELEASE`              | unset      | Forwarded to `Sentry.init` so issues group by deploy.                                                                                                                      |
| `SENTRY_TRACES_SAMPLE_RATE`   | `0`        | Default 0 means spans are **not** sent. Set to `1` (or a fraction) for the totals span and the per-call `op:http.client` spans to surface in Sentry / OTLP dashboards.     |

Rate-limit ceiling defaults pair with LML's own per-replica `discogs_rate_limit=50` cap: this cron caps **attempted** egress at 20 req/min (failed calls also consume a token), so foreground LML traffic gets at least 30 req/min of headroom during the run window.

### Known caveat: BS-side timeout < LML's retry budget

The shared `@wxyc/lml-client.lmlFetch` enforces a 30 s timeout on every LML call, and `getRelease`/`getArtistDetails` do not currently accept a `timeoutMs` override (unlike `lookupMetadata`). LML server-side can hold a Discogs round-trip up to ~62 s during a 429-retry storm (`discogs_max_retries=5`, jittered exponential capped at 60 s). So a BS-side 30 s timeout can return `kind: 'error'` while LML's background completes and writes back the row — the next day's run picks it up as a PG hit. Counters undercount the actual back-fill rate during 429-heavy windows; fix is to thread `timeoutMs`/`budgetMs` through the lml-client release/artist endpoints (out of scope for this PR).

## Run procedure

- **Production**: registered via the BS deploy-base machinery. The `cron-schedule` field in `package.json` is picked up by `scripts/resolve-cron-schedule.sh` at deploy time. Schedule: `30 4 * * *` UTC — between artist-search-alias-consumer (`15 4`) and flowsheet-metadata-backfill (`0 6`).
- **Manual one-shot on EC2**:
  ```
  docker run --rm --env-file .env <image> 2>&1 | tee rotation-artist-backfill.log
  ```
- **Dry-run** (no artist calls fire):
  ```
  docker run --rm --env-file .env -e DRY_RUN=true <image>
  ```

## Verification

After a run, every in-scope artist id should have a row in LML's PG cache with `fetched_at` non-NULL. A re-run is the smoke test: total `artists_attempted` stays the same, but `artists_ok + artists_not_found` should equal `artists_attempted` (no live API egress).

## Files

- `job.ts` — entry point + run lifecycle.
- `deploy-guard.ts` — `/health` + GitHub compare gate.
- `query.ts` — SELECT for active rotation release ids.
- `lml-fetch.ts` — typed wrappers over the LML release + artist endpoints.
- `lml-limiter.ts` — concurrency + rate-limit gate.
- `orchestrate.ts` — two-tier loop + counters.
- `logger.ts` — JSON logs + Sentry init.
