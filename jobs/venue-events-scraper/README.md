# venue-events-scraper

Daily cron job that pulls upcoming concerts from Rockhouse Partners-powered Triangle venue sites (catscradle.com, local506.com — extensible via [`rhp-venues.ts`](rhp-venues.ts)) and UPSERTs them into the `concerts` table.

First ingestion source for the on-tour feature. Future sources (Bandsintown live-fetch, editorial submissions) extend the `concert_source_enum` rather than replacing this job — see the migration block comment in [`shared/database/src/migrations/0091_venues-and-concerts.sql`](../../shared/database/src/migrations/0091_venues-and-concerts.sql).

## What it does

For each configured RHP venue site:

1. Fetches `<base_url>/events/` and extracts every `/event/<slug>/` link. Each listing card (`.eventWrapper` / `.rhp-event`) also contributes its `h4.eventSubHeader` text to that card's first event link.
2. Fetches each event detail page concurrently (cap: `VENUE_SCRAPER_CONCURRENCY`, default 8) and parses the schema.org `Event` JSON-LD block emitted by the Rockhouse Partners WordPress plugin under the literal `<!-- Event Markup for Official Venue Sites -->` comment. The headliner is the JSON-LD `name`. The support acts come from the listing-card subheader, with a leading `with ` / `w/` removed and split on commas only ("and" stays inside names). Without a subheader, they fall back to the Etix ticket-URL slug, which loses `/` and `,` (`Tobacco Roadwim Tapley And The Cannons`) — see [BS#3633](https://github.com/WXYC/Backend-Service/issues/3633).
3. Resolves `venues.slug` → `venue_id`, seeding the `venues` row on first sight from `VENUE_SEEDS` or from the JSON-LD `location` fallback.
4. UPSERTs each parsed concert into `concerts` keyed on `(source='rhp_scrape', source_id=<event-page-pathname>)`.

The architecture is single-source-uniqueness, not cross-source dedup: re-scrapes update in place, but the same logical concert from a future `submission` source would create a separate row. Dedup across sources is deferred to a read-time view so we preserve the per-source audit trail.

## Schedule and operations

- **Cron**: `0 5 * * *` UTC = 01:00 ET overnight, before the LML backfill window. Registered via deploy-base from `package.json`'s `cron-schedule` field.
- **Runtime**: typically <60s for the current two sites (catscradle.com ~96 events, local506.com ~20 events).
- **Exit code**: 1 if every site fails its index fetch (suggests an environmental problem worth paging on); 0 otherwise. Per-page failures are counted but don't fail the run.

## Environment variables

| Variable                    | Default | Purpose                                           |
| --------------------------- | ------- | ------------------------------------------------- |
| `VENUE_SCRAPER_CONCURRENCY` | `8`     | Per-site in-flight event-page fetch cap (1..32).  |
| `DB_STATEMENT_TIMEOUT_MS`   | `60000` | Inherited from `Dockerfile.venue-events-scraper`. |
| `SENTRY_DSN`                | unset   | Optional. When unset the SDK no-ops.              |

## Adding a new venue

Two cases:

**Same RHP plugin, new site.** Confirm the site embeds `<!-- Event Markup for Official Venue Sites -->` on event detail pages (curl one event page, grep), then append to `RHP_SITES` in [`rhp-venues.ts`](rhp-venues.ts):

```ts
{
  site_slug: 'new-rhp-venue',
  base_url: 'https://newvenue.example',
  default_venue_slug: 'new-rhp-venue',
  venue_name_to_slug: { 'New Venue': 'new-rhp-venue' },
},
```

Also add a `VENUE_SEEDS` entry so the venues row gets canonical city/state/address. Without one, the writer creates a placeholder row: the city comes from the JSON-LD address (`"107 Brewer Lane, Carrboro, North Carolina"` → `Carrboro`), or `''` when the address names none, and the state is always `NC`. The writer never stores a placeholder word such as `Unknown`, because clients print `venue.city` as-is. A placeholder row's city is filled in on a later run once the address yields one, and only while the city is still `''` or the legacy `Unknown`, so a hand-corrected city survives.

**Different platform.** The parser is RHP-specific (it expects the JSON-LD block under that specific HTML comment marker). For other ticketing platforms, add a sibling fetcher / parser pair and a new `concert_source_enum` value.

## Source-format drift detection

The parser is strict about schema.org's required fields (`name`, `startDate`, `@type === 'Event'`). If RHP changes their HTML, the affected pages count as `parse_errors` (loud Sentry events) rather than silently producing garbage rows. A wholesale format change surfaces as `parse_errors >> 0` in the job's final log line; a single bad page is just a noisy event.

The 0091 migration's `raw_data jsonb` column carries the parsed JSON-LD for every concert row, so we can forensically diff source payloads when investigating drift.

## Bandsintown-related architectural note

This job does **not** write to `concerts` from Bandsintown. Bandsintown's [Data Applications Terms](https://corp.bandsintown.com/data-applications-terms) forbid persistent caching of API results (session-only). The Bandsintown integration lives on a separate live-fetch path that bypasses the `concerts` table entirely. See [`plans/touring-events/bandsintown-outreach.md`](https://github.com/WXYC/wxyc-workspace) in the workspace meta-repo for the partnership-ask context.
