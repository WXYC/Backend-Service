# concerts-poster-enrichment (BS#1743)

Nightly cron that enriches **concert rows missing a poster image** (`concerts.image_url IS NULL`) with the resolved headliner's Discogs artist image, so `GET /concerts` (which already serves `image_url` unchanged) stops falling back to iOS's generated gradient for shows whose source scrape never captured a poster (Motorco / Chapel of Bones / Pour House — see WXYC/triangle-shows#54 — or any other venue's event page that didn't expose a parseable image at scrape time).

## Hard dependency: WXYC/Backend-Service#1742

Both concert writers (`jobs/triangle-shows-etl/writer.ts`, `jobs/venue-events-scraper/writer.ts`) currently overwrite `concerts.image_url` on every re-upsert with whatever the source scrape hands over that cycle — including `null` when the scrape didn't find an image that time. **#1742** changes both writers' `onConflictDoUpdate` to `image_url: sql\`COALESCE(excluded."image_url", ${concerts.image_url})\`` so a null re-scrape can no longer clobber a previously-captured (or enriched) poster.

**#1742 must be merged and deployed before this job runs in production.** Without it, the very next scrape cycle (every 5-6 hours) after this job writes an enriched poster would null it right back out. The two changes touch disjoint files and can be reviewed in parallel, but the deploy order matters.

## What it does

1. Load candidates: concert rows with `image_url IS NULL`, `removed_at IS NULL`, in the upcoming-show window, whose headliner has a resolvable Discogs id — `COALESCE(headlining_discogs_artist_id, artists.discogs_artist_id)`, the exact expression the genre-enrichment sibling and `GET /concerts` both key on.
2. Dedupe the candidates by headliner Discogs id (an artist billed on multiple upcoming shows gets exactly one lookup) and page the distinct-artist list.
3. Call LML's `GET /api/v1/discogs/artist/:id` (`getArtistDetails`, `@wxyc/lml-client`) once per distinct headliner, rate-limited by a job-owned limiter.
4. For every artist whose Discogs profile carries a real (non-blank) `image_url`, UPDATE `concerts.image_url` for every concert row that artist headlines — gated to `image_url IS NULL` so a concurrent write can't be overwritten.

No new column, no migration, no DTO/contract change — `image_url` is already on `concerts` and already projected by `toConcertDTO`. The read path needs no change.

## Modes

| Invocation                    | Candidate window                                                                           | Writes                             |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- |
| `node dist/job.js` (nightly)  | upcoming-only (`starts_on >= today`, venue-local Eastern), rows with `image_url IS NULL`   | poster image                       |
| `node dist/job.js --backfill` | **all dates** — the one-time deploy backfill over existing resolved, unenriched headliners | poster image                       |
| `node dist/job.js --dry-run`  | (either of the above)                                                                      | no — enumerate + log the plan only |

## Idempotency + data safety

- The candidate predicate (`image_url IS NULL`) and the writer's UPDATE guard (`WHERE image_url IS NULL`) are the same condition, so a re-run never touches an already-populated row — collected posters (scraped or enriched) are never overwritten.
- There is **no negative cache**. Unlike the genre sibling, which persists an empty verdict into a separate `artist_metadata` row to avoid re-asking forever, this job has nowhere to record "this artist has no Discogs image" other than `concerts.image_url` itself — and writing an empty string there would violate the "skip null/blank, never write empty" constraint. A no-image artist's concerts simply stay candidates and are re-queried every run until either the source scrape captures a poster or Discogs gains an image. This is bounded: the candidate window is the small upcoming-show cohort (mirrors the similar-artists sibling's full-window re-fetch, not the genre sibling's anti-join), and every lookup is rate-limited.
- A per-artist fetch failure (transport error, LML/Discogs error) is skipped and left retryable — no attempt-at marker, the `image_url IS NULL` predicate is the retry substrate.

## Scheduling

Chained after the artist resolvers (05:15 UTC strict/alias, 05:35 UTC LML), the 05:45 UTC genre enrichment, and the 05:55 UTC similar-artists enrichment. Default `cron-schedule`: `05 6 * * *` UTC.

## One-time backfill at deploy

```bash
# built + pushed by the deploy pipeline as an ECR image; run once at deploy,
# AFTER #1742 has deployed:
docker run --rm --env-file .env <image> --backfill
```

Run off-peak. Re-running is a no-op over rows the job (or a scrape) has since filled.

## Env

| Var                                     | Default | Meaning                                                                                                                                           |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONCERTS_POSTER_ENRICH_PAGE_SIZE`      | 10      | distinct headliners per page (paces the cooperative-pause probe + log cadence — there is no bulk endpoint here, so this is not an LML batch size) |
| `CONCERTS_POSTER_ENRICH_MAX_CONCURRENT` | 1       | limiter concurrency                                                                                                                               |
| `CONCERTS_POSTER_ENRICH_RATE_PER_MIN`   | 20      | limiter rate, in ARTISTS per minute (one token per `getArtistDetails` call)                                                                       |
| `LIVE_ACTIVITY_LOOKBACK_SECONDS`        | 60      | cooperative-pause probe window (`0` disables)                                                                                                     |
| `LIBRARY_METADATA_URL`, `LML_API_KEY`   | —       | LML endpoint + server-to-server bearer (merged at the `@wxyc/lml-client` chokepoint)                                                              |

## LML contract

`getArtistDetails(artistId)` (`shared/lml-client/src/index.ts`) hits `GET /api/v1/discogs/artist/:id` and returns `DiscogsArtistDetails`, which carries `image_url?: string | null`. This is the same internal call the proxy controller already uses for the iOS artist-details passthrough — no new external integration. Unlike `fetchArtistGenresBulk`, `getArtistDetails` is a single-artist call with no bulk variant and no built-in limiter, so this job wraps every call in its own job-owned `LmlLimiter` (`lml-limiter.ts`).

## Prior art reused

- `shared/lml-client` `getArtistDetails` — already used by `apps/backend/controllers/proxy.controller.ts`.
- `apps/enrichment-worker/enrich.ts` — persists `artist_image_url` for albums from the analogous Discogs artist-image source (different table, same source).
- `jobs/concerts-genre-enrichment/` — the scaffold this job was cloned from (job.ts entrypoint shape, cooperative-pause probe, logger, limiter).
- `jobs/concerts-artist-resolver/writer.ts` — the single-row `UPDATE ... WHERE <column> IS NULL` idempotent-write pattern this job's writer generalizes to an array of concert ids.
