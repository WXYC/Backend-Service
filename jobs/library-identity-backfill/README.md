# @wxyc/library-identity-backfill

One-shot backfill that materializes `library_identity` and `library_identity_source` from the union of existing identity artifacts (per [§4 step 2 of the cross-cache-identity plan](../../plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md)).

The job dispatches one of several **source legs** at runtime via `BACKFILL_LEG`:

| Leg | Sub-PR | Source                                                                                               | Default |
| --- | ------ | ---------------------------------------------------------------------------------------------------- | ------- |
| S1  | 2.0    | Backend `library.canonical_entity_id` → `discogs_release` per-source rows                            | yes     |
| S2  | 2.1    | Backend `artists.{discogs_artist_id, ...}` (mirrored from LML) + LML `reconciliation_log` provenance |         |

Sub-PRs 2.2a, 2.2b, 2.3 extend the enum further. All legs share the dual-table writer (§3.2.2.2) and the §3.4.1.1 main-row recompute.

## What S1 does

For every `library` row where `canonical_entity_id LIKE 'discogs:%'` and which is not already in `library_identity`:

1. Decompose the value into `(library_id, source='discogs_release', external_id=<release_id>, method='exact_match', confidence=1.00)`.
2. Open a `db.transaction()`.
3. `SELECT … FOR UPDATE` on the existing `library_identity` row (defense-in-depth; the primary serialization mechanism is `ON CONFLICT (library_id)`).
4. UPSERT the per-source row into `library_identity_source` with `ON CONFLICT (library_id, source) DO UPDATE`.
5. Recompute the main-row values via `recomputeMainRow()` (§3.4.1.1 composition rules) and UPSERT into `library_identity` with `ON CONFLICT (library_id) DO UPDATE`.

## What S2 does

At job start: bulk-load LML's `entity.identity ⨝ entity.reconciliation_log` from `DATABASE_URL_DISCOGS`, building an in-memory `Map<(library_name, source), {method, confidence}>` provenance index.

For every Backend `library × artists` row where any of the six identity columns is non-null and at least one corresponding `(library_id, source)` pair is missing from `library_identity_source`:

1. Emit up to 6 per-source rows — one per non-null `artists` identity column. Source name maps to `discogs_artist`, `mb_artist`, `wikidata`, `spotify`, `apple_music`, `bandcamp`.
2. For each per-source row, look up `(method, confidence)` in the provenance index. Use the real values when present; fall back to `alias_match 0.85` (tagged `notes='backfill:S2,fallback=no-log'`) for the rare hand-edit case.
3. When ≥2 identity columns are populated, pass `agreementSources = [list of populated sources]` to the writer so the §3.4.1.1 recompute applies Rule 2 → main-row method becomes `cross_source_agreement` with `confidence = MAX(0.95, MIN-of-corroborating-confidences)`.
4. Same dual-table writer + recompute path as S1 (steps 2-5 above), so per-source rows + main-row land atomically.

