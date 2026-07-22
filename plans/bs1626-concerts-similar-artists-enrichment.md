# BS#1626 — On Tour R3b: nightly similar-artists enrichment from semantic-index + projection on GET /concerts

## Context

Release R3b of the On Tour plan matches concerts against on-device likes by set intersection: `concert.similar_artists ∩ likedIds`. The concerts feed must carry each curated headliner's affinity neighbors. Nothing computes or persists that today.

This is a strict sibling of BS#1624 (`jobs/concerts-genre-enrichment/`) — same standalone-nightly-job shape, same read-projection split — but reads a **different service** (semantic-index, not LML), keys at a **different id-space** (`artists.id`, not Discogs id), and uses a **different refresh policy** (full-window nightly overwrite, not a presence anti-join).

## Id-space (verified — the linchpin)

- semantic-index#358 (CLOSED, merged) populates `artist.wxyc_library_code_id` from `wxyc_schema.artists.id` — "definitionally the consumer's id-space (`SimilarArtist.artist_id` keyspace)". Case-sensitive exact name join; ambiguous names left NULL (~1%).
- semantic-index#354 (CLOSED, merged) endpoint keys on `library_artist_ids` = that same `artists.id` keyspace; response `SimilarArtist.artist_id` is in the same keyspace.
- In Backend, `artists.id` is exactly what `concerts.headlining_artist_id` FKs to and what `GET /concerts` already emits as `headlining_artist_id`.

**Conclusion:** the job sends `concerts.headlining_artist_id` verbatim to the endpoint, and persists returned `artist_id` verbatim. No translation, no join.

## Endpoint contract (semantic-index#354, public no-auth)

- **Request:** `POST {SEMANTIC_INDEX_URL}/graph/library-artists/neighbors/batch` with `{"library_artist_ids": [...], "limit": 20}`. Omit `heat` (server default 0.5 is the production blend).
- **Response:** `{"results": {"<id>": [{"artist_id": N, "weight": W}, ...]}}` — keyed by stringified input id; every requested id present; weights descending, list-relative. Empty list = unknown/unmapped/ambiguous headliner → "no enrichment", not an error.
- **Cap:** 100 ids/call, structured 422 beyond. Chunk at 100 (cohort ~50 today; one chunk in practice).
- **Health:** `GET {SEMANTIC_INDEX_URL}/health` exposes `mapped_artist_count` (~22K expected) — the integration-day disambiguator.

## Storage (new table, migration 0122)

