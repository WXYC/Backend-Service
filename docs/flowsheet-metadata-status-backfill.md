# flowsheet.metadata_status backfill (BS#891)

Once [migration 0078](../shared/database/src/migrations/0078_flowsheet-metadata-status.sql) lands, every flowsheet row carries `metadata_status = 'pending'` by default. For rows that were already enriched before the column existed, that's wrong — once the Epic C cron flips its sweep predicate to `metadata_status = 'pending'` (BS#895), it would re-enrich the entire 2.6M-row table at LML's expense. This runbook resolves the existing state into the new column before the cron predicate flips.

## When to run

After the migration deploys and the CONCURRENTLY-built partial indexes are in place, and **before** [BS#895](https://github.com/WXYC/Backend-Service/issues/895) ships the cron predicate change. Order:

1. Build `flowsheet_metadata_status_pending_idx` CONCURRENTLY on prod (see `0078_flowsheet-metadata-status.sql` for the exact statement).
2. Build `flowsheet_metadata_status_enriching_stale_idx` CONCURRENTLY on prod.
3. Merge the migration. Its `IF NOT EXISTS` clauses make the apply a no-op.
4. Run this backfill.
5. Ship BS#895 (cron predicate change).

## The derivation

Pre-#891, three implicit states existed:

| `metadata_attempt_at` | `artwork_url` / `discogs_url` | New `metadata_status`                   |
| --------------------- | ----------------------------- | --------------------------------------- |
| `NULL`                | any                           | `pending` (already correct via default) |
| `NOT NULL`            | either populated              | `enriched_match`                        |
| `NOT NULL`            | both `NULL`                   | `enriched_no_match`                     |

`failed_no_retry` was not reachable from the implicit state machine — the historical drain retried every NULL row forever. Existing rows can't map to it.

`enriching` was also not reachable — there was no claim mechanism. Existing rows can't map to it either.

## SQL recipe

Walk the [bulk update playbook](bulk-update-playbook.md) before running. Set `synchronous_commit = off` in the session, batch by `id` to bound per-transaction WAL, and pair the final UPDATE with `ANALYZE`. Connect with a role that can SET session GUCs (any operator role; the readonly proxy can't).

```sql
\set ON_ERROR_STOP on

-- Session knobs from the bulk-update playbook. Backfills are idempotent
-- (the partial-index-backed resume filter holds), so async commit is safe.
SET LOCAL synchronous_commit = off;
SET LOCAL statement_timeout = '5min';

-- Confirm scope before mutating. Expected: ~50k–100k rows on the prod
-- flowsheet snapshot as of 2026-05-22 (rows with metadata_attempt_at NOT
-- NULL are the post-#658 + #673 backfill residue). The remaining ~2.5M
-- rows already have metadata_attempt_at IS NULL and stay at the
-- 'pending' default — no UPDATE needed for them.
SELECT count(*)                                          AS rows_to_update,
       count(*) FILTER (WHERE artwork_url IS NOT NULL
                          OR discogs_url IS NOT NULL)    AS will_be_enriched_match,
       count(*) FILTER (WHERE artwork_url IS NULL
                         AND discogs_url IS NULL)        AS will_be_enriched_no_match
FROM wxyc_schema.flowsheet
WHERE entry_type = 'track'
  AND metadata_attempt_at IS NOT NULL
  AND metadata_status = 'pending';
```

Run the SELECT first, eyeball the totals, then run the UPDATE:

```sql
-- Batched by id to bound per-transaction WAL. Each batch claims its own
-- subtransaction and commits independently. The partial-index-less
-- predicate is fine here because we paginate by id — the planner uses
-- the PK btree directly. Tune BATCH_SIZE up if prod has IOPS headroom;
-- the playbook's 5000 baseline assumes a 3000 IOPS gp3 instance.
DO $$
DECLARE
  batch_size      int := 5000;
  last_id         int := 0;
  max_id          int;
  rows_updated    int;
  total_updated   bigint := 0;
BEGIN
  SELECT max(id) INTO max_id FROM wxyc_schema.flowsheet;
  LOOP
    EXIT WHEN last_id >= max_id;
    UPDATE wxyc_schema.flowsheet
       SET metadata_status =
             CASE
               WHEN artwork_url IS NOT NULL OR discogs_url IS NOT NULL
                 THEN 'enriched_match'::wxyc_schema.metadata_status_enum
               ELSE 'enriched_no_match'::wxyc_schema.metadata_status_enum
             END
     WHERE id > last_id
       AND id <= last_id + batch_size
       AND entry_type = 'track'
       AND metadata_attempt_at IS NOT NULL
       AND metadata_status = 'pending';
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    total_updated := total_updated + rows_updated;
    last_id := last_id + batch_size;
    RAISE NOTICE 'last_id=% total_updated=%', last_id, total_updated;
  END LOOP;
  RAISE NOTICE 'backfill complete: % rows updated', total_updated;
END $$;

-- @rule id=post-bulk-update-analyze: the UPDATE touches metadata_status,
-- which the new partial indexes filter on. Without ANALYZE the planner's
-- stats lag and the next Epic C C6 sweep can fall off the partial-index
-- path and seq-scan the table. See BS#934 (the suggest-endpoint regression
-- that taught us this).
ANALYZE wxyc_schema.flowsheet;
```

## Verification

After the backfill, the residual `metadata_status = 'pending'` rows should be exactly the historical "never tried" set — every `metadata_attempt_at IS NULL` track row plus any pre-#891 holdouts that never enriched. The same query the Epic C C6 (BS#895) cron will use should match:

```sql
SELECT count(*)
FROM wxyc_schema.flowsheet
WHERE entry_type = 'track'
  AND artist_name IS NOT NULL
  AND metadata_status = 'pending';
-- Expected ≈ the historical NULL-attempt residual (~1.86M before #638
-- ran; ~50k–100k after). EXPLAIN should show an Index Scan using
-- flowsheet_metadata_status_pending_idx.
```

Also sanity-check the terminal states:

```sql
SELECT metadata_status, count(*)
FROM wxyc_schema.flowsheet
WHERE entry_type = 'track'
GROUP BY metadata_status
ORDER BY metadata_status;
```

`enriching` and `failed_no_retry` should both be zero — neither is reachable from the pre-#891 implicit state machine.

## Related

- [BS#891](https://github.com/WXYC/Backend-Service/issues/891) — this work.
- [BS#895](https://github.com/WXYC/Backend-Service/issues/895) — Epic C C6 cron predicate change; must wait for this backfill.
- [`docs/bulk-update-playbook.md`](bulk-update-playbook.md) — the per-row cost story, the WHERE-IS-NULL infinite-loop pitfall, the `ANALYZE` rule.
- [`docs/migrations.md`](migrations.md) — `@rule id=ddl-only` and `@rule id=post-bulk-update-analyze`.
