# uncovered-release-list

Weekly cron job (BS#1877, [ADR 0013](../../docs/adr/0013-search-augmented-critic-review-discovery.md)'s "uncovered-release list handoff", sibling to [`jobs/album-critic-reviews-etl`](../album-critic-reviews-etl/README.md)): computes the `rotation × album_critic_reviews` anti-join — active rotation releases with **zero** critic reviews today — further anti-joins against releases already handed off for search at least once, writes the result as `uncovered-releases.jsonl`, and commits it to the private [`WXYC/research-data`](https://github.com/WXYC/research-data) repo, where its `search` crawl mode ([RD#16](https://github.com/WXYC/research-data/issues/16)) reads it. This is the only new Backend-Service-side surface ADR 0013's design requires — a read-only anti-join plus a git write to a repo Backend-Service doesn't otherwise touch, not a new outbound web-egress subsystem or an authenticated endpoint. Keeps the design [Project #32](https://github.com/orgs/WXYC/projects/32) freeze-compatible.

## Schedule

`40 7 * * 0` UTC (weekly, Sunday 07:40) from `package.json`'s `cron-schedule`, registered by deploy-base. 30 minutes after `album-critic-reviews-etl`'s `10 7 * * 0` run, so this job's anti-join reads `album_critic_reviews` **after** that week's manifest pull has landed — a release the manifest ETL just covered is excluded from this week's list rather than round-tripped needlessly. DB-only against Backend-Service's own Postgres (no LML HTTP calls), so [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md)'s LML-spacing policy doesn't govern it (see that doc's "Excluded / DB-only" section); still placed outside the busy 04:15–06:17 UTC stack for readability, alongside the other Sunday-only jobs.

## Environment

See [`docs/env-vars.md`](../../docs/env-vars.md) for the full reference. Required: the standard `DB_*` set only — unlike `album-critic-reviews-etl`, **no external credential is required to run**; the anti-join read and the local `uncovered-releases.jsonl` write both work with zero external calls. Optional:

- `OUTPUT_PATH` — where the snapshot file is written (default `./output/uncovered-releases.jsonl`).
- `PUBLISH` — locked truthy `true`/`1`. Must be set (together with `RESEARCH_DATA_WRITE_TOKEN`) for the job to actually push to research-data; see "Handoff" below.
- `RESEARCH_DATA_WRITE_TOKEN` — a fine-grained PAT scoped to `WXYC/research-data` with `Contents: Read and write`. **Not yet provisioned as of this job's initial ship** — see "Handoff".
- `DRY_RUN`, `SENTRY_DSN`.

## Snapshot contract (cross-repo interface — `WXYC/research-data`)

One JSON object per line in `uncovered-releases.jsonl`, committed to the `uncovered-releases-snapshot` branch of `WXYC/research-data`. **Locked schema** — coordinated with [`research-data#16`](https://github.com/WXYC/research-data/issues/16) (the `search` crawl-mode ticket that consumes this file):

```jsonc
{
  "artist": "string, required — library-canonical artist name",
  "album": "string, required — library-canonical album title",
  "library_id": 12345,
}
```

`artist`/`album` are the **library-canonical** pair (`library.album_title` / `artists.artist_name`, joined off the resolved `library_id`) — never the raw rotation/tubafrenzy DJ-typed snapshot text. This is the entire point of ADR 0013's design: a search-sourced review row can be written with the same canonical pair from the start, so `album-critic-reviews-etl`'s exact-match resolver hits trivially without loosening it (see the ADR's "Why Option B" section). `library_id` is `library.id`, the same key `album_critic_reviews.album_id` FKs to. An empty uncovered set still produces a (zero-byte) **local** file — a valid, meaningful "nothing new to search this cycle" artifact, not a skipped write. It is deliberately **not published**: see "Never publish an empty snapshot" below.

## Pipeline (`orchestrate.ts`)

1. Fetch every active rotation row (`rotation.ts`'s `fetchActiveRotationRows`) — `kill_date IS NULL OR kill_date > CURRENT_DATE`, `LEFT JOIN rotation_library_view` + `COALESCE` so both album_id-linked rows (canonical fields via the view) and snapshot-only rows (never linked; own `artist_name`/`album_title` text) are kept. Guard: 0 active rows -> throw (rotation is never genuinely empty; an empty read is a source regression).
2. Resolve each row to a `CanonicalRelease` (`resolveCanonicalRelease`), sequentially. Already-linked rows use the view's canonical fields directly; unlinked rows call `resolveLinkedAlbumId` (`@wxyc/database`, the same exact-match resolver `album-critic-reviews-etl/match.ts` uses) on the snapshot text, then fetch that resolved id's canonical fields. A miss drops the row — this job cannot emit `library_id` for a release with no library link at all. Guard: 0 resolved -> throw (evaluated regardless of `DRY_RUN`).
3. Dedup to one row per `library.id` (`dedupeByLibraryId`) — tubafrenzy permits multiple active rotation rows per release (re-bins, re-adds).
4. Two anti-joins (`antijoin.ts`): drop releases already carrying an `album_critic_reviews` row (`loadCoveredLibraryIds`), and drop releases already recorded in `uncovered_release_search_markers` (`loadHandedOffLibraryIds` — see "Found-nothing marker" below).
5. `DRY_RUN` stops here: emits a locked-schema JSON report and returns, having made zero writes and zero network calls beyond the read-only DB queries above.
6. Render (`writer.renderSnapshot`) once and write to disk (`writer.writeSnapshotFile`) — happens even when the uncovered set is empty.
7. Publish the same rendered content to research-data (`publish.ts`), **unless the set is empty** (see below). A publish failure is caught, logged, and counted — never aborts the run; the local file write already succeeded and is this run's durable artifact regardless.
8. Record handoff markers (`markers.recordHandoffs`) **only when the publish actually committed** — see "Found-nothing marker".

### Never publish an empty snapshot

Publishing is a **whole-file replace of one fixed path**, and markers are publish-once. So an empty publish hands off nothing while overwriting the previous snapshot at research-data HEAD — whose releases are already permanently marked. If the consumer had not yet read that snapshot, those releases become marked-but-never-searched with no recovery path: precisely the failure the publish-gated marker design exists to prevent, arriving from the other direction.

Holding the previous file instead costs at most one redundant re-read by the consumer, which is harmless — those releases are already marked, so they can never be re-offered. The job therefore logs `publish_skipped_empty` and leaves HEAD alone. The **local** write still happens unconditionally; nothing downstream reads it.

## Found-nothing marker: a dedicated table, not a `source_key` convention

ADR 0013 named two options for "so a release that came up empty isn't re-searched every cycle": a small tracking table, or a `source_key` convention analogous to `album-critic-reviews-etl`'s `manifest:${source}`. **This job uses a dedicated table** — `uncovered_release_search_markers` (migration 0156) — because every column `album_critic_reviews`' UPSERT natural key would need to carry (`source`, `source_url`, `snippet`) is `NOT NULL` and semantically "this IS a review"; recording "we looked, found nothing" there would mean inventing sentinel values for columns whose whole contract is a real review's attribution, polluting the exact table `GET /proxy/metadata/album` reads. The dedicated table keeps "has a review" (`album_critic_reviews`, real rows only) and "already handed off for search" (this table) as two independently-true, independently-anti-joined predicates.

Semantics are **publish-once, never retried**: a row is written the moment a release is included in a snapshot that actually reaches research-data (`publishOutcome.committed === true`), not after any confirmation that a search happened or found something. A release that comes up empty is therefore never re-searched on a future cycle (the ticket's core requirement) — no live feedback signal from research-data is needed at all, keeping the whole design self-contained to a single Backend-Service DB, consistent with "no new outbound web-egress, no new authenticated endpoint." A release that DOES get a review lands in `album_critic_reviews` independently via the existing manifest ETL, so `loadCoveredLibraryIds` already excludes it too — this table's exclusion is redundant-but-harmless in that case.

**Markers are deliberately NOT written when publish doesn't commit** (disabled, missing token, or a live failure) — see "Handoff" below for why this matters right now.

## Handoff: real code, currently unexercised (needs a credential)

`publish.ts` commits the rendered snapshot to a dedicated `uncovered-releases-snapshot` branch on `WXYC/research-data` via GitHub's Contents API (GET the branch's current file sha, PUT the new content) — the same Contents-API idiom `album-critic-reviews-etl/fetch.ts` already uses the other direction (it GETs a release asset; this PUTs a file). This is real, DI-tested code (see `publish.test.ts`), gated behind two independent conditions:

1. `PUBLISH=true` — an explicit operator opt-in, not implied by the token's mere presence.
2. `RESEARCH_DATA_WRITE_TOKEN` — a fine-grained PAT scoped to `WXYC/research-data` with `Contents: Read and write`. **Deliberately a separate credential from `RESEARCH_DATA_TOKEN`** (`album-critic-reviews-etl`'s read-only manifest-fetch token) — that token's whole point, stated in its own README, is read-only; minting a distinct write-scoped token here keeps that invariant legible instead of quietly upgrading a read-only credential's effective scope.

**As of this job's initial ship, neither is provisioned.** Every run writes `uncovered-releases.jsonl` locally (an operator can pull it from the container and hand it to research-data by hand in the interim) but returns `{ attempted: false, committed: false }` from `publishSnapshot` and — per the found-nothing marker's publish-gated write above — records zero handoff markers, so nothing is silently lost by running before the token exists. Turning the real push on is a two-step ops task, not a code change:

1. **One-time, in `WXYC/research-data`:** create the `uncovered-releases-snapshot` branch (from `main`) and open a single PR from it to `main`. Every subsequent commit this module makes to that branch auto-updates the already-open PR — no branch/PR lifecycle management lives in this code.
2. **In Backend-Service's cron env:** provision `RESEARCH_DATA_WRITE_TOKEN` and set `PUBLISH=true`.

## Run / dry-run

```bash
# Build + run locally (against whatever DB_* points at):
npm run build --workspace=@wxyc/database --workspace=@wxyc/uncovered-release-list
npm start --workspace=@wxyc/uncovered-release-list

# Dry run: fetch + resolve + dedup + both anti-joins + run guards, zero writes, zero network calls:
DRY_RUN=true npm start --workspace=@wxyc/uncovered-release-list
```

The `DRY_RUN` report is a **locked schema** — exactly these keys, one JSON line on stdout; treat as an interface:

```json
{
  "job": "uncovered-release-list",
  "dry_run": true,
  "active_rotation_rows": 0,
  "resolved": 0,
  "unresolved_dropped": 0,
  "deduped": 0,
  "already_covered": 0,
  "already_handed_off": 0,
  "uncovered": 0
}
```

## Invariants (do not weaken)

- **Never delete.** The job has no delete path against any table; `uncovered_release_search_markers` is UPSERT-only, and `album_critic_reviews` is read-only from this job's side.
- **Idempotent.** Re-running with `PUBLISH` off (today's default) always re-derives and re-writes the same snapshot for the same DB state — harmless. Once `PUBLISH` is on, a repeated real run makes zero NEW handoff-marker writes for releases already marked (the anti-join excludes them before they're ever re-offered).
- **Exact match only** (via the shared `resolveLinkedAlbumId`). Do not loosen to fuzzy/pg_trgm — see `album-critic-reviews-etl/README.md`'s identical invariant; loosening it here would corrupt the canonical `(artist, album)` pair the whole downstream pipeline trusts.
- **Markers are publish-gated, not write-gated.** Do not move `recordHandoffs` earlier in the pipeline (e.g., right after computing `uncovered`) — see "Found-nothing marker" for why that would silently and permanently drop releases that were never actually handed off.

## Related

- [BS#1877](https://github.com/WXYC/Backend-Service/issues/1877) — this job's ticket.
- [ADR 0013](../../docs/adr/0013-search-augmented-critic-review-discovery.md) — the design this job implements one piece of ("Uncovered-release list handoff" section).
- [BS#1830](https://github.com/WXYC/Backend-Service/issues/1830) / [`jobs/album-critic-reviews-etl/README.md`](../album-critic-reviews-etl/README.md) — the structural donor and the downstream consumer of any review this job's handoff eventually produces.
- [`WXYC/research-data#16`](https://github.com/WXYC/research-data/issues/16) — the `search` crawl-mode ticket this job's output feeds; the snapshot schema above is coordinated with it.
