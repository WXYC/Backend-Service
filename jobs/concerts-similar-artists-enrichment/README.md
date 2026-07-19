# concerts-similar-artists-enrichment (BS#1626 + BS#1701)

Nightly cron that enriches **upcoming curated concert headliners** with artist-level **affinity neighbors** from the semantic-index graph, so `GET /concerts` can project `Concert.similar_artists` (wxyc-shared#222) for the iOS On Tour "For You" shelf (wxyc-ios-64#493 / R3b). The iOS client matches concerts against on-device likes by set intersection: `concert.similar_artists ∩ likedIds`.

Sibling of `concerts-genre-enrichment` (BS#1624) — same standalone-nightly-job shape and read-projection split — but reads a **different service** (semantic-index, not LML) and uses a **different refresh policy** (full-window nightly overwrite, not a presence anti-join).

## Two lanes

The graph is built from **everything played on WXYC**, catalog or not, but a headliner is reachable in it by two different keys depending on how the concert resolved. So the job runs **two lanes** over the shared `runEnrichment` orchestrator, one per key:

| Lane                  | Cohort                                                                      | Endpoint                                                                       | Table (keyed on)                                          |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **library** (BS#1626) | `headlining_artist_id IS NOT NULL`                                          | `POST /graph/library-artists/neighbors/batch` (#354), `{ library_artist_ids }` | `artist_similar_artists` (`artists.id`, FK)               |
| **discogs** (BS#1701) | `headlining_artist_id IS NULL AND headlining_discogs_artist_id IS NOT NULL` | `POST /graph/discogs-artists/neighbors/batch` (#367), `{ discogs_artist_ids }` | `discogs_artist_similar_artists` (bare Discogs id, no FK) |

The two cohorts **partition** the resolved-headliner space, so no headliner is written to both tables. **Both lanes return WXYC catalog neighbor ids** (semantic-index returns library-code neighbors regardless of the lookup key — #367 reuses #354's translate-drop-cut path), so the persisted `SimilarArtist.artist_id`s are matchable against on-device likes in one id space either way. `GET /concerts` COALESCEs the two lanes on `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)` (library lane winning the rare both-present row).

**Why two tables, not one Discogs-keyed table** (like the genre sibling's `artist_metadata`): 23 of 38 currently-covered in-library headliners carry a NULL `artists.discogs_artist_id` (the column is nullable), so re-keying the library lane on the Discogs id would drop them (a 61% coverage regression). The library lane must stay keyed on `artists.id`; the discogs lane is purely additive.

## What each lane does

1. Load the cohort (distinct ids; no anti-join — the whole cohort is re-fetched every night).
2. Chunk (<= 100 ids/chunk) through the lane's neighbors endpoint, `limit: 20`.
3. **Overwrite** the lane's table keyed on its id:
   - non-empty verdict → UPSERT (`ON CONFLICT DO UPDATE` — keeps neighbors current with the graph rebuild);
   - empty verdict from a responded chunk → DELETE the row (the genuine now-unmapped/ambiguous ~1%);
   - a chunk whose fetch **throws** → its ids are neither upserted nor deleted (retryable next run; a transport failure never wipes a healthy row).

The shared orchestrator is id-agnostic (it operates on an opaque numeric write-key); the discogs lane translates its `discogs_artist_id` to/from the orchestrator's `artist_id`-named seam at the dep boundary in `job.ts` (two `.map()`s), keeping each lane's own SQL honestly named.

## Station-affinity play count (BS#1702)

The same nightly call also carries `source_plays` (semantic-index#369) — the headliner's all-time WXYC flowsheet play count (`artist.total_plays`), keyed by the same stringified input id. The job collects it across chunks and **UPSERTs it into the sibling table `artist_station_plays`** (`ON CONFLICT (artist_id) DO UPDATE`), which `GET /concerts` LEFT-joins onto `Concert.station_plays` for the On Tour "For You" **station-affinity** tier (a cold-start listener with no personal likes still sees heavy-rotation touring artists).

Two deliberate differences from the neighbors write:

- **UPSERT-only, no DELETE.** A play count only grows and drifts slowly; a stale row for an artist no longer touring is harmless (no upcoming concert joins it). Above all it must NOT share the neighbors' DELETE-on-empty lifecycle — a heavily-played artist with **no** affinity neighbors is exactly the cold-start card this tier exists to surface, so its count must survive an all-empty neighbor sweep. Hence a separate table and writer (`station-writer.ts`).
- **Written before the neighbors null-wipe early return.** `source_plays` is persisted independently of the neighbor verdicts, so it lands even when the neighbors sweep is all-empty. A responded run that returns no `source_plays` at all (semantic-index#369 undeployed, or a fault) trips a benign `station_empty_skip` guard — write nothing, never UPSERT zeros over real counts, never a non-zero exit (`station_plays` is harmless while null on the wire). `--backfill` covers station plays for the same cohort automatically.

## Id-space (the linchpin)

semantic-index#358 populates the graph's `artist.wxyc_library_code_id` from `wxyc_schema.artists.id` — "definitionally the consumer's id-space (`SimilarArtist.artist_id` keyspace)". Both endpoints return neighbors in **that** keyspace; only the lookup **key** differs (library `artists.id` vs external Discogs id). So the returned `SimilarArtist.artist_id` re-emits with zero field mapping in both lanes, and unbinding the headliner key (discogs lane) never moves the neighbor key.

## Null-wipe guard (integration-day + drift safety)

The endpoint returns all-empty until semantic-index#358 deploys **and** a nightly rebuild runs. If a whole sweep comes back empty over a non-empty cohort, the job **logs loudly with `/health` `mapped_artist_count`** (~22K when healthy — the disambiguator between "mapping not yet rebuilt" and a real fault) and **writes no neighbors** — never wiping the collected rows. It exits non-zero so the cron alerts **only when it also wrote no station plays** (BS#1702): a night that still records station play counts made progress, so the loud log fires for visibility but the run isn't reported as "wrote nothing". So that suppressing the exit can't blind a genuine fault, a healthy-`mapped_artist_count` all-empty sweep **also raises one aggregate Sentry signal** (`all_empty_sweep`) — the empty sweep over a healthy graph is "likely a real fault, not a bootstrap," so it stays alertable even at exit 0; a 0/null count is the expected pre-rebuild bootstrap and stays log-only. A broad-but-partial empties (empty fraction over 20%, likely a partial rebuild) suppresses the DELETE branch too; UPSERTs of the non-empty verdicts still land.

## Scheduling

Chained **after** the artist resolvers (05:15 strict/alias, 05:35 LML) and the 05:45 genre enrichment. Default `cron-schedule`: `55 5 * * *` UTC. It reads `headlining_artist_id`, so it must run after the 05:35 LML resolver that FK-closes that column on singleton Discogs matches — `05:15` would race the resolver.

## Modes

Modes apply to **both** lanes.

| Invocation                    | Cohort window                                                         | Writes                             |
| ----------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `node dist/job.js` (nightly)  | upcoming-only (`starts_on >= today`, venue-local Eastern)             | yes (overwrite)                    |
| `node dist/job.js --backfill` | **all dates** — the one-time deploy backfill over existing headliners | yes (overwrite)                    |
| `node dist/job.js --dry-run`  | (either)                                                              | no — enumerate + log the plan only |

## One-time backfill at deploy

```bash
# built + pushed by the deploy pipeline as an ECR image; run once at deploy:
docker run --rm --env-file .env <image> --backfill
```

Run off-peak, after semantic-index#358 has deployed and a nightly graph rebuild has run (otherwise the sweep is all-empty and the guard writes nothing).

## Env

| Var                                  | Default                    | Meaning                                                                |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------------------- |
| `SEMANTIC_INDEX_URL`                 | `https://explore.wxyc.org` | Base URL of the semantic-index graph API (public, no-auth)             |
| `CONCERTS_SIMILAR_ENRICH_LIMIT`      | 20                         | top-K neighbors per headliner (K=20 is the R3b contract)               |
| `CONCERTS_SIMILAR_ENRICH_CHUNK_SIZE` | 100                        | ids per endpoint chunk (hard cap 100 — the endpoint's per-request cap) |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`     | 60                         | cooperative-pause probe window (`0` disables)                          |

No API key: the endpoint is public and its worst case is a bounded local SQLite read, so there is no shared LML chokepoint and no rate limiter (~1 request/night).

## Endpoint contract (semantic-index#354 + #367)

Both calls are isolated in `neighbors-client.ts` behind one shared impl: `fetchNeighborsBatch` (library lane, `{ library_artist_ids }` → `/graph/library-artists/neighbors/batch`) and `fetchDiscogsNeighborsBatch` (discogs lane, `{ discogs_artist_ids }` → `/graph/discogs-artists/neighbors/batch`). Only the request path and the id-array field name differ; everything else is identical: `limit` (heat omitted → server default 0.5, the production blend), the cap (100 ids/call, structured 422 beyond — the job chunks at 100), and the response `{ results: { "<id>": [{ artist_id, weight }, ...] }, source_plays: { "<id>": <int> } }` keyed by stringified input id, every requested id present, weights descending and **list-relative** (comparable within one headliner's list, not across headliners — persisted as-is, ranked/capped client-side per wxyc-ios-64#493). An empty list means unknown/unmapped/ambiguous → "no enrichment", not an error.

`source_plays` (semantic-index#369, BS#1702) is the **library lane's** station-affinity signal — an additive map of each headliner's all-time WXYC flowsheet play count, validated to a non-negative integer, absent on an un-deployed semantic-index (degrades to `{}`, the station writer then writes nothing). The **discogs endpoint (#367) returns no `source_plays`**, and station plays are keyed on `artists.id`, so the discogs lane omits the `writeStation` dep entirely and does no station work. Every test mocks the network call; nothing here hits a live endpoint.
