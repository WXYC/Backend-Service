# BS#974 — library-identity-consumer: cover NULL `canonical_entity_id` rows (behind a flag, with a hot-loop stop-condition)

## Problem

`jobs/library-identity-consumer`'s SELECT predicate (post-#1144) only considers rows with `canonical_entity_id IS NOT NULL`:

```sql
canonical_entity_id IS NOT NULL
AND (NOT EXISTS(library_identity li for this row) OR EXISTS(stale li))
```

So the ~34K `canonical_entity_id IS NULL` library rows — including the ~6,300 V/A compilation rows (#801) machine-populated with NULL canonical ids — are never scanned. The 2026-05-20 prod dry-run confirmed it: `compilation=0` because LML never saw a V/A row. #830 (matched_via.source distribution) and dj-site#520 (rotation-tracks dropdown) can't be answered until the full library is in scope.

Naively adding the NULL-canonical rows creates a **hot-loop**: an unresolved NULL-canonical row never lands in `library_identity` (only resolved rows do), so `NOT EXISTS(li)` stays true forever → re-attempted every run, burning LML quota. #974's acceptance calls for a stop-condition + a feature flag for staged rollout. (This is exactly why #974 was split from #1144's narrow fix.)

## Deployment model (load-bearing correction)

This job is **one-shot / manually run** — `package.json` declares `"job-type": "one-shot"` with no `cron-schedule`, the README opens "One-shot ETL job" run via manual `docker run`, and it is in **no** cron registration or `docs/ops-cron-scheduling.md`. So, unlike the cron-backed attempt-at markers (`metadata_attempt_at`, `concert_performers.artist_resolve_attempted_at`), the new marker's "re-attempt the NULL/stale set" step has **no automatic backstop**: a stamped-unresolved row is only re-attempted when an operator re-runs the job past the staleness window. Converting the job to a cron is explicitly out of scope (it's LML-heavy → the `docs/ops-cron-scheduling.md` slot-exclusivity policy would apply; that's a separate decision). All "subsequent runs" language below means **subsequent manual re-runs**.

## End state

- The consumer covers the full library on a run **when the flag is on**, so the ~34K NULL-canonical rows (incl. the V/A compilations) finally reach LML.
- **Flag off = byte-identical to today's #1144 behavior** (zero-change deploy, then flip).
- A subsequent manual re-run within the staleness window does **not** re-burn LML on the still-unresolved rows (the marker dedups); past the window they become eligible again (LML data may have improved).

## Design

### 1. Migration (DDL-only) — `library.unresolved_attempted_at`

`ALTER TABLE library ADD COLUMN IF NOT EXISTS unresolved_attempted_at timestamptz;` (nullable, default NULL). A new **attempt-at marker**: stamped when LML _responded_ with a definitive non-resolution (`unresolved`/`compilation`), left NULL on transient failures so they stay retryable. Schema.ts adds the column next to `canonical_entity_id`.

**Migration number is provisional** — `0129` is already claimed by the in-flight `feature/1762-curated-support` branch, and `main` is at `0128`. Run `npm run drizzle:generate` at implementation time to claim the next free idx, follow the `when = previous_entry.when + 1ms` journal recipe (docs/migrations.md), and hand-verify the SQL is the single `ADD COLUMN IF NOT EXISTS` (drizzle-kit sometimes emits extra churn). Whichever of the two branches merges second renumbers per docs/migrations.md §parallel-PR collisions. (Landed as 0130 — #1762 merged first.)

**No index** — the SELECT is driven by the `library.id` PK id-cursor (`id > afterId ORDER BY id LIMIT n`) over a 64K-row table; the marker is a per-row column filter, not a scan driver (unlike flowsheet's millions).

### 2. Feature flag — `INCLUDE_NULL_CANONICAL` (default false)

`resolveIncludeNullCanonical(raw)` in `select.ts`, mirroring `resolveDryRun`. Off → the existing predicate verbatim. On → the expanded predicate.

### 3. Predicate (`loadBatch` gains a **trailing** `includeNullCanonical` param, default `false`)

Appended last so the existing `tests/unit/jobs/library-identity-consumer/select.test.ts` calls `loadBatch(0, 500, null, 7)` keep their flag-off behavior and their `canonical_entity_id`-present assertions.

- **Off** (unchanged #1144):
  ```sql
  artist_name IS NOT NULL AND canonical_entity_id IS NOT NULL
  AND (NOT EXISTS(li) OR EXISTS(stale li))
  ```
- **On** (expanded; drops the canonical filter, adds the marker gate to the first-time clause):

  ```sql
  artist_name IS NOT NULL AND (
    EXISTS(stale li)                       -- re-verify any resolved row when its identity ages out (staleDays)
    OR (
      NOT EXISTS(li)                       -- never resolved into library_identity
      AND (unresolved_attempted_at IS NULL OR unresolved_attempted_at < NOW() - unresolvedRetryDays)
    )
  )
  ```

  This is the post-#1144 form of the ticket's proposed three-way OR. It also fixes the pre-existing canonical-unresolved hot-loop (those rows now honor the marker too) — exactly what the acceptance criterion asks.

  **The unresolved-retry window is a SEPARATE knob** — `UNRESOLVED_RETRY_DAYS` (default 30, its own `resolveUnresolvedRetryDays` resolver mirroring `resolveStaleThreshold`), NOT the 7-day `STALE_THRESHOLD_DAYS` identity-freshness window. Matches the fleet convention (`CONCERTS_ARTIST_RESOLVE_NO_MATCH_TTL_DAYS`=30) and avoids weekly LML re-burn on rows unlikely to newly resolve — the exact quota concern #974 exists to solve. `loadBatch` gains a trailing `unresolvedRetryDays` param too (default 30).

### 4. Writer stamping — `stampUnresolvedAttemptedAt(ids)` in `writer.ts`

`UPDATE library SET unresolved_attempted_at = NOW() WHERE id = ANY($ids::int[])` (array-literal bind per BS#1071/#1072, no per-row splat). Called per batch (flag-on, non-dry-run) for the library_ids whose result kind is **`unresolved` or `compilation`** only. **Not** stamped on: `single_artist` (the `library_identity` row IS its marker), `writer_error`/`lml_error`/`lml_cardinality_mismatch`/`lml_untrusted_library_id` (transient/protocol — stay retryable). Mirrors the `metadata_attempt_at` "responded vs transient" split.

### 5. Orchestrator threading

`runConsumer` gains **optional** opts fields — `includeNullCanonical?` (default `false`) + `stampUnresolvedAttemptedAt?` (default a no-op fn) — so the ~9 existing `runConsumer({...})` calls in `orchestrate.test.ts` that omit them keep compiling. Collect `unresolved`+`compilation` ids per batch into an array; after the result loop, stamp them (flag-on, non-dry-run). Dry-run counts them (would_unresolved / would_skip.compilation) but writes nothing. **Do NOT add a field to `DryRunReport`** — `orchestrate.test.ts` locks its exact key set; the existing `rows_unresolved` + `rows_skipped.compilation` already count the stamped set. (A `Totals`-only breadcrumb would be schema-safe but isn't needed; skip it.)

### 6. Wiring — `job.ts`

Resolve `INCLUDE_NULL_CANONICAL`, pass to `runConsumer`; inject `writer.stampUnresolvedAttemptedAt`. Log the flag in the `started` line.

### 7. Staged rollout (ops — the human cutover, not this PR)

The job is invoked manually (`docker run … library-identity-consumer` with env), so "rollout" = the env the operator passes:

1. Merge + deploy the image with `INCLUDE_NULL_CANONICAL` unset → a manual run behaves exactly as #1144 (zero-change verification).
2. Manual dry-run with `INCLUDE_NULL_CANONICAL=true DRY_RUN=true` → confirm `scanned ≈ 64,676` and `would_skip.compilation > 0` (V/A rows now classified).
3. Optionally subset-first via the existing `PARTITION_INDEX`/`PARTITION_COUNT`.
4. Manual live drain with `INCLUDE_NULL_CANONICAL=true`. Re-runs past the staleness window re-check the still-unresolved set (no cron does this automatically — see Deployment model).

## Tests (TDD)

All under `tests/unit/jobs/library-identity-consumer/` (centralized, not co-located):

- `select.test.ts`: existing flag-off calls (`loadBatch(0, 500, null, 7)`) keep asserting `canonical_entity_id IS NOT NULL` present + no `unresolved_attempted_at`; new flag-on calls (5th arg `true`) assert the canonical filter is dropped and the `unresolved_attempted_at` marker gate is present. (String-shape assertions matching the file's existing style, plus — if the integration harness reaches it — a behavioral fixture: a NULL-canonical row with a fresh `unresolved_attempted_at` is excluded, a NULL-marker one is included.)
- `writer` test: `stampUnresolvedAttemptedAt([1,2])` issues one `= ANY('{1,2}'::int[])` UPDATE; empty array is a no-op (no query).
- `orchestrate.test.ts`: with flag-on, `unresolved` + `compilation` ids are passed to the stamp fn; `single_artist` + `writer_error` + `lml_error` ids are NOT; dry-run stamps nothing; flag-off stamps nothing.

## Docs

- `docs/migrations.md` §Attempt-at markers: bump the opening count (**"Five" → "Six"**) and add the `library.unresolved_attempted_at` entry. Must call out **two deviations** from the section's "shared shape": (1) stamped on **definitive no-match only** (`unresolved`/`compilation`) — a `single_artist` success is recorded by the `library_identity` row instead, unlike the five stamp-on-both markers; (2) re-attempt is **manual-only (no cron backstop)**, the opposite risk profile from the cron-backed markers.
- Consumer `README.md`: the flag, the marker, the manual staged-rollout steps.
- `docs/env-vars.md`: `INCLUDE_NULL_CANONICAL` + `UNRESOLVED_RETRY_DAYS`.
- CLAUDE.md workspace-table row for the consumer: note the flag + marker.

## Non-goals / out of scope

- Compilation (V/A) _resolution_ stays #801's job — this PR only brings them into scope + stamps them so a manual re-run doesn't redundantly re-attempt them within the window. **Note for BS#801:** compilations resolve into per-track tables, not the main `library_identity` row, so `NOT EXISTS(li)` stays true for them and the marker will re-eligible them every window forever (bounded, not a hot-loop). #801 should revisit the compilation gate (treat a populated per-track identity as the "resolved" signal) so they aren't perpetually re-attempted.
- Converting the job from one-shot to a cron (LML-heavy slot policy applies) — separate decision.
- The actual prod drain (the ops cutover above) is the human's, not this PR.
- No change to `writeSingleArtist` / `library_identity` write path.
