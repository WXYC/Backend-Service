# 0004 — The iOS DJ tool is an authorized flowsheet writer (Queue read + targeted writes)

The iOS DJ tool joins dj-site as a first-class authorized writer of flowsheet entries in v1: it reads the live Queue (the unplayed-yet tail of the current show — see [`wxyc-dj-tool-ios/CONTEXT.md`](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/CONTEXT.md) for the Queue term), reads currently-playing, posts new track entries from Mail Bin and search results, reorders via `PATCH /flowsheet/play-order`, and deletes entries. iOS does **not** in v1 handle show start/end, non-track entries (talksets, breakpoints, messages), or DJ join/leave — those FCC-adjacent operations stay with dj-site.

No schema change on our side. The implication is that two surfaces now both authz against the same flowsheet write endpoints; existing JWT-role checks already cover this. The Mail Bin → Queue handoff uses the same `convertBinToQueue` semantics dj-site already uses (queue with empty `track_title`, DJ fills on-air — see [`dj-site/lib/features/bin/conversions.ts`](https://github.com/WXYC/dj-site/blob/main/lib/features/bin/conversions.ts)).

Canonical source: [`wxyc-dj-tool-ios/docs/cross-repo-adrs.md` ADR 0003](https://github.com/WXYC/wxyc-dj-tool-ios/blob/main/docs/cross-repo-adrs.md#adr-0003--ios-is-an-in-show-companion-to-dj-site-queue-read--targeted-writes).

## Consequences

- iOS gains on-air detection via polling `/flowsheet/on-air?dj_id=me` (~30s when foregrounded). No new endpoint — it's an existing route gaining a second consumer.
- Both surfaces operate on the same Queue resource — **last write wins**. No multi-surface presence/locking in v1.
- iOS will exercise [`PATCH /flowsheet/play-order`](https://github.com/WXYC/wxyc-shared/blob/main/api.yaml) before dj-site does (dj-site's `handleReorder` is currently a no-op — see [`app/dashboard/@modern/flowsheet/@queue/page.tsx`](https://github.com/WXYC/dj-site/blob/main/app/dashboard/%40modern/flowsheet/%40queue/page.tsx)). Endpoint validation matters more than it did before.
