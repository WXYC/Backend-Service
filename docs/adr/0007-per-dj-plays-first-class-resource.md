# 0007 — Per-DJ play history is a first-class API surface, not a search workaround

Several v1 iOS picks (Underplayed Gems Phase 2, Diversity Readout, Bin Maturity) need per-DJ flowsheet history. The existing workarounds (`/flowsheet/search?q=dj:Name` for keyword search, `/djs/playlists` then enumerate-shows then fetch-each as N+1) don't scale and don't compose. We add a dedicated resource group, all backed by the same underlying `flowsheet_entries WHERE dj_id = X` query foundation so the three ship in one PR:

```
GET /djs/{id}/plays?since=ISO_DATE&limit=N&cursor=...&exclude_requests=bool
  → paginated FlowsheetV2TrackEntry[] for the DJ

GET /djs/{id}/play-stats?window=30d|90d|1y|all
  → { artists: [{id, name, count}], labels, genres, counts, ... }
  Pre-aggregated server-side so iOS doesn't re-aggregate thousands of rows for the diversity readout

GET /djs/{id}/has-played?album_ids=1,2,3,...
  → { album_id → play_count_by_this_dj }
  Tiny lookup for bin maturity per-entry badges
```

Filter rules baked in: `exclude_requests=true` drops entries with `request_flag = true` (listener taste, not DJ taste). Rotation plays are included by default — clients can weight them down (the iOS plan weights them at 0.75 per the Q8 grilling resolution) using the raw `rotation_id` we return.

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0006](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0006--per-dj-play-history-is-a-first-class-api-surface-not-a-search-workaround).

## Consequences

- New endpoints, no new schema. All three are query views over [`flowsheet_entries`](../../shared/database/src/schema.ts) with `dj_id` filter.
- `play-stats` is pre-aggregated to make Diversity Readout viable on a mobile network. We pick the bucket boundaries server-side so the iOS client doesn't need to know our row volume.
- `has-played` is a batch existence-with-count check; intentionally cheaper than asking the same question per row through `/plays`.
- Future consumers (dj-site DJ-profile page, wxyc.org listener stats if/when they go public) get the same surface for free.
