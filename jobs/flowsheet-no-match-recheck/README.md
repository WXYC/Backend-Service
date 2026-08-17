# flowsheet-no-match-recheck

Recurring, cause-agnostic re-ask of `flowsheet` rows stuck at terminal `metadata_status = 'enriched_no_match'`.

## Why this job exists (BS#2176)

`enriched_no_match` is a terminal status, but the condition it records is not permanent. A playcut can be a correct no-match at write time and become resolvable days later — discogs-etl's next rebuild caches the release, an LML matcher fix ships, or the librarian files the album — and nothing revisits the row, so it stays wrong forever.

This repo has written **three** one-shot rescue drains for exactly this shape: `jobs/flowsheet-reenrichment` (BS#1433), `jobs/flowsheet-linked-reenrichment` (BS#1638), and BS#1979 (open). Each is bounded by a frozen predicate tied to one historical cause, so every new cause (most recently BS#1998's 26,286-row orphan cohort from the 2026-08-03/04 breaker incident) mints a new orphan cohort and a new ticket. This job replaces that pattern with a standing mechanism: every run re-asks LML for a bounded, TTL-gated slice of the whole `enriched_no_match` cohort, so no future freeze cause needs its own drain.

It does **not** supersede the historical one-shot drains automatically — see "Relationship to the existing drains" below.

## What it does

Each run:

1. Loads up to `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE` candidate rows — `metadata_status = 'enriched_no_match'`, `entry_type = 'track'`, `artist_name IS NOT NULL`, and `no_match_recheck_attempted_at` either NULL or past `FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS` — ordered oldest-recheck-attempted-first (never-attempted rows lead).
2. For each row, calls LML's single-item `POST /api/v1/lookup` (`(artist, album, track)`, the same shape `flowsheet-metadata-backfill` uses) through the shared `@wxyc/lml-client` chokepoint.
3. Gates every match through the track-context trust predicate (`isTrustedLmlTrackContextMatch`, BS#1359) — a same-artist substitution (`fallback`/`alternative`/`song_as_artist`) is never auto-persisted.
4. **Trusted match** → fill-null write (never clobbers a populated field) and flips the row to `enriched_match`: linked rows (`album_id` present) UPSERT into `album_metadata`; unlinked (free-form) rows update flowsheet's own inline metadata columns.
5. **No match, or an untrusted candidate** → stamps `no_match_recheck_attempted_at` so the row backs off behind the TTL; `metadata_status` stays `enriched_no_match`.
6. **Transient LML failure** (a throw, a cascade-timeout body, or a breaker-open/shed response with no usable answer) → leaves the row untouched entirely, so it stays immediately retryable next run.

## The retry marker

`flowsheet.no_match_recheck_attempted_at` (migration 0151 — landed as 0150 originally; renumbered after rebasing past WXYC/Backend-Service#2173's parallel migration, which claimed 0150 first) is a **new** column — deliberately not a reuse of `flowsheet.metadata_attempt_at`. That column's NULL-vs-stamped split is a load-bearing writer discriminator depended on by BS#1011 / BS#895 (the live CDC worker leaves it NULL on no-match rows; only `flowsheet-metadata-backfill` stamps it), and the C6 gap-recovery sweep's candidate predicate reads it. Overloading it would break that discriminator for every row this sweep touches. See `docs/migrations.md`'s "Attempt-at markers" section and `tests/unit/jobs/flowsheet-metadata-backfill/worklist.test.ts`'s exact-match pinning test for the C6 predicate, which asserts this new column never appears there.

Shape mirrors `rotation.discogs_release_id_resolve_attempted_at` (BS#1813/BS#1029, this job's structural donor): stamped on a definitive response (fresh no-match or a trust-gate rejection), left NULL on a transient failure so the row stays immediately retryable.

## Timer vs. state-change trigger — decision

The ticket asked whether a cheaper state-change-gated trigger (an `album_metadata` row gaining a `discogs_url`, or a `library` row appearing for a previously-unlinked artist/album pair) should replace the timer. This job uses the **timer** (TTL + bounded batch), not a state-change gate, for three reasons:

1. **Coverage.** The demonstrated case (flowsheet #5308981) resolved because LML's own matcher/cache improved between the original write and the replay — no local `library`/`album_metadata` row changed at all. A state-change gate over BS's own tables cannot see an upstream LML/Discogs-side improvement; only re-asking LML can.
2. **Existing precedent already narrow.** The epic #1810 W4 self-heal pass inside `flowsheet-metadata-backfill` already proves the state-change-gated shape works, but only for the one cause it can observe (`rotation.discogs_release_id` transitioning NULL→present). Generalizing a state-change gate to cover every possible upstream cause would mean watching an open-ended set of tables/columns — exactly the "one cause, one predicate, one ticket" pattern this job exists to stop.
3. **Cost is already bounded the right way.** The ticket's binding constraint is LML call budget, not trigger cheapness — a state-change gate mainly saves LML calls on rows that were never going to resolve anyway. This job's TTL + batch size do that job directly: a batch of 200 rows every 6 hours is a small, predictable LML cost regardless of cohort size, and it is the only shape that also recovers the "nothing in BS's own tables changed, LML just got better" case.

W4's rotation-linked self-heal pass is left in place (out of scope for this ticket to touch) — it is now a strict subset of this job's cohort (any rotation-linked row it would catch is also enriched_no_match and eventually reached by this job's TTL rotation) and is expected to become a low-value redundancy once this job is running in steady state. See "Relationship to the existing drains" for the recommendation on winding it down.

## Schedule

Registered by deploy-base from `package.json`:

```text
47 */6 * * *
```

Runs at minute 47 every 6 hours UTC (00:47 / 06:47 / 12:47 / 18:47) — no other heavy-drain cron holds `:47`, including `rotation-release-id-backfill`'s `:17` quad-daily slot (satisfies the hard invariant). The two sit only 30 min apart, below the ≥60 min recommended margin — the mathematical ceiling for two crons sharing the same `*/6` anchor grid, documented as a non-promotable exception at `docs/ops-cron-scheduling.md`'s "Margin ceiling" section. Cooperative pause yields when a DJ is actively adding tracks.

## Manual invocation

```sh
gh workflow run deploy-manual.yml -f target=flowsheet-no-match-recheck -f version=latest

docker run --rm --env-file .env $AWS_ECR_URI/flowsheet-no-match-recheck:latest
```

### Dry run first

```sh
docker run --rm --env-file .env -e DRY_RUN=true $AWS_ECR_URI/flowsheet-no-match-recheck:latest
```

`DRY_RUN` (case-insensitive `true`/`1`) runs the LML lookups but skips every write, including marker-only attempts. The counters surface `resolved_dry` instead of `resolved` for trusted matches and log the candidate count + a projected LML call volume (== candidate count, since this job is single-row, not bulk) before any write — the acceptance-criteria "dry-run mode reporting candidate counts and projected LML call volume" requirement.

## Env

| Var                                                  | Default    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`                               | (required) | LML service URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `LML_API_KEY`                                        | (required) | Bearer for LML auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `DB_*`                                               | (required) | Standard postgres connection (host/port/name/username/password)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DRY_RUN`                                            | `false`    | Skip all writes; log planned counts only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS`                | `14`       | Re-attempt a stamped no-match/trust-rejected row only after this many days                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE`              | `200`      | Rows visited per run — the bounded-drip ceiling on LML call volume, independent of how large the total cohort is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BACKFILL_LML_MAX_CONCURRENT`                        | `1`        | Concurrency cap on LML calls (semaphore permits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `BACKFILL_LML_RATE_PER_MIN`                          | `20`       | Token-bucket rate limit on LML calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `FLOWSHEET_NO_MATCH_RECHECK_LML_PER_CALL_TIMEOUT_MS` | `35000`    | Client-side socket-abort safety net (mirrors `flowsheet-metadata-backfill`'s `BACKFILL_LML_PER_CALL_TIMEOUT_MS` default), not a lever that extends how long LML itself searches — this caller sends the class-5 `X-Caller-Budget-Ms` header unconditionally, and the header's mere presence arms LML's own ~4s empty-state cutoff regardless of this value (see `shared/lml-client/src/policy.ts`'s "CORRECTED MODEL"). A cold, hard-to-resolve release is expected to come back `degraded_reason: 'deadline_exceeded'` well under this timeout; `lml-fetch.ts`'s `isUnansweredDegraded` treats that as transient so the row stays retryable |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`                     | `60`       | Defer while a track was added inside this window; `0` disables the probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LIVE_ACTIVITY_PAUSE_MS`                             | `30000`    | Sleep between live-activity probes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LIVE_ACTIVITY_MAX_PAUSE_MS`                         | `1800000`  | Cumulative cooperative-pause budget for the whole run; 0 = uncapped. On exhaustion the run aborts rather than pausing indefinitely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SENTRY_DSN`                                         | —          | Optional; Sentry stays inactive without it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

At the defaults (200 rows / 6h), a run's worst case is 200 LML calls against a 20/min-capped, concurrency-1 limiter — under 10 minutes of LML time per run, well inside the LML budget and clear of every heavy-drain cron's window.

**Cohort-size caveat (BS#2179 review, unmeasured):** 800 rows/day (200 × 4 runs) only cycles the full `enriched_no_match` cohort inside `FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS` if that cohort is in the low tens of thousands. BS#1979's specific slice is ~26k rows (see "Relationship to the existing drains" below), but that is one known-cause slice, not the whole `enriched_no_match` population — the true fleet-wide count has not been measured against prod as of this PR. If it turns out to be materially larger, the 14-day TTL is effectively vestigial (a first full pass takes longer than the TTL window, so no row is ever revisited on schedule) and `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE`/`_TTL_DAYS` should be resized against the real number rather than this estimate. Filed as a follow-up to measure the real count and revisit the defaults before or shortly after the first prod run: WXYC/Backend-Service#2186.

## Counter shape

JSON log line emitted on `step: finished`:

```json
{
  "level": "info",
  "step": "finished",
  "message": "flowsheet-no-match-recheck done",
  "dry_run": false,
  "scanned": 200,
  "resolved": 46,
  "resolved_dry": 0,
  "unresolved": 121,
  "trust_rejected": 9,
  "lml_error": 22,
  "raced": 2,
  "db_error": 0,
  "repo": "Backend-Service",
  "tool": "flowsheet-no-match-recheck",
  "run_id": "<uuid>"
}
```

Invariant: `scanned == resolved + resolved_dry + unresolved + trust_rejected + lml_error + raced + db_error`.

| Counter          | Meaning                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scanned`        | Rows visited (matches the candidate query's row count, bounded by `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE`)                                           |
| `resolved`       | LML returned a track-context-trusted match and the write, including the row's status flip, landed cleanly                                            |
| `resolved_dry`   | LML returned a trusted match; `DRY_RUN` suppressed the write                                                                                         |
| `unresolved`     | LML found no candidate at all (or a trusted `search_type` with no artwork among its results); marker stamped so the TTL applies                      |
| `trust_rejected` | LML found a candidate, but its `search_type` (`fallback`/`alternative`/`song_as_artist`) isn't trustworthy for a track-context write; marker stamped |
| `lml_error`      | LML call threw, returned a `{timeout:true}` cascade-exhaustion body, or a breaker-open/shed response with no usable answer; marker left untouched    |
| `raced`          | The write matched zero rows because a concurrent writer already moved the row off `enriched_no_match` between select and update                      |
| `db_error`       | The marker or match write threw (deadlock, connection reset, …); isolated to the row so the batch continues, retried next tick                       |

`trust_rejected` and `unresolved` rows are exactly the kind the digest job (`jobs/metadata-no-match-digest`) reports — they now self-heal on this job's own TTL cadence instead of staying wrong forever.

## Relationship to the existing drains

- **BS#1433 / BS#1638** (`flowsheet-reenrichment`, `flowsheet-linked-reenrichment`): completed one-shot drains of already-frozen cohorts. This job does not touch them; nothing to decide.
- **BS#1979** (open, third one-shot drain for the class-5 4s-budget-cutoff cohort): **not runnable today regardless of preference** — its `blocked_by` graph is #1978 (closed) + #1995 (closed) + **#642 "[A.4] Tests, docs, and close-out for flowsheet-metadata-backfill" (still open)**, so the sequencing question below only becomes live once #642 closes. **The two mechanisms are complementary, not redundant, for that specific cohort — this job does not subsume #1979.** This job stays registered at LML class 5 sending the `X-Caller-Budget-Ms` header unconditionally (BS#2179 review HIGH 3, see `shared/lml-client/src/policy.ts`), the same ~4s empty-state cutoff that froze BS#1979's cohort in the first place; BS#1979's 59% recovery figure was measured **headerless**. So this job's recurring TTL sweep will still visit every row in that cohort on its own schedule (a 26k-row cohort at 200 rows / 6h clears in roughly 3–4 weeks of steady-state operation), but a genuinely cold (4–20s) release in that cohort is expected to come back `degraded_reason: 'deadline_exceeded'` under this job too — this job's HIGH-2 fix (`isUnansweredDegraded`) keeps that transient rather than manufacturing a fresh 14-day-TTL false no-match, but it does not manufacture a resolution either; the row just stays immediately retryable without converging. Genuine resolution for that specific pre-frozen sub-population still needs either #1979's dedicated headerless one-shot (once #642 unblocks it) or independent Discogs/LML-side cache warming. Whether that gap is acceptable, or #642 should be prioritized to unblock #1979, is a product/urgency call, not a mechanism question. See the implementer's report on this ticket for the recommendation.
- **Epic #1810 W4 self-heal** (inside `flowsheet-metadata-backfill`): unchanged by this PR. Its rotation-linked, state-change-gated cohort is a strict subset of what this job now also covers on a timer; it is expected to become low-value redundancy once this job has been running for a few TTL cycles, at which point removing it is a follow-up worth its own small PR (see this ticket's implementer report).

## Related

- Ticket: BS#2176
- One-shot drains this generalizes: BS#1433, BS#1638, BS#1979
- Orphan cohort that motivated the "no owner" framing: BS#1998
- Structural donor (job shape — attempt marker + no-match TTL + cooperative pause): `jobs/rotation-release-id-backfill` (BS#1813/BS#1029)
- Write-shape donor (fill-null COALESCE UPSERT + race guard): `jobs/flowsheet-linked-reenrichment` (BS#1638)
- Trust gate: `shared/lml-client/src/trust.ts` (`isTrustedLmlTrackContextMatch`, BS#1359); sibling un-gated paths tracked at BS#1959
- Seed mechanism: epic #1810 W4 self-heal pass inside `jobs/flowsheet-metadata-backfill`
- Reader-calibration correction: `jobs/metadata-no-match-digest/README.md`
- PR #2179 review follow-ups (filed rather than fixed inline): BS#2185 (deterministic-failure rows starve the NULLS FIRST queue head), BS#2186 (measure the real cohort, revisit TTL/batch defaults), BS#2187 (no cron-liveness signal), BS#2188 (marker-only UPDATEs broadcast SSE noise)
