# triangle-shows-etl

Nightly pull ETL (BS#1589, Phase 1 of the [BS#1570](https://github.com/WXYC/Backend-Service/issues/1570) touring-events integration): mirrors the [triangle-shows](https://github.com/WXYC/triangle-shows) concert calendar into `venues`/`concerts` for the **16 Triangle venues the RHP `venue-events-scraper` doesn't cover**. The existing `concerts-artist-resolver` stamps `headlining_artist_id` on the new rows in the same nightly cycle with no changes (its claim query selects on `headlining_artist_id IS NULL` with no source filter).

## Schedule

`cron-schedule: "5 5 * * *"` UTC (01:05 ET) — between the RHP scraper at 05:00 and the resolver at 05:15. Known soft edge (BS#1570 correction 5): a cold-starting triangle-shows host can occasionally push this pull past the 05:15 resolver, deferring artist resolution of new rows by one night. Self-healing; not a bug.

## Environment

| Var                                                           | Required | Purpose                                                                                                                                                                                                            |
| ------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRIANGLE_SHOWS_URL`                                          | yes      | Base URL of the triangle-shows API (no trailing slash). The job fails fast at startup when unset.                                                                                                                  |
| `SENTRY_DSN` / `SENTRY_RELEASE` / `SENTRY_TRACES_SAMPLE_RATE` | no       | Org-standard observability (issue #538 logger contract). The staleness signal is message-based (`Sentry.captureMessage`), so it works with tracing off — BS crons default `SENTRY_TRACES_SAMPLE_RATE=0` (BS#1457). |

Plus the standard `@wxyc/database` connection vars. See [`docs/env-vars.md`](../../docs/env-vars.md).

## The pull

`GET /api/v1/events?dedup=false&include_removed=true&start=<today − 8 days, America/New_York>` — a **full snapshot every run**, idempotent by construction (no `updated_since`).

- `dedup=false`: every stored row, not the calendar's cross-venue-collapsed view — this is a mirror, not a display surface.
- `include_removed=true`: tombstoned events included, so `removed_at` can be mirrored.
- **Back-dated `start` is contract-required**: the source's default `start=today` window hides a tombstone stamped on the event's own show date, and source rows are hard-deleted 7 days past their date. 8 days covers the full tombstone-observable window.

## Keying (load-bearing)

`source_id = '<venue_slug>:' + source_key` — **never bare `source_key`**. triangle-shows' uniqueness is per-venue (`(venue_id, source_key)` is its unique index); `source_key` alone collides across venues (VenuePilot external ids are small integers, and the ingested set contains three same-platform pairs: rubies+stancyks VenuePilot, neptunes-parlour+boom-club Squarespace, shadowbox-studio+slims MEC). Max composed length ~1165 chars — why migration 0112 widened `concerts.source_id` to `text`.

## Venue partition (BS#1570 Decision 1)

The 5 double-covered triangle-shows slugs are excluded — events skipped, no ETL-provisioned venue rows: `cats-cradle`, `cats-cradle-back-room`, `local-506`, `motorco`, `haw-river-ballroom`. Startup assertions fail the run loudly when (a) any excluded slug disappears from the source venue list (partition drift — re-verify the double-coverage set), or (b) an ingested slug would overflow `venues.slug varchar(64)`.

Supersession-checkpoint footnote (not this job's concern): BS's venue seed spells Motorco `motorco-music-hall`; triangle-shows uses `motorco`. Flipping a venue from RHP to triangle-shows later must map the slug or it will provision a duplicate venue row.

## Status divergence from `rhp_scrape` (deliberate)

For `source='triangle_shows'` rows, `status` is **source-authoritative — refreshed in both directions on every upsert** (including downgrades, e.g. `sold_out` back to `on_sale`). This deliberately diverges from the RHP writer's insert-only/admin-managed status: RHP's JSON-LD `Offer.availability` is too unreliable to drive automated transitions, while triangle-shows maintains an explicit per-event status enum refreshed by its 13 platform scrapers — for these rows the source is strictly better-informed than a BS admin. Do not "fix" one writer to match the other.

Same both-directions rule for `removed_at`: it mirrors the source's tombstone — set when stamped, **cleared when a delisted event reappears**. Absence-from-snapshot is never treated as a removal signal; rows that age out at the source (hard-delete at +7 days) may keep a NULL `removed_at` forever, which is fine because `starts_on` windowing retires them from any feed.

Field mapping details (status enum mapping incl. `free` → `on_sale` + `price_min=0`, `artist ?? name` truncation, date-only events keeping `starts_at` NULL) live in `map.ts` and its unit tests (`tests/unit/jobs/triangle-shows-etl/`).

## Observability

Org-standard JSON logs + Sentry (issue #538 contract). A loud Sentry **warning** fires when the source's `/api/v1/health.last_scrape` is > 24h stale — its scheduler scrapes 06:00/18:00 ET, so ~7h-old data at the 05:05 UTC pull is normal. A run with ingestable events but zero upserts exits non-zero so cron-success monitoring can't stay green through a write-path failure.

## No sync-notify / SSE

Deliberately absent until a live surface consumes concerts (the read API is Phase 2 of BS#1570).
