# concerts-similar-artists-enrichment (BS#1626)

Nightly cron that enriches **upcoming curated in-library concert headliners** with artist-level **affinity neighbors** from the semantic-index graph, so `GET /concerts` can project `Concert.similar_artists` (wxyc-shared#222) for the iOS On Tour "For You" shelf (wxyc-ios-64#493 / R3b). The iOS client matches concerts against on-device likes by set intersection: `concert.similar_artists ∩ likedIds`.

Sibling of `concerts-genre-enrichment` (BS#1624) — same standalone-nightly-job shape and read-projection split — but reads a **different service** (semantic-index, not LML), keys at a **different id-space** (`artists.id`, not a Discogs id), and uses a **different refresh policy** (full-window nightly overwrite, not a presence anti-join).

## What it does

1. Load the cohort: distinct `artists.id` of **in-library** headliners (`concerts.headlining_artist_id IS NOT NULL`) of non-removed upcoming curated concerts. No anti-join — the whole cohort is re-fetched every night.
2. Chunk (<= 100 ids/chunk) through semantic-index's `POST /graph/library-artists/neighbors/batch` (semantic-index#354), `{ library_artist_ids, limit: 20 }`.
3. **Overwrite** `artist_similar_artists` keyed on `artists.id`:
   - non-empty verdict → UPSERT (`ON CONFLICT (artist_id) DO UPDATE` — keeps neighbors current with the graph rebuild);
   - empty verdict from a responded chunk → DELETE the row (the genuine now-unmapped/ambiguous ~1%);
   - a chunk whose fetch **throws** → its ids are neither upserted nor deleted (retryable next run; a transport failure never wipes a healthy row).

`headlining_artist_id`, `library_artist_ids`, and the response `artist_id`s are all one keyspace (`artists.id`; verified against semantic-index#358), so the job sends and persists ids verbatim — no translation, no join.

## Station-affinity play count (BS#1702)

The same nightly call also carries `source_plays` (semantic-index#369) — the headliner's all-time WXYC flowsheet play count (`artist.total_plays`), keyed by the same stringified input id. The job collects it across chunks and **UPSERTs it into the sibling table `artist_station_plays`** (`ON CONFLICT (artist_id) DO UPDATE`), which `GET /concerts` LEFT-joins onto `Concert.station_plays` for the On Tour "For You" **station-affinity** tier (a cold-start listener with no personal likes still sees heavy-rotation touring artists).

Two deliberate differences from the neighbors write:

- **UPSERT-only, no DELETE.** A play count only grows and drifts slowly; a stale row for an artist no longer touring is harmless (no upcoming concert joins it). Above all it must NOT share the neighbors' DELETE-on-empty lifecycle — a heavily-played artist with **no** affinity neighbors is exactly the cold-start card this tier exists to surface, so its count must survive an all-empty neighbor sweep. Hence a separate table and writer (`station-writer.ts`).
- **Written before the neighbors null-wipe early return.** `source_plays` is persisted independently of the neighbor verdicts, so it lands even when the neighbors sweep is all-empty. A responded run that returns no `source_plays` at all (semantic-index#369 undeployed, or a fault) trips a benign `station_empty_skip` guard — write nothing, never UPSERT zeros over real counts, never a non-zero exit (`station_plays` is harmless while null on the wire). `--backfill` covers station plays for the same cohort automatically.

## Id-space (the linchpin)

semantic-index#358 populates the graph's `artist.wxyc_library_code_id` from `wxyc_schema.artists.id` — "definitionally the consumer's id-space (`SimilarArtist.artist_id` keyspace)". So `concerts.headlining_artist_id` is exactly what the endpoint keys on, and the returned `SimilarArtist.artist_id` re-emits with zero field mapping. Discogs-only headliners (no `artists.id`) have no `library_artist_id` and are **out of scope** (the genre sibling covers their genres; the affinity graph can't cover them).

## Null-wipe guard (integration-day + drift safety)

The endpoint returns all-empty until semantic-index#358 deploys **and** a nightly rebuild runs. If a whole sweep comes back empty over a non-empty cohort, the job **logs loudly with `/health` `mapped_artist_count`** (~22K when healthy — the disambiguator between "mapping not yet rebuilt" and a real fault) and **writes no neighbors** — never wiping the collected rows. It exits non-zero so the cron alerts **only when it also wrote no station plays** (BS#1702): a night that still records station play counts made progress, so the loud log fires for visibility but the run isn't reported as "wrote nothing". A broad-but-partial empties (empty fraction over 20%, likely a partial rebuild) suppresses the DELETE branch too; UPSERTs of the non-empty verdicts still land.

## Scheduling

Chained **after** the artist resolvers (05:15 strict/alias, 05:35 LML) and the 05:45 genre enrichment. Default `cron-schedule`: `55 5 * * *` UTC. It reads `headlining_artist_id`, so it must run after the 05:35 LML resolver that FK-closes that column on singleton Discogs matches — `05:15` would race the resolver.

## Modes

| Invocation                    | Cohort window                                                                    | Writes                             |
| ----------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| `node dist/job.js` (nightly)  | upcoming-only (`starts_on >= today`, venue-local Eastern)                        | yes (overwrite)                    |
| `node dist/job.js --backfill` | **all dates** — the one-time deploy backfill over existing in-library headliners | yes (overwrite)                    |
| `node dist/job.js --dry-run`  | (either)                                                                         | no — enumerate + log the plan only |

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

## Endpoint contract (semantic-index#354)

The call is isolated behind `fetchNeighborsBatch` in `neighbors-client.ts`. Request `{ library_artist_ids: number[], limit }` (heat omitted → server default 0.5, the production blend). Response `{ results: { "<id>": [{ artist_id, weight }, ...] }, source_plays: { "<id>": <int> } }` keyed by stringified input id; every requested id present; weights descending and **list-relative** (comparable within one headliner's list, not across headliners — persisted as-is, ranked/capped client-side per wxyc-ios-64#493). `source_plays` (semantic-index#369, BS#1702) is **additive** — absent on an un-deployed semantic-index, in which case the client degrades it to `{}` (the station writer then writes nothing). The client validates each play count to a non-negative integer, mirroring the neighbor sanitization. Cap 100 ids/call with a structured 422 beyond; the job chunks at 100. An empty list means unknown/unmapped/ambiguous → "no enrichment", not an error. Every test mocks the network call; nothing here hits a live endpoint.
