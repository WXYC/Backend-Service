# triangle-shows-etl

Nightly pull ETL (BS#1589): mirrors the [triangle-shows](https://github.com/WXYC/triangle-shows) concert calendar API into `venues`/`concerts` for the Triangle venues the RHP `venue-events-scraper` doesn't cover. Second producer for the touring-events feature, alongside `rhp_scrape`.

## How it runs

Cron-registered via deploy-base's `cron-schedule` from `package.json`: `5 5 * * *` UTC (01:05 ET) — after the venue-events-scraper at 05:00 and before the concerts-artist-resolver at 05:15, so rows from both sources get `headlining_artist_id` stamped in the same nightly cycle. The resolver needs no changes: its claim query selects on `headlining_artist_id IS NULL` with no source filter.

Every run is a full snapshot, idempotent by construction — no incremental cursor, no `cronjob_runs` watermark. The pull is:

```
GET /api/v1/venues
GET /api/v1/events?dedup=false&include_removed=true&start=<today − 8 days, America/New_York>
GET /api/v1/health   (staleness check only)
```

The query string is contract, not plumbing: it's the mirror-consumer recipe shipped by triangle-shows Phase 0. The back-dated `start` matters — the source's default `start=today` window hides a tombstone stamped on an event's own show date, and source rows are hard-deleted 7 days past their date, so an 8-day reach-back guarantees every observable tombstone is inside the window.

## Keying

`source_id = '<venue_slug>:' + source_key` — **never bare `source_key`**. The source's `source_key` (tier-prefixed `ext:`/`url:`/`hash:`, contract in triangle-shows `backend/README.md`) is unique per `(venue_id, source_key)` only, and the ingested set contains three same-platform venue pairs whose `ext:`/`url:` keys can collide across venues (rubies+stancyks on VenuePilot, neptunes-parlour+boom-club on Squarespace, shadowbox-studio+slims on MEC). The slug used for qualification is resolved from the run's venue list by `venue_id`, not the event's denormalized `venue_slug` join field.

## Venue partition (BS#1570 Decision 1)

Five double-covered slugs stay on the RHP scraper and are excluded here: `cats-cradle`, `cats-cradle-back-room`, `local-506`, `motorco`, `haw-river-ballroom`. Two startup assertions in `venues.ts` make drift run-fatal: every excluded slug must still exist in the source venue list (a vanished slug means the partition needs re-auditing, not silent ingestion), and every ingested slug must fit `venues.slug varchar(64)`. A **new** unexcluded slug is not drift — new rooms flow straight in.

Ingested venues are UPSERTed on `slug` with `name`/`city` from the source and `state = 'NC'` hardcoded, eventless venues included. The source is authoritative for name/city/state on these slugs (admin edits revert next run — fix the data at the triangle-shows source); `address` is never written, so an admin-entered address survives.

## Status divergence from rhp_scrape (deliberate)

For `source='triangle_shows'`, `status` is **source-authoritative**: refreshed in both directions on every upsert, so a sold-out show that reopens when new tickets release flips back to `on_sale` on the next pull. This deliberately diverges from `rhp_scrape`, whose status is insert-only/admin-managed because RHP's `Offer.availability` isn't trustworthy. The source's status enum maps as: `on_sale`/`sold_out`/`cancelled` identity; `free` → `on_sale` + `price_min = 0` (an explicit source price wins over the derived zero). BS's `rescheduled` has no producer here. A status outside the source enum fails that one event (`map_errors`), never the run.

`removed_at` is mirrored the same way — set when the source tombstones an event, **cleared on reappearance** (the explicit null is in the conflict-update set). Absence-from-snapshot is never a removal signal: rows age out at the source with tombstones sometimes never observed, which is fine because `starts_on` windowing retires them from any feed.

Shared invariant with the RHP writer: `first_scraped_at` is omitted from both insert values and the conflict-update set (BS#1385 — the INSERT-only stability anchor).

`headlining_artist_id` is conditionally cleared on conflict when the raw headliner actually changed (`IS DISTINCT FROM excluded`): the concerts-artist-resolver is write-once and would otherwise serve a swapped headliner under the old artist forever. Untouched rows keep their resolved id. (The RHP writer has the same latent gap for `rhp_scrape` rows — tracked separately, since its raw headliner also refreshes on conflict.)

## Field mapping

See `map.ts` (pure, unit-tested in `tests/unit/jobs/triangle-shows-etl/`). Highlights: `starts_on` ← `date` verbatim (venue-local calendar day, NOT NULL); `starts_at`/`doors_at` composed from `date` + `show_time`/`doors_time` in America/New_York, NULL when the source has no time — no fabricated times; `headlining_artist_raw` ← `artist` when non-blank, else `name` (empty/whitespace artist falls back too), truncated to 256 code points; `title` ← `name`; `supporting_artists_raw` ← `support_artists` split on commas; prices → `numeric(8,2)` dollars; `genre`/`subgenre`/`description` stay in `raw_data` only.

## Known edges (documented, not bugs)

- **Cross-source duplicates**: an RHP "presents" listing at a triangle-owned venue (e.g. catscradle.com listing a show at The Ritz) creates an `rhp_scrape` row for the same physical show this ETL mirrors as `triangle_shows` — and under a _different_ `venues` row, since RHP's generic slugifier and triangle-shows slugs differ. Multi-source rows are deliberate (see the concerts table docstring: dedup is deferred to a read-time view); the Phase 2 dedup view must therefore handle venue-slug aliasing, not just same-`venue_id` collapse.
- **Ingested-slug rename**: if the source renames an ingested venue's slug, events re-key and INSERT as new rows while the old rows never tombstone (bounded by `starts_on` windowing). The `venues_created` counter makes this observable — see Observability.
- **Time-order anomalies**: free-text source scrapers can pair a past-midnight `show_time` with the advertised calendar date, composing a `starts_at` before `doors_at` (and ~24h before the real moment). Counted and logged (`time_order_anomalies`), passed through unmodified — no heuristic can safely re-shift either timestamp (the inverse skew also occurs, where `starts_at` is correct and a misparsed `doors_time` is the wrong one). The real fix belongs upstream in the triangle-shows scrapers.

## Observability

Org-standard JSON log counters (`finished` line carries the run totals) + Sentry error capture, same contract as the venue-events-scraper. A loud `source_stale` warning fires when the source's `/api/v1/health` reports `last_scrape` over 24h old — ~7h-old data at the 05:05 UTC pull is normal (the source's scheduler scrapes at 06:00/18:00 ET). Note BS crons default `SENTRY_TRACES_SAMPLE_RATE=0` (BS#1457): error events flow regardless, but if an alert ever needs to key on span attributes, enable tracing for this job explicitly.

The job exits non-zero when the venue partition assertion fails, venue provisioning fails, the events pull fails, the snapshot is empty (`0 events` is never legitimate for an unbounded upcoming window — it means a wiped source, wrong deployment, or window-param regression), or events were pulled but zero upserted — so cron-success monitoring can't stay green on a silently-empty run. HTTP pulls retry once on 5xx/timeout (Railway cold starts).

`venues_created` in the finished-line totals should be 16 on the first run and 0 in steady state. Nonzero afterwards means either a genuinely new room or an ingested-slug rename — the latter permanently re-keys that venue's events, so audit the `venue_created` warn lines before Phase 2 trusts the feed.

## Env

- `TRIANGLE_SHOWS_URL` (required) — base URL of the triangle-shows API. See `docs/env-vars.md`.
- Standard database variables (`DB_HOST` etc.) from `shared/database`.

## Development

```bash
npm run build --workspace=@wxyc/triangle-shows-etl   # tsup bundle
npx tsc -p jobs/triangle-shows-etl --noEmit          # direct typecheck — jobs/** is OUTSIDE `npm run typecheck`, and tsup is transpile-only
npx jest --config jest.unit.config.ts tests/unit/jobs/triangle-shows-etl/
```
