# Backfill precondition assertions

## What this is

A defensive pattern for _code_ changes that depend on a column having been backfilled. The backfill itself runs as a one-shot job under `jobs/<name>-backfill/`; the question is how the runtime guards against being asked to serve traffic before the backfill has run.

For _migrations_ that depend on a backfill, the canonical pattern is the `DO $$ ... RAISE EXCEPTION ... END $$;` precondition guard at the top of the migration file (see `0053_flowsheet-dj-name-column.sql` → `jobs/flowsheet-dj-name-backfill/` → `0054_flowsheet-search-doc-with-dj-name.sql`). That guard fires inside the DDL transaction.

This document covers the _runtime_ analog: a boot-time assertion that fails loud when a backfill-dependent code path is called before the backfill has populated the column.

## Why

This pattern was introduced after the 2026-04-28 catalog-search incident:

- Migration 0058 added `library.artist_name` (nullable) and a stored `search_doc` tsvector built from `setweight(to_tsvector('simple', artist_name), 'A') || setweight(to_tsvector('simple', album_title), 'B')`.
- A backfill job (`jobs/library-artist-name-backfill/`) was supposed to populate `artist_name` from the `artists` join.
- The Epic A.5 search rewrite shipped _before_ the backfill ran in prod.
- Result: `to_tsvector('simple', NULL)` is the empty tsvector, so all 64,163 prod rows produced search_doc tsvectors with album-title lexemes only. Searching by artist returned zero results silently. Took an outage and a multi-hour investigation to trace.

The migration-precondition guard pattern doesn't apply here — there was no follow-up migration after 0058 to refuse, and the `search_doc` column itself was perfectly valid SQL with NULL inputs. The bug was a _code-side_ assumption that the backfill had run.

## The pattern

For any code path that depends on a backfilled column being non-NULL, gate it behind a boot-time assertion that:

1. Runs the cheapest possible `SELECT count(*) ... WHERE col IS NULL LIMIT 1` once per process.
2. Caches the result for the lifetime of the process — once the column is populated, it stays populated, so re-checking on every request is wasted work.
3. Throws a typed error subclassing `WxycError` with `statusCode: 503` so the existing `errorHandler` middleware refuses requests with a body that points operators at the backfill job.
4. Logs to Sentry with `tool=<feature>`, `step=startup-assertion`, `count=<n>` so the alert path is observable.
5. Caches the missing-backfill failure as well as success — the operator response is "run the backfill, restart the process" — but does _not_ cache transient DB errors so the next call retries.

The canonical implementation is `apps/backend/services/library-artist-name-assertion.service.ts`. Mirror it for any new gate.

## When to add a gate

When you ship code that reads a backfilled column and silently produces wrong answers if the column has NULL rows. Examples:

- A search index built from a column.
- A constraint enforced at write time but not at read time.
- A denormalized join key.

When _not_ to add a gate:

- The column is nullable by design and the code handles NULL correctly.
- The dependency is one-way: a migration that depends on a backfill (use the migration-precondition guard instead).
- The cost of running the gate query exceeds the cost of being wrong (rare — the gate query is a single indexed lookup with `LIMIT 1`).

## Wiring

Each public entry point on the affected service should `await` the assertion before any other DB work:

```ts
export async function searchLibrary(...): Promise<...> {
  await assertLibraryArtistNamePopulated();
  // ... actual search ...
}
```

The assertion is cached per-process, so subsequent calls are sub-microsecond after the first.

## Operator response

When the assertion fails, the search endpoint returns 503 with a body like:

```json
{
  "message": "library.artist_name has 64163 NULL row(s); catalog search is disabled. Run jobs/library-artist-name-backfill/ and restart the backend."
}
```

The operator runs the backfill job (`docker run --rm --env-file .env <image>` on EC2), then restarts the backend container. The next request after restart re-runs the assertion against the populated column, sees count=0, caches success, and serves traffic normally.

A backend restart is required because the assertion caches the failure for the lifetime of the process — once the runtime has decided to refuse search, it won't reconsider until the next process boot. This is intentional: it means a half-finished backfill (partially populated column) can't accidentally re-enable a path that's still serving partially-correct results.
