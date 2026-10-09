# Flowsheet ↔ Library Linkage

How a flowsheet `track` row gets matched to the library album it represents, how the live paths match by normalized text (the original design routed the match through LML's canonical-entity layer instead; that forward path was removed in commit `d45c1d58`, 2026-06-03, and the sections describing it below are historical), and where the seams are between this work and Epic A's catalog search.

## Why this exists

Of ~1.96M flowsheet `track` rows on production at the start of Epic B, only ~775K (40%) had `album_id` populated. The remaining 60% split into two buckets:

| Bucket                                      | Count |   % | Cause                                                                                                                                       |
| ------------------------------------------- | ----: | --: | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `legacy_release_id` set, FK doesn't resolve | ~292K | 15% | The release id pointed at a tubafrenzy library row that no longer exists in PG (renumbered, deleted, or never imported).                    |
| No `legacy_release_id` at all               | ~889K | 45% | DJ typed the entry by hand instead of picking from the bin. tubafrenzy never had an id to give us; the gap is structural, not a regression. |

Without a populated `album_id` we can't compute per-album play counts (which power Epic A's ranking), can't enrich a free-form entry with the same metadata a bin-pick gets, and can't run any analysis that wants to join flowsheet → library (genre over time, label distribution, rotation effectiveness). Closing the gap unblocks all of those.

## Backfill: SQL-direct, not LML

Backfill no longer routes through LML. The empirical numbers we landed on changed the calculus: a normalized exact-text match between `flowsheet.{artist_name,album_title}` and `library.{artist_name,album_title}` recovers ~6.7% of the unlinked residual (52,984 of ~793K rows on the 2026-04-27 prod run), bridging via the local Discogs snapshot adds another ~1.7% (13,548 rows), and `pg_trgm` fuzzy text adds ~7.7% (61,122 rows) — 127K rows total in seconds, well above LML's reachable yield against the same residual at its rate ceiling.

