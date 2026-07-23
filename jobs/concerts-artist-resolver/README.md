# concerts-artist-resolver

Daily cron ETL. Originally BS#1372 (headliner-only); extended to a four-step run by BS#1760 (parent #1618, On Tour epic #1588) to also sync and resolve support-act performers. The `concerts` substrate (#1347) ships `headlining_artist_id` as nullable and, since migration 0128, a `concert_performers` junction table for per-performer identity (#1759). This job fills both in via local-only matching against `artists` and `artist_search_alias` (no LML round-trip), keeping iOS and dj-site free to JOIN on resolved ids instead of falling back to a brittle raw-name JOIN.

## Run shape — four ordered steps in one cron

Folding sync + support resolve into this job (rather than a standalone cron) gives a hard step-ordering guarantee two crons scheduled minutes apart via deploy-base cannot provide — sync must run before the support resolve arm consumes the junction it just populated.

1. **Sync** `concert_performers` (role=`support`) from `concerts.supporting_artists_raw`. See [Sync step](#sync-step-concert_performers-from-supporting_artists_raw) below.
2. **Headliner resolve** — unchanged from BS#1372. See [Resolution strategy](#resolution-strategy) below.
3. **Support resolve arm** — the same strict-then-alias `resolveArtistId` function (reused verbatim), applied to `concert_performers` rows via a bespoke loop + junction writer. See [Support resolve arm](#support-resolve-arm) below.
4. **Recompute** `concerts.has_resolved_support` — a single set-based UPDATE, windowed recompute-from-truth. See [has_resolved_support recompute](#has_resolved_support-recompute) below.

Steps run strictly in sequence inside one try block in `job.ts`: a fatal failure in an earlier step aborts the remaining steps for that run (mirrors how `album-reviews-etl`'s link pass is allowed to fail the whole cron loudly). Per-row/per-concert failures WITHIN a step never abort that step's own loop — `runSync`, `runResolver`, and `runSupportResolver` each catch and count per-item errors internally.

## Resolution strategy

Local-only. Both the headliner arm and the support arm use the canonical `wxyc_schema.normalize_artist_name(text)` SQL function (migration 0092) — lowercase + strip a leading `the\s+`. The TypeScript twin lives at `shared/database/src/normalize-artist-name.ts` so any caller (this job, a future iOS canonical-id matcher, a sibling resolver) normalizes the same way.

Two arms, run per name:

1. **Strict.** `normalize_artist_name(raw) = normalize_artist_name(a.artist_name)`. Backed by `artists_normalized_name_idx`.
2. **Alias.** `normalize_artist_name(raw) = normalize_artist_name(asa.variant)` against `artist_search_alias`. Backed by `artist_search_alias_normalized_variant_idx`. Fires **only when strict returns zero matches** (strict-wins).

Each arm runs `LIMIT 2` against a `SELECT DISTINCT artist_id` so the caller can distinguish singleton vs. ambiguous in one round-trip. Multiple variants for the same canonical artist count as one match (the `DISTINCT` collapses them). Multiple distinct `artist_id`s → `ambiguous`, leaves the id NULL.

The conservative bias matches the substrate intent: NULL is the documented steady state, not a defect. Known consequence — `artists` has ~235 groups with duplicate `artist_name` values; names whose raw form collides with those stay NULL forever under this rule. The trade is intentional — accept low recall in exchange for zero wrong-FK writes.

This exact function (`resolveArtistId` in `query.ts`) is reused **verbatim** by the support resolve arm (step 3) — it is candidate-agnostic by construction (`(raw: string) => Promise<ResolveOutcome>`), so no headliner-specific coupling needs to be threaded through.

## Sync step: `concert_performers` from `supporting_artists_raw`

Populates and reconciles the `concert_performers` junction (role=`support`) from each upcoming, non-tombstoned concert's `supporting_artists_raw` array (BS#1758 billing-tail capture). Implemented as a pure per-concert diff (`sync.ts`'s `diffConcertPerformers`, unit-testable with no DB) plus a dep-injected orchestrator loop (`sync.ts`'s `runSync`) wired to real I/O in `sync-db.ts`.

- **Idempotent UPSERT.** One row inserted per array element, `ON CONFLICT (concert_id, role, raw_name) DO NOTHING`. A name already present as an active row is a no-op — this is what makes a re-run against unchanged input insert nothing new.
- **Array-shrink → soft-tombstone.** An active row whose name fell out of the array gets `removed_at` set to `now()`. **Never hard-deleted** — a tombstoned row retains `artist_id` / `discogs_artist_id` / `artist_resolve_attempted_at`, so a later re-bill doesn't force the (future Phase-D) LML arm to re-spend its budget re-resolving a name that was already resolved once.
- **Reappearance → un-tombstone.** A tombstoned row whose name is back in the array gets `removed_at` cleared. Mirrors the concerts writer's own both-directions `removed_at` policy (`triangle-shows-etl/writer.ts`).
- A row that's both absent from the array and already tombstoned, or both present and already active, produces **no diff** — `runSync` never calls the writer for an empty diff, which is what makes a re-run against unchanged input a true no-op (no writes issued, not just writes that affect zero rows).

**Candidate scope + independence from the parent concert's tombstone.** The concert-level `ON DELETE CASCADE` on `concert_performers.concert_id` rarely fires — concerts soft-delete via `removed_at`, not a hard delete — so a `concert_performers` row does **not** automatically inherit its parent concert's tombstone. The sync's candidate scope (which concerts get synced at all) and the support resolve arm's candidate scope (step 3) each **independently** filter `concerts.removed_at IS NULL AND starts_on >= todayEastern` — a support row on a since-tombstoned concert is excluded from the support resolve arm even though the junction row itself still shows `removed_at IS NULL`.

## Support resolve arm

**Bespoke loop** (`support.ts`'s `runSupportResolver`) — deliberately **not** `runResolver`/`writeArtistId` from `orchestrate.ts`/`writer.ts`. Those are headliner-shaped: the `Candidate` type carries `headlining_artist_raw` and the writer hardcodes `concerts.headlining_artist_id`. The support arm reuses only the pure `resolveArtistId(raw) → outcome` function itself (see [Resolution strategy](#resolution-strategy)) plus its `ResolveFn`/`ResolveOutcome` type contract.

Candidate predicate (`support-db.ts`'s `loadSupportCandidates`): unresolved, active junction rows joined to an upcoming, non-tombstoned concert —

```sql
WHERE cp.role = 'support'
  AND cp.artist_id IS NULL
  AND cp.removed_at IS NULL
  AND cp.raw_name !~* '\mtribute'
  AND c.removed_at IS NULL
  AND c.starts_on >= (now() AT TIME ZONE 'America/New_York')::date
```

**Tribute guard is RAW-NAME-ONLY** — a deliberate divergence from the headliner arm's `loadCandidates` (`query.ts`), which also excludes on `title !~* '\mtribute'`. The concert title frames the **headliner** slot; a support act billed at a tribute-titled show is a real opener, not a mislabeled honoree, so only the performer's own raw name gates candidacy here.

The writer (`support-db.ts`'s `writeSupportArtistId`) is fill-NULLs-only (`WHERE id = ? AND artist_id IS NULL`) and stamps **no attempt-at marker** — `concert_performers.artist_resolve_attempted_at` (migration 0128) binds only the future Phase-D LML arm (see `docs/migrations.md`'s "Attempt-at markers" section). Ambiguous and unmatched names leave `artist_id` NULL with no marker either, matching today's headliner SQL arm exactly.

## `has_resolved_support` recompute

A single set-based UPDATE (`recompute.ts`'s `recomputeHasResolvedSupport`), windowed to the active concert set (`removed_at IS NULL AND starts_on >= todayEastern`), recomputing from truth every run:

```sql
has_resolved_support = EXISTS (
  SELECT 1 FROM concert_performers cp
  WHERE cp.concert_id = concerts.id
    AND cp.role = 'support'
    AND cp.removed_at IS NULL
    AND (cp.artist_id IS NOT NULL OR cp.discogs_artist_id IS NOT NULL)
)
```

**Why a recompute and not a same-transaction boolean flip at resolve time:** a one-directional flip can't handle the down-transition (tombstone the only resolved support → must go false) without decrement bookkeeping — the exact drift surface a `count` column was rejected to avoid when the substrate landed (migration 0128). A windowed recompute-from-truth is idempotent, handles resolve **and** tombstone/un-tombstone uniformly with the same formula, and is O(upcoming concerts) — hundreds to low-thousands, trivial at this scale.

**Dual-lane resolved predicate** (`artist_id IS NOT NULL OR discogs_artist_id IS NOT NULL`) mirrors the headliner curated predicate — a support act counts as resolved via the library FK (this job's Phase B arm) **or** a bare Discogs id (the future Phase D LML arm). Because that LML arm doesn't exist yet, only the `artist_id` lane is populated in production today; the predicate is written dual-lane now so the future arm's writes are picked up without a query change.

The UPDATE is guarded `WHERE has_resolved_support IS DISTINCT FROM <computed>` so an unchanged flag is never rewritten — `last_modified` only advances on a genuine transition, mirroring the `setWhere`-guarded no-op-skip convention the concerts writers use (`venue-events-scraper`, `triangle-shows-etl`).

A concert that ages out of the active window (past show, or tombstoned) keeps whatever `has_resolved_support` value it last had — nothing un-recomputes a past show.

## Idempotency + race-safety

- **Headliner arm** (unchanged): SELECT predicate `headlining_artist_id IS NULL AND headlining_artist_raw IS NOT NULL AND ("title" IS NULL OR "title" !~* '\mtribute') AND "headlining_artist_raw" !~* '\mtribute'`. UPDATE WHERE clause: `id = ? AND headlining_artist_id IS NULL`. See the [Known limitation](#known-limitation-scraper-raw-name-updates-dont-invalidate-the-fk) below.
- **Sync step**: idempotent on `(concert_id, role, raw_name)` via the UNIQUE index from migration 0128; see [Sync step](#sync-step-concert_performers-from-supporting_artists_raw) above.
- **Support arm**: SELECT predicate gates on `artist_id IS NULL AND removed_at IS NULL`; UPDATE WHERE clause `id = ? AND artist_id IS NULL`. A concurrent pod racing this job manifests as a 0-row UPDATE, counted as `raced` rather than `resolved`.
- **Recompute**: `IS DISTINCT FROM`-guarded, so re-running against unchanged state updates zero rows.

A later alias-substrate refresh that would now resolve a previously-unmatched row (either arm) picks it up on the next cron run. A later alias-substrate refresh that would now produce a _different_ singleton for an already-resolved row does **not** self-heal — that's the conservative-singleton-only trade, same for both arms.

### Known limitation: scraper raw-name updates don't invalidate the FK

The `venue-events-scraper` UPSERT writes a fresh `headlining_artist_raw` on every re-scrape (see `jobs/venue-events-scraper/writer.ts` — the `set` clause includes the raw column). If a venue upgrades an opener to headliner before show date — common when a pre-sale promo gets bumped — the raw column changes but `headlining_artist_id` doesn't (this resolver's WHERE clause skips non-NULL FK rows). The concert ends up with raw="Spoon" pointing at the artist row for Pavement. Follow-up captured separately; the safe fix is for the scraper to NULL the FK when it overwrites the raw, but that crosses substrate boundaries and is out of scope here.

## Recurring drain

Cron schedule `15 5 * * *` UTC, registered via the `cron-schedule` field in `package.json` and picked up by `.github/workflows/deploy-base.yml` on merge to main.

Cadence rationale:

- `artist-search-alias-consumer` at `15 4 * * *` (alias substrate refreshed)
- `venue-events-scraper` at `0 5 * * *` (new concerts written)
- `triangle-shows-etl` at `5 5 * * *` (the other concerts source written)
- `concerts-artist-resolver` at `15 5 * * *` (this job — all four steps)
- `concerts-artist-lml-resolver` at `35 5 * * *` (the future Phase D LML arm; runs after this job so both this job's SQL arms get first claim)

Crontab has no dependency semantics; ordering is best-effort by wall clock. If an upstream scraper runs late, this job runs on the prior day's data; the next run picks up the missed rows. Acceptable.

Per-row/per-concert no-op when nothing new matches. Steady state: a handful of indexed queries, near-zero work.

## Invocation

```bash
docker run --rm --env-file .env <image>
```

Required env: `DB_*` (postgres connection).

Optional env: `SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`.

No job-specific env vars beyond the shared observability ones above — neither the sync step nor the support arm has a TTL/budget knob (that concept belongs to the future Phase D LML arm, which spends an external API budget; this job's SQL arms are free local queries).

## Counters

The run-end log lines and Sentry spans (`${JOB_NAME}.run.sync_totals`, `.run.totals`, `.run.support_totals`, `.run.recompute_totals`) carry:

**Sync** (`sync.*`)

| field              | meaning                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `concerts_scanned` | Upcoming, non-tombstoned concerts read.                                  |
| `concerts_changed` | Of those, how many had a non-empty diff (applyDiff was actually called). |
| `inserted`         | New `concert_performers` rows inserted.                                  |
| `untombstoned`     | Rows whose `removed_at` was cleared (name reappeared).                   |
| `tombstoned`       | Rows whose `removed_at` was set (name dropped from the array).           |
| `error`            | Per-concert write failures (caught, counted, loop continues).            |

**Headliner resolve** (`resolver.*`, unchanged from BS#1372) — see the field table this job has always had: `scanned`, `resolved`, `resolved_strict`, `resolved_alias`, `ambiguous`, `unmatched`, `null_raw_skipped`, `error`, `raced`.

**Support resolve arm** (`support.*`)

| field             | meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `scanned`         | Candidate junction rows read.                                         |
| `resolved`        | Rows whose `artist_id` was stamped (sum of strict + alias).           |
| `resolved_strict` | Singleton matches from the strict arm.                                |
| `resolved_alias`  | Singleton matches from the alias arm.                                 |
| `ambiguous`       | >1 distinct `artist_id` after dedup → id stays NULL.                  |
| `unmatched`       | Zero matches from both arms → id stays NULL.                          |
| `error`           | Transient resolver/writer failure. Row stays NULL; retried next run.  |
| `raced`           | Writer's WHERE clause matched 0 rows — a concurrent run set it first. |

**Recompute** (`recompute.*`)

| field           | meaning                                                          |
| --------------- | ---------------------------------------------------------------- |
| `updated`       | Concerts whose `has_resolved_support` actually flipped this run. |
| `updated_true`  | Of those, how many flipped to `true`.                            |
| `updated_false` | Of those, how many flipped to `false`.                           |

## Tests

```bash
npm run test:unit -- tests/unit/jobs/concerts-artist-resolver tests/unit/database/normalize-artist-name.test.ts
npm run test:integration -- tests/integration/concerts-artist-resolver-support.spec.js
```

Unit tests are dep-injected (no PG/LML): `orchestrate.test.ts` / `query.test.ts` (headliner arm, unchanged), `sync.test.ts` (the pure `diffConcertPerformers` diff + the `runSync` loop), `sync-db.test.ts` (SQL-contract + outcome-shape tests for the I/O), `support.test.ts` (the bespoke `runSupportResolver` loop), `support-db.test.ts` (SQL-contract tests for the candidate predicate + writer), `recompute.test.ts` (SQL-contract + outcome-counting tests), `error-sink.test.ts` (the shared onError-sink guard sync.ts/support.ts both use).

The `pg` integration spec (`concerts-artist-resolver-support.spec.js`) exercises sync → resolve → recompute end-to-end against a real Postgres: sync idempotency, array-shrink tombstone + reappearance untombstone, strict/ambiguous support resolution, the raw-name-only tribute guard, and every `has_resolved_support` transition (resolve → tombstone → un-tombstone, the dual-lane predicate, recompute idempotency).

The TypeScript twin's test (`normalize-artist-name.test.ts`) pins the byte-identical output the SQL function must produce.

## Pattern reference

- `jobs/rotation-release-id-backfill/` — dep-injected resolver shape (`loadCandidates → lookup → write`).
- `jobs/artist-search-alias-consumer/` — daily cron via `cron-schedule` in `package.json`; its writer is the precedent for the parameterised-VALUES pattern this job's sync writer uses for text arrays (never a `'{...}'::text[]` literal — the BS#1068-1073 corruption trap).
- `jobs/concerts-artist-lml-resolver/` — the sibling job that will add the Phase D LML arm for `concert_performers` (support rows whose `artist_id` this job's SQL arm couldn't fill); its `targets.ts` is the role-agnostic `(raw_name → verdict → row targets)` shape that arm will extend.
