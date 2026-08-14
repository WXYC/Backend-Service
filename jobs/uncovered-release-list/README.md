# uncovered-release-list

Weekly cron job (BS#1877, [ADR 0013](../../docs/adr/0013-search-augmented-critic-review-discovery.md)'s "uncovered-release list handoff", widened by the "rotation ∪ recently played" amendment, sibling to [`jobs/album-critic-reviews-etl`](../album-critic-reviews-etl/README.md)): computes the `(active rotation ∪ recently played) × album_critic_reviews` anti-join — active rotation releases and recently-played linked albums with **zero** critic reviews today — further anti-joins against releases already handed off for search at least once, writes the result as `uncovered-releases.jsonl`, and commits it to the private [`WXYC/research-data`](https://github.com/WXYC/research-data) repo, where its `search` crawl mode ([RD#16](https://github.com/WXYC/research-data/issues/16)) reads it. This is the only new Backend-Service-side surface ADR 0013's design requires — a read-only anti-join plus a git write to a repo Backend-Service doesn't otherwise touch, not a new outbound web-egress subsystem or an authenticated endpoint. Keeps the design [Project #32](https://github.com/orgs/WXYC/projects/32) freeze-compatible.

WXYC is a freeform station: most of what a DJ actually enters into the flowsheet is not a current rotation release, so the releases most likely to reach a listener's feed are exactly the ones a rotation-only candidate set never sees. The candidate set is **active rotation ∪ albums played recently** — two arms, `rotation.ts` (unchanged) and the new `plays.ts` — everything else about ADR 0013's design (wire schema, exact-match ceiling, handoff mechanism) is unchanged.

## Precondition — read this first

**The publish credential is not provisioned, and the widening's cost model depends on it.** Marker writes are publish-gated (`orchestrate.ts`), and both `PUBLISH` and `RESEARCH_DATA_WRITE_TOKEN` are unprovisioned as of this job's initial ship — see "Handoff" below and `docs/env-vars.md`.

Until that credential lands, `recordHandoffs` writes nothing, so **every weekly run re-offers the entire eligible set**. Post-widening that means ~2,356 albums offered every run (the trailing-30-day linked-album count, measured against the local prod clone), the cap firing on every run, and `capped_out` pinned near 1,956 indefinitely — the exact opposite of "a safety valve normal operation never reaches."

So: provisioning `PUBLISH=true` + `RESEARCH_DATA_WRITE_TOKEN` (the two-step ops task in "Handoff" below) is a **prerequisite for this widening to behave as designed**, not an independent follow-up.

## Schedule

`40 7 * * 0` UTC (weekly, Sunday 07:40) from `package.json`'s `cron-schedule`, registered by deploy-base. 30 minutes after `album-critic-reviews-etl`'s `10 7 * * 0` run, so this job's anti-join reads `album_critic_reviews` **after** that week's manifest pull has landed — a release the manifest ETL just covered is excluded from this week's list rather than round-tripped needlessly. DB-only against Backend-Service's own Postgres (no LML HTTP calls), so [`docs/ops-cron-scheduling.md`](../../docs/ops-cron-scheduling.md)'s LML-spacing policy doesn't govern it (see that doc's "Excluded / DB-only" section); still placed outside the busy 04:15–06:17 UTC stack for readability, alongside the other Sunday-only jobs.

## Modes

| Invocation                      | Play-arm source                                                                     | Candidate window                                                           | Rotation-lane guards                                   |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| `node dist/job.js` (weekly)     | `plays.fetchRecentPlays` — a trailing `UNCOVERED_PLAY_LOOKBACK_DAYS`-day window     | steady state, ~2,356 eligible                                              | hard throw on zero active rotation / zero resolved     |
| `node dist/job.js --backfill`   | `plays.fetchAllPlayedAlbums` — the `album_plays` MV, every linked album ever played | one-time backlog, 37,421 total                                             | demoted to log + Sentry, drain proceeds on plays alone |
| `DRY_RUN=true node dist/job.js` | (either of the above)                                                               | zero writes; no network calls beyond a Sentry capture if a guard escalates | (either of the above)                                  |

`--backfill` and `DRY_RUN` compose freely (a dry-run preview of the backfill plan).

## Environment

See [`docs/env-vars.md`](../../docs/env-vars.md) for the full reference. Required: the standard `DB_*` set only — unlike `album-critic-reviews-etl`, **no external credential is required to run**; the anti-join read and the local `uncovered-releases.jsonl` write both work with zero external calls. Optional:

- `OUTPUT_PATH` — where the snapshot file is written (default `./output/uncovered-releases.jsonl`, relative to the job's cwd). Under this job's `ENTRYPOINT` (direct `node dist/job.js`, cwd is the container's `/uncovered-release-list` WORKDIR), the default resolves to `/uncovered-release-list/output/uncovered-releases.jsonl` — see "Pulling the file from a container" below.
- `UNCOVERED_PLAY_LOOKBACK_DAYS` — trailing window (days) for the steady-state play arm. Default `30`. Parsed and validated in both modes (a malformed value fails fast even under `--backfill`, matching the donor's option-struct shape); its value is only _read_ in steady state — `--backfill` drains every linked album ever played instead.
- `UNCOVERED_MAX_RELEASES_PER_RUN` — post-anti-join cap, both modes. Default `400`. **One cap knob, one cap position** — see "Cap semantics" below.
- `PUBLISH` — locked truthy `true`/`1`. Must be set (together with `RESEARCH_DATA_WRITE_TOKEN`) for the job to actually push to research-data; see "Handoff" below.
- `RESEARCH_DATA_WRITE_TOKEN` — a fine-grained PAT scoped to `WXYC/research-data` with `Contents: Read and write`. **Not yet provisioned as of this job's initial ship** — see "Handoff".
- `DRY_RUN`, `SENTRY_DSN`.

## Snapshot contract (cross-repo interface — `WXYC/research-data`)

One JSON object per line in `uncovered-releases.jsonl`, committed to the `uncovered-releases-snapshot` branch of `WXYC/research-data`. **Locked schema** — coordinated with [`research-data#16`](https://github.com/WXYC/research-data/issues/16) (the `search` crawl-mode ticket that consumes this file), **unchanged by the candidate-set widening**:

```jsonc
{
  "artist": "string, required — library-canonical artist name",
  "album": "string, required — library-canonical album title",
  "library_id": 12345,
}
```

`artist`/`album` are the **library-canonical** pair — `rotation.ts`'s resolve loop for rotation-arm rows, `plays.ts`'s `artists`/`library` joins for play-arm rows — never the raw rotation/tubafrenzy snapshot text or a DJ-typed play string. This is the entire point of ADR 0013's design: a search-sourced review row can be written with the same canonical pair from the start, so `album-critic-reviews-etl`'s exact-match resolver hits trivially without loosening it (see the ADR's "Why Option B" section). `library_id` is `library.id`, the same key `album_critic_reviews.album_id` FKs to. An empty uncovered set still produces a (zero-byte) **local** file — a valid, meaningful "nothing new to search this cycle" artifact, not a skipped write. It is deliberately **not published**: see "Never publish an empty snapshot" below.

## Candidate set — the two arms

**Rotation arm** (`rotation.ts`, unchanged): every active rotation row (`kill_date IS NULL OR kill_date > CURRENT_DATE`), resolved to its library-canonical pair.

**Play arm** (`plays.ts`, new): linked `flowsheet` plays (`entry_type = 'track' AND album_id IS NOT NULL`) — the repo's canonical definition of "a play" (also `album_plays`'s own WHERE clause and `catalog-popularity-freetext-resolve/job.ts`). Two sources, selected by run mode:

- `fetchRecentPlays(lookbackDays)` — steady state. A trailing `UNCOVERED_PLAY_LOOKBACK_DAYS`-day window over `flowsheet`, grouped by `album_id` and ranked play-count desc.
- `fetchAllPlayedAlbums()` — `--backfill`. Reuses the existing `album_plays` materialized view (migration 0059) instead of re-aggregating 2.6M `flowsheet` rows — that MV is defined as exactly this arm's aggregate minus the time window, uniquely indexed on `album_id`, and refreshed hourly by the API container. `album_popularity` (migration 0107) is rejected for both arms: it collapses pressings into a master-level signal, which would break the `library_id` the wire contract requires.

Both play-arm sources already know their `library.id` and join their canonical strings in the same query (via `artists`, the same canonical-artist source `rotation.ts` uses) — they return `CanonicalRelease[]` directly, with no resolve step. **Free-text (unlinked) plays are out of scope**: ~43% of music plays have `album_id IS NULL` and cannot emit the wire contract's required `library_id: int`; resolving them would mean running the DJ-typed string through a matcher, reintroducing exactly the wrong-album risk ADR 0013's canonical-pair design exists to avoid. `flowsheet_freetext_resolution` (migration 0106) is the future bridge, not built here.

Rotation-resolved releases are concatenated first, then play-arm releases, then deduped to one row per `library.id` (first-wins) — an album in both arms keeps its rotation-arm entry (semantically free, since both arms resolve to the identical canonical pair for a given `library.id`), but this pins determinism and keeps rotation at the head of the cap ordering.

## Pipeline (`orchestrate.ts`)

1. Fetch every active rotation row (`rotation.ts`'s `fetchActiveRotationRows`) — `kill_date IS NULL OR kill_date > CURRENT_DATE`, `LEFT JOIN rotation_library_view` + `COALESCE` so both album_id-linked rows (canonical fields via the view) and snapshot-only rows (never linked; own `artist_name`/`album_title` text) are kept. Guard: 0 active rows -> throw in steady state (rotation is never genuinely empty; an empty read is a source regression); demoted to log+Sentry under `--backfill` (see "Guards" below).
2. Resolve each rotation row to a `CanonicalRelease` (`resolveCanonicalRelease`), sequentially. Already-linked rows use the view's canonical fields directly; unlinked rows call `resolveLinkedAlbumId` (`@wxyc/database`, the same exact-match resolver `album-critic-reviews-etl/match.ts` uses) on the snapshot text, then fetch that resolved id's canonical fields. A miss drops the row. Guard: 0 resolved (when there were rotation rows to resolve) -> throw in steady state, evaluated regardless of `DRY_RUN`; demoted under `--backfill`.
3. Fetch the play-arm candidates via the single injected `fetchPlayCandidates` — `job.ts` already selected `fetchRecentPlays` or `fetchAllPlayedAlbums` based on `--backfill`; the orchestrator never sees which arm ran. Guard: 0 play rows -> **not** a throw — loud error-level log + unconditional Sentry capture, exit stays 0 (see "Guards" below).
4. Concatenate resolved rotation releases first, then play-arm releases (`candidate_rows = resolved + recent_play_rows`).
5. Dedup to one row per `library.id` (`dedupeByLibraryId`) — tubafrenzy permits multiple active rotation rows per release, and a release can independently surface via both arms.
6. Two anti-joins (`antijoin.ts`): drop releases already carrying an `album_critic_reviews` row (`loadCoveredLibraryIds`), and drop releases already recorded in `uncovered_release_search_markers` (`loadHandedOffLibraryIds` — see "Found-nothing marker" below).
7. Cap the uncovered set at `UNCOVERED_MAX_RELEASES_PER_RUN`, immediately after the anti-join and **before** the `DRY_RUN` branch — see "Cap semantics" below. `capped_out = uncovered.length - capped.length`, computed here, logged when it fires.
8. `DRY_RUN` stops here: emits a locked-schema JSON report and returns, having made zero writes and no network calls beyond the read-only DB queries above — plus a Sentry capture if a guard escalated, since the guards deliberately carry no `DRY_RUN` exemption.
9. Render (`writer.renderSnapshot`) once from the **capped** list and write to disk (`writer.writeSnapshotFile`) — happens even when the capped set is empty. That empty case is local-only; step 10 declines to publish it.
10. Publish the same rendered content to research-data (`publish.ts`), **unless the capped set is empty** (see "Never publish an empty snapshot" below). A publish failure is caught, logged, and counted — never aborts the run; the local file write already succeeded and is this run's durable artifact regardless.
11. Record handoff markers (`markers.recordHandoffs`) for the **capped** list **only when the publish actually committed** — see "Found-nothing marker".

## Cap semantics

**One cap knob, one cap position.** `UNCOVERED_MAX_RELEASES_PER_RUN` (default `400`) truncates the uncovered set immediately after the anti-join, in both steady-state and `--backfill` modes — no separate backfill limit env var, and no SQL `LIMIT` in either play-arm query. A SQL `LIMIT` in the play arm would silently stall the drain: run 1 selects the top N by play count and marks them, run 2 re-selects the _identical_ top N, `filterUncovered` drops all of them as already-handed-off, and the job emits 0 rows forever — invisible in the report, since `uncovered` is pre-cap. Capping after the anti-join makes each run advance past what the previous run consumed.

The capped list — not the uncovered list — is the single input to **every** downstream site: `renderSnapshot`, `writeSnapshot`, `publish`, and `recordHandoffs` all consume the same array, so the file on disk, the published snapshot, and the marker rows describe the identical release set. Feeding `recordHandoffs` the uncapped list would permanently strand the truncated tail — exactly the failure mode "Backfill pacing" below exists to prevent.

`capped_out` is computed at the cap site (`uncovered.length - capped.length`), before the `DRY_RUN` branch — never derived from `written` (which is `0` under `DRY_RUN`, since nothing is written). Logged loudly whenever it fires, and reported under `DRY_RUN` too — the exact mode an operator uses to check whether the cap is firing.

One legibility caveat: rotation permanently occupies the head of the capped list (rotation-first concat, order-preserving dedup and anti-join), so if active rotation ever exceeded the cap, a run would emit zero play-arm rows while `capped_out` looked healthy and non-zero — a silently stalled drain. At today's ~300 active rotation against the 400 default this cannot happen; if rotation volume ever grows near the cap, compare `recent_play_rows` against what was actually written before trusting a backfill's progress.

## One-time backlog vs. steady state

A 30-day steady-state window on a weekly cron rolls over completely in ~4 runs — a candidate not handed off within those runs leaves the eligible set. Only **39.7%** of albums in a 30-day window get replayed within the following 60 days (measured), so most of what's evicted is lost for months or indefinitely. **Once markers are being written** (see "Precondition"), the eligible set per run is just the _new_-album rate — measured at ~75/week — so `UNCOVERED_MAX_RELEASES_PER_RUN` (400) is a safety valve, not the metering mechanism, and steady state costs ≈325 searches/month.

The one-time historical backlog — 37,421 distinct linked albums ever played — is handled separately via `--backfill`, sourced from `album_plays` so the highest-play-count albums drain first:

```bash
mkdir -p ./out
docker run --rm --env-file .env \
  -e UNCOVERED_MAX_RELEASES_PER_RUN=2000 \
  -v "$PWD/out:/uncovered-release-list/output" \
  <image> --backfill
```

**The bind-mount is not optional while the publish credential is unprovisioned.** The snapshot file is the run's entire artifact, and `--rm` deletes the container — and its `/uncovered-release-list/output` — the moment the job exits, so without a mount there is nothing left to `docker cp` and the whole batch is lost. See "Pulling the file from a container" below.

The `-e` override raises the cap per invocation — the plain env-file recipe alone gives an operator no cap lever, and 400/run would collide with the pacing contract below to make the 37,421-album backlog effectively undrainable. Draining all 37,421 is out of scope; backfill is prioritized and bounded on purpose.

### Backfill pacing: one snapshot file + permanent markers = one invocation per consumer cycle

The publish target is a single fixed path (`uncovered-releases.jsonl` on the `uncovered-releases-snapshot` branch), and each commit is a **whole-file replace**, not an append. Meanwhile `recordHandoffs` marks every published release permanently: publish-once, never retried. Combine the two and rapid repeated `--backfill` invocations have a failure mode the cap can't see: run it ten times back-to-back and 4,000 releases are marked handed-off while only the final 400 (or 2,000, or whatever the cap was set to) exist at branch HEAD. If research-data#16's consumer reads HEAD on its own cadence, the earlier batches are marked-but-never-searched — the exact permanent-drop failure the publish-gated marker design exists to prevent, arriving through the front door.

**Operator contract: at most one `--backfill` invocation per consumer cycle** — run, confirm the consumer has processed that snapshot commit, then run the next batch. This coupling has been relayed onto [`research-data#16`](https://github.com/WXYC/research-data/issues/16) as a consumer design requirement ([the relay comment](https://github.com/WXYC/research-data/issues/16#issuecomment-5297380930)): if the consumer walks the snapshot branch's commit history instead of reading HEAD only, this pacing constraint disappears entirely. Until that ticket's design confirms that, the operator contract above is the safety.

The weekly steady-state cron has the same coupling in principle but is benign in practice — at matched weekly cadences, each snapshot sits at HEAD for a full cycle before the next run replaces it.

### Never publish an empty snapshot

The same whole-file-replace coupling, from the other direction. An empty publish hands off nothing while overwriting the previous snapshot at research-data HEAD — whose releases are already permanently marked. If the consumer had not yet read that snapshot, those releases become marked-but-never-searched with no recovery path: precisely the failure the publish-gated marker design exists to prevent.

Holding the previous file instead costs at most one redundant re-read by the consumer, which is harmless — those releases are already marked, so they can never be re-offered. The job therefore logs `publish_skipped_empty` and leaves HEAD alone. The **local** write still happens unconditionally; nothing downstream reads it.

## Guards

- **Zero active rotation** — hard throw in steady state (rotation is never genuinely empty in production; an empty read is a source regression). Demoted under `--backfill` to a loud error-level log + Sentry capture, and the run continues on the play arm alone: rotation is ~300 of ~37,721 backfill candidates, and a rotation-source regression mid-drain must not abort a run holding tens of thousands of valid play-arm candidates.
- **Zero resolved** — hard throw in steady state, evaluated regardless of `DRY_RUN` (a resolver regression must not hide behind a dry run). Demoted under `--backfill` the same way as the rotation guard above.
- **Zero recent plays** — **not a throw.** Loud error-level structured log + unconditional Sentry capture, exit stays 0, in both modes. A third guard carrying a `DRY_RUN` exemption would introduce exactly the hiding-place the other two guards exist to close — this module's convention is "evaluated regardless of `DRY_RUN`." An empty 30-day `flowsheet` window in prod is not an expected common case (it means the station stopped logging plays, or the query broke), so this escalates rather than staying silent — but it must never abort a run that may still hold valid rotation candidates. This is also what keeps the local `DRY_RUN=true` recipe below working: `dev_env/seed_db.sql` has no `flowsheet` rows, so an **error-level empty-plays log against the dev seed is expected, not a fault** — with no `SENTRY_DSN` configured locally, the capture is a no-op.

## Found-nothing marker: a dedicated table, not a `source_key` convention

ADR 0013 named two options for "so a release that came up empty isn't re-searched every cycle": a small tracking table, or a `source_key` convention analogous to `album-critic-reviews-etl`'s `manifest:${source}`. **This job uses a dedicated table** — `uncovered_release_search_markers` (migration 0156) — because every column `album_critic_reviews`' UPSERT natural key would need to carry (`source`, `source_url`, `snippet`) is `NOT NULL` and semantically "this IS a review"; recording "we looked, found nothing" there would mean inventing sentinel values for columns whose whole contract is a real review's attribution, polluting the exact table `GET /proxy/metadata/album` reads. The dedicated table keeps "has a review" (`album_critic_reviews`, real rows only) and "already handed off for search" (this table) as two independently-true, independently-anti-joined predicates.

Semantics are **publish-once, never retried**: a row is written the moment a release is included in a snapshot that actually reaches research-data (`publishOutcome.committed === true`), not after any confirmation that a search happened or found something. A release that comes up empty is therefore never re-searched on a future cycle (the ticket's core requirement) — no live feedback signal from research-data is needed at all, keeping the whole design self-contained to a single Backend-Service DB, consistent with "no new outbound web-egress, no new authenticated endpoint." A release that DOES get a review lands in `album_critic_reviews` independently via the existing manifest ETL, so `loadCoveredLibraryIds` already excludes it too — this table's exclusion is redundant-but-harmless in that case.

**Markers are deliberately NOT written when publish doesn't commit** (disabled, missing token, or a live failure) — see "Handoff" below for why this matters right now.

## Handoff: real code, currently unexercised (needs a credential)

`publish.ts` commits the rendered snapshot to a dedicated `uncovered-releases-snapshot` branch on `WXYC/research-data` via GitHub's Contents API (GET the branch's current file sha, PUT the new content) — the same Contents-API idiom `album-critic-reviews-etl/fetch.ts` already uses the other direction (it GETs a release asset; this PUTs a file). This is real, DI-tested code (see `publish.test.ts`), gated behind two independent conditions:

1. `PUBLISH=true` — an explicit operator opt-in, not implied by the token's mere presence.
2. `RESEARCH_DATA_WRITE_TOKEN` — a fine-grained PAT scoped to `WXYC/research-data` with `Contents: Read and write`. **Deliberately a separate credential from `RESEARCH_DATA_TOKEN`** (`album-critic-reviews-etl`'s read-only manifest-fetch token) — that token's whole point, stated in its own README, is read-only; minting a distinct write-scoped token here keeps that invariant legible instead of quietly upgrading a read-only credential's effective scope.

**As of this job's initial ship, neither is provisioned.** Every run writes `uncovered-releases.jsonl` locally (an operator can pull it from the container and hand it to research-data by hand in the interim) but returns `{ attempted: false, committed: false }` from `publishSnapshot` and — per the found-nothing marker's publish-gated write above — records zero handoff markers, so nothing is silently lost by running before the token exists. **The widened candidate set's steady-state sizing (~325 searches/month) is conditional on this being provisioned** — see "Precondition" at the top of this README. Turning the real push on is a two-step ops task, not a code change:

1. **One-time, in `WXYC/research-data`:** create the `uncovered-releases-snapshot` branch (from `main`) and open a single PR from it to `main`. Every subsequent commit this module makes to that branch auto-updates the already-open PR — no branch/PR lifecycle management lives in this code.
2. **In Backend-Service's cron env:** provision `RESEARCH_DATA_WRITE_TOKEN` and set `PUBLISH=true`.

## Run / dry-run

```bash
# Build + run locally (against whatever DB_* points at):
npm run build --workspace=@wxyc/database --workspace=@wxyc/uncovered-release-list
npm start --workspace=@wxyc/uncovered-release-list

# Dry run: fetch + resolve + dedup + both anti-joins + cap + run guards; zero writes
# (network egress only if a guard escalates to Sentry):
DRY_RUN=true npm start --workspace=@wxyc/uncovered-release-list

# Dry-run preview of the backlog drain plan:
DRY_RUN=true npm start --workspace=@wxyc/uncovered-release-list -- --backfill
```

The `DRY_RUN` report is a **locked schema** — exactly these keys, one JSON line on stdout; treat as an interface. Widened by this amendment with four new keys (`backfill`, `recent_play_rows`, `candidate_rows`, `capped_out`) — an intentional widening of the locked interface, alongside the pre-existing keys whose _scope_ widened (`deduped`, `already_covered`, `already_handed_off` now cover both arms, not rotation alone). `backfill` is the in-band mode signal: under `--backfill`, `recent_play_rows` holds every linked album ever played, not a lookback-window count, and this key is how a reader tells the difference:

```json
{
  "job": "uncovered-release-list",
  "dry_run": true,
  "backfill": false,
  "active_rotation_rows": 0,
  "resolved": 0,
  "unresolved_dropped": 0,
  "recent_play_rows": 0,
  "candidate_rows": 0,
  "deduped": 0,
  "already_covered": 0,
  "already_handed_off": 0,
  "uncovered": 0,
  "capped_out": 0
}
```

`active_rotation_rows`, `resolved`, `unresolved_dropped` stay rotation-scoped only (the play arm bypasses the resolve loop, so the zero-resolved throw message stays accurate as written).

## Pulling the file from a container

While the publish credential is unprovisioned, the local output file is the run's entire artifact. Under this job's `ENTRYPOINT` (direct `node dist/job.js`, cwd = the container's `/uncovered-release-list` WORKDIR), the default `OUTPUT_PATH` resolves to `/uncovered-release-list/output/uncovered-releases.jsonl`.

**Bind-mount that directory — don't plan to copy it out afterward.** Every `docker run` recipe in this repo uses `--rm`, which deletes the container the instant the job exits, taking the output directory with it; a `docker cp` after the fact has nothing to copy from. Mount a host directory over the output path and the file is simply there when the run finishes:

```bash
mkdir -p ./out
docker run --rm --env-file .env -v "$PWD/out:/uncovered-release-list/output" <image>
cat ./out/uncovered-releases.jsonl
```

`docker cp` is only available if you deliberately ran **without** `--rm`, leaving the exited container around to copy from:

```bash
docker cp <container>:/uncovered-release-list/output/uncovered-releases.jsonl ./uncovered-releases.jsonl
```

## Invariants (do not weaken)

- **Never delete.** The job has no delete path against any table; `uncovered_release_search_markers` is UPSERT-only, and `album_critic_reviews` is read-only from this job's side.
- **Idempotent.** Re-running with `PUBLISH` off (today's default) always re-derives and re-writes the same snapshot for the same DB state — harmless. Once `PUBLISH` is on, a repeated real run makes zero NEW handoff-marker writes for releases already marked (the anti-join excludes them before they're ever re-offered).
- **Exact match only** (via the shared `resolveLinkedAlbumId` for the rotation arm; the play arm needs no resolve step at all, since a linked play already knows its `library.id`). Do not loosen to fuzzy/pg_trgm — see `album-critic-reviews-etl/README.md`'s identical invariant; loosening it here would corrupt the canonical `(artist, album)` pair the whole downstream pipeline trusts.
- **Markers are publish-gated, not write-gated.** Do not move `recordHandoffs` earlier in the pipeline (e.g., right after computing `uncovered`) — see "Found-nothing marker" for why that would silently and permanently drop releases that were never actually handed off.
- **One cap knob, one cap position.** Do not add a separate backfill limit env var or a SQL `LIMIT` in either play-arm query — see "Cap semantics" and "Backfill pacing" for why either would silently stall the drain.

## Related

- [BS#1877](https://github.com/WXYC/Backend-Service/issues/1877) — this job's ticket.
- [ADR 0013](../../docs/adr/0013-search-augmented-critic-review-discovery.md) — the design this job implements one piece of ("Uncovered-release list handoff" section, amended for the candidate-set widening).
- [BS#1830](https://github.com/WXYC/Backend-Service/issues/1830) / [`jobs/album-critic-reviews-etl/README.md`](../album-critic-reviews-etl/README.md) — the structural donor and the downstream consumer of any review this job's handoff eventually produces.
- [`WXYC/research-data#16`](https://github.com/WXYC/research-data/issues/16) — the `search` crawl-mode ticket this job's output feeds; the snapshot schema above is coordinated with it, as is the backfill-pacing contract.
