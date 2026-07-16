# BS#1591 — flowsheet-metadata-backfill: play-descending priority drain + non-library play-floor

## Goal

Reorder the daily `flowsheet-metadata-backfill` drain from `flowsheet.id` order to **play-descending artist priority**, and exclude — at query time, with zero row mutation — non-library artists below a configurable play-floor (`BACKFILL_NONLIBRARY_PLAY_FLOOR`, default **5**; decision recorded in the 2026-07-13 triage, not re-opened here). This turns the 2026-07-10 8h uniform flood (~82% cache-miss, LML 502s across the live stack) into a front-loaded, bounded drain: the cache-friendly library head (86.1% of play-weighted demand) drains first and cheaply, and the deep uncacheable one-off tail stops consuming Discogs fan-out.

Issue: [WXYC/Backend-Service#1591](https://github.com/WXYC/Backend-Service/issues/1591). All five design decisions in the issue body are taken as given; this plan implements them.

## Chosen shape: in-memory work-list + monotonic array cursor (Design decision 1)

The issue offers two materialization options (scratch table vs in-memory id list). This plan picks the **in-memory ordered list**: one SELECT at run start returns `(id, plays)` for every eligible pending row in priority order; the orchestrator then advances a plain array index over it. Rationale: no runtime DDL, no cleanup-on-crash concern, no postgres-js pinned-connection complication, and the memory cost (~14MB at a 900k-row cohort as two packed number arrays) is well inside the LookupCache's existing ~40MB budget. The wedge-proof property is structural: the cursor is an array index that advances unconditionally, each id appears exactly once in the list, so a failing row (`lml_error` / transient `enrich_error`) can never be re-selected within the run — it stays `metadata_attempt_at IS NULL` and falls to the next run's work-list, identical cross-run retry semantics to today.

Accepted trade-off (documented in the job header): rows inserted _after_ the work-list is built are not picked up mid-run — they wait for the next run. That is the cron's drift-repair role anyway; the live `apps/enrichment-worker` path owns new rows.

## The work-list query (new module `jobs/flowsheet-metadata-backfill/worklist.ts`)

One statement, built with the same `sql` template style as `loadBatch` (raw schema-qualified table refs honoring `WXYC_SCHEMA_NAME`):

```sql
WITH plays AS (
  SELECT wxyc_schema.normalize_artist_name("artist_name") AS artist_norm, COUNT(*)::int AS plays
  FROM wxyc_schema.flowsheet
  WHERE "entry_type" = 'track' AND "artist_name" IS NOT NULL
  GROUP BY 1
),
library_artists AS (
  SELECT wxyc_schema.normalize_artist_name("artist_name") AS artist_norm FROM wxyc_schema.artists
  UNION
  SELECT wxyc_schema.normalize_artist_name("variant") FROM wxyc_schema.artist_search_alias
)
SELECT f."id", p.plays
FROM wxyc_schema.flowsheet f
JOIN plays p ON p.artist_norm = wxyc_schema.normalize_artist_name(f."artist_name")
WHERE f."entry_type" = 'track'
  AND f."artist_name" IS NOT NULL
  AND f."metadata_attempt_at" IS NULL
  AND f."add_time" < now() - interval '60 seconds'
  [AND (f."id" % $count) = $index]          -- partition fragment, when configured
  AND (
    f."album_id" IS NOT NULL                -- linked rows: library by construction (decision 3)
    OR EXISTS (SELECT 1 FROM library_artists la
               WHERE la.artist_norm = wxyc_schema.normalize_artist_name(f."artist_name"))
    OR p.plays >= $floor                    -- non-library above the floor
    OR f."add_time" > now() - ($recencyDays * interval '1 day')  -- recency exemption (decision 5)
  )
ORDER BY p.plays DESC, p.artist_norm ASC, f."id" ASC
```

Points pinned by the design decisions:

- **Play-count source (decision 2):** the `plays` CTE is a per-run flowsheet aggregate over ALL track rows (total popularity, not pending-only). No semantic-index dependency. Grouping key is the SQL function `wxyc_schema.normalize_artist_name(text)` (migration 0092, IMMUTABLE PARALLEL SAFE) so the key cannot drift from the TS twin or the rest of the stack.
- **Library membership (decision 3):** normalized `artists.artist_name` UNION normalized `artist_search_alias.variant` (the BS#1266 substrate — catches name variants). Linked rows (`album_id IS NOT NULL`) are eligible by construction and skip the name check. Note the functional indexes from 0092 (`artists_normalized_name_idx`, `artist_search_alias_normalized_variant_idx`) exist but this query hash-joins whole sets — index use is a bonus, not a requirement.
- **Query-time exclusion (decision 4):** below-floor rows are simply absent from the result. No marker stamp, no status change, no new enum value. An artist that later crosses the floor graduates automatically.
- **Recency exemption (decision 5) — recording the choice:** we implement the _exemption_ variant, not the historical-drain scoping: `add_time > now() - N days` rows are always eligible, `N` from `BACKFILL_FLOOR_RECENCY_DAYS` (default **7**, `0` disables the exemption). When BS#895 re-scopes this cron to an hourly gap-recovery sweep, consumer-missed rows of below-floor artists remain sweepable inside the window, so the recovery role is not poisoned.
- **Ordering:** `plays DESC, artist_norm ASC, id ASC`. The `artist_norm` tiebreaker guarantees same-artist contiguity even when distinct artists share a play count, preserving the run-scoped LookupCache dedup clustering the issue calls out; `id ASC` last makes the order fully deterministic.
- **Floor = 0 disables the floor:** when `BACKFILL_NONLIBRARY_PLAY_FLOOR=0` the whole eligibility disjunction is omitted from the SQL (everything pending is eligible) and the below-floor count is 0 without running the count query.

### Below-floor skipped count (decision 4's consequence)

The pending cohort no longer drains to literal 0 — the retire criterion becomes "pending == below-floor residual" — so the run must report the deliberate residual. Because the work-list's eligibility disjunction partitions the pending set exactly (De Morgan complement), the count is computed **by subtraction**, not by re-running the expensive CTEs: a second, cheap statement counts the total pending cohort using the existing partial index from #659/#660 (`SELECT COUNT(*) FROM flowsheet WHERE entry_type='track' AND artist_name IS NOT NULL AND metadata_attempt_at IS NULL AND add_time < now() - interval '60 seconds' [AND partition]`), and `below_floor_skipped = pending_total - worklist_size`. With floor=0 the eligibility clause is omitted, so the subtraction yields 0 by construction — no special-casing.

The complement identity is what makes subtraction valid; the integration spec asserts it directly against real PG (seeded matrix → `worklist + excluded == pending`). The count lands in a new `below_floor_skipped` totals bucket, the `finished` log line, and a `backfill.below_floor_skipped` numeric attribute on the run-totals Sentry span (BS#1563 convention, set at span creation per BS#1081). `pending_total` is also logged in `worklist_built` for dashboard reconciliation.

Cost + failure-mode note (plan-review finding): the work-list statement is the fleet's first single-SELECT over the whole pending cohort, and it runs once up front — if it exceeded the container's `DB_STATEMENT_TIMEOUT_MS=300000` the nightly run would make zero progress. The `plays` CTE (seq scan + regexp + GROUP BY over ~2.9M track rows) plus the per-pending-row normalize join is expected well inside that budget, but it must be verified, not assumed: **pre-merge, run the work-list statement as `EXPLAIN ANALYZE` against prod-scale data** (prod EC2 read-only, per `reference_running_audit_scripts_on_ec2`). If the margin is thin, the fallbacks are (in order) raising `DB_STATEMENT_TIMEOUT_MS` in `Dockerfile.flowsheet-metadata-backfill` and materializing the `plays` aggregate into a scratch table. The subtraction design above already eliminated the second expensive scan.

Memory note (plan-review finding): the right yardstick is container headroom, not the LookupCache's 40MB budget. Steady-state cost is ~14MB (two packed number arrays at a 900k cohort); the transient peak is higher (~100–150MB) because postgres-js buffers the full result as row objects before we pack them — well inside Node's default heap on the EC2 host. Not worth a `.cursor()` streaming read.

## Orchestrator changes (`orchestrate.ts`)

- `loadBatch(afterId, ...)` (id-cursor SELECT) is **replaced** by `loadBatchByIds(ids)`: `SELECT id, artist_name, album_title, track_title, album_id FROM flowsheet WHERE "id" = ANY($ids) AND "metadata_attempt_at" IS NULL`. The other filter clauses are already guaranteed by work-list membership; only the marker is re-checked so rows enriched mid-run by the worker/runtime drop out _before_ an LML call is spent (the `applyEnrichment` id+marker guard remains the last line of defense). Returned rows are re-ordered in JS to work-list order (`= ANY` does not preserve order).
- Run flow: resolve config → cooperative-pause probe (unchanged, per-batch) → `buildWorkList(...)` once → loop slicing `batchSize` ids off the list, cursor `+= slice.length` unconditionally → per-row `processRow` exactly as today (throttle, cache-hit skip, dead-letter classification all untouched).
- New totals buckets: `below_floor_skipped` (constant per run, from the count query) and `stale_skipped` (work-list ids that didn't come back from `loadBatchByIds` — measures mid-run overlap with the worker; previously this overlap was invisible). Both added to `Totals`, `formatTotals`, `projectTotalsSpan` (`backfill.below_floor_skipped`, `backfill.stale_skipped`), and the log lines.
- New log steps: `worklist_built` (`worklist_size`, `below_floor_skipped`, `build_ms`, `max_plays`, `min_plays`) and `batch_done` gains `batch_plays_max` / `batch_plays_min` — this is how the "first batch of a run is high-play artists" acceptance criterion is verifiable in the batch logs.
- `started` log gains `play_floor` and `floor_recency_days`.
- New injectable `buildWorkList` opt on `runBackfill` (default: the real one) so behavior tests drive ordering/no-wedge without SQL mocks; SQL-shape tests keep using the `db.execute` mock against the real builder.
- `resolvePartitionFilter` unchanged; its fragment now composes into the work-list + count queries (unqualified `"id"` resolves to `f."id"` — no ambiguity, CTEs carry no `id` column).
- Header comment rewritten: the work-list cursor is the new wedge-proof shape (BS#1011 lineage preserved — in-run cursor always advances, failed rows retry next run), plus the mid-run-inserts trade-off note.

## New env resolvers (in `orchestrate.ts`, co-located with `resolveThrottleMs` et al. per the existing resolver-placement convention — plan-review finding)

- `resolvePlayFloor` — `BACKFILL_NONLIBRARY_PLAY_FLOOR`, default `5`, via `requireNonNegativeInt` (`0` disables the floor; misconfig throws loudly at startup).
- `resolveFloorRecencyDays` — `BACKFILL_FLOOR_RECENCY_DAYS`, default `7`, via `requireNonNegativeInt` (`0` disables the recency exemption).

`runBackfill` resolves both and passes the values into `buildWorkList`, which stays a pure SQL module.

## Docs

- `docs/env-vars.md`: new subsection `### flowsheet-metadata-backfill drain shape (BS#1591)` adjacent to the "Backfill LML rate gating" block (NOT under "One-shot backfill jobs" — this is a recurring cron; plan-review finding), documenting both vars: floor semantics, 0-disables, decision-5 recency rationale and the BS#895 interaction.
- `CLAUDE.md` job-table row for `@wxyc/flowsheet-metadata-backfill`: mention play-descending drain + non-library floor (BS#1591).
- `docs/bulk-update-playbook.md`: one short paragraph in the infinite-loop-pitfall section noting the work-list-cursor variant of the wedge-proof recipe (materialize once, advance an index; never re-SELECT head-of-cohort under a value-ordered drain).
- Job header comment (see above).

## Tests (TDD order: each spec lands red first, then the implementation)

Unit — `tests/unit/jobs/flowsheet-metadata-backfill/`:

1. New `worklist.test.ts`:
   - `buildWorkList` SQL shape via `db.execute` mock: pending predicate (entry_type / artist_name / marker / 60s race guard), `normalize_artist_name` grouping + join key, library UNION arms (`artists` + `artist_search_alias`), `album_id IS NOT NULL` arm, floor param, recency arm, `ORDER BY` plays DESC → artist_norm → id, partition fragment composed into both statements.
   - Floor=0: eligibility disjunction omitted; `belowFloorSkipped === 0` (pending count == worklist size by construction).
   - RecencyDays=0: recency arm omitted.
   - Returns `(ids, plays)` in server order; `belowFloorSkipped` computed as `pending_total - worklist_size` from the cheap count statement.
   - `resolvePlayFloor` / `resolveFloorRecencyDays` (in orchestrate.test.ts with their siblings): defaults (5 / 7), parse, `0` accepted, negative/garbage/float throws with the env-var name in the message.
2. `orchestrate.test.ts` rework:
   - Ordering: injected work-list `[ids...]` in play-desc order → `lookup` called in exactly that order across multiple batches (acceptance: play-descending processing).
   - **No-wedge (explicit per acceptance criteria):** head id's lookup throws → `lookup` called exactly once for that id, run terminates normally, `totals.lml_error === 1`, and no subsequent batch SELECT contains that id.
   - `loadBatchByIds` shape: `= ANY` + `metadata_attempt_at IS NULL`; a work-list id missing from the SELECT result → counted `stale_skipped`, not processed, cursor still advances.
   - `below_floor_skipped` propagated to totals + `finished` log; `worklist_built` and `batch_done` plays-range fields present.
   - Existing canonical-WHERE-filter tests updated to the new two-statement shape; cursor-advance test replaced by work-list-slice test.
3. `totals-span.test.ts`: `backfill.below_floor_skipped` + `backfill.stale_skipped` added to the pinned numeric-attribute key set.

Integration — new `tests/integration/flowsheet-metadata-backfill-worklist.spec.js` (pure SQL mirroring the work-list statement, per the sibling upsert spec's convention — "when the job file is hand-edited the SQL here must follow"):

- Seed `artists` (+ one `artist_search_alias` variant) + flowsheet rows across the matrix: high-play non-library, below-floor non-library, below-floor library (by name), below-floor alias-matched, linked (`album_id`), recent below-floor non-library.
- Assert: result order is plays-desc with artist contiguity; below-floor non-library row excluded; library / alias / linked / recent rows included despite the floor; complement property `worklist + below_floor == pending`.
- Exercises the real `normalize_artist_name` SQL function ("The " prefix + case folding) — e.g. seed `The Csillagrablók` vs `csillagrablók` to prove name-form variance doesn't defeat the library exemption.

## Out of scope (per issue)

- LML#755 circuit-breaker (landed), #1199 retry cap, #1339 back-pressure, #1280 Not-on-Discogs skip signal, #1137 shared-limiter unification, and the #895 hourly retune itself (only its floor interaction is guarded here).
- `lml-limiter.ts` values unchanged (`BACKFILL_LML_MAX_CONCURRENT=1`, `BACKFILL_LML_RATE_PER_MIN=20`), cooperative pause unchanged, 60s race guard unchanged.

## Acceptance-criteria map

| Criterion                                                  | Where satisfied                                                                                                  |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Play-descending processing, verifiable in batch logs       | ORDER BY + `batch_plays_max/min` in `batch_done`; unit ordering test                                             |
| Configurable floor, default 5, documented, query-time only | `resolvePlayFloor` + eligibility SQL + env-vars.md; no writes to skipped rows                                    |
| Library artists always enriched; linked always eligible    | `library_artists` UNION arm + `album_id IS NOT NULL` arm; unit + integration tests                               |
| Recency exemption recorded (decision 5)                    | `BACKFILL_FLOOR_RECENCY_DAYS` (default 7) + docs; unit + integration tests                                       |
| No-wedge, explicit test                                    | array-cursor design + orchestrate no-wedge test                                                                  |
| Below-floor skipped count logged (totals + span attr)      | count statement → `below_floor_skipped` bucket + `backfill.below_floor_skipped` span attr; totals-span test      |
| TDD coverage: ordering, floor, library, recency, no-wedge  | unit + integration specs above                                                                                   |
| Rollout observation                                        | post-deploy: watch first cron run's `worklist_built`/`batch_done` logs + LML#683 alert silence (not a unit test) |

## Rollout

Branch `feature/issue-1591` in a worktree; PR closes #1591. No migration. After merge + auto-deploy, observe the next 06:00 UTC run: `worklist_built` totals sane (worklist + below-floor ≈ prior pending count), first batches log high `batch_plays_max`, LML #683 Discogs call-rate alert stays quiet, and the run wall-clock drops versus the 2026-07-10 8h baseline.
