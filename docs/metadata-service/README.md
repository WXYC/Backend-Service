# Metadata Service

This document describes how the backend service fetches and serves album/artist metadata (artwork URLs, streaming links, artist bios) as part of flowsheet responses.

## Overview

When a track is added to the flowsheet, the backend fetches metadata from [library-metadata-lookup](https://github.com/WXYC/library-metadata-lookup) (LML) asynchronously and stores it directly on the flowsheet row. Subsequent GET requests return the metadata inline with the entry. LML handles its own caching of Discogs API data, so no additional cache layer is needed on the backend.

## Architecture

| Component                | Responsibility                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Flowsheet Controller** | Handles HTTP requests, triggers async metadata fetch, updates the flowsheet row                                  |
| **Flowsheet Service**    | Database queries returning entries with inline metadata                                                          |
| **Metadata Service**     | Calls LML for Discogs data and enriched streaming URLs                                                           |
| **LML**                  | External service: Discogs search, release details, artist details, streaming URL enrichment (with its own cache) |

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

## Fire-and-Forget Metadata Fetch

When a track is added, metadata is fetched asynchronously without blocking the response:

1. `POST /flowsheet` inserts the entry to the database
2. If the entry has an `artist_name`, `fetchMetadata()` is called asynchronously
3. The HTTP response returns immediately (metadata columns are null)
4. `fetchMetadata()` calls LML's Discogs search, release details, and artist details endpoints
5. On success, the flowsheet row is updated with the metadata via `db.update(flowsheet).set(...)`
6. On the next GET request, the metadata is included in the response

### LML Endpoints Used

| Endpoint                           | Data Retrieved                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `POST /api/v1/discogs/search`      | artwork_url, release_url, release_year, streaming URLs, artist_bio, wikipedia_url |
| `GET /api/v1/discogs/release/{id}` | Enriched artwork_url, year, artist_id                                             |
| `GET /api/v1/discogs/artist/{id}`  | Artist profile (bio), Wikipedia URL                                               |

### Fallback Behavior

When LML returns no results or is unavailable, the metadata service constructs search URLs for YouTube Music, Bandcamp, and SoundCloud as a bare minimum. These are generic search links, not direct album/track URLs.

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

The `LIBRARY_METADATA_URL` environment variable must be set to the LML service base URL (e.g., `http://localhost:8001`). Without this, metadata fetching is silently skipped and all metadata columns remain null.

## Migration History

| Migration                            | Purpose                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `0023_metadata_tables.sql`           | Created separate album_metadata and artist_metadata cache tables (original design) |
| `0035_inline_flowsheet_metadata.sql` | Added metadata columns to flowsheet table, dropped the cache tables                |