S1 ↔ S2 cross-source agreement (release-level vs artist-level) is deferred to a follow-up — within-row agreement (multiple sources resolved together by LML's matcher) is enough to land 2.1's gate-improving coverage.

## Run command

Build via the GitHub Actions workflow `Manual Build & Deploy` with `target=library-identity-backfill`, then on EC2:

```bash
# S1 (sub-PR 2.0):
docker run --rm \
  --env-file .env \
  -e BATCH_SIZE=500 \
  -e THROTTLE_MS=100 \
  <ecr-image-uri>:<tag> \
  2>&1 | tee log

# S2 (sub-PR 2.1):
docker run --rm \
  --env-file .env \
  -e BACKFILL_LEG=S2 \
  -e BATCH_SIZE=500 \
  -e THROTTLE_MS=100 \
  <ecr-image-uri>:<tag> \
  2>&1 | tee log
```

`DATABASE_URL_DISCOGS` is required for S2 (the provenance index reader connects to LML's discogs-cache PG).

For a 4-way partitioned run (4 disjoint containers in parallel):

```bash
for i in 0 1 2 3; do
  docker run --rm -d --name lib-id-bf-$i \
    --env-file .env \
    -e PARTITION_INDEX=$i -e PARTITION_COUNT=4 \
    <ecr-image-uri>:<tag>
done
```

## Dry run

Set `DRY_RUN=true` to scan the source rows without writing. The job emits a single JSON object on stdout with a per-leg locked schema:

```json
// S1
{
  "source": "S1",
  "scanned": 64321,
  "would_write_sources": 12450,
  "would_upsert_mains": 12450,
  "skipped": {
    "already_in_library_identity": 51800,
    "no_canonical_entity_id": 70,
    "non_discogs_namespace": 1
  }
}

// S2
{
  "source": "S2",
  "scanned": 12345,
  "would_write_sources": 24680,
  "would_upsert_mains": 12100,
  "skipped": {
    "no_identity_columns": 200,
    "all_sources_already_in_library_identity_source": 45
  }
}
```

The `skipped` keys are stable strings (per leg). For S1, `scanned == would_write_sources + sum(skipped.values())`. For S2, `would_write_sources` exceeds `scanned` because each library row fans out to up to 6 per-source rows; `would_upsert_mains` is bounded by distinct library_ids touched.

```bash
# S1 dry run
docker run --rm --env-file .env -e DRY_RUN=true <ecr-image-uri>:<tag>

# S2 dry run
docker run --rm --env-file .env -e BACKFILL_LEG=S2 -e DRY_RUN=true <ecr-image-uri>:<tag>
```

## Environment variables

See [`docs/env-vars.md`](../../docs/env-vars.md#etl-jobs--one-shot-backfill) for the canonical list. Quick reference:

| Variable               | Default | Purpose                                                                        |
| ---------------------- | ------- | ------------------------------------------------------------------------------ |
| `BACKFILL_LEG`         | `S1`    | Source leg: `S1` (sub-PR 2.0) or `S2` (sub-PR 2.1).                            |
| `DATABASE_URL`         | —       | Backend PostgreSQL connection string (required for both legs)                  |
| `DATABASE_URL_DISCOGS` | —       | LML discogs-cache PG connection string. Required for `BACKFILL_LEG=S2`.        |
| `BATCH_SIZE`           | `500`   | Rows fetched per SELECT cursor batch                                           |
| `THROTTLE_MS`          | `100`   | Inter-row sleep (DB pacing; S1 has no upstream API, S2 reads PG once at start) |
| `PARTITION_INDEX`      | `0`     | Index of this partition (0-based; S1 only — S2 ignores until follow-up)        |
| `PARTITION_COUNT`      | `1`     | Total partition count (use `1` for single-container runs)                      |
| `DRY_RUN`              | unset   | When `true` / `1` / `TRUE`: scan + report on stdout, no writes                 |
| `SENTRY_DSN`           | unset   | Optional; Sentry stays inactive when unset                                     |

## Idempotency & rerun safety

**S1** WHERE filter (library_id-level):

```sql
WHERE canonical_entity_id IS NOT NULL
  AND canonical_entity_id LIKE 'discogs:%'
  AND NOT EXISTS (SELECT 1 FROM library_identity li WHERE li.library_id = library.id)
```

**S2** WHERE filter (per-source granularity, library_id × source-set):

```sql
WHERE (artists.discogs_artist_id IS NOT NULL
       OR artists.musicbrainz_artist_id IS NOT NULL
       OR ... [6 columns total])
  AND NOT EXISTS (
    SELECT 1 FROM library_identity_source lis
    WHERE lis.library_id = library.id
      AND lis.source IN ('discogs_artist','mb_artist','wikidata','spotify','apple_music','bandcamp')
    HAVING count(*) >= [count of populated identity columns on this row]
  )
```

The S2 filter is per-source granularity because S2 may add new sources to a library_id that S1 already wrote. The writer's `ON CONFLICT (library_id, source) DO UPDATE` then handles partial-rerun cases where some sources are written and others aren't.

Already-written rows are skipped; both legs are safely re-runnable. Per-source `notes` are tagged `'backfill:S1'` / `'backfill:S2'` so post-run audit and unwind can identify each leg's contribution.

## Rollback (per §5.3)

```sql
-- 1) Remove the per-source rows for the leg you want to undo
DELETE FROM wxyc_schema.library_identity_source WHERE notes LIKE 'backfill:S1%';
-- or
DELETE FROM wxyc_schema.library_identity_source WHERE notes LIKE 'backfill:S2%';

-- 2) Remove main rows that no longer have any per-source rows
DELETE FROM wxyc_schema.library_identity li
WHERE NOT EXISTS (SELECT 1 FROM wxyc_schema.library_identity_source s WHERE s.library_id = li.library_id);

-- 3) Recompute main rows that lost some sources but still have others (after 2.1+)
-- Run the orchestrator's recompute path against the remaining per-source rows.
```

For partial unwinds (e.g., a single library_id), prefer surgical `DELETE … WHERE library_id = ?` and follow with a recompute on rerun.

## Source confidence assignment (§3.4.1)

**S1** stamps `method='exact_match', confidence=1.00`. Justification: `library.canonical_entity_id` is populated by the existing `library-canonical-entity-backfill` job's "direct hit with release_id" branch, which is the §3.4.1 `exact_match` definition.

**S2** stamps real `(method, confidence)` per-row from LML's `entity.reconciliation_log`. Each per-source row's provenance comes from the latest reconciliation_log entry for that `(library_name, source)` tuple. Methods include `exact_match`, `name_variation`, `member_group`, `alias_match`, `manual` — the actual matcher path LML used. Narrow fallback to `alias_match 0.85` for the rare hand-edit case where `artists.{column}` is non-null but no reconciliation_log entry exists; tagged `notes='backfill:S2,fallback=no-log'` for audit detection.

## Cross-source agreement

The `recomputeMainRow()` function (`recompute.ts`) fully implements the §3.4.1.1 rules: Rule 1 (manual hard floor), Rule 2 (cross-source agreement boost — `MAX(0.95, MIN-of-corroborating-confidences)`), Rule 3 (inherited exclusion), Rule 4 (MIN fallback).

**S1 alone**: one per-source row per library_id, so no agreement (single source).
**S2 within-row agreement**: when an `entity.identity` row has ≥2 populated external IDs, those sources were resolved together by LML's matcher; the resolver passes them as `agreementSources` to the writer, triggering Rule 2 → main-row method becomes `cross_source_agreement` with `confidence=0.95`.
**S1 ↔ S2 agreement (deferred)**: release-level S1 + artist-level S2 corroborate only via release → artist mapping (either Backend's `artists.discogs_artist_id` plus a release→artist resolver, or Wikidata's `discogs_mapping`). Out of scope for sub-PR 2.1; tracked as a follow-up.

## Plan reference

- Plan doc: [`plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md`](../../plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md)
- Parent plan: [`WXYC/wiki` `library-hook-canonicalization-plan.md`](https://github.com/WXYC/wiki/blob/main/plans/library-hook-canonicalization-plan.md) §4 step 2, §3.2.2.2 (writer), §3.4.1 (confidence matrix), §3.2.3 (gate-check)
- Parent epic: [#663](https://github.com/WXYC/Backend-Service/issues/663) (E2 — Backend half)
