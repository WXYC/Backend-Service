# rotation-lml-identity-backfill

Recurring daily-cron drift-repair that resolves `rotation.lml_identity_id` via LML's `POST /api/v1/identity/resolve` (LML#526) for active rotation rows whose `discogs_release_id` is populated but `lml_identity_id` is still NULL.

Companion to the BS#1380 schema addition (migration `0094_rotation-lml-identity-id.sql`). Catches both write paths that legitimately produce NULL `lml_identity_id`:

1. `jobs/rotation-etl/job.ts` — rotation-etl writes only `discogs_release_id` from the tubafrenzy paste and never calls LML (its useful life is bounded by the tubafrenzy decommission window ~September 2026; investing in lml-client wiring there isn't worth the diff). The CASE clause in the UPSERT also clears `lml_identity_id` when a paste-correction changes the effective `discogs_release_id` — those clears land here for re-resolution too.
2. `apps/backend/services/library.service.ts:addToRotation` — synchronous resolve at INSERT time; falls back to NULL on `LML_RESOLVE_TIMEOUT_MS` / 5xx / network failures so the music director isn't blocked on an LML outage. Those rows land here on the next daily tick.

## When to run

Daily cron (default `0 9 * * *` UTC / 04:00–05:00 ET, moved from `0 6 * * *` by BS#1665 to clear the LML-hitting cron stack — see `docs/ops-cron-scheduling.md`), registered automatically by the deploy pipeline. Cooperative pause (BS#735) defers each batch when DJs are active.

One-shot invocation is supported for ad-hoc operator runs (post-incident catch-up, initial migration deploy, or coverage-gate probes):

```sh
# Build (via `Manual Build & Deploy` on GitHub Actions)
gh workflow run deploy-manual.yml -f target=rotation-lml-identity-backfill -f version=latest

# Run on EC2
docker run --rm --env-file .env $AWS_ECR_URI/rotation-lml-identity-backfill:latest
```

The SELECT predicate (`lml_identity_id IS NULL AND discogs_release_id IS NOT NULL`) makes reruns idempotent — already-resolved rows are skipped.

### Dry run first

```sh
docker run --rm --env-file .env -e DRY_RUN=true $AWS_ECR_URI/rotation-lml-identity-backfill:latest
```

`DRY_RUN=true` runs the LML resolve loop so the resolved / unresolved / error counters are honest but suppresses every UPDATE. The `resolved` counter is replaced by `resolved_dry`.

### Coverage report

```sh
docker run --rm --env-file .env $AWS_ECR_URI/rotation-lml-identity-backfill:latest --report
```

`--report` emits the resolvable-coverage SQL result and exits without running the resolve loop. Used to check BS#1381's unblock condition (`resolvable_coverage_pct >= 99.0` steady-state across consecutive daily runs).

## Env

| Var                               | Default    | Purpose                                                                                                  |
| --------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`            | (required) | LML service URL                                                                                          |
| `LML_API_KEY`                     | (required) | Bearer for LML auth (rotation safe — see [BS#1094](https://github.com/WXYC/Backend-Service/issues/1094)) |
| `DB_*`                            | (required) | Standard postgres connection (host/port/name/username/password)                                          |
| `DRY_RUN`                         | `false`    | Skip all UPDATEs; log planned writes only                                                                |
| `BACKFILL_LML_MAX_CONCURRENT`     | `1`        | Concurrency cap on LML calls (semaphore permits)                                                         |
| `BACKFILL_LML_RATE_PER_MIN`       | `20`       | Token-bucket rate limit on LML calls                                                                     |
| `BACKFILL_LML_RESOLVE_TIMEOUT_MS` | `8000`     | Per-call abort budget on `resolveIdentity`                                                               |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`  | `60`       | Cooperative-pause window; 0 disables                                                                     |
| `LIVE_ACTIVITY_PAUSE_MS`          | `30000`    | How long to pause between probes when activity is detected                                               |
| `SENTRY_DSN`                      | —          | Optional; Sentry stays inactive without it                                                               |

The `BACKFILL_LML_*` triple is the safety story BS#995 established for the `flowsheet-metadata-backfill` cron. Defaults pin LML calls to one in-flight / 20 per minute / 8 s per call — for the few-hundred-row active rotation set that's bounded by ~15 min wall time and is provably non-disruptive to runtime LML traffic.

## Counter shape

JSON log line emitted on `step: finished`:

```json
{
  "level": "info",
  "step": "finished",
  "message": "rotation-lml-identity-backfill done",
  "dry_run": false,
  "scanned": 310,
  "resolved": 247,
  "resolved_dry": 0,
  "unresolved": 51,
  "lml_error": 11,
  "raced": 1,
  "repo": "Backend-Service",
  "tool": "rotation-lml-identity-backfill",
  "run_id": "<uuid>"
}
```

Invariant: `scanned == resolved + resolved_dry + unresolved + lml_error + raced` (matches the counter shape from `jobs/rotation-release-id-backfill/orchestrate.ts:30-91`).

| Counter        | Meaning                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `scanned`      | Rows visited (matches the candidate query's row count)                                                                                 |
| `resolved`     | LML minted/returned an identity_id AND the UPDATE landed cleanly                                                                       |
| `resolved_dry` | LML returned an identity_id; DRY_RUN suppressed the UPDATE                                                                             |
| `unresolved`   | LML rejected the input with 422 (sentinel discogs id, malformed bandcamp URL)                                                          |
| `lml_error`    | LML call threw (cold-cache timeout, network blip, 5xx); row stays NULL for next run                                                    |
| `raced`        | UPDATE matched zero rows — either a concurrent backfill won the race, or rotation-etl cleared the row mid-run after a paste-correction |

## Coverage gate

The gate that unblocks [BS#1381](https://github.com/WXYC/Backend-Service/issues/1381) is **resolvable coverage** — the fraction of active rotation rows where backfill _could_ populate `lml_identity_id` that actually have it. Denominator excludes rows with NULL `discogs_release_id` (no backfill source).

```sql
SELECT
  COUNT(*) FILTER (WHERE kill_date IS NULL OR kill_date > CURRENT_DATE) AS active,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND discogs_release_id IS NOT NULL) AS active_with_discogs,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND discogs_release_id IS NOT NULL
                   AND lml_identity_id IS NOT NULL) AS active_with_lml,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                             AND discogs_release_id IS NOT NULL
                             AND lml_identity_id IS NOT NULL)
        / NULLIF(COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                                  AND discogs_release_id IS NOT NULL), 0),
    2
  ) AS resolvable_coverage_pct
FROM wxyc_schema.rotation;
```

`--report` mode runs exactly this. When `resolvable_coverage_pct >= 99.0` steady-state across consecutive daily cron runs, comment on [BS#1381](https://github.com/WXYC/Backend-Service/issues/1381) to unblock that work.

Rows that sit at `lml_identity_id IS NULL AND discogs_release_id IS NOT NULL` for >7 days after backfill is healthy indicate either LML can't resolve the ID (catalog drift) or backfill has a bug — investigate per-row, not by lowering the gate threshold.

**Why resolvable coverage instead of absolute:** post-tubafrenzy-decommission, new `addToRotation` rows pick up `discogs_release_id` from `library_identity`, which has its own incomplete subset. Absolute coverage `(active_with_lml / active)` conflates "backfill is done" with "library_identity has full Discogs handle population" — two unrelated work tracks. The WXYC/dj-site#648 high-volume MD path makes the denominator in absolute coverage move with library_identity health, not backfill progress.

## Post-run verification

```sql
SELECT
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND lml_identity_id IS NOT NULL) AS active_with_lml,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND lml_identity_id IS NULL
                   AND discogs_release_id IS NOT NULL) AS lml_remaining,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND lml_identity_id IS NULL
                   AND discogs_release_id IS NULL) AS no_discogs_handle
FROM wxyc_schema.rotation;
```

`lml_remaining` is the candidate count for the next daily tick; it should trend toward zero as both write paths converge.

## Related

- Schema PR: [BS#1380](https://github.com/WXYC/Backend-Service/issues/1380) (this issue)
- LML precursor: [LML#526](https://github.com/WXYC/library-metadata-lookup/issues/526) — introduces the release identity that `lml_identity_id` points at
- LML companion consumer: [LML#525](https://github.com/WXYC/library-metadata-lookup/issues/525) — `POST /api/v1/cache/refresh-for-identities` consumes the values this backfill produces
- Operational precedent (one-shot variant): `jobs/rotation-release-id-backfill/`
- Operational precedent (recurring-drift-repair shape): `jobs/flowsheet-metadata-backfill/` — same `BACKFILL_CRON_SCHEDULE` override pattern
- Cooperative-pause primitive: [BS#735](https://github.com/WXYC/Backend-Service/issues/735)
- Backfill cron-schedule override: [BS#914](https://github.com/WXYC/Backend-Service/issues/914) — see `scripts/resolve-cron-schedule.sh`
- Coverage-gate consumer: [BS#1381](https://github.com/WXYC/Backend-Service/issues/1381) — `rotation-artist-backfill` switching off the LML-identity handle
