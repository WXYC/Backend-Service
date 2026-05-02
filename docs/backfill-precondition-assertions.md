# Backfill precondition assertions

## What this is

A defensive pattern for _code_ changes that depend on a column having been backfilled. The backfill itself runs as a one-shot job under `jobs/<name>-backfill/`; the question is how the runtime guards against being asked to serve traffic before the backfill has run, or against new leak paths re-introducing NULL rows after the fact.

For _migrations_ that depend on a backfill, the canonical pattern is the `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard at the top of the migration file (see `0053_flowsheet-dj-name-column.sql` → `jobs/flowsheet-dj-name-backfill/` → `0054_flowsheet-search-doc-with-dj-name.sql`). That guard fires inside the DDL transaction.

This document covers the _runtime_ analog: a boot-time data-quality check that flags a backfill-dependent column slipping back into a degraded state.

## Why

This pattern was introduced after the 2026-04-28 catalog-search incident:

- Migration 0058 added `library.artist_name` (nullable) and a stored `search_doc` tsvector built from `setweight(to_tsvector('simple', artist_name), 'A') || setweight(to_tsvector('simple', album_title), 'B')`.
- A backfill job (`jobs/library-artist-name-backfill/`) was supposed to populate `artist_name` from the `artists` join.
- The Epic A.5 search rewrite shipped _before_ the backfill ran in prod.
- Result: `to_tsvector('simple', NULL)` is the empty tsvector, so all 64,163 prod rows produced search_doc tsvectors with album-title lexemes only. Searching by artist returned zero results silently. Took an outage and a multi-hour investigation to trace.

The migration-precondition guard pattern doesn't apply here — there was no follow-up migration after 0058 to refuse, and the `search_doc` column itself was perfectly valid SQL with NULL inputs. The bug was a _code-side_ assumption that the backfill had run.

## What NOT to do — the 2026-04-30 follow-up incident

The original version of this pattern made the runtime check a hard precondition that 503'd the search endpoint for the lifetime of the process whenever any single row had `artist_name IS NULL`. That worked while the column was uniformly empty (the intended trigger), but it weaponized itself against a single bad row:

- 2026-04-28: a new release ("Tranquilizer", Oneohtrix Point Never) was inserted by the library ETL, which had not been updated to set `library.artist_name`.
- 2026-04-30: the backend container was restarted as part of routine ops. The first authenticated `/library/?artist_name=...` call ran the precondition, found one NULL row out of 64,164, threw 503, and cached the failure for the lifetime of the new process.
- DJs lost catalog search station-wide for the rest of the on-air session, despite LML being healthy and 64,163 rows being well-formed.

The lesson: a process-cached 503 turns "degraded data" into "outage" — and once any future leak path drips a single NULL into the table, every subsequent restart re-poisons. Hard gates that depend on _zero_ NULLs are too brittle; the gate amplifies a row-level data-quality issue into a service-level one.

## The pattern (revised)

For any code path that depends on a backfilled column, do all of:

1. **Make the read path tolerate NULL rows.** Trigram (`%`) and tsvector (`@@`) predicates already drop NULLs naturally — degraded rows fall out of search instead of poisoning it. Project the value from a non-degraded source (e.g., the JOIN target) at the result level so even degraded rows that match a different predicate still serialize correctly.

2. **Add a soft data-quality check, not a hard gate.** Run the cheapest possible `SELECT count(*) ... WHERE col IS NULL LIMIT 1` once per process, cache the result, and emit a Sentry warning (`level: 'warning'`) if `count > 0`. Do **not** throw — degraded data is observability, not a precondition.

3. **Plug the leak path at the source.** If the column is meant to be denormalized at insert time, every insert path needs to set it. Audit `INSERT INTO library` (or whichever table) across the controllers AND every ETL/job. The canonical pattern: lift the canonical value into the helper that returns the FK target so the insert can't compile without it. See `ensureArtist` in `jobs/library-etl/job.ts` for the post-fix shape.

4. **Run the backfill job to repair existing degradation.** `jobs/<name>-backfill/` is the recovery tool, not the prevention tool. It exists for incidents and migrations; the steady-state defense is (1) + (3).

The canonical implementation is `apps/backend/services/library-artist-name-assertion.service.ts` (post-2026-04-30 revision). Mirror it for any new degradation-prone column.

## When to add a soft check

When you ship code that reads a backfilled column and the column is denormalized from another source of truth, so leak paths are realistic. The check exists to make the leak visible in Sentry before it grows.

When _not_ to add a check:

- The column is nullable by design and the code handles NULL correctly already.
- The dependency is one-way: a migration that depends on a backfill (use the migration-precondition guard instead).
- The column has a NOT NULL constraint and the database itself rejects bad inserts.

## Wiring

Each public entry point on the affected service should `await` the check before any other DB work:

```ts
export async function searchLibrary(...): Promise<...> {
  await checkLibraryArtistNameHealth();
  // ... actual search ...
}
```

The check is cached per-process, so subsequent calls are sub-microsecond after the first.

## Operator response

When the check fires a Sentry warning, the operator response is:

1. Identify the leak path. Recent inserts with NULL in the affected column are the smoking gun:
   ```sql
   SELECT id, artist_id, album_title, add_date
     FROM library
    WHERE artist_name IS NULL
    ORDER BY add_date DESC;
   ```
2. Patch the code path that's inserting NULL (controller, ETL, internal endpoint).
3. Run the backfill job to repair the existing rows: `docker run --rm --env-file .env <library-artist-name-backfill-image>`.
4. No restart needed — the search functions already tolerate NULLs; the degraded rows just reappear as searchable once backfilled.