The remaining ~666K residual is bounded by library-catalog coverage (albums simply not in WXYC's library), not by any matching strategy. LML's data source is the same Discogs corpus our local snapshot already covers, so re-running an LML-driven backfill against the residual would mostly produce 429s and "no candidate" outcomes.

The exact-text pass computes both sides with `wxyc_schema.text_match_key()` (migration 0191): fold Unicode form and diacritics, lowercase, strip a leading "the ", delete every non-alphanumeric run. A key of `''` (a symbols-only title like `>>>`) never matches. The insert path (`addEntry`), the edit path (`updateEntry`) and the job pass share the same function.

The three SQL-direct passes live under `scripts/` and document their own normalization, confidence, idempotency, and reversal:

- `scripts/direct-link-flowsheet.sql` — exact normalized text match (`linkage_source='direct_text_match'`, confidence 1.0).
- `scripts/discogs-bridge-flowsheet.sql` — flowsheet → local Discogs snapshot → library via `canonical_entity_id` (`linkage_source='discogs_local_bridge'`, confidence 0.9).
- `scripts/fuzzy-trigram-flowsheet.sql` — `pg_trgm` similarity match with same-album tie-break (`linkage_source='fuzzy_trigram_match'`, confidence 0.85).

The live paths do not go through LML either: the historical LML forward path (live `addEntry` linkage) was removed in commit `d45c1d58` (2026-06-03), and the three text writers described under [Live write paths](#live-write-paths) replaced it.

## Architecture

**Historical:** this is the removed LML forward-path design (commit `d45c1d58`, 2026-06-03); the live paths match by `text_match_key` instead.

Two-sided canonical resolution. Library rows and flowsheet rows both resolve to the same opaque external identifier (a Discogs release id today; the column type allows MusicBrainz / other resolvers later). Linkage flows through that identifier, not through text:

```
flowsheet row (no album_id, has artist + album text)
  │
  ▼
LML.lookupMetadata(artist, album)   (LML internally tries exact → normalized → fuzzy)
  │
  ▼
mapLookupToCanonicalEntity         → "discogs:release:<id>" + coarse confidence
  │
  ▼
confidence ≥ AUTO_ACCEPT_THRESHOLD ?
  ├── no  → enqueue flowsheet_linkage_review for human triage
  └── yes
       │
       ▼
     SELECT id FROM library WHERE canonical_entity_id = $1
       │
       ├── 0 rows  → unmatched (canonical entity exists, WXYC doesn't own it)
       ├── 1 row   → link with linkage_source='lml_high_confidence'
       └── 2+ rows → tie-break (rotation > format > plays > id), then link
```

Library-side resolution runs the same first three steps on insert (B-1.3) and as a one-time backfill (B-1.2). That's the reason the flowsheet-side step 4 is a single index lookup, not a fuzzy join — by the time we get to step 4 both sides are already pointing at the same opaque id.

## Confidence thresholds (B-0 calibration)

LML does not currently return per-result confidence. We derive a coarse band from `search_type`, calibrated against a 100-case hand-judged sample (issue #492):

| `search_type`    | Stored confidence | Action       | Rationale                                                                                      |
| ---------------- | ----------------: | ------------ | ---------------------------------------------------------------------------------------------- |
| `direct`         |               0.9 | auto-accept  | All hand-judged cases were correct — pure typo/punctuation wins.                               |
| `fallback`       |               0.5 | review queue | Mostly wrong-album-by-right-artist. Not zero signal, but not safe to auto-link.                |
| `alternative`    |               0.3 | review queue | Same artist, different album candidate. Treated as fallback.                                   |
| `compilation`    |               0.3 | review queue | Compilation track candidates; only sometimes the right release.                                |
| `song_as_artist` |               0.3 | review queue | Treats the song title as an artist — usually a miss but occasionally rescues a misfiled entry. |
| `none`           |              null | discard      | Zero results. The next sweep retries.                                                          |

The auto-accept gate is `linkage.confidence < AUTO_ACCEPT_THRESHOLD` where `AUTO_ACCEPT_THRESHOLD = 0.9`, so `direct` (==0.9) auto-links and everything else routes to review or is discarded. The stored value is captured at link time on `library.canonical_entity_confidence` and `flowsheet.linkage_confidence` so future analyses can re-judge weak matches once LML exposes a real per-result signal.

## Schema

| Column                                 | Type          | Migration | Purpose                                                                                                                                                                |
| -------------------------------------- | ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library.canonical_entity_id`          | `text`        | 0061      | Opaque, source-namespaced (`discogs:release:<id>`). B-tree indexed for the flowsheet-side lookup.                                                                      |
| `library.canonical_entity_confidence`  | `real`        | 0061      | Confidence band stored at link time.                                                                                                                                   |
| `library.canonical_entity_resolved_at` | `timestamptz` | 0061      | Audit + retry policy. NULL means "never resolved".                                                                                                                     |
| `flowsheet.linkage_source`             | `text`        | 0062      | One of `etl_legacy_id`, `dj_bin_pick`, `lml_high_confidence`, `human_review`, `tubafrenzy_mirror`, `direct_text_match`, `discogs_local_bridge`, `fuzzy_trigram_match`. |
| `flowsheet.linkage_confidence`         | `real`        | 0062      | Confidence band stored at link time.                                                                                                                                   |
| `flowsheet.linked_at`                  | `timestamptz` | 0062      | Stamps when the link was made (lets B-2.2 retry rules age weak matches).                                                                                               |
| `flowsheet.legacy_link_attempted_at`   | `timestamptz` | 0063      | Marker stamped by `jobs/broken-fk-recovery` when the FK resolver tried and failed. Lets B-2.2 sweep both never-had-FK rows AND broken-FK residuals in the same pass.   |
| `flowsheet_linkage_review`             | table         | 0067      | Manual review queue: stores the flowsheet id, ranked candidate library ids and confidences, and the operator's decision.                                               |

Migration numbers are illustrative — the canonical numbers are in `shared/database/src/migrations/meta/_journal.json`.

## Components

### Live write paths

| Path                      | File                                                                       | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addAlbum` (library)      | `apps/backend/services/library.service.ts`                                 | After insert, kicks off LML lookup + writes `canonical_entity_id` if a candidate exists. Failure is non-fatal — the row stays unresolved and the B-1.2 backfill re-tries it later.                                                                                                                                                                                                                                                                                                                                                                                              |
| `addEntry` (flowsheet)    | `apps/backend/controllers/flowsheet.controller.ts` → `annotateTextLinkage` | BS#3066. For `entry_type` `track` only (a track-shaped body carrying another type is skipped), a typed row (no `album_id`, or a library-miss `album_id`) is looked up with `findLibraryReleasesByText`; exactly one catalog release links it as `direct_text_match`, confidence 1.0, and zero or several leave it unlinked. Rotation plays arriving with `album_id: null` are linked the same way. Typed fields are never rewritten and `label_id` is not derived. A lookup failure is non-fatal (Sentry `subsystem: 'text-linkage'`). A picked entry is stamped `dj_bin_pick`. |
| `updateEntry` (flowsheet) | `apps/backend/services/flowsheet.service.ts`                               | BS#3065. Re-matches text when artist or album actually change; see the edit-path notes in the service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

The insert-path lookup runs synchronously before the insert, on the default pool (`addEntry` holds no transaction there). The unit suite is `tests/unit/controllers/flowsheet.addEntry.textLinkage.test.ts`; the end-to-end cases are the "text linkage on insert" and "text linkage on edit" blocks in `tests/integration/flowsheet.spec.js`. Six catalog titles are symbols-only (`>>>`, `( )`, `$`, `++++`, `?`, `:)`): their key is `''`, so they are linkable only by a pick.

The text writers that exist are: insert (`addEntry`), edit (`updateEntry`) and the job pass (`legacy-linkage-resolve`, below; disabled until BS#3063). All stamp `direct_text_match`.

### Backfill jobs

| Job                               | Path                                      | Inputs                                                             | Outputs                                                                                                                              |
| --------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Library canonical-entity backfill | `jobs/library-canonical-entity-backfill/` | `library` rows where `canonical_entity_id IS NULL`                 | Stamps `canonical_entity_id`, `_confidence`, `_resolved_at`. Throttled, restartable via id cursor.                                   |
| Broken-FK recovery                | `jobs/broken-fk-recovery/`                | `flowsheet` rows with `legacy_release_id` whose FK doesn't resolve | Re-runs the legacy-id resolver. Stamps `legacy_link_attempted_at` on rows that still don't resolve so the next job can pick them up. |
| Flowsheet linkage audit backfill  | `jobs/flowsheet-linkage-audit-backfill/`  | All `flowsheet` rows with `album_id` already populated             | Stamps `linkage_source` retroactively for the legacy-linked rows so audits can attribute every linked row to a source.               |

**Recurring text-match pass (BS#3061).** `jobs/legacy-linkage-resolve/` re-applies `wxyc_schema.text_match_key()` every 30 minutes to recent unlinked `track` rows whose library row was filed after the play was logged, stamping `linkage_source = 'direct_text_match'`, `linkage_confidence = 1.0` — the same label and rule as the insert path, the edit path and `scripts/direct-link-flowsheet.sql`, so one reversal predicate covers all of them. The `LINKAGE_RESOLVE_TEXT_MATCH_WINDOW_DAYS` window is a **cost bound, not a watermark** (anchored to `now()`, never to the heartbeat). The pass **ships disabled**: it writes nothing until that variable is set to a positive integer on the cron host, and enabling is the manual step tracked in BS#3063 (scope query, dry run, owner approval). `--dry-run` reports its would-link count regardless.

The flowsheet → library backfill itself is the trio of SQL scripts described in [Backfill: SQL-direct, not LML](#backfill-sql-direct-not-lml) above; it isn't a Docker job. The previous `jobs/flowsheet-lml-link-backfill/` Docker job was removed in 2026-04 — see the kill PR's commit message for the full rationale.

All jobs share the package layout in `CLAUDE.md`'s "Migrations are DDL-only" section: `"job-type": "one-shot"` in `package.json`, ECR-built Docker image, invoked via `docker run --rm --env-file .env <image>` during a low-traffic window.

### Tie-break (B-2.3)

When the canonical-entity lookup returns multiple library rows, `pickPrimaryLibraryRow` (`shared/database/src/library-tiebreak.ts`) picks one by:

1. Currently in rotation (most recent rotation row wins).
2. Format preference (CD > vinyl > vinyl 12" > vinyl 7" > vinyl 10" > cdr).
3. Most flowsheet plays in the last 12 months.
4. Lowest `library.id` (deterministic tiebreaker — proxies "first imported, longest in the catalog").

Returns `null` only when the candidate set raced with a concurrent delete; callers treat that as a transient no-match and let the next sweep retry. The removed LML forward path used this helper directly; the SQL-direct backfill scripts express the same priority order in the equivalent `MIN(library_id)` plus shared-canonical fallback (historical: the live text writers do not tie-break, they refuse ambiguity and leave the row unlinked).

### Review queue (B-3.1)

`flowsheet_linkage_review` rows are drained one at a time by the CLI at `scripts/review-linkage.ts`:

```bash
npx tsx scripts/review-linkage.ts
```

For each case the operator sees the flowsheet artist/album/track text and the LML-ranked library candidates. The keys are `y` (accept the suggested candidate, stamp `flowsheet.album_id` + `linkage_source='human_review'`), `n` (reject; flowsheet stays unmatched so a future LML improvement can pick it up), or `skip` (no DB write; the case re-appears in the next session).

A web UI is out of scope for v1. Volume needs to materially exceed the CLI's throughput before that calculus changes.

### Observability (B-3.2)

`apps/backend/services/linkage-metrics.service.ts` exposes:

- **In-process counters** keyed by outcome (`linked_high_conf`, `gray_zone_review`, `no_candidate`, `lml_error`, `lml_timeout`). The removed LML forward path incremented them; SQL-direct backfill rows are accounted for via post-run `SELECT count(*) GROUP BY linkage_source`, not the in-process counters.
- **SQL-backed gauges**:
  - `getCumulativeLinkageCoverage()` — fraction of all track rows with `album_id` set. Watch this fall as B-2.2 sweeps run.
  - `getRecentLinkageRate(hours)` — fraction of recently inserted rows that are linked. A falling ratio means more recent plays name no single catalog release: the insert path links at write time, so there is no background worker to fall behind.
- **Sentry tagging** (historical, LML forward path): `reportLinkageError` tagged every captured exception with `subsystem='lml-linkage'` and `path='forward'|'review'` so the operator can filter the Sentry issue stream by subsystem instead of by stack trace. The live text paths report `subsystem: 'text-linkage'`. (`path='backfill'` was reachable while the LML-driven backfill existed; the SQL-direct scripts surface failures as psql errors instead of Sentry events.)

## Cross-epic interaction with Epic A

Epic A (catalog search ranking, see `docs/catalog-search/`) and Epic B share two surfaces:

| Surface                              | Role in Epic A                                                                         | Role in Epic B                                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library.artist_name` (denormalized) | Drives the `search_doc` tsvector and the `library_artist_name_trgm_idx` trigram index. | Read by the historical LML-linkage forward path via `library` joins, which matched on `canonical_entity_id`; the live paths match on `text_match_key` of the typed text.                                                                           |
| `album_plays` materialized view      | Powers the play-count factor in the catalog ranker.                                    | The view aggregates `flowsheet WHERE entry_type='track' GROUP BY album_id`. **Every row Epic B links makes Epic A's ranker more accurate.** Going from 40% → ~55% linkage moves ~290K plays from "uncounted" to "counted" in the per-album rollup. |

Implication: Epic B is most valuable to Epic A when the backfill has run to completion. The SQL-direct backfill takes minutes rather than days, so the coverage gap closes in a single maintenance window once the text-linkage paths are live.

## Related issues

- Epic B: [#484](https://github.com/WXYC/Backend-Service/issues/484)
- B-0 calibration data: [#492](https://github.com/WXYC/Backend-Service/issues/492)
- B-2.1 forward path: [#498](https://github.com/WXYC/Backend-Service/issues/498)
- B-2.2 backfill: [#499](https://github.com/WXYC/Backend-Service/issues/499)
- B-2.3 tie-break: [#500](https://github.com/WXYC/Backend-Service/issues/500)
- B-3.1 review queue: [#501](https://github.com/WXYC/Backend-Service/issues/501)
- B-3.2 metrics: [#502](https://github.com/WXYC/Backend-Service/issues/502)
- B-3.3 (this doc): [#503](https://github.com/WXYC/Backend-Service/issues/503)
