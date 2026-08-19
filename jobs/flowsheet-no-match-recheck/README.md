# flowsheet-no-match-recheck

Recurring, cause-agnostic re-ask of `flowsheet` rows stuck at terminal `metadata_status = 'enriched_no_match'`.

**BS#2218 correction (2026-08-18):** the job shipped by BS#2176 could make zero forward progress indefinitely — see "The BS#2218 self-lock and its fix" below before relying on any of the numbers elsewhere in this doc that predate it (they describe the pre-fix design's intent, not its measured prod behavior).

## Why this job exists (BS#2176)

`enriched_no_match` is a terminal status, but the condition it records is not permanent. A playcut can be a correct no-match at write time and become resolvable days later — discogs-etl's next rebuild caches the release, an LML matcher fix ships, or the librarian files the album — and nothing revisits the row, so it stays wrong forever.

This repo has written **three** one-shot rescue drains for exactly this shape: `jobs/flowsheet-reenrichment` (BS#1433), `jobs/flowsheet-linked-reenrichment` (BS#1638), and BS#1979 (open). Each is bounded by a frozen predicate tied to one historical cause, so every new cause (most recently BS#1998's 26,286-row orphan cohort from the 2026-08-03/04 breaker incident) mints a new orphan cohort and a new ticket. This job replaces that pattern with a standing mechanism: every run re-asks LML for a bounded, TTL-gated slice of the whole `enriched_no_match` cohort, so no future freeze cause needs its own drain.

It does **not** supersede the historical one-shot drains automatically — see "Relationship to the existing drains" below.

## What it does

Each run:

1. Loads up to `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE` candidate rows — `metadata_status = 'enriched_no_match'`, `entry_type = 'track'`, `artist_name IS NOT NULL`, and `no_match_recheck_attempted_at` either NULL or past `FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS`. Two tiers, in order: never-attempted rows first (`NULLS FIRST`), **newest-first** (`id DESC`) as of BS#2218; then previously-attempted, TTL-expired rows, oldest-attempted-first (unchanged). An OFFSET cursor (BS#2218, see below) shifts which slice of that ordering this run reads.
2. For each row, calls LML's single-item `POST /api/v1/lookup` (`(artist, album, track)`, the same shape `flowsheet-metadata-backfill` uses) through the shared `@wxyc/lml-client` chokepoint, with `budgetMs: null` (BS#2218) — no `X-Caller-Budget-Ms` header, so a cold non-library release gets LML's full cascade instead of its ~4s empty-state fast-degrade.
3. Gates every match through the track-context trust predicate (`isTrustedLmlTrackContextMatch`, BS#1359) — a same-artist substitution (`fallback`/`alternative`/`song_as_artist`) is never auto-persisted.
4. **Trusted match** → fill-null write (never clobbers a populated field) and flips the row to `enriched_match`: linked rows (`album_id` present) UPSERT into `album_metadata`; unlinked (free-form) rows update flowsheet's own inline metadata columns.
5. **No match, or an untrusted candidate** → stamps `no_match_recheck_attempted_at` so the row backs off behind the TTL; `metadata_status` stays `enriched_no_match`.
6. **Transient LML failure** (a throw, a cascade-timeout body, or a breaker-open/shed response with no usable answer) → leaves the row untouched entirely, so it stays a candidate. Note the BS#2218 nuance: "stays a candidate" is not "is re-read next run". The marker is what makes the row eligible; the OFFSET cursor decides which eligible slice a run reads, and it advances exactly past this run's leftovers — so a transient row is re-read once the cursor comes back around, not on the immediately following run. That is the starvation guard working as intended, and it is why the cursor advances by leftovers rather than by batch size (see below).
7. Advances and persists the BS#2218 OFFSET cursor past however many of this run's candidates are still candidates (skipped in `DRY_RUN`).

## The BS#2218 self-lock and its fix

Prod measurement on 2026-08-18 found this job could make **zero forward progress indefinitely**. Four individually-defensible design choices composed into a self-lock: (1) the never-attempted tiebreak was `id ASC`, so 22 years of history sat ahead of anything recent; (2) a transient LML response deliberately leaves the retry marker untouched (the correct BS#1977 fix); (3) `deadline_exceeded` is classified transient (the correct BS#2179 review HIGH 2 fix); and (4) this caller sent `X-Caller-Budget-Ms` unconditionally, arming LML's ~4s empty-state cutoff — and the rows this job targets are disproportionately the ones that need LML's FULL cascade (cold non-library release resolution, measured 4-20s), so `deadline_exceeded` was the _expected_ answer for exactly this cohort. The result, measured directly: 64 rows stamped from a 137,340-row cohort across five runs (~1,000 candidate slots consumed), with the queue head never moving past `id 154` — a literal `ping test` row from 2004-11-04.

A second, independent defect compounded it: even a perfectly functioning job needed ~5.5 months to reach a 2026 playcut under `id ASC`, because 2026 rows were 3.6% of the cohort and sorted last.

Fix, all three required together (see BS#2218 for the full measurement and decision record):

- **Budget-header suppression** (`lml-fetch.ts`) — `budgetMs: null` unconditionally, the same BS#1914 lever BS#1978 applied to the live enrichment worker's CDC lane. No feature flag: every candidate this job looks up is exactly the cold-release population that needs the full cascade, so there's no adjacent lane to scope suppression away from.
- **`id` tiebreak flipped to newest-first** (`query.ts`) — `id DESC` instead of `id ASC`. The TTL-expired tier still sorts oldest-attempted-first; only its `id` tiebreak rides along to `DESC`, which is immaterial because that tiebreak only arbitrates rows sharing an identical `no_match_recheck_attempted_at` and each stamp is its own single-row UPDATE.
- **OFFSET cursor** (`watermark.ts`, `cronjob_runs.cursor_position`, migration 0152) — a starvation guard independent of the other two: even if some future condition makes a slice of the cohort chronically transient again, the cursor advances past it every run instead of re-reading the identical window forever. Wraps modulo a fresh candidate count, so it never permanently skips a row whose TTL has since expired — it layers on top of the TTL rotation, it doesn't replace it. It advances by however many of the run's candidates are STILL candidates afterwards, not by how many were scanned: a row that got a definitive answer has left the set, and advancing past it too would step over rows the job has never read (a whole batch per run at a healthy resolution rate, deferred until the next wrap). In the all-transient case nothing leaves, so the advance is the full batch and the guard behaves exactly as an outcome-independent one would.

  The cursor's known cost is that it defers the head: a no-match row written today sorts to ordering position 0, and once the cursor has moved off 0 it does not return until it wraps — a fixed `total / BATCH_SIZE` runs, ~5.7 months at the 2026-08-18 numbers. `watermark.ts`'s module doc carries the reasoning for accepting that (the first pass still rescues the backlog newest-first, and a freshly-written no-match already survived a headerless live lookup since BS#1978, so it is a weaker recheck candidate than a historical one) and the shape to reach for if it stops holding.

**Do not stamp the marker on a transient response to force progress** — that was considered and rejected; it would reintroduce the exact false-freeze BS#1977 and BS#2179 review HIGH 2 fixed, one TTL rotation removed.

## The retry marker

`flowsheet.no_match_recheck_attempted_at` (migration 0151 — landed as 0150 originally; renumbered after rebasing past WXYC/Backend-Service#2173's parallel migration, which claimed 0150 first) is a **new** column — deliberately not a reuse of `flowsheet.metadata_attempt_at`. That column's NULL-vs-stamped split is a load-bearing writer discriminator depended on by BS#1011 / BS#895 (the live CDC worker leaves it NULL on no-match rows; only `flowsheet-metadata-backfill` stamps it), and the C6 gap-recovery sweep's candidate predicate reads it. Overloading it would break that discriminator for every row this sweep touches. See `docs/migrations.md`'s "Attempt-at markers" section and `tests/unit/jobs/flowsheet-metadata-backfill/worklist.test.ts`'s exact-match pinning test for the C6 predicate, which asserts this new column never appears there.

Shape mirrors `rotation.discogs_release_id_resolve_attempted_at` (BS#1813/BS#1029, this job's structural donor): stamped on a definitive response (fresh no-match or a trust-gate rejection), left NULL on a transient failure so the row stays eligible. Unlike the donor, eligibility here is not the same as being re-read next run — BS#2218's cursor decides that; see step 6 above.

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

| Var                                                  | Default    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIBRARY_METADATA_URL`                               | (required) | LML service URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LML_API_KEY`                                        | (required) | Bearer for LML auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DB_*`                                               | (required) | Standard postgres connection (host/port/name/username/password)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DRY_RUN`                                            | `false`    | Skip all writes; log planned counts only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS`                | `14`       | Re-attempt a stamped no-match/trust-rejected row only after this many days                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE`              | `200`      | Rows visited per run — the bounded-drip ceiling on LML call volume, independent of how large the total cohort is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BACKFILL_LML_MAX_CONCURRENT`                        | `1`        | Concurrency cap on LML calls (semaphore permits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `BACKFILL_LML_RATE_PER_MIN`                          | `20`       | Token-bucket rate limit on LML calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `FLOWSHEET_NO_MATCH_RECHECK_LML_PER_CALL_TIMEOUT_MS` | `35000`    | Client-side socket-abort safety net (mirrors `flowsheet-metadata-backfill`'s `BACKFILL_LML_PER_CALL_TIMEOUT_MS` default), not a lever that extends how long LML itself searches. **BS#2218:** this caller now sends `budgetMs: null` unconditionally, so `X-Caller-Budget-Ms` never reaches LML — a cold, hard-to-resolve release instead runs LML's full headerless cascade, bounded by LML's own `LML_SEARCH_HARD_TIMEOUT_MS` (25000ms default). This constant is a safety margin ABOVE that hard cap so it only fires on a genuinely wedged connection. `lml-fetch.ts`'s `isUnansweredDegraded` still treats a breaker-open/shed response or a socket `timeout: true` as transient so the row stays retryable |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`                     | `60`       | Defer while a track was added inside this window; `0` disables the probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `LIVE_ACTIVITY_PAUSE_MS`                             | `30000`    | Sleep between live-activity probes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `LIVE_ACTIVITY_MAX_PAUSE_MS`                         | `1800000`  | Cumulative cooperative-pause budget for the whole run; 0 = uncapped. On exhaustion the run aborts rather than pausing indefinitely                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SENTRY_DSN`                                         | —          | Optional; Sentry stays inactive without it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

At the defaults (200 rows / 6h) against a 20/min-capped, concurrency-1 limiter, a run's duration envelope changed materially under BS#2218: pre-fix, every call fast-degraded near the ~4s empty-state cutoff regardless of the rate limiter, so 200 calls fit comfortably under 10 minutes of LML time. Post-fix (`budgetMs: null`), a genuinely cold candidate can now run LML's full cascade up to its own `LML_SEARCH_HARD_TIMEOUT_MS` (25000ms) — concurrency-1 means calls are strictly serialized, so a worst case of 200 calls each taking the full 25s is ~83 minutes, still well inside the 6h cadence window but no longer a ~10-minute run. In practice most calls resolve faster than the hard cap (this is exactly the population BS#1978 measured at 4-20s), so the typical run should land well under the worst case — but the worst case itself is the number to plan capacity/alerting against, not the pre-fix ~10-minute figure.

**Cohort-size (measured 2026-08-18, BS#2218):** 137,340 rows. At the theoretical maximum of 800 rows/day (200 × 4 runs), a full cycle takes ~172 days if every candidate resolves definitively — well past `FLOWSHEET_NO_MATCH_RECHECK_TTL_DAYS`'s 14-day default, so in steady state the TTL is effectively a floor ("at least 14 days between reattempts"), not a guarantee ("every row reattempted every 14 days"). This is the reason the BS#2218 never-attempted tiebreak matters as much as the budget-header fix: without it, the ~172-day cycle spent its early months on the least valuable, most expensive material (2004-2005 rows, 16-30% NULL-album vs 2-5% in recent years) before ever reaching a row a listener can currently see. `FLOWSHEET_NO_MATCH_RECHECK_BATCH_SIZE`/`_TTL_DAYS` are candidates for resizing against this real number; tracked at WXYC/Backend-Service#2186 (which predates this measurement).

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
- **BS#1979** (open, third one-shot drain for the class-5 4s-budget-cutoff cohort): **BS#2218 changed this relationship.** Previously this job stayed registered at LML class 5 sending `X-Caller-Budget-Ms` unconditionally (BS#2179 review HIGH 3), the same ~4s empty-state cutoff that froze BS#1979's cohort in the first place — so a genuinely cold (4-20s) release in that cohort would come back `degraded_reason: 'deadline_exceeded'` under this job too, staying transient (never a false no-match, but never a resolution either) instead of converging. As of BS#2218 this job sends `budgetMs: null` unconditionally, the same headerless posture BS#1979's 59% recovery figure was measured under — so this job's recurring TTL sweep is now expected to genuinely resolve that cohort as it cycles through, not just leave it transient. BS#1979's `blocked_by` graph (#1978 closed + #1995 closed + **#642 "[A.4] Tests, docs, and close-out for flowsheet-metadata-backfill" still open**) is unaffected by this PR; whether #1979's dedicated one-shot is still worth running once this job's steady-state sweep reaches that cohort is worth revisiting once #642 unblocks it, but the headerless-cascade justification for keeping the two mechanisms strictly separate no longer holds the way it did pre-BS#2218.
- **Epic #1810 W4 self-heal** (inside `flowsheet-metadata-backfill`): unchanged by this PR. Its rotation-linked, state-change-gated cohort is a strict subset of what this job now also covers on a timer; it is expected to become low-value redundancy once this job has been running for a few TTL cycles, at which point removing it is a follow-up worth its own small PR (see this ticket's implementer report).

## Related

- Ticket: BS#2176; self-lock fix: BS#2218 (supersedes/closes the follow-up filed as BS#2185)
- One-shot drains this generalizes: BS#1433, BS#1638, BS#1979
- Orphan cohort that motivated the "no owner" framing: BS#1998
- Structural donor (job shape — attempt marker + no-match TTL + cooperative pause): `jobs/rotation-release-id-backfill` (BS#1813/BS#1029)
- Write-shape donor (fill-null COALESCE UPSERT + race guard): `jobs/flowsheet-linked-reenrichment` (BS#1638)
- Trust gate: `shared/lml-client/src/trust.ts` (`isTrustedLmlTrackContextMatch`, BS#1359); sibling un-gated paths tracked at BS#1959
- Seed mechanism: epic #1810 W4 self-heal pass inside `jobs/flowsheet-metadata-backfill`
- Reader-calibration correction: `jobs/metadata-no-match-digest/README.md`
- PR #2179 review follow-ups (filed rather than fixed inline): BS#2185 (deterministic-failure rows starve the NULLS FIRST queue head — **fixed by BS#2218**), BS#2186 (measure the real cohort, revisit TTL/batch defaults — cohort measured by BS#2218; default resizing still open), BS#2187 (no cron-liveness signal), BS#2188 (marker-only UPDATEs broadcast SSE noise)
