# rotation-release-id-backfill

One-shot ETL that pre-resolves Discogs release ids for active rotation rows via LML, persisting to `rotation.discogs_release_id` so the dj-site rotation-tracks picker can read it via a deterministic SQL JOIN instead of falling through to a runtime LML cascade.

Unblocks the picker resolver revert in [BS#1030](https://github.com/WXYC/Backend-Service/issues/1030); closes the loop on [BS#994](https://github.com/WXYC/Backend-Service/issues/994) (the 2026-05-21 LML monopolization incident whose precipitating cause was the runtime cascade this work removes).

## When to run

This is a **one-shot**, **manually triggered** job:

- After migration `0085_rotation-discogs-release-id-source.sql` lands in prod.
- Before [BS#1030](https://github.com/WXYC/Backend-Service/issues/1030)'s revert PR ships — the revert deletes the tier-3 cascade that's the picker's only fallback today, so leaving the picker empty for 100% of rotation rows during the gap is not acceptable.
- After a future rotation pool refresh (the SELECT predicate `discogs_release_id IS NULL` makes reruns idempotent — already-populated rows are skipped).

Cron registration is intentionally absent (`"job-type": "one-shot"` in `package.json`). Re-running after LML's catalog improves is a deliberate operator decision, not a scheduled tick.

### Sole sanctioned offline writer (BS#1521, Option A, 2026-07-05)

**This gated LML job is the ONLY sanctioned offline writer of `rotation.discogs_release_id`.** The 2026-05-29 operator-run bypass-LML rescue — which hit `api.discogs.com/database/search` directly, bypassing every `search_type` trust gate — is **retired**. It wrote its resolved ids under the placeholder source `lml_offline_backfill` (the only enum value at the time); `scripts/relabel-rotation-direct-backfill.sql` then promoted those rows to `discogs_release_id_source = 'discogs_direct_backfill'` once migration 0086 shipped that value, so the relabel — not the rescue directly — is the proximate writer of every `discogs_direct_backfill` row. The rescue produced the one demonstrated wrong-album write in the rotation trusted-store incident family ([BS#1515](https://github.com/WXYC/Backend-Service/issues/1515), Yenbett → Tzenni). Do not re-run it. This job's `search_type` trust gate ([PR #1519](https://github.com/WXYC/Backend-Service/pull/1519)) — which landed the sequencing prerequisite for the retirement — makes it the safe replacement for pool refreshes.

Any **new** `discogs_direct_backfill` row appearing after 2026-07-05 is an anomaly: the [#1517](https://github.com/WXYC/Backend-Service/issues/1517) audit flags that lineage (it is the bypass-LML bucket, `discogs_direct_backfill`, in `scripts/audit/bs_rotation_release_id_pollution.py`'s source list), and the [#1522](https://github.com/WXYC/Backend-Service/issues/1522) recurring check flags it automatically. The rescue's companion relabel is neutered against re-runs (pure-SQL `NOT EXISTS` guard) so a re-run is a no-op **as long as any `discogs_direct_backfill` row persists** — which the #1517 "do not delete these rows" constraint keeps true; the durable guarantee is the retirement, not the guard alone.

## Invocation

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

`DRY_RUN=true` logs every planned UPDATE but does not execute it. The counters surface `rows_resolved_dry` instead of `rows_resolved`. Useful for confirming the candidate set is what you expect before committing.

## Env

| Var                                | Default    | Purpose                                                                                                  |
| ---------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`             | (required) | LML service URL                                                                                          |
| `LML_API_KEY`                      | (required) | Bearer for LML auth (rotation safe — see [BS#1094](https://github.com/WXYC/Backend-Service/issues/1094)) |
| `DB_*`                             | (required) | Standard postgres connection (host/port/name/username/password)                                          |
| `DRY_RUN`                          | `false`    | Skip all UPDATEs; log planned writes only                                                                |
| `BACKFILL_LML_MAX_CONCURRENT`      | `1`        | Concurrency cap on LML calls (semaphore permits)                                                         |
| `BACKFILL_LML_RATE_PER_MIN`        | `20`       | Token-bucket rate limit on LML calls                                                                     |
| `BACKFILL_LML_PER_CALL_TIMEOUT_MS` | `8000`     | Per-call abort budget on LML calls                                                                       |
| `SENTRY_DSN`                       | —          | Optional; Sentry stays inactive without it                                                               |

The `BACKFILL_LML_*` triple is the safety story BS#995 established for the `flowsheet-metadata-backfill` cron. Defaults pin LML calls to one in-flight / 20 per minute / 8 s per call — for a 310-row backfill that's ~15.5 min wall time and is provably non-disruptive to runtime LML traffic.

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
  "repo": "Backend-Service",
  "tool": "rotation-release-id-backfill",
  "run_id": "<uuid>"
}
```

Invariant: `scanned == resolved + resolved_dry + unresolved + lml_error + raced + sentinel_rejected + trust_rejected`.

| Counter             | Meaning                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scanned`           | Rows visited (matches the candidate query's row count)                                                                                                                                                                  |
| `resolved`          | LML returned a positive release id on a `direct` match AND the UPDATE landed cleanly                                                                                                                                    |
| `resolved_dry`      | LML returned a positive release id on a `direct` match; DRY_RUN suppressed the UPDATE                                                                                                                                   |
| `unresolved`        | LML returned no Discogs match (`response.results[0].artwork.release_id` was null)                                                                                                                                       |
| `lml_error`         | LML call threw (cold-cache timeout, network blip, etc.); row stays NULL for next run                                                                                                                                    |
| `raced`             | UPDATE matched zero rows because a tubafrenzy paste won the race between candidate-select and update                                                                                                                    |
| `sentinel_rejected` | LML returned `<= 0` (cache pollution / upstream regression); pre-empted before write per BS#1429 CHECK fence                                                                                                            |
| `trust_rejected`    | LML returned a candidate id on a non-`direct` (or absent) `search_type` — an artist-fallback answer pointing at a **different album**; never persisted (BS#1516, the Yenbett→Tzenni recurrence BS#1515). Row stays NULL |

`trust_rejected` rows are candidates for LML-side match improvements (or the album has no Discogs release yet); `unresolved` rows need Discogs/catalog additions. Both re-enter the candidate set on the next run.

## Post-run verification

```sql
SELECT
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)) AS active_rows,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND discogs_release_id IS NOT NULL) AS active_resolved,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS backfill_attribution
FROM wxyc_schema.rotation;
```

Target: `active_resolved / active_rows ≥ 0.8` per the BS#1029 acceptance criterion. A lower number indicates LML's cold-cache pathology ([LML#338](https://github.com/WXYC/library-metadata-lookup/issues/338)) — owned separately and not a defect in this job.

## Re-running on subset

The SELECT predicate `discogs_release_id IS NULL` is the idempotency gate; rerunning is safe and skips already-populated rows. To re-resolve only the offline-backfill subset (e.g., after LML's catalog improves):

```sql
UPDATE wxyc_schema.rotation
   SET discogs_release_id = NULL,
       discogs_release_id_source = 'tubafrenzy_paste'  -- back to virtual default
 WHERE discogs_release_id_source = 'lml_offline_backfill';
```

This restores the candidate set to the subset the backfill should re-process. The `discogs_release_id_source` column makes this surgical — MD-verified-via-tubafrenzy values are never touched.

## Related

- Parent incident: [BS#994](https://github.com/WXYC/Backend-Service/issues/994)
- Picker revert (depends on this): [BS#1030](https://github.com/WXYC/Backend-Service/issues/1030)
- Backfill pacing safety story: [BS#995](https://github.com/WXYC/Backend-Service/issues/995) / PR [#1001](https://github.com/WXYC/Backend-Service/pull/1001) / PR [#1017](https://github.com/WXYC/Backend-Service/pull/1017)
- Plan it restores fidelity to: [`wiki/plans/catalog-track-search.md`](https://github.com/WXYC/wiki/blob/main/plans/catalog-track-search.md)
