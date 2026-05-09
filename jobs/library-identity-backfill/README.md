# @wxyc/library-identity-backfill

One-shot backfill that materializes `library_identity` and `library_identity_source` from the union of existing identity artifacts (per [§4 step 2 of the cross-cache-identity plan](../../plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md)).

This package is the **skeleton + S1 leg** (sub-PR 2.0). Sub-PRs 2.1-2.4 add the remaining four sources; 2.0 stands up the dual-table writer (§3.2.2.2) and the §3.4.1.1 main-row recompute, exercising them with the simplest source (Backend's own `library.canonical_entity_id` column).

## What it does

For every `library` row where `canonical_entity_id LIKE 'discogs:%'` and which is not already in `library_identity`:

1. Decompose the value into `(library_id, source='discogs_release', external_id=<release_id>, method='exact_match', confidence=1.00)`.
2. Open a `db.transaction()`.
3. `SELECT … FOR UPDATE` on the existing `library_identity` row (defense-in-depth; the primary serialization mechanism is `ON CONFLICT (library_id)`).
4. UPSERT the per-source row into `library_identity_source` with `ON CONFLICT (library_id, source) DO UPDATE`.
5. Recompute the main-row values via `recomputeMainRow()` (§3.4.1.1 composition rules) and UPSERT into `library_identity` with `ON CONFLICT (library_id) DO UPDATE`.

## Run command

Build via the GitHub Actions workflow `Manual Build & Deploy` with `target=library-identity-backfill`, then on EC2:

```bash
docker run --rm \
  --env-file .env \
  -e BATCH_SIZE=500 \
  -e THROTTLE_MS=100 \
  <ecr-image-uri>:<tag> \
  2>&1 | tee log
```

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

Set `DRY_RUN=true` to scan the source rows without writing. The job emits a single JSON object on stdout with the locked schema:

```json
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
```

The `skipped` keys are stable strings; `scanned == would_write_sources + sum(skipped.values())`.

```bash
docker run --rm --env-file .env -e DRY_RUN=true <ecr-image-uri>:<tag>
```

## Environment variables

See [`docs/env-vars.md`](../../docs/env-vars.md#etl-jobs--one-shot-backfill) for the canonical list. Quick reference:

| Variable          | Default | Purpose                                                        |
| ----------------- | ------- | -------------------------------------------------------------- |
| `DATABASE_URL`    | —       | Backend PostgreSQL connection string (required)                |
| `BATCH_SIZE`      | `500`   | Rows fetched per SELECT cursor batch                           |
| `THROTTLE_MS`     | `100`   | Inter-row sleep (DB pacing only; no upstream API in 2.0)       |
| `PARTITION_INDEX` | `0`     | Index of this partition (0-based)                              |
| `PARTITION_COUNT` | `1`     | Total partition count (use `1` for single-container runs)      |
| `DRY_RUN`         | unset   | When `true` / `1` / `TRUE`: scan + report on stdout, no writes |
| `SENTRY_DSN`      | unset   | Optional; Sentry stays inactive when unset                     |

## Idempotency & rerun safety

The WHERE filter is:

```sql
WHERE canonical_entity_id IS NOT NULL
  AND canonical_entity_id LIKE 'discogs:%'
  AND NOT EXISTS (SELECT 1 FROM library_identity li WHERE li.library_id = library.id)
```

Already-written rows are skipped; the job is safely re-runnable. The per-source `notes` column is tagged `'backfill:S1'` so future sub-PRs can identify rows this run wrote.

## Rollback (per §5.3)

```sql
-- 1) Remove S1's per-source rows
DELETE FROM wxyc_schema.library_identity_source WHERE notes LIKE 'backfill:S1%';

-- 2) Remove the corresponding main rows. After 2.0, every main row's only source is the S1 row,
-- so this is the right scope; once 2.1+ ships, scope by joining on the per-source delete result.
DELETE FROM wxyc_schema.library_identity li
WHERE NOT EXISTS (SELECT 1 FROM wxyc_schema.library_identity_source s WHERE s.library_id = li.library_id);
```

For partial unwinds (e.g., a single library_id), prefer surgical `DELETE … WHERE library_id = ?` and follow with a recompute on rerun.

## Source confidence assignment (§3.4.1)

S1 stamps `method='exact_match', confidence=1.00`. Justification: `library.canonical_entity_id` is populated by the existing `library-canonical-entity-backfill` job's "direct hit with release_id" branch, which is the §3.4.1 `exact_match` definition. The historical `AUTO_ACCEPT_CONFIDENCE = 0.95` from that job is a synth value for retroactive filtering, not an assertion that the underlying match is below `exact_match` 1.00.

## Cross-source agreement

Sub-PR 2.0 has only one source per library_id, so cross-source agreement detection is not yet exercised. The `recomputeMainRow()` function fully implements the §3.4.1.1 rules (Rule 1 manual hard floor, Rule 2 agreement boost, Rule 3 inherited exclusion, Rule 4 MIN fallback) so 2.1's S2 leg is a single-source-leg-PR rather than re-litigating the composition rules.

## Plan reference

- Plan doc: [`plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md`](../../plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md)
- Parent plan: [`WXYC/wiki` `library-hook-canonicalization-plan.md`](https://github.com/WXYC/wiki/blob/main/plans/library-hook-canonicalization-plan.md) §4 step 2, §3.2.2.2 (writer), §3.4.1 (confidence matrix), §3.2.3 (gate-check)
- Parent epic: [#663](https://github.com/WXYC/Backend-Service/issues/663) (E2 — Backend half)
