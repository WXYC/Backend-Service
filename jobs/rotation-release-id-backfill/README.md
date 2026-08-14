# rotation-release-id-backfill

Recurring resolver that pre-resolves Discogs release ids for active rotation rows via LML, persisting to `rotation.discogs_release_id` so the dj-site rotation-tracks picker can read it via a deterministic SQL JOIN instead of falling through to a runtime LML cascade.

Originally shipped as the BS#1029 one-shot. BS#1813 promotes it to a scheduled, trust-gated resolver with `discogs_release_id_resolve_attempted_at` + no-match TTL so new rotation rows do not accumulate NULL release ids forever.

## Schedule

Registered by deploy-base from `package.json`:

```text
17 */6 * * *
```

Runs at minute 17 every 6 hours UTC. The `:17` minute avoids the current LML-heavy cron slots in `docs/ops-cron-scheduling.md`; cooperative pause yields when a DJ is actively adding tracks.

### Sole sanctioned offline writer (BS#1521, Option A, 2026-07-05)

**This gated LML job is the ONLY sanctioned offline writer of `rotation.discogs_release_id`.** The 2026-05-29 operator-run bypass-LML rescue — which hit `api.discogs.com/database/search` directly, bypassing every `search_type` trust gate — is **retired**. It wrote its resolved ids under the placeholder source `lml_offline_backfill` (the only non-default enum value at the time — migration 0085 created the enum as `tubafrenzy_paste` default plus `lml_offline_backfill`); `scripts/relabel-rotation-direct-backfill.sql` then promoted those rows to `discogs_release_id_source = 'discogs_direct_backfill'` once migration 0086 shipped that value, so the relabel — not the rescue directly — is the proximate writer of every `discogs_direct_backfill` row. The rescue produced the one demonstrated wrong-album write in the rotation trusted-store incident family ([BS#1515](https://github.com/WXYC/Backend-Service/issues/1515), Yenbett → Tzenni). Do not re-run it. This job's `search_type` trust gate ([PR #1519](https://github.com/WXYC/Backend-Service/pull/1519)) — which landed the sequencing prerequisite for the retirement — makes it the safe replacement for pool refreshes.

Any **new** `discogs_direct_backfill` row appearing after 2026-07-05 is an anomaly: the [#1517](https://github.com/WXYC/Backend-Service/issues/1517) audit flags that lineage (it is the bypass-LML bucket, `discogs_direct_backfill`, in `scripts/audit/bs_rotation_release_id_pollution.py`'s source list), and the [#1522](https://github.com/WXYC/Backend-Service/issues/1522) recurring check flags it automatically. The rescue's companion relabel is neutered against re-runs (pure-SQL `NOT EXISTS` guard) so a re-run is a no-op **as long as any `discogs_direct_backfill` row persists** — which the #1517 "do not delete these rows" constraint keeps true; the durable guarantee is the retirement, not the guard alone.

## Manual invocation

```sh
# Build (via `Manual Build & Deploy` on GitHub Actions)
gh workflow run deploy-manual.yml -f target=rotation-release-id-backfill -f version=latest

# Run on EC2
docker run --rm --env-file .env $AWS_ECR_URI/rotation-release-id-backfill:latest
```

### Dry run first

```sh
docker run --rm --env-file .env -e DRY_RUN=true $AWS_ECR_URI/rotation-release-id-backfill:latest
```

`DRY_RUN` (case-insensitive `true`/`1`) runs the LML lookups but skips every UPDATE, including marker-only attempts. The counters surface `resolved_dry` instead of `resolved` for trusted matches. Useful for confirming the candidate set is what you expect before committing.

## Env

| Var                                     | Default    | Purpose                                                                                                                                                                                                                                            |
| --------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`                  | (required) | LML service URL                                                                                                                                                                                                                                    |
| `LML_API_KEY`                           | (required) | Bearer for LML auth (rotation safe — see [BS#1094](https://github.com/WXYC/Backend-Service/issues/1094))                                                                                                                                           |
| `DB_*`                                  | (required) | Standard postgres connection (host/port/name/username/password)                                                                                                                                                                                    |
| `DRY_RUN`                               | `false`    | Skip all UPDATEs; log planned writes only                                                                                                                                                                                                          |
| `ROTATION_RELEASE_ID_NO_MATCH_TTL_DAYS` | `30`       | Re-attempt stamped no-match / trust-rejected / sentinel rows only after this many days                                                                                                                                                             |
| `BACKFILL_LML_MAX_CONCURRENT`           | `1`        | Concurrency cap on LML calls (semaphore permits)                                                                                                                                                                                                   |
| `BACKFILL_LML_RATE_PER_MIN`             | `20`       | Token-bucket rate limit on LML calls                                                                                                                                                                                                               |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS`      | `8000`     | Per-call abort budget on LML calls                                                                                                                                                                                                                 |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`        | `60`       | Defer while a track was added inside this window; `0` disables the probe                                                                                                                                                                           |
| `LIVE_ACTIVITY_PAUSE_MS`                | `30000`    | Sleep between live-activity probes. Must be >= 1000 (BS#2147) — a sub-floor value, including 0, is rejected at init rather than silently disabling the pause.                                                                                      |
| `LIVE_ACTIVITY_MAX_PAUSE_MS`            | `1800000`  | Cumulative cooperative-pause budget for the whole run; 0 = uncapped. On exhaustion the run **aborts** (`LiveActivityPauseCeilingExceededError`, non-zero exit) rather than pausing indefinitely (BS#2147 review round 2) — see `docs/env-vars.md`. |
| `SENTRY_DSN`                            | —          | Optional; Sentry stays inactive without it                                                                                                                                                                                                         |

The `BACKFILL_LML_*` triple is the safety story BS#995 established for the `flowsheet-metadata-backfill` cron. Defaults pin LML calls to one in-flight / 20 per minute / 8 s per call. The no-match TTL keeps the permanently-unresolvable tail from being re-paid every six-hour tick.

## Counter shape

JSON log line emitted on `step: finished`:

```json
{
  "level": "info",
  "step": "finished",
  "message": "rotation-release-id-backfill done",
  "dry_run": false,
  "scanned": 310,
  "resolved": 247,
  "resolved_dry": 0,
  "unresolved": 43,
  "lml_error": 11,
  "raced": 1,
  "sentinel_rejected": 0,
  "trust_rejected": 8,
  "db_error": 0,
  "repo": "Backend-Service",
  "tool": "rotation-release-id-backfill",
  "run_id": "<uuid>"
}
```

Invariant: `scanned == resolved + resolved_dry + unresolved + lml_error + raced + sentinel_rejected + trust_rejected + db_error`.

| Counter             | Meaning                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scanned`           | Rows visited (matches the candidate query's row count)                                                                                                                                                                                     |
| `resolved`          | LML returned a positive release id on a `direct` match AND the UPDATE, including the attempt marker, landed cleanly                                                                                                                        |
| `resolved_dry`      | LML returned a positive release id on a `direct` match; DRY_RUN suppressed the UPDATE                                                                                                                                                      |
| `unresolved`        | LML returned no Discogs match (`response.results[0].artwork.release_id` was null); marker stamped so the TTL applies                                                                                                                       |
| `lml_error`         | LML call threw (cold-cache timeout, network blip, etc.) OR returned a `{timeout:true}` cascade-exhaustion body; marker stays NULL for next run so the transient row stays immediately retryable                                            |
| `raced`             | UPDATE matched zero rows because a tubafrenzy paste or another resolver run won the race between candidate-select and update                                                                                                               |
| `sentinel_rejected` | LML returned `<= 0` (cache pollution / upstream regression); pre-empted before release-id write per BS#1429 CHECK fence; marker stamped so the TTL applies                                                                                 |
| `trust_rejected`    | LML returned a candidate id on a non-`direct` (or absent) `search_type` — an artist-fallback answer pointing at a **different album**; never persisted (BS#1516, the Yenbett→Tzenni recurrence BS#1515). Marker stamped so the TTL applies |
| `db_error`          | The marker or release-id UPDATE threw (deadlock, connection reset, …); isolated to the row per BS#1820 review so the batch continues, marker stays NULL, row retried next tick                                                             |

`trust_rejected` rows are candidates for LML-side match improvements (or the album has no Discogs release yet); `unresolved` rows need Discogs/catalog additions. Both re-enter the candidate set when `discogs_release_id_resolve_attempted_at` is older than `ROTATION_RELEASE_ID_NO_MATCH_TTL_DAYS`.

## Post-run verification

```sql
SELECT
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)) AS active_rows,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND discogs_release_id IS NOT NULL) AS active_resolved,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS backfill_attribution
FROM wxyc_schema.rotation;
```

Target: `active_resolved / active_rows ≥ 0.8` per the BS#1029 acceptance criterion. A lower number may indicate LML match coverage issues ([LML#338](https://github.com/WXYC/library-metadata-lookup/issues/338)) or a large TTL-held no-match tail.

## Re-running on subset

The SELECT predicate `discogs_release_id IS NULL` is the idempotency gate; rerunning is safe and skips already-populated rows. To re-resolve only the offline-backfill subset (e.g., after LML's catalog improves):

```sql
UPDATE wxyc_schema.rotation
   SET discogs_release_id = NULL,
       discogs_release_id_source = 'tubafrenzy_paste',  -- back to virtual default
       discogs_release_id_resolve_attempted_at = NULL
 WHERE discogs_release_id_source = 'lml_offline_backfill';
```

This restores the candidate set to the subset the backfill should re-process. The `discogs_release_id_source` column makes this surgical — MD-verified-via-tubafrenzy values are never touched.

## Related

- Parent incident: [BS#994](https://github.com/WXYC/Backend-Service/issues/994)
- Picker revert (depends on this): [BS#1030](https://github.com/WXYC/Backend-Service/issues/1030)
- Backfill pacing safety story: [BS#995](https://github.com/WXYC/Backend-Service/issues/995) / PR [#1001](https://github.com/WXYC/Backend-Service/pull/1001) / PR [#1017](https://github.com/WXYC/Backend-Service/pull/1017)
- Plan it restores fidelity to: [`wiki/plans/catalog-track-search.md`](https://github.com/WXYC/wiki/blob/main/plans/catalog-track-search.md)
