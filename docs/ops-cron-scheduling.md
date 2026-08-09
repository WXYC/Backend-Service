# Ops: LML-hitting cron spacing policy (BS#1665)

Policy for spacing the crons that hit library-metadata-lookup (LML) over HTTP, so the cron stack can't re-trip LML's Discogs saturation breaker (LML#755) the way it did on 2026-07-11 06:00 UTC — two heavy-drain crons fired at the same `HH:MM`, tripping the breaker into a 4-day continuous shed storm (32,520 shed events, LIBRARY-METADATA-LOOKUP-1Q). See WXYC/library-metadata-lookup#803 for the postmortem and BS#1665 for the fix this doc records.

The breaker trips on LML's Discogs API work, driven by LML's HTTP endpoints — not by DB reads. Scheduling policy only applies to LML-over-HTTP crons.

## Three cron shapes

**1. Heavy-drain crons** — unbounded or large-cohort LML sweeps (`bulkLookupMetadata`, per-row lookups over a large backlog).

- **Hard invariant:** no two heavy-drain crons share the same `HH:MM`. This is the literal 2026-07-11 failure mode — two heavy drains firing simultaneously, not the existence of heavy drains per se.
- **Recommended margin:** ≥60 min apart, to reduce the odds that a _slow_ run of one overlaps the _start_ of another.
- Runtime overlap itself (a run still alive when the next day's stack fires) is **not** a scheduling problem — a 23-hour run overlaps from any start time. That's a runtime-liveness concern, folded into BS#1201 (cron heartbeats + max-runtime guard), not this policy.

**2. Light-touch crons** — bounded small-cohort LML calls (the concerts pipeline, `artist-search-alias-consumer`), each already gated by the job's own limiter. Exempt from the ≥60 min margin; total LML call volume per run is a handful. May cluster.

**3. DB-only jobs** — read LML's cache tables directly (e.g. `entity.identity`) over a direct Postgres connection, never call LML's HTTP API, and cannot trip the breaker. Out of scope for this policy entirely. Listed explicitly so a future author doesn't try to "space" them.

## Current slot table (UTC)

| Time                          | Job                                       | Class                                                                                                                |
| ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 04:15                         | `artist-search-alias-consumer`            | light (`search-aliases/bulk`, bounded)                                                                               |
| 04:30                         | `rotation-artist-backfill`                | **heavy drain**                                                                                                      |
| 04:45                         | `catalog-popularity-freetext-resolve`     | **heavy drain** (`bulkLookupMetadata`)                                                                               |
| 05:35                         | `concerts-artist-lml-resolver`            | light (upcoming-show cohort)                                                                                         |
| 05:45                         | `concerts-genre-enrichment`               | light (upcoming-show cohort)                                                                                         |
| **06:00**                     | **`library-discogs-unavailable-recheck`** | **light** (BS#1283 — `LIBRARY_DISCOGS_UNAVAILABLE_RECHECK_BATCH_SIZE`-bounded, default 50, per-row `lookupMetadata`) |
| 06:05                         | `concerts-poster-enrichment`              | light (one call per distinct headliner)                                                                              |
| 00:17 / 06:17 / 12:17 / 18:17 | `rotation-release-id-backfill`            | **heavy drain** (small active-rotation cohort, per-row `lookupMetadata`; TTL-gated)                                  |
| 07:00 Mon                     | `rotation-release-id-pollution-check`     | light (weekly, read-only, paced)                                                                                     |
| **09:00**                     | **`rotation-lml-identity-backfill`**      | **heavy drain** — moved here by BS#1665, was `0 6 * * *`                                                             |
| **:10 hourly**                | **`flowsheet-metadata-backfill`**         | **exempt from slot-exclusivity** — BS#895 hourly recovery sweep, see below                                           |

`rotation-lml-identity-backfill`'s new `0 9 * * *` slot is clear of the entire 04:15–06:05 stack, ~2h after the weekly Monday pollution check, and ~04:00–05:00 ET — still off-peak for DJs (cooperative pause covers the rest).

## Excluded / DB-only (verified — don't try to "space" these)

- `artist-identity-etl` (hourly `0 * * * *`) — reads LML's `entity.identity` table directly over `DATABASE_URL_DISCOGS`; no Discogs API call, cannot trip the breaker.
- `library-etl`, `legacy-linkage-resolve` (`*/30 * * * *`, fire at `:00` and `:30` every hour) — neither depends on `@wxyc/lml-client`. Safe to share a minute with them.
  - This was a **trio** — `flowsheet-etl`, `library-etl`, `rotation-etl` — until Phase 3 of the tubafrenzy decommission ([WXYC/wiki#88](https://github.com/WXYC/wiki/issues/88)) made the two tubafrenzy importers `job-type: one-shot`. Their Backend-local linkage-repair tail pass moved to the new `legacy-linkage-resolve`, which inherits the `*/30` slot, so `:00`/`:30` host load is **lower** than it was but not empty. Slot rationales elsewhere in this doc that cite "the `*/30` ETL trio" are historically accurate about why a slot was picked; read them as "the `*/30` pair" for current occupancy.
- `concerts-artist-resolver` (05:15) — pure-SQL strict/alias resolver, no LML. (`concerts-artist-lml-resolver` at 05:35 is the LML-touching one.)
- `concerts-similar-artists-enrichment` (05:55, hits semantic-index not LML), `venue-events-scraper`, `triangle-shows-etl`, `album-reviews-etl`, `legacy-mirror-reconcile` — non-LML.
- `metadata-no-match-digest` (`07 15 * * *` UTC, daily) — reads `flowsheet`/`shows`/`cronjob_runs` directly and sends via SES; no `@wxyc/lml-client` dependency, cannot trip the breaker. Its `:07` past 15:00 UTC slot was picked only to avoid the `:00` slot shared by the `*/30` ETL trio (now a pair — see above) + hourly `artist-identity-etl`, a host-load courtesy unrelated to this policy.

## The hourly safety net (BS#895)

`flowsheet-metadata-backfill` runs as an hourly `10 * * * *` recovery sweep, per `package.json`'s `cron-schedule`. It is **exempt from slot-exclusivity by construction** — governed by the static LML gate (`BACKFILL_LML_MAX_CONCURRENT=1`, `BACKFILL_LML_RATE_PER_MIN=20`) + cooperative pause, not by its slot. Its `:10` offset was chosen because it was clear of every current cron and of the non-LML ETL trio (`:00` was taken by `rotation-lml-identity-backfill` after BS#1665 plus the `*/30` ETL trio; `:30` by `rotation-artist-backfill` plus the same trio). That trio is now a pair (see "Excluded / DB-only") — the `:10` slot is still correct, just less contended than when it was picked. Its own workload is bounded by two knobs (`BACKFILL_GRACE_MINUTES`, default 15 — gives the CDC consumer first crack at a fresh row; `BACKFILL_RECOVERY_WINDOW_HOURS`, default 6 — hard age ceiling that excludes the ~748k-row undrained historical `pending` backlog #1011 left behind), not by this policy's heavy-drain/light-touch classification.

## Grandfathered margin gap: 04:30 / 04:45

`rotation-artist-backfill` (04:30) and `catalog-popularity-freetext-resolve` (04:45) are two heavy drains only 15 min apart — they satisfy the hard invariant (distinct `HH:MM`) but sit below the ≥60 min recommended margin. Deliberately grandfathered rather than re-laid, because:

- They predate the 2026-07-11 incident and neither independently tripped the breaker — the trip required two heavy drains firing at the _same instant_.
- Each is paced by its own static LML limiter.
- Genuine runtime-overlap protection is BS#1201's job, not the schedule's.

Promoting them to full ≥60 min compliance later is a trivial one-line follow-up, not silent debt.

## Adding a new LML-hitting cron

1. Classify it: heavy-drain, light-touch, or DB-only.
2. Heavy-drain: pick an `HH:MM` no other heavy-drain cron holds, ideally ≥60 min from the nearest one. Update the slot table above.
3. Light-touch: any minute is fine, but prefer clustering near the existing concerts-pipeline block (05:35–06:05) for readability.
4. DB-only: no constraint from this policy.
5. If the job needs an ops-tunable cadence override, do **not** add it to the shared `BACKFILL_CRON_SCHEDULE` allowlist in `scripts/resolve-cron-schedule.sh` unless its cadence story is genuinely the same as `flowsheet-metadata-backfill`'s — see the BS#1665 postmortem for why a shared override var is a latent re-collision route.
