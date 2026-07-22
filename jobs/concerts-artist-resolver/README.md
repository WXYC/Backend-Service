# concerts-artist-resolver

Daily cron ETL (BS#1372) that resolves `concerts.headlining_artist_raw` to `concerts.headlining_artist_id`. The `concerts` substrate (#1347) ships `headlining_artist_id` as nullable; the venue-events scraper (#1343) writes the raw name and leaves the FK NULL. This job fills the FK in via local-only matching against `artists` and `artist_search_alias` (no LML round-trip), keeping iOS and dj-site free to JOIN on `headlining_artist_id` instead of falling back to a brittle raw-name JOIN.

## Resolution strategy

Local-only. Both arms use the canonical `wxyc_schema.normalize_artist_name(text)` SQL function (migration 0092) — lowercase + strip a leading `the\s+`. The TypeScript twin lives at `shared/database/src/normalize-artist-name.ts` so any caller (this job, a future iOS canonical-id matcher, a sibling resolver) normalizes the same way.

Two arms, run per row:

1. **Strict.** `normalize_artist_name(headlining_artist_raw) = normalize_artist_name(a.artist_name)`. Backed by `artists_normalized_name_idx`.
2. **Alias.** `normalize_artist_name(headlining_artist_raw) = normalize_artist_name(asa.variant)` against `artist_search_alias`. Backed by `artist_search_alias_normalized_variant_idx`. Fires **only when strict returns zero matches** (strict-wins).

Each arm runs `LIMIT 2` against a `SELECT DISTINCT artist_id` so the orchestrator can distinguish singleton vs. ambiguous in one round-trip. Multiple variants for the same canonical artist count as one match (the `DISTINCT` collapses them). Multiple distinct `artist_id`s → `ambiguous`, leaves the FK NULL.

The conservative bias matches the substrate intent: NULL is the documented steady state, not a defect. Known consequence — `artists` has ~235 groups with duplicate `artist_name` values; concerts whose raw name collides with those stay NULL forever under this rule. The trade is intentional — accept low recall in exchange for zero wrong-FK writes.

## Idempotency + race-safety

- SELECT predicate: `headlining_artist_id IS NULL AND headlining_artist_raw IS NOT NULL AND ("title" IS NULL OR "title" !~* '\mtribute') AND "headlining_artist_raw" !~* '\mtribute'`. Already-resolved rows are never re-examined; the resolver is write-once-trust-forever. The tribute arms exclude tribute-context rows outright: in a tribute-framed event the billed name belongs to — or aliases — the honoree, not the performer, so any match either arm finds is a mislabel by construction (the Stanczyks "REM Tribute to Lifes Rich Pageant" row alias-resolved to the real R.E.M. and reached the iOS For You shelf). Word-start `\m` so a name like "Tributaries" doesn't trip it; a genuinely in-library tribute act staying NULL is the same low-recall/zero-wrong-FK trade as the singleton rule.
- UPDATE WHERE clause: `id = ? AND headlining_artist_id IS NULL`. A concurrent pod or a scraper write that lands between SELECT and UPDATE manifests as a 0-row UPDATE which the orchestrator counts as `raced` rather than `resolved`.
- A later alias-substrate refresh that would now resolve a previously-unmatched row picks it up on the next cron run. A later alias-substrate refresh that would now produce a _different_ singleton for an already-resolved row does **not** self-heal — that's the conservative-singleton-only trade.

### Known limitation: scraper raw-name updates don't invalidate the FK

The `venue-events-scraper` UPSERT writes a fresh `headlining_artist_raw` on every re-scrape (see `jobs/venue-events-scraper/writer.ts` — the `set` clause includes the raw column). If a venue upgrades an opener to headliner before show date — common when a pre-sale promo gets bumped — the raw column changes but `headlining_artist_id` doesn't (this resolver's WHERE clause skips non-NULL FK rows). The concert ends up with raw="Spoon" pointing at the artist row for Pavement. Follow-up captured separately; the safe fix is for the scraper to NULL the FK when it overwrites the raw, but that crosses substrate boundaries and is out of scope here.

## Recurring drain

Cron schedule `15 5 * * *` UTC, registered via the `cron-schedule` field in `package.json` and picked up by `.github/workflows/deploy-base.yml` on merge to main.

Cadence rationale:

- `artist-search-alias-consumer` at `15 4 * * *` (alias substrate refreshed)
- `venue-events-scraper` at `0 5 * * *` (#1343 — new concerts written)
- `concerts-artist-resolver` at `15 5 * * *` (this job — pick up the new rows)

Crontab has no dependency semantics; ordering is best-effort by wall clock. If the scraper runs late, the resolver runs on the prior day's data; the next run picks up the missed rows. Acceptable.

Per-row no-op when nothing new matches. Steady state: one indexed `WHERE IS NULL` query, near-zero work.

## Run shape

```bash
docker run --rm --env-file .env <image>
```

Required env: `DB_*` (postgres connection).

Optional env: `SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`.

## Counters

The run-end log line and Sentry span carry:

| field                       | meaning                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `resolver.scanned`          | Rows read by the SELECT (including `null_raw_skipped`).                                  |
| `resolver.resolved`         | Rows whose `headlining_artist_id` was stamped (sum of strict + alias).                   |
| `resolver.resolved_strict`  | Singleton matches from the strict arm.                                                   |
| `resolver.resolved_alias`   | Singleton matches from the alias arm (fired only on zero strict).                        |
| `resolver.ambiguous`        | >1 distinct `artist_id` after dedup → FK stays NULL.                                     |
| `resolver.unmatched`        | Zero matches from both arms → FK stays NULL.                                             |
| `resolver.null_raw_skipped` | Defensive — production SELECT filters NULL `headlining_artist_raw`. Should be 0 in prod. |
| `resolver.error`            | Transient resolver failure (e.g. PG timeout). Row stays NULL; retried next run.          |
| `resolver.raced`            | Writer's WHERE clause matched 0 rows — a concurrent run set the FK first.                |

## Tests

```bash
npm run test:unit -- tests/unit/jobs/concerts-artist-resolver tests/unit/database/normalize-artist-name.test.ts
```

The orchestrator is dep-injected so the unit tests drive the loop with in-memory resolver / loader / writer doubles. The TypeScript twin's test pins the byte-identical output the SQL function must produce.

## Pattern reference

- `jobs/rotation-release-id-backfill/` — dep-injected resolver shape (`loadCandidates → lookup → write`).
- `jobs/artist-search-alias-consumer/` — daily cron via `cron-schedule` in `package.json`.
