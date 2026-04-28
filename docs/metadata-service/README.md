# Metadata Service

This document describes how the backend service fetches and serves album/artist metadata (artwork URLs, streaming links, artist bios) as part of flowsheet responses.

## Overview

When a track is added to the flowsheet, the backend fetches metadata from [library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup) (LML) asynchronously and stores it directly on the flowsheet row. Subsequent GET requests return the metadata inline with the entry. LML handles its own caching of Discogs API data, so no additional cache layer is needed on the backend.

## Architecture

| Component                                                                       | Responsibility                                                                                           |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Flowsheet Controller** (`apps/backend/controllers/flowsheet.controller.ts`)   | Handles `POST /flowsheet` from dj-site; calls the shared enrichment helper after the row is inserted     |
| **Webhook Receiver** (`apps/backend/routes/internal.route.ts`)                  | Handles `POST /internal/flowsheet-webhook` from tubafrenzy; calls the shared enrichment helper on INSERT |
| **Enrichment Service** (`apps/backend/services/metadata/enrichment.service.ts`) | Shared `fireAndForgetMetadataForRow` — fetches metadata and updates the flowsheet row                    |
| **Metadata Service** (`apps/backend/services/metadata/metadata.service.ts`)     | `fetchMetadata` — calls LML's `/lookup` endpoint and shapes the response into the column-mapped result   |
| **LML Client** (`apps/backend/services/lml/lml.client.ts`)                      | Single HTTP chokepoint with timeout + bearer auth header                                                 |
| **LML**                                                                         | External service: unified `/lookup` endpoint with 3-tier caching (memory + PostgreSQL + Discogs API)     |

### Metadata Fields on Flowsheet

| Column                 | Type         | Source                                        |
| ---------------------- | ------------ | --------------------------------------------- |
| `artwork_url`          | varchar(512) | LML (Discogs)                                 |
| `discogs_url`          | varchar(512) | LML (Discogs)                                 |
| `release_year`         | smallint     | LML (Discogs)                                 |
| `spotify_url`          | varchar(512) | LML enrichment                                |
| `apple_music_url`      | varchar(512) | LML enrichment                                |
| `youtube_music_url`    | varchar(512) | LML enrichment or search URL fallback         |
| `bandcamp_url`         | varchar(512) | LML enrichment or search URL fallback         |
| `soundcloud_url`       | varchar(512) | LML enrichment or search URL fallback         |
| `artist_bio`           | text         | LML (Discogs artist profile, markup stripped) |
| `artist_wikipedia_url` | varchar(512) | LML (Discogs artist URLs)                     |

## Fire-and-Forget Enrichment

Both flowsheet write paths converge on the same shared helper, `fireAndForgetMetadataForRow` (`apps/backend/services/metadata/enrichment.service.ts`). The promise is intentionally not awaited — enrichment must never block the HTTP response. Errors are logged and reported to Sentry under `subsystem='metadata'`, never thrown.

### dj-site path: `POST /flowsheet`

1. The controller inserts the entry to the database.
2. If the entry has an `artist_name`, `fireAndForgetMetadataForRow` is invoked.
3. The HTTP response returns immediately (metadata columns are null).
4. The helper calls LML's `/api/v1/lookup` endpoint.
5. On a result with artwork, the row is updated with all 10 metadata columns.
6. On the next GET request, the metadata is included in the response.

### Tubafrenzy webhook path: `POST /internal/flowsheet-webhook`

1. The receiver upserts the row from the tubafrenzy event payload.
2. The upsert uses `RETURNING { id, created: (xmax = 0) }`. The `xmax = 0` predicate distinguishes a fresh INSERT from the `ON CONFLICT DO UPDATE` branch.
3. **Enrichment is gated on `created`.** Benign retries / no-op updates from tubafrenzy do not re-fetch from LML and do not re-write the metadata columns. This avoids amplifying CDC trigger fires + search_doc tsvector regen + 6-index updates on every duplicate webhook delivery.
4. On INSERT, `fireAndForgetMetadataForRow` runs identically to the dj-site path.
5. The `liveFs` SSE refetch event broadcasts immediately after the upsert (does not wait for enrichment to land — see [#628](https://github.com/WXYC/Backend-Service/issues/628) for the follow-up to re-emit after enrichment).

### LML Endpoint Used

| Endpoint              | Purpose                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/lookup` | Unified lookup: artist correction, title normalization, fallback strategies, artwork, streaming URLs, artist metadata in a single call |

The legacy per-component endpoints (`/api/v1/discogs/search`, `/api/v1/discogs/release/{id}`, `/api/v1/discogs/artist/{id}`) are still available on LML and are used by other Backend-Service paths (catalog search, proxy endpoints), but the metadata enrichment path consolidates onto `/lookup`.

### Fallback Behavior

When LML returns no results or is unavailable, the metadata service constructs search URLs for YouTube Music, Bandcamp, and SoundCloud as a bare minimum. These are generic search links, not direct album/track URLs. They give iOS/dj-site at least a "search for this on $service" affordance for the long tail of releases LML can't match.

## One-shot Recovery: `scripts/backfill-metadata.ts`

For populating metadata on rows inserted before this enrichment was wired in (or for rows where a prior enrichment returned null because LML's cache hadn't been populated yet), there's a one-shot script:

```bash
dotenvx run -f .env -- npx tsx scripts/backfill-metadata.ts
```

Env knobs:

- `BACKFILL_LIMIT` — number of entries to process (default `1000`)
- `BACKFILL_DRY_RUN` — set `true` to preview without updating

The script's WHERE filter is `WHERE artwork_url IS NULL` and it only updates rows when LML returns artwork. No-match rows are left null (so they'll be re-attempted on a future run if the LML matcher improves).

For the historical tail (~1.86M legacy NULL rows as of 2026-04-28), see [#631](https://github.com/WXYC/Backend-Service/issues/631) — that work needs a containerized backfill job rather than the inline script.

## Conditional GET (304 Not Modified)

The flowsheet endpoints support conditional requests via the `Last-Modified` header and either the `If-Modified-Since` header or `since` query parameter. This allows clients to avoid re-downloading unchanged data.

### How It Works

1. **Server response**: Every successful GET response includes a `Last-Modified` header
2. **Client request**: Client stores this timestamp and sends it back via `If-Modified-Since` header or `since` query parameter
3. **304 Not Modified**: If the flowsheet hasn't changed, server returns 304 (no body)
4. **200 OK**: If the flowsheet has changed, server returns full response with updated `Last-Modified`

### Supported Endpoints

| Endpoint                | Support |
| ----------------------- | ------- |
| `GET /flowsheet`        | Yes     |
| `GET /flowsheet/latest` | Yes     |

## Configuration

| Env var                | Purpose                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `LIBRARY_METADATA_URL` | LML service base URL (e.g. `http://localhost:8001`). Without this, metadata fetching is silently skipped.                |
| `LML_API_KEY`          | Bearer token sent on every LML request. Required in production once LML's `LML_REQUIRE_AUTH` is `true`. Optional in dev. |

## Migration History

| Migration                            | Purpose                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `0023_metadata_tables.sql`           | Created separate album_metadata and artist_metadata cache tables (original design) |
| `0035_inline_flowsheet_metadata.sql` | Added metadata columns to flowsheet table, dropped the cache tables                |
