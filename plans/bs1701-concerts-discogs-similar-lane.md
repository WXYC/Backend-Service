# BS#1701 — On Tour For You: extend similar-artists beyond the WXYC library catalog

## Context

The On Tour "For You" **Similar** tier matches a listener's liked artists against a concert headliner's affinity neighbors. Today that only works for headliners resolved to an in-library `artists.id`: the enrichment cohort filters `headlining_artist_id IS NOT NULL`, the neighbors lookup keys on `library_artist_ids` (the `artists.id` keyspace), and `GET /concerts` LEFT-joins `artist_similar_artists` on `concerts.headlining_artist_id`. A curated concert whose headliner resolved only via `headlining_discogs_artist_id` (Discogs-only touring artists absent from the WXYC library — the BS#1614 LML-minted ids) is feed-eligible and gets `genres`, but structurally gets `similar_artists: null`.

The design pass is complete and recorded as a comment on BS#1701. The blocking dependency — **WXYC/semantic-index#367**, `POST /graph/discogs-artists/neighbors/batch` — is **merged and deployed** to explore.wxyc.org. This plan implements the Backend-Service consumer.

### Decisions carried from the design comment (locked)

1. **Headliner lookup key: Discogs artist id.** The new endpoint swaps the reverse lookup to `artist.discogs_artist_id` and returns the same library-code-keyed `SimilarArtist[]`. No name fallback (name adds zero recall over Discogs id per the design's Finding 2).
2. **Backend storage: two lanes, not a re-key.** Keep BS#1626's `artist_similar_artists` (library-id keyed, `ON DELETE CASCADE` FK) **untouched**. Add a Discogs-keyed sibling table (bare external Discogs id PK, no FK — mirrors `artist_metadata`). `GET /concerts` gains a second LEFT JOIN on `effectiveHeadlinerDiscogsId` and projects `COALESCE(<library lane>.neighbors, <discogs lane>.neighbors)`, library lane winning. Enrichment cohorts **partition** so no headliner is double-written.
3. **Neighbor keyspace stays catalog `artists.id`; iOS unchanged.** The Discogs-keyed endpoint still returns library-code neighbors (semantic-index#367 reuses #354's translate-drop-cut path verbatim), so nothing on the neighbor side or on iOS moves.

### Why two lanes and not one Discogs-keyed table (like the genre sibling)

The genre lane uses a single Discogs-keyed table (`artist_metadata`) for both in-library and Discogs-only headliners, reached via `effectiveHeadlinerDiscogsId`. Similar-artists **cannot** collapse to one table the same way: **23 of 38** currently-covered in-library headliners have a NULL `artists.discogs_artist_id` (the column is nullable). Re-keying `artist_similar_artists` on the Discogs id would drop all 23 — a 61% regression of existing coverage (design Finding 1). So the library lane must stay keyed on `artists.id`; the Discogs lane is additive.

### Honest impact ceiling (design Finding 3)

~+23 similar-eligible curated headliners (feed goes 38 → ~61 of 117 curated). The remaining ~48% keep `similar_artists: null` because those touring artists aren't in the semantic-index graph at all (never played on WXYC) — a structural gap this ticket cannot close.

## Current surface (verified in the worktree)

- `apps/backend/services/concerts.service.ts`
  - `effectiveHeadlinerDiscogsId = COALESCE(concerts.headlining_discogs_artist_id, artists.discogs_artist_id)` (line 239)
  - `concertPageFields.similar_artists = artist_similar_artists.neighbors` (line 249)
  - `getConcertsPage` joins `artist_similar_artists` on `headlining_artist_id` (line 279)
  - `getConcertById` joins the SAME set (line 347) — the BS#1694 hotfix comment (lines 334-340) warns that the two projections MUST stay join-identical or Drizzle throws "table … is not part of the query". **Both methods must gain the new join.**
  - `getUpcomingShowsMaps` uses `concertJoinFields` (NOT `concertPageFields`), so the #1616 embed hot-path is untouched.
- `jobs/concerts-similar-artists-enrichment/`
  - `query.ts` — `loadEnrichmentCandidates(backfill)` → `{ artist_id }[]`, cohort `headlining_artist_id IS NOT NULL`. Its doc-comment (lines 5-12) states "Similar artists CANNOT cover those [Discogs-only]" — the exact limitation this ticket removes; **must be updated**.
  - `neighbors-client.ts` — `fetchNeighborsBatch(libraryArtistIds, limit)` → `POST /graph/library-artists/neighbors/batch`, body `{ library_artist_ids, limit }`, cap `SEMANTIC_INDEX_NEIGHBORS_BATCH_CAP=100`, ~80 lines of timeout + sanitize logic.
  - `orchestrate.ts` — `runEnrichment(deps, options)`, fully dep-injected & lane-agnostic on the id (null-wipe guard, delete-suppression, malformed handling). Log strings say "in-library headliners".
  - `writer.ts` — `overwriteNeighbors(upserts, deleteArtistIds)`, UPSERT + scoped DELETE on `artist_similar_artists`.
  - `job.ts` — `runJob(options) → Totals`, wires deps, computes exit code.
- `shared/database/src/schema.ts` — `artist_similar_artists` (FK to `artists.id`, `onDelete: cascade`, lines 1445-1452); `artist_metadata` (bare Discogs PK, no FK, lines 1398-1403) is the naming/no-FK precedent; `SimilarArtistNeighbor = { artist_id, weight }` (line 1421).
- Latest migration on `origin/main` is **0122**. **Migration numbering is a merge-order race**: worktree `bs1702` has already generated `0123_artist-station-plays.sql` on its own branch (not yet on main), so whichever of bs1701/bs1702 merges _second_ renumbers. Generate against the journal tail at generate time and again before pushing; expect **0123** on my base now, **0124** if bs1702 lands first. (`bs1638` is on an old base ≤0116 and adds no migration ≥0117 — not a collision source.)

## Implementation

### 1. Migration (next free index) + schema — new table `discogs_artist_similar_artists`

DDL-only, `IF NOT EXISTS`. Mirror `artist_metadata`'s shape (bare external Discogs id PK, no FK) with `artist_similar_artists`'s `neighbors`/`updated_at` columns:

```sql
CREATE TABLE IF NOT EXISTS "wxyc_schema"."discogs_artist_similar_artists" (
  "discogs_artist_id" integer PRIMARY KEY NOT NULL,
  "neighbors" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

No secondary index: reads and writes are by PK. Author the Drizzle table def in `schema.ts` next to `artist_similar_artists`, generate the migration with `npm run drizzle:generate` (takes the next free journal index — see numbering-race note above), then verify the emitted SQL matches (adjust name/`IF NOT EXISTS` per `docs/migrations.md`). Add `DiscogsArtistSimilarArtists` / `NewDiscogsArtistSimilarArtists` inferred types.

**Table name:** `discogs_artist_similar_artists` — the keyspace-first `discogs_` prefix reads clearly and pairs with the library-keyed `artist_similar_artists` by suffix. (Decided; not an open question.)

Reuses `SimilarArtistNeighbor` verbatim for the `neighbors` `$type` — same wire shape, so the stored jsonb IS `Concert.similar_artists` in both lanes.

**Also update the existing `artist_similar_artists` JSDoc** (schema.ts:1428-1430): it currently asserts "only IN-LIBRARY headliners … have a neighbor list — hence a real FK." Add a cross-reference noting Discogs-only headliners now get neighbor lists via the sibling `discogs_artist_similar_artists` table (which is why THIS table stays FK'd to `artists.id` and that one is a bare Discogs PK).

### 2. Discogs enrichment lane (extends the existing job — one cron, one deploy target)

- **`discogs-query.ts`** — `loadDiscogsEnrichmentCandidates(backfill)` → `{ discogs_artist_id }[]`:
  ```sql
  SELECT DISTINCT "c"."headlining_discogs_artist_id" AS discogs_artist_id
  FROM <schema>.concerts "c"
  WHERE "c"."removed_at" IS NULL
    AND "c"."headlining_artist_id" IS NULL
    AND "c"."headlining_discogs_artist_id" IS NOT NULL
    [AND window]
  ORDER BY "c"."headlining_discogs_artist_id" ASC
  ```
  Bare `headlining_discogs_artist_id`, **not** `effectiveHeadlinerDiscogsId`: the `headlining_artist_id IS NULL` partition guarantees there's no `artists` row, so the COALESCE second arm is always NULL here. Disjoint from the library cohort (`headlining_artist_id IS NOT NULL`) → no headliner double-written. Same `unwrapRows`/window/backfill helpers as `query.ts`.
- **`neighbors-client.ts`** — extract the shared POST/parse/sanitize body into one impl parameterized by `(path, bodyKey)`; expose `fetchNeighborsBatch` (unchanged signature) and new `fetchDiscogsNeighborsBatch(discogsArtistIds, limit)` → `POST /graph/discogs-artists/neighbors/batch`, body `{ discogs_artist_ids, limit }`. Same cap constant, timeout, and `{artist_id, weight}` sanitizer (neighbors are catalog ids in both lanes). Response shape is identical (`{ results: { "<id>": [...] } }`).
- **`discogs-writer.ts`** — `overwriteDiscogsNeighbors(upserts, deleteDiscogsIds)` → same UPSERT-or-overwrite + scoped-DELETE transaction as `overwriteNeighbors`, but on `discogs_artist_similar_artists` keyed on `discogs_artist_id`.
- **`orchestrate.ts`** — reused for both lanes (it already abstracts `loadCandidates`/`fetchNeighbors`/`overwrite` over an opaque numeric id). **One small, explicit delta**: add an OPTIONAL `cohortLabel?: string` to `EnrichOptions`, defaulting to the current "in-library headliners" wording, and thread it into the hardcoded `enumerated` log string (orchestrate.ts:133) so the discogs lane's log lines read accurately. The library lane passes no label (keeps its current wording); the existing `orchestrate.test.ts` default-label log assertion is updated to reference the default constant. The orchestrator's `EnrichmentCandidate.artist_id` / `SimilarArtistsRow.artist_id` fields stay as-is (they mean "the write-key id"); the discogs lane's own query/writer name their column `discogs_artist_id` and translate at the dep boundary in `job.ts` (`{ discogs_artist_id } → { artist_id }` in, `{ artist_id } → { discogs_artist_id }` out — two trivial `.map()`s), keeping each lane's SQL honestly named. `Totals.cohort`'s doc-comment stays library-flavored but is lane-neutral in meaning ("candidates loaded").
- **`job.ts`** — `runJob` runs BOTH lanes sequentially (library, then discogs), each via `runEnrichment` with its own deps, sharing the cooperative-pause `awaitQuiet`. Return `{ library: Totals; discogs: Totals }`; `main` ORs the two lanes' exit-code signals (`all_empty_skip || (wroteNothing && somethingFailed)`) so either lane failing alone still alerts. **The `finished` log context (job.ts:157) must be flattened per-lane** (e.g. `library_enriched` / `discogs_enriched`, or spread each lane under its own key) — a bare `{ ...totals }` spread of the new nested shape would emit `{ library: {...}, discogs: {...} }` into CloudWatch. `--backfill` / `--dry-run` apply to both.

### 3. `GET /concerts` COALESCE join (`concerts.service.ts`)

- Import `discogs_artist_similar_artists`.
- Change `concertPageFields.similar_artists` to
  ```ts
  similar_artists: sql<SimilarArtistNeighbor[] | null>`COALESCE(${artist_similar_artists.neighbors}, ${discogs_artist_similar_artists.neighbors})`,
  ```
  library lane first (wins when both present — the design's ordering).
- Add to **both** `getConcertsPage` and `getConcertById`:
  ```ts
  .leftJoin(discogs_artist_similar_artists, eq(discogs_artist_similar_artists.discogs_artist_id, effectiveHeadlinerDiscogsId))
  ```
  Both LEFT (a headliner in neither lane keeps the row, `similar_artists: null`). `toConcertDTO` is unchanged (`row.similar_artists ?? null` already handles the COALESCE result). Update the projection JSDoc + the `similar_artists` field comment to describe the two-lane COALESCE.

### 4. Contract (api.yaml) — no change

`Concert.similar_artists` (`SimilarArtist[]`, optional+nullable) is **unchanged** — same field, now populated for more headliners. No `wxyc-shared/api.yaml` edit, no codegen, no DTO-shape change. The `Equal<ConcertDTO, ApiYamlConcert>` compile-time pin in `concerts.service.test.ts` still holds. (Confirms this is a data-coverage change, not a wire-contract change.)

## Testing (TDD — failing test first each step)

- **Schema** (`tests/unit/database/schema.discogs-artist-similar-artists.test.ts`, new): mirror `schema.artist-similar-artists.test.ts` — column presence, PK on `discogs_artist_id`, jsonb `neighbors`, **no** FK (contrast the library table's cascade FK).
- **Neighbors client** (`tests/unit/jobs/concerts-similar-artists-enrichment/neighbors-client.test.ts`, extend): `fetchDiscogsNeighborsBatch` posts the right path + `discogs_artist_ids` body key, honors the cap, sanitizes to `{artist_id, weight}`, and treats empty/oversize as the existing errors. Keep the existing `fetchNeighborsBatch` cases green (proves the refactor is behavior-preserving).
- **Orchestrate** (`orchestrate.test.ts`, extend): the reused orchestrator drives the discogs deps identically — one case asserting the `cohortLabel` flows into logs; existing library cases stay green (default-label assertion updated).
- **Job glue** (`tests/unit/jobs/concerts-similar-artists-enrichment/job.test.ts`, new): the genuinely-new two-lane wiring — both lanes run (library then discogs), the `{discogs_artist_id}↔{artist_id}` boundary `.map()`s translate correctly (the discogs `overwrite` dep receives ids under `discogs_artist_id`), `runJob` returns `{ library, discogs }`, and a **single failing lane still yields exit 1** (guards against a naive "aggregate then compute once" that would mask one lane).
- **Discogs writer + query + end-to-end** (`tests/integration/concerts-similar-artists-enrichment.spec.js`, extend): a Discogs-only headliner (`headlining_artist_id NULL`, `headlining_discogs_artist_id` set) → enriched into `discogs_artist_similar_artists`; the partition excludes it from the library cohort and vice-versa; a re-run overwrites; an empty verdict deletes only within the cohort.
- **`GET /concerts` COALESCE** (concerts endpoint integration test): (a) Discogs-only headliner with a discogs-lane row surfaces `similar_artists`; (b) in-library headliner with BOTH lanes present → library lane wins; (c) headliner in neither lane → `similar_artists: null`; (d) `getConcertById` parity (same projection).

## Docs

- `jobs/concerts-similar-artists-enrichment/README.md` — document the two lanes + the partition.
- Root `CLAUDE.md` job-table row for `@wxyc/concerts-similar-artists-enrichment` — currently says "in-library ... Discogs-only touring artists ... out of scope"; rewrite to describe both lanes.
- `concerts.service.ts` JSDoc (the similar-artists projection paragraph + the `similar_artists` DTO field) — describe the COALESCE two-lane resolve.

## Risk / safety

- **Migration**: DDL-only, additive, `IF NOT EXISTS`. Follow `docs/migrations.md` (journal `when` bump, snapshot). Re-check the latest migration index at generate time (parallel worktrees).
- **Data safety**: the discogs writer mirrors the library writer's scoped-DELETE discipline — DELETEs keyed on an explicit cohort id list, never blanket; null-wipe + delete-suppression guards inherited from the shared orchestrator.
- **No double-write**: partitioned cohorts (`headlining_artist_id IS NOT NULL` vs `IS NULL AND discogs IS NOT NULL`).
- **By-id read parity**: both `getConcertsPage` and `getConcertById` gain the join (the BS#1694 regression class).
- **PR size**: migration + schema + 3 job files + service + ~4 test files + 3 doc edits, est. < 1000-line delta → single PR. `Closes #1701`.

## Acceptance criteria (BS#1701)

- [x] Design decision recorded — Discogs-id key (design comment).
- [x] semantic-index exposes neighbors for non-library headliners — #367 merged/deployed.
- [ ] Enrichment cohort covers Discogs-only curated headliners — discogs lane (§2).
- [ ] `GET /concerts` returns `similar_artists` for a Discogs-only headliner with graph neighbors — COALESCE join (§3).
- [ ] iOS Similar tier surfaces such a concert — no iOS change (neighbor keyspace unchanged); verify via the `ForYou gate:` diagnostic once deployed.