Neighbors are a property of the **artist**, keyed on `artists.id`. `artist_metadata` (BS#1624) is keyed on `discogs_artist_id` — wrong key — so a new table is required.

```sql
CREATE TABLE "wxyc_schema"."artist_similar_artists" (
  "artist_id"  integer PRIMARY KEY NOT NULL
               REFERENCES "wxyc_schema"."artists"("id") ON DELETE CASCADE,
  "neighbors"  jsonb NOT NULL,   -- SimilarArtist[] = [{artist_id, weight}], weight desc
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
```

- FK to `artists.id` (unlike genre's bare id) is correct here: the cohort is `headlining_artist_id IS NOT NULL` (in-library only), so every key is a real `artists.id`. `ON DELETE CASCADE` keeps rows clean if an artist is ever hard-deleted by ETL. `-- @no-precondition-needed`: FK on a fresh empty table has no rows to violate.
- `neighbors` as a single ordered `jsonb` array is the exact wire shape and makes the nightly overwrite one UPSERT per artist (vs delete+insert of a row-per-neighbor table).
- Drizzle schema: `artist_similar_artists` in `shared/database/src/schema.ts`. Define an exported `SimilarArtistNeighbor = { artist_id: number; weight: number }` type in `schema.ts` (no such type exists there today — the genre analog used a plain `text().array()`) and type the column `neighbors: jsonb('neighbors').$type<SimilarArtistNeighbor[]>().notNull()`.

## Job: `jobs/concerts-similar-artists-enrichment/` (BS#1624 shape)

Files mirror the genre job 1:1 in structure: `job.ts`, `orchestrate.ts`, `query.ts`, `writer.ts`, `neighbors-client.ts` (replaces `lml-limiter.ts` — semantic-index client), `logger.ts` (verbatim copy), `package.json`, `tsconfig.json`, `tsup.config.ts`, `README.md`. Plus `Dockerfile.concerts-similar-artists-enrichment`.

### query.ts — candidate cohort

Distinct `artists.id` for **upcoming curated in-library** headliners:

```sql
SELECT DISTINCT "c"."headlining_artist_id" AS artist_id
FROM "wxyc_schema"."concerts" "c"
WHERE "c"."removed_at" IS NULL
  AND "c"."headlining_artist_id" IS NOT NULL
  AND "c"."starts_on" >= (now() AT TIME ZONE 'America/New_York')::date   -- dropped by --backfill
ORDER BY "c"."headlining_artist_id" ASC
```

- `headlining_artist_id IS NOT NULL` = in-library only (narrower than the genre cohort's COALESCE-with-Discogs; Discogs-only headliners have no `library_artist_id` to send and are out of scope).
- **No `artist_similar_artists` anti-join** — the refresh policy is full-window overwrite, not presence-gated. `--backfill` drops only the upcoming window (there is no "already enriched" exclusion to relax).
- Uses the same `unwrapRows` driver-shape guard as the genre query.

### neighbors-client.ts — semantic-index client

- `SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP = 100`; `fetchNeighborsBatch(ids, limit)` POSTs the batch, validates `results` is an object, returns it. `AbortController` timeout (default 30s, batch-scaled). Throws on non-2xx (incl. 422) and unparseable body — the whole chunk is then retryable next night.
- `fetchGraphHealth()` GETs `/health`, returns `{ mapped_artist_count: number | null }` (best-effort; null on any failure). Called **only** when a sweep comes back all-empty, to enrich the loud log.
- Base URL from `SEMANTIC_INDEX_URL` (default `https://explore.wxyc.org`). No API key (public endpoint). No rate limiter (one bounded local read/night).

### orchestrate.ts — the loop (dep-injected, unit-testable)

1. Load cohort artist_ids. Empty → return (no calls).
2. `--dry-run` → log plan, return (no fetch, no writes) — matches genre job.
3. Chunk at 100. For each chunk: `awaitQuiet()` (cooperative pause, same as genre), then `fetchNeighborsBatch`. On throw → count `errors += chunk.length`, continue (retryable) — **the thrown chunk's ids never enter `fetched`** (they are neither upserted nor deleted; their existing row survives to be retried next night). For a chunk that responded, record every requested id into `fetched: Map<artist_id, SimilarArtist[]>`, defaulting a (contract-guaranteed-present) missing id to `[]`. Track `respondedIds` = the union of ids from responded chunks.
4. **All-empty guard (null-wipe protection):** if `respondedIds` was non-empty AND every value in `fetched` is empty → this is "mapping not yet rebuilt" or a real fault. Fetch `/health`, log loudly (`all_empty_sweep`, with `mapped_artist_count`), set `totals.all_empty_skip = true`, and **return without writing** (never wipe existing rows).
5. Otherwise **overwrite** via `writer.overwriteNeighbors(upserts, deletes)`:
   - `upserts` = responded artists whose fetched list is non-empty → UPSERT `ON CONFLICT (artist_id) DO UPDATE SET neighbors=EXCLUDED.neighbors, updated_at=now()` (overwrite — keeps neighbors current with the graph, unlike genre's DO NOTHING).
   - `deletes` = **only** artists in `respondedIds` whose fetched list is empty (the genuine now-unmapped ~1%) → DELETE their row so a stale list can't outlive the graph. **Critically NOT** ids from a thrown/errored chunk — those are transient failures that must stay retryable, so they are excluded from the delete set entirely (the High-severity fix from plan review: a partial multi-chunk fetch failure must never wipe a healthy row). Scoped to responded cohort ids only, never the whole table.
   - Both in one transaction.

`Totals`: `cohort, chunks, fetched, with_neighbors, neighbors_total, enriched (upserted), cleared (deleted), errors, all_empty_skip`.

### job.ts — entrypoint

Mirrors genre `job.ts`: env parse (`CONCERTS_SIMILAR_ENRICH_LIMIT` default 20, capped ≤100; `LIVE_ACTIVITY_LOOKBACK_SECONDS`), `--backfill`/`--dry-run` flags, cooperative pause helpers (`checkLiveActivity`/`awaitQuietWindow` copied verbatim), Sentry logger init, `NODE_ENV !== 'test'` auto-invoke guard.

### package.json

`"cron-schedule": "55 5 * * *"`, `"job-type"` omitted (defaults to `cron`). Deps: `@sentry/node`, `@wxyc/database` (no `@wxyc/lml-client` — this job doesn't touch LML).

### Dockerfile

Copy `Dockerfile.concerts-genre-enrichment`, drop the `shared/lml-client` COPY/build lines (not needed), rename paths + `DB_APPLICATION_NAME=wxyc-concerts-similar-artists-enrichment`. The deploy pipeline auto-discovers the job via turbo-affected and reads `cron-schedule` from package.json — no `deploy-base.yml` edit needed.

### CLAUDE.md job-table row

Add a descriptive row for `@wxyc/concerts-similar-artists-enrichment` to the monorepo job table in `CLAUDE.md` (every sibling job has one). `check:doc-budget` is warn-only; extract to `docs/` only if the budget warning fires.

## Cross-repo SSOT (already merged — no work in this repo)

The SSOT `wxyc-shared/api.yaml` **already carries** `SimilarArtist` and `Concert.similar_artists` — merged in wxyc-shared#222 (2026-07-15, this ticket's blocked-by). Confirmed by fetching the live `WXYC/wxyc-shared:api.yaml`. So the schema-first rule is already satisfied upstream. As with the genre sibling (whose `genres` field also lives in the SSOT via wxyc-shared#221 but is a **local alias** in `concerts.service.ts` because the _published `@wxyc/shared` npm pin_ predates it), we keep a local `SimilarArtist` alias and **defer only the npm-pin bump** — not the SSOT change (there is none to make here). The `ApiYamlConcert` mirror in `concerts.service.test.ts` is the honest-drift guard until the pin catches up.

## Read path: GET /concerts projection (apps/backend/services/concerts.service.ts)

Follow the BS#1624 split exactly — add to the **page projection only**, never the `upcoming_show` embed (#1616 hot path).

- `ConcertDTO`: add `similar_artists?: SimilarArtist[] | null` (local `SimilarArtist = { artist_id: number; weight: number }` type, pending published `@wxyc/shared`, same as the genres alias). Update the `ApiYamlConcert` pin in `concerts.service.test.ts` and the wire-key-set test.
- `ConcertJoinRow`: add `similar_artists?: SimilarArtist[] | null` (optional — only the page projection selects it).
- `toConcertDTO`: `similar_artists: row.similar_artists ?? null` (null-safe; embed & unresolved both → null).
- `concertPageFields`: add `similar_artists: artist_similar_artists.neighbors`.
- `getConcertsPage`: add `.leftJoin(artist_similar_artists, eq(artist_similar_artists.artist_id, concerts.headlining_artist_id))`. Clean FK join — no COALESCE/Discogs needed (unlike genres). LEFT so unresolved/un-enriched → null.
- `getUpcomingShowsMaps` / `upcomingShowJoinFields`: **unchanged** — the embed map must not carry `similar_artists` (read-path guard, coordinates with #1616).

## Tests

1. **Unit — `tests/unit/jobs/concerts-similar-artists-enrichment/orchestrate.test.ts`** (mirror genre orchestrate.test.ts): cohort → chunk → fetch → overwrite over dep-injected fakes. Pins: empty cohort → zero calls; chunking at cap; verdicts keyed by stringified id; non-empty → upsert, empty (responded) → delete; **all-empty sweep → no writes + all_empty_skip** (the null-wipe guard, the headline test); dry-run → no fetch/writes; **a thrown chunk's ids are counted as errors and appear in NEITHER upserts NOR deletes** (the High-severity plan-review fix — a partial multi-chunk failure must not wipe a healthy row); cooperative pause awaited per chunk; missing-id-in-a-responded-result defaults to empty.
2. **Unit — neighbors-client** (optional small suite): request body shape (`library_artist_ids` + `limit`, no `heat`), 422 throws, health parse.
3. **Unit — concerts.service.test.ts**: extend the `ApiYamlConcert` pin + wire-key test + a `similar_artists` passthrough/null case.
4. **Integration — `tests/integration/concerts-similar-artists-enrichment.spec.js`** (mirror the genre spec): real PG. Candidate SELECT (in-library only, DISTINCT, upcoming window, backfill drop); overwrite writer (UPSERT overwrites an existing row — the opposite of genre's DO-NOTHING assertion; DELETE clears an emptied row); `GET /concerts` emits `similar_artists` for a resolved+enriched headliner, `null` for resolved-unenriched and unresolved.

## Acceptance-criteria mapping

- Migration + standalone job (BS#1624 shape), artist-level `artists.id` key → §Storage, §Job.
- Cohort filters `headlining_artist_id IS NOT NULL` → query.ts.
- Full-window nightly re-fetch + overwrite (no anti-join) → query.ts (no anti-join) + writer (DO UPDATE).
- `GET /concerts` emits `similar_artists`, null-safe, page projection only → §Read path.
- All-empty sweep logs loudly, no null wipe → orchestrate step 4 + tests.
- Integration specs alongside concerts ETL tests → §Tests 4.
- Scheduled `55 5 * * *` UTC → package.json.

## Out of scope

- Discogs-only headliners (no `artists.id`) — never queried (genre sibling covers their genres; affinity graph can't cover them).
- iOS ranking/noise-cap (wxyc-ios-64#493).
- Bumping the `@wxyc/shared` pin — local alias until the published package carries `SimilarArtist`/`similar_artists`.
