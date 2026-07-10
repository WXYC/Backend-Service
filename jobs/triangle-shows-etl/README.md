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

`source_id = '<venue_slug>:' + source_key` — **never bare `source_key`**. triangle-shows' uniqueness is per-venue (`(venue_id, source_key)` is its unique index); `source_key` alone collides across venues. The ingested set contains several same-platform groupings — a Ticketmaster quad (koka-booth, red-hat, dpac, the-ritz), an rhp_events pair (lincoln-theatre, the-pinhook), and the three pairs whose `ext:`/`url:` tier keys are the collision-prone kind (rubies+stancyks VenuePilot, neptunes-parlour+boom-club Squarespace, shadowbox-studio+slims MEC) — and the venue qualifier protects all of them uniformly. Max composed length ~1201 chars (source slug ≤100 + ':' + key ≤1100; ingested slugs are additionally asserted ≤64) — why migration 0112 widened `concerts.source_id` to `text`.

## Venue partition (BS#1570 Decision 1)

The 5 double-covered triangle-shows slugs are excluded — events skipped, no ETL-provisioned venue rows: `cats-cradle`, `cats-cradle-back-room`, `local-506`, `motorco`, `haw-river-ballroom`. Startup assertions fail the run loudly when (a) any excluded slug disappears from the source venue list (partition drift — re-verify the double-coverage set), or (b) an ingested slug would overflow `venues.slug varchar(64)` (the writer's `ensureVenue` enforces the same bound at the chokepoint, covering on-demand provisioning too; venue _names_ clamp to varchar(128) rather than fail — a long display name must not drop a venue's whole calendar).

The startup assertion only catches a known overlap _disappearing_. The forward direction — a NEW venue appearing (source growth, or `/venues` list drift with on-demand provisioning) — is surfaced as a single end-of-run Sentry warning listing every venue row the run actually INSERTed (`venues_created`): each entry is the cue to re-check the RHP double-coverage partition before duplicates accumulate. The first-ever run names all 16; after that the list should be empty.

Supersession-checkpoint footnote (not this job's concern): BS's venue seed spells Motorco `motorco-music-hall`; triangle-shows uses `motorco`. Flipping a venue from RHP to triangle-shows later must map the slug or it will provision a duplicate venue row.

## Status divergence from `rhp_scrape` (deliberate)

For `source='triangle_shows'` rows, `status` is **source-authoritative — refreshed in both directions on every upsert** (including downgrades, e.g. `sold_out` back to `on_sale`). This deliberately diverges from the RHP writer's insert-only/admin-managed status: RHP's JSON-LD `Offer.availability` is too unreliable to drive automated transitions, while triangle-shows maintains an explicit per-event status enum refreshed by its 13 platform scrapers — for these rows the source is strictly better-informed than a BS admin. Do not "fix" one writer to match the other.

Same both-directions rule for `removed_at`: it mirrors the source's tombstone — set when stamped, **cleared when a delisted event reappears**. Absence-from-snapshot is never treated as a removal signal; rows that age out at the source (hard-delete at +7 days) may keep a NULL `removed_at` forever, which is fine because `starts_on` windowing retires them from any feed.

Field mapping details (status enum mapping incl. `free` → `on_sale` + `price_min=0`, `artist ?? name` truncation, date-only events keeping `starts_at` NULL) live in `map.ts` and its unit tests (`tests/unit/jobs/triangle-shows-etl/`).

## Observability

Org-standard JSON logs + Sentry (issue #538 contract). A loud Sentry **warning** fires when the source's `/api/v1/health.last_scrape` is > 24h stale, absent, or unparseable — its scheduler scrapes 06:00/18:00 ET, so ~7h-old data at the 05:05 UTC pull is normal. Every fetch retries once after 15s (a cold-starting source host degrades to "resolution deferred one night", not "no mirror tonight") and non-2xx failures carry a slice of the response body so a FastAPI 422's `detail` is self-describing in the log.

**Run guards (exit non-zero):** an empty snapshot (0 events — a live Triangle calendar is never empty, so a 200-with-empty-array is a source regression, not a success); ingestable events with zero upserts; or failures outnumbering successes (majority-failure — a wholesale drift must not stay green because a handful of rows squeaked through). Per-event errors are counted and logged individually, but Sentry captures are deduped per distinct (step, message) per run so a 1,500-event drift is one Sentry event, not a quota flood; a venue whose provisioning failed is negative-cached for the rest of the run.

**Resolver caveat (Phase 2 must reconcile):** when the source has no `artist`, `headlining_artist_raw` falls back to the event _name_ — which feeds event-title strings into the `concerts-artist-resolver`'s exact-match arm. A title that happens to normalize to a library artist (tribute nights, DJ nights named after artists) can be FK-stamped to the wrong artist and thereby enter the curated partial index. The resolver also re-scans tombstoned/unresolvable rows nightly (its claim query has no `removed_at` filter). Both are deliberately left to the Phase 2 curation-predicate ticket (BS#1570 correction 3) — this job makes no resolver changes per BS#1589.

## No sync-notify / SSE

Deliberately absent until a live surface consumes concerts (the read API is Phase 2 of BS#1570).
