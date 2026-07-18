# concerts-genre-enrichment (BS#1624)

Nightly cron that enriches **resolved concert headliners** with artist-level Discogs **genres** (and styles), so `GET /concerts` can project `Concert.genres` (wxyc-shared#221) for the iOS On Tour tab (wxyc-ios-64#474 R2).

## What it does

1. Load candidates: RESOLVED headliners (`concerts.headlining_discogs_artist_id`, or a library `headlining_artist_id` whose `artists.discogs_artist_id` is known) that have **no** `artist_metadata` row yet — deduped by Discogs artist id.
2. Page them through LML's bulk artist-genres endpoint (`POST /api/v1/artists/genres/bulk`, LML#781).
3. UPSERT `genres`/`styles` into `artist_metadata` keyed on the Discogs artist id, `ON CONFLICT DO NOTHING`.

The effective Discogs id — `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)` — is the exact expression the `GET /concerts` projection joins `artist_metadata` on (`apps/backend/services/concerts.service.ts`), so enrichment writes and the read join resolve genres through the same key.

## Scheduling

Chained **after** the artist resolvers: 05:15 UTC strict/alias (`concerts-artist-resolver`) and 05:35 UTC LML (`concerts-artist-lml-resolver`). Default `cron-schedule`: `45 5 * * *` UTC. It only ever sees headliners those passes resolved.

## Modes

| Invocation                    | Candidate window                                                               | Writes                             |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| `node dist/job.js` (nightly)  | upcoming-only (`starts_on >= today`, venue-local Eastern)                      | yes                                |
| `node dist/job.js --backfill` | **all dates** — the one-time deploy backfill over existing resolved headliners | yes                                |
| `node dist/job.js --dry-run`  | (either)                                                                       | no — enumerate + log the plan only |

**Idempotency.** The candidate query anti-joins `artist_metadata` (`WHERE am.discogs_artist_id IS NULL`) and the writer is `ON CONFLICT DO NOTHING`, so a re-run — including a re-run of the one-time backfill — enriches nothing already enriched and never overwrites a collected row. A page whose LML call throws is skipped and its artists are re-selected next run (the anti-join is the retry substrate; there is no attempt-at marker).

## One-time backfill at deploy

```bash
# built + pushed by the deploy pipeline as an ECR image; run once at deploy:
docker run --rm --env-file .env <image> --backfill
```

Run off-peak. Re-running is a no-op.

## Env

| Var                                    | Default | Meaning                                                                              |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `CONCERTS_GENRE_ENRICH_PAGE_SIZE`      | 10      | artists per LML page (hard cap `ARTIST_GENRES_BATCH_CAP` = 25)                       |
| `CONCERTS_GENRE_ENRICH_MAX_CONCURRENT` | 1       | limiter concurrency                                                                  |
| `CONCERTS_GENRE_ENRICH_RATE_PER_MIN`   | 20      | limiter page rate                                                                    |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`       | 60      | cooperative-pause probe window (`0` disables)                                        |
| `LIBRARY_METADATA_URL`, `LML_API_KEY`  | —       | LML endpoint + server-to-server bearer (merged at the `@wxyc/lml-client` chokepoint) |

## LML contract (reconciled — LML#847)

The LML call is isolated behind `fetchArtistGenresBulk` in `@wxyc/lml-client`, reconciled against the shipped `POST /api/v1/artists/genres/bulk` endpoint (LML#781, merged as LML#847) and the wxyc-shared `ArtistGenres*` contract (#235): request `{ artist_name, discogs_artist_id? }[]` under the `artists` envelope key; response per-artist `{ genres: string[], styles: string[], source }`, index-aligned with the request. `fetchArtistGenresBulk` enforces `results.length === artists.length` before returning (throws `LmlClientError(502)` on a misaligned array), so the orchestrator's positional zip can never mis-attribute a genre set. Per-request cap `ARTIST_GENRES_BATCH_CAP` = 25. LML's `source` discriminator routes the write: `unavailable` (LML couldn't reach Discogs) is skipped and left retryable; `cache`/`discogs_api`/`not_found` persist. Every test mocks the LML call; nothing here hits a live endpoint.
