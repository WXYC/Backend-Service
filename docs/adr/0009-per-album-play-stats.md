# 0009 — Per-album play-stats endpoint for the iOS Album Detail histogram

The iOS DJ tool's Album Detail screen gains a histogram of station-wide plays of the album over time, sized after Apple Health's [chart surfaces](https://developer.apple.com/documentation/charts). We expose one dedicated endpoint: `GET /library/{album_id}/play-stats`, returning both year and month buckets in one payload plus first-played-at / last-played-at / total-plays summary fields. Both granularities arrive in the same response so iOS's user-toggle (Year / Month) renders instantly without a second round trip. Scope is station-wide only — per-DJ play data for the same album is already answered by [ADR 0007 (per-DJ plays)](./0007-per-dj-plays-first-class-resource.md)'s `/djs/{id}/has-played` (Bin Maturity badges) and the Albums-axis amendment on `/djs/{id}/play-stats` (Top Played fold-in on Diversity Readout).

Architecturally this is the per-album sibling of [ADR 0007's per-DJ play history](./0007-per-dj-plays-first-class-resource.md) — same flowsheet substrate, different filter (`album_id` vs `dj_id`), parallel ADR rather than fold-in because the consumer-facing contracts and authorization profiles differ. Per-DJ stats carry per-user privacy implications and require the requesting user's authorization to read someone else's plays; per-album stats are intrinsically station-wide and require only signed-in-as-anyone.

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0008](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0008--per-album-play-history-is-a-first-class-api-surface-parallel-to-per-dj-plays) and the repo-local [iOS ADR 0003](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/adr/0003-per-album-play-stats.md). Companion BS mirror: [ADR 0010 (Search Plays endpoint)](./0010-search-plays-flowsheet-builder.md), which shares this ADR's caching posture and is the v2 home for the per-album drill-in deferred below.

## Our side of the work

- **Add `GET /library/{album_id}/play-stats`** to the existing `library/` controller. Response shape: `{ year_counts: {"2017": 1, "2018": 7, ...}, month_counts: {"2017-08": 1, ...}, first_played_at, last_played_at, total_plays }`. Both granularities in one payload so the iOS toggle is instant. Query is a `SELECT date_trunc(year|month, played_at), count(*) FROM flowsheet_entries WHERE album_id = $1 GROUP BY 1` — same substrate as the per-DJ stats endpoints we built in [ADR 0007](./0007-per-dj-plays-first-class-resource.md).
- **Confirm the index on `flowsheet_entries.album_id`** is in place (we believe it already is for other queries). If missing, add it as part of this work — the endpoint is read-heavy and the album_id filter must be cheap.
- **60s TTL cache** keyed on `album_id`, matching the staleness posture we adopted for [per-DJ stats (ADR 0007)](./0007-per-dj-plays-first-class-resource.md) and [Search Plays (ADR 0010)](./0010-search-plays-flowsheet-builder.md). Read rate is far higher than write rate (one row per actual play, infrequent for any given album); 60-second-stale aggregates are imperceptible.
- **OpenAPI surface** in [`wxyc-shared/api.yaml`](https://github.com/WXYC/wxyc-shared/blob/main/api.yaml) — `GET /library/{album_id}/play-stats` path + `AlbumPlayStats` response schema. Documented as station-wide-scope (no `dj_id` query param).

## Consequences for us

- **No new schema.** Endpoint consumes existing `flowsheet_entries.album_id` index. No migration. Reversible by removing the endpoint.
- **No drill-in endpoint in v1.** iOS ships tooltip-only on bar tap; raw-rows pagination (`GET /library/{album_id}/plays`) is deferred to a future ADR that lands alongside [iOS's Search Plays surface (ADR 0010)](./0010-search-plays-flowsheet-builder.md) — at which point the drill-in becomes a filtered view over the same `FlowsheetV2TrackEntry[]` shape that Search Plays already renders.
- **The endpoint shares query infrastructure with [ADR 0007's per-DJ trio](./0007-per-dj-plays-first-class-resource.md)** but does not block on it. The two ADRs can ship in parallel or in the same PR train — choice depends on which surface (Album Detail histogram vs. per-DJ Underplayed Gems / Diversity Readout / Bin Maturity) gets prioritized first.
- **LML is the iOS-side dependency for the release-year reference line**, not ours. The endpoint returns no metadata about the album beyond play stats; iOS reads release year from [`/proxy/metadata/album`](https://github.com/WXYC/library-metadata-lookup) separately, and gracefully drops the chart annotation if LML fails. Our endpoint stays available regardless.

## Related work tickets

[`wxyc-dj-tool-ios/docs/bs-work-inventory.md`](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/bs-work-inventory.md#bs-31-get-libraryalbum_idplay-stats-endpoint) sub-ticket [BS-31](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/bs-work-inventory.md#bs-31-get-libraryalbum_idplay-stats-endpoint) (endpoint + index check + OpenAPI). All S-sized; one PR.

## Sibling mirrors in this repo

- [ADR 0007 — Per-DJ plays endpoint group](./0007-per-dj-plays-first-class-resource.md) (the parallel per-DJ surface)
- [ADR 0010 — Search Plays endpoint](./0010-search-plays-flowsheet-builder.md) (companion endpoint sharing this caching posture)
