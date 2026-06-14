# rotation-artist-backfill

Daily cron job that warms LML's release + artist caches for every release in BS rotation, keyed by stable `entity.release_identity.id`. Closes [BS#1381](https://github.com/WXYC/Backend-Service/issues/1381); supersedes the Discogs-specific iteration that closed [BS#1361](https://github.com/WXYC/Backend-Service/issues/1361) (PR #1376).

## Why this exists

LML's monthly Discogs cache rebuild populates `artist.profile`, `artist_alias`, `artist_name_variation`, `artist_member`, and `artist_url` from the Discogs artists dump. Existing rows in LML's cache that pre-date the rebuild keep their stub values (mostly NULL `profile`) until the next monthly rebuild lands. For artists most-visible to users — those credited on releases currently in rotation — that's an unnecessarily long fix-to-visibility delay.

This cron targets the user-visible loop (DJs see the same rotation artists repeatedly) and cuts the backfill from ~190k Discogs calls to roughly hundreds.

The BS#1381 iteration moves the input key from `rotation.discogs_release_id` to `rotation.lml_identity_id` so the cron is source-agnostic — LML maps each identity to its per-source `(source, external_id)` pairs and dispatches the refresh. New sources (MusicBrainz, Bandcamp, Spotify, Apple Music) light up transparently as LML wires them, without a BS-side change.

## Mechanism

One-tier batched loop:

```
for batch in chunk(active_rotation_identity_ids(), LML_REFRESH_BATCH_CAP):
  POST {LIBRARY_METADATA_URL}/api/v1/cache/refresh-for-identities
       { "identity_ids": batch }
```

LML's [`/api/v1/cache/refresh-for-identities`](https://github.com/WXYC/library-metadata-lookup/issues/525) (LML#525) does the work internally:

1. Maps each `identity_id` to its per-source `(source, release_external_id)` pairs via `entity.release_identity`.
2. Dispatches per-source release-cache refresh. Today only the `discogs_release` leg is wired; other sources return `release_outcome = "not_implemented"`.
3. Walks each refreshed Discogs release's `artists[*].artist_id` (with the `artist_id > 0` sentinel guard) and refreshes the per-artist cache.

All of this multiplexes onto LML's fallthrough seam — [LML#503](https://github.com/WXYC/library-metadata-lookup/pull/503)'s `fetched_at` discriminator means already-warm rows don't re-hit Discogs, and [LML#510](https://github.com/WXYC/library-metadata-lookup/pull/510)'s 404 tombstones make re-runs steady-state PG hits.

### Per-id status semantics

| `status`          | Meaning                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warmed`          | At least one source's `release_outcome` was `success` (cache hit, fresh fetch, or tombstone). Cache state is current.                                                   |
| `not_found`       | No row in `entity.release_identity` for this id — BS holds a stale `lml_identity_id` reference. **This is the corruption signal** the BS#1402 alert keys on.            |
| `not_implemented` | At least one source returned `not_implemented`, no source was `success`. Today's `discogs_master`-only / MusicBrainz / Bandcamp / Spotify / Apple Music rows fall here. |
| `error`           | All dispatched sources errored. The only retry signal.                                                                                                                  |

### Batch size

`LML_REFRESH_BATCH_CAP = 50` is a HARD constant, not an env-tunable. LML returns HTTP 400 on batches above 50. The cap is derived from `discogs_rate_limit` × cold-cache fan-out ≤ Railway's request-timeout ceiling:

- 50 ids × (~1 release + ~3 artists per release) ≈ 200 Discogs calls per batch
- At LML's `discogs_rate_limit=50/min`, that's ~4 min wall-clock cold-cache → fits Railway's ~5 min request timeout
- A 200-id cap (the original sketch) would yield ~16 min cold-cache → structurally infeasible

Recalibration only lands alongside an ingress change (CDN insertion, replica scale-up, Railway timeout change). We do not expose a `BACKFILL_LML_BATCH_SIZE` env override; raising it would only ever produce 400s, and lowering it has no operational lever to pull (concurrency + rate-per-minute are the cron-side tunables for that).

## Deploy gate

The job aborts unless LML's `/health` returns a `commit_sha` that is `8a1344c` (LML PR [#559](https://github.com/WXYC/library-metadata-lookup/pull/559), the feat PR that shipped LML#525) or a descendant of it. Without that commit, `POST /api/v1/cache/refresh-for-identities` returns 404 and every batch fails. See `deploy-guard.ts`.

Local dev: set `LOCAL_DEV=1` to skip the gate when `commit_sha` is null (Railway only injects `RAILWAY_GIT_COMMIT_SHA` in deployed environments).

## Configuration

| Env var                       | Default    | Purpose                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`        | (required) | LML base URL.                                                                                                                                                                                                                                                                                                                                                       |
| `LML_API_KEY`                 | (required) | Bearer token for LML's `_lml_protected` endpoints. Required in staging/prod (matches sibling backfill jobs); `LOCAL_DEV=1` is the BS-side escape hatch for dev/CI.                                                                                                                                                                                                  |
| `BACKFILL_LML_MAX_CONCURRENT` | `3`        | Local semaphore + orchestrator concurrency. Each in-flight batch can fan out internally on LML's side to ~200 Discogs calls cold-cache.                                                                                                                                                                                                                             |
| `BACKFILL_LML_RATE_PER_MIN`   | `20`       | Token bucket refill rate per minute — **applied to batch calls, not Discogs egress**. With batches of up to 50, this leaves the per-replica `discogs_rate_limit=50/min` budget shared between this cron and runtime LML callers (verify steady-state runtime req/min in Sentry before sizing).                                                                      |
| `DRY_RUN`                     | unset      | When `1`/`true`/`True`/`TRUE`: enumerate identity cardinality, skip refresh calls.                                                                                                                                                                                                                                                                                  |
| `LOCAL_DEV`                   | unset      | When `1`: permits null `commit_sha` on `/health` AND skips the `LML_API_KEY` pre-flight check (single dev/CI escape hatch for both gates).                                                                                                                                                                                                                          |
| `GITHUB_TOKEN`                | unset      | Sent on the GitHub compare API call for the deploy gate (60→5000 req/h tier).                                                                                                                                                                                                                                                                                       |
| `SENTRY_DSN`                  | unset      | When set, observability + error capture surface. The `${JOB_NAME}.run` parent span, per-batch `lml.refresh_for_identities` spans, and the `${JOB_NAME}.run.totals` summary span all need it.                                                                                                                                                                        |
| `SENTRY_RELEASE`              | unset      | Forwarded to `Sentry.init` so issues group by deploy.                                                                                                                                                                                                                                                                                                               |
| `SENTRY_TRACES_SAMPLE_RATE`   | `0`        | Default 0 means spans are **not** sent. Gates all spans this job emits: the `op:job.run` parent span (and its catch-block error status — so span-status-based error-rate alerts only fire at non-zero sample rate), the `op:http.client` per-batch spans, and the `${JOB_NAME}.run.totals` summary. `captureException` issue events fire regardless of sample rate. |

### Rate-limit recalibration

The new endpoint fans out internally, so one BS-side call can spawn many Discogs calls. LML enforces `discogs_max_concurrent=5` and `discogs_rate_limit=50/min` per replica **across every concurrent LML caller** (runtime enrichment via `lookupMetadata`, picker resolution via `getRotationTracksFromRelease`, this cron). All callers share the same per-replica budget.

The `BACKFILL_LML_RATE_PER_MIN=20` default targets ~30/min for the cron alone, leaving ~20/min for runtime callers — verify steady-state runtime Discogs req/min in Sentry before changing.

**Pre-merge load-test methodology** (`load-test-runbook.md` — TBD):

1. Snapshot production rotation count → expected batch count = `ceil(N_identities / 50)`.
2. Run `npm run start` against staging LML with `BACKFILL_LML_RATE_PER_MIN=<target>` and `BACKFILL_LML_MAX_CONCURRENT=<target>`.
3. Generate a synthetic runtime-caller baseline against staging LML at the production steady-state req/min.
4. Verify Discogs req/min observed at LML stays under `discogs_rate_limit=50` per replica.
5. Record the chosen numbers and reasoning here.

### Known caveat: BS-side timeout < LML's cold-cache batch wall-clock

The shared `@wxyc/lml-client.lmlFetch` defaults to a 30 s timeout and `refreshForIdentities` does not yet thread a `timeoutMs` override through the cron. LML server-side can hold a cold-cache 50-id batch up to ~4 min while Discogs rate-limit drains. So a BS-side 30 s timeout can return `kind: 'error'` while LML's background completes and writes back the rows — the next day's run picks them up as PG hits.

Counters undercount the actual back-fill rate during cold-cache batches; fix is to thread `timeoutMs` through `refreshForIdentities` and set a budget that survives the worst-case 4-min wall-clock. Out of scope for this PR.

## Run procedure

- **Production**: registered via the BS deploy-base machinery. The `cron-schedule` field in `package.json` is picked up by `scripts/resolve-cron-schedule.sh` at deploy time. Schedule: `30 4 * * *` UTC — between artist-search-alias-consumer (`15 4`) and flowsheet-metadata-backfill (`0 6`).
- **Manual one-shot on EC2**:
  ```
  docker run --rm --env-file .env <image> 2>&1 | tee rotation-artist-backfill.log
  ```
- **Dry-run** (no refresh calls fire):
  ```
  docker run --rm --env-file .env -e DRY_RUN=true <image>
  ```

## Verification

After a run, every in-scope identity should resolve as `status = "warmed"` (or `not_implemented` for sources LML hasn't wired yet). A re-run is the smoke test: total `backfill.identities_scanned` stays the same, and `backfill.warmed_releases` should match what the first run produced — but with no live Discogs egress on LML's side (verify via LML-side dashboards, since BS-side counters intentionally don't surface cache hit/miss).

The `backfill.not_found / backfill.identities_scanned > 1%` alert (BS#1402) signals BS holds stale `lml_identity_id` references — the `rotation-lml-identity-backfill` cron from BS#1380 should be catching up; investigate that job's most recent run if the alert fires.

## Files

- `job.ts` — entry point + run lifecycle.
- `deploy-guard.ts` — `/health` + GitHub compare gate.
- `query.ts` — SELECT for active rotation identity ids.
- `lml-fetch.ts` — typed wrapper over LML's identity-refresh endpoint.
- `lml-limiter.ts` — concurrency + rate-limit gate.
- `orchestrate.ts` — one-tier batched loop + counters.
- `logger.ts` — JSON logs + Sentry init.
