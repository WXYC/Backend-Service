# Flowsheet ↔ Library Linkage

How a flowsheet `track` row gets matched to the library album it represents, why we route the match through LML's canonical-entity layer instead of text-comparing the two tables, and where the seams are between this work and Epic A's catalog search.

## Why this exists

Of ~1.96M flowsheet `track` rows on production at the start of Epic B, only ~775K (40%) had `album_id` populated. The remaining 60% split into two buckets:

| Bucket | Count | % | Cause |
| --- | ---: | ---: | --- |
| `legacy_release_id` set, FK doesn't resolve | ~292K | 15% | The release id pointed at a tubafrenzy library row that no longer exists in PG (renumbered, deleted, or never imported). |
| No `legacy_release_id` at all | ~889K | 45% | DJ typed the entry by hand instead of picking from the bin. tubafrenzy never had an id to give us; the gap is structural, not a regression. |

Without a populated `album_id` we can't compute per-album play counts (which power Epic A's ranking), can't enrich a free-form entry with the same metadata a bin-pick gets, and can't run any analysis that wants to join flowsheet → library (genre over time, label distribution, rotation effectiveness). Closing the gap unblocks all of those.

## What we deliberately did not do

A direct exact-text match between `flowsheet.{artist_name,album_title}` and `library.{artist_name,album_title}` is **not** part of the pipeline. The empirical recovery on a production sample is ~0.13% (1,568 of 1.18M unlinked rows), and LML's lookup already runs exact → normalized → fuzzy internally — pre-filtering by exact text would just shadow LML's pipeline without adding signal. Every match flows through LML.

## Architecture

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

| `search_type` | Stored confidence | Action | Rationale |
| --- | ---: | --- | --- |
| `direct` | 0.9 | auto-accept | All hand-judged cases were correct — pure typo/punctuation wins. |
| `fallback` | 0.5 | review queue | Mostly wrong-album-by-right-artist. Not zero signal, but not safe to auto-link. |
| `alternative` | 0.3 | review queue | Same artist, different album candidate. Treated as fallback. |
| `compilation` | 0.3 | review queue | Compilation track candidates; only sometimes the right release. |
| `song_as_artist` | 0.3 | review queue | Treats the song title as an artist — usually a miss but occasionally rescues a misfiled entry. |
| `none` | null | discard | Zero results. The next sweep retries. |

The auto-accept gate is `linkage.confidence < AUTO_ACCEPT_THRESHOLD` where `AUTO_ACCEPT_THRESHOLD = 0.9`, so `direct` (==0.9) auto-links and everything else routes to review or is discarded. The stored value is captured at link time on `library.canonical_entity_confidence` and `flowsheet.linkage_confidence` so future analyses can re-judge weak matches once LML exposes a real per-result signal.

## Schema

| Column | Type | Migration | Purpose |
| --- | --- | --- | --- |
| `library.canonical_entity_id` | `text` | 0061 | Opaque, source-namespaced (`discogs:release:<id>`). B-tree indexed for the flowsheet-side lookup. |
| `library.canonical_entity_confidence` | `real` | 0061 | Confidence band stored at link time. |
| `library.canonical_entity_resolved_at` | `timestamptz` | 0061 | Audit + retry policy. NULL means "never resolved". |
| `flowsheet.linkage_source` | `text` | 0062 | One of `etl_legacy_id`, `dj_bin_pick`, `lml_high_confidence`, `human_review`, `tubafrenzy_mirror`. |
| `flowsheet.linkage_confidence` | `real` | 0062 | Confidence band stored at link time. |
| `flowsheet.linked_at` | `timestamptz` | 0062 | Stamps when the link was made (lets B-2.2 retry rules age weak matches). |
| `flowsheet.legacy_link_attempted_at` | `timestamptz` | 0063 | Marker stamped by `jobs/broken-fk-recovery` when the FK resolver tried and failed. Lets B-2.2 sweep both never-had-FK rows AND broken-FK residuals in the same pass. |
| `flowsheet_linkage_review` | table | 0067 | Manual review queue: stores the flowsheet id, ranked candidate library ids and confidences, and the operator's decision. |

Migration numbers are illustrative — the canonical numbers are in `shared/database/src/migrations/meta/_journal.json`.

## Components

### Live write paths

| Path | File | Behavior |
| --- | --- | --- |
| `addAlbum` (library) | `apps/backend/services/library.service.ts` | After insert, kicks off LML lookup + writes `canonical_entity_id` if a candidate exists. Failure is non-fatal — the row stays unresolved and the B-1.2 backfill re-tries it later. |
| `addEntry` (flowsheet) | `apps/backend/controllers/flowsheet.controller.ts` → `fireAndForgetLinkage` | Skips if `album_id` is already set (bin-pick) or `artist_name` is empty (message). Otherwise calls `runLmlLinkage` after the HTTP response is sent. Errors are routed through `reportLinkageError` so the operator sees one consistent `subsystem='lml-linkage'` Sentry filter. |

`fireAndForgetLinkage` runs after `res.send()`; the HTTP response is never blocked on LML. The unit suite proves both paths in `tests/unit/controllers/flowsheet.addEntry.linkage.test.ts`; the integration spec at `tests/integration/flowsheet-linkage.spec.js` exercises the full live stack end-to-end against the mock LML server.

### Backfill jobs

| Job | Path | Inputs | Outputs |
| --- | --- | --- | --- |
| Library canonical-entity backfill | `jobs/library-canonical-entity-backfill/` | `library` rows where `canonical_entity_id IS NULL` | Stamps `canonical_entity_id`, `_confidence`, `_resolved_at`. Throttled, restartable via id cursor. |
| Broken-FK recovery | `jobs/broken-fk-recovery/` | `flowsheet` rows with `legacy_release_id` whose FK doesn't resolve | Re-runs the legacy-id resolver. Stamps `legacy_link_attempted_at` on rows that still don't resolve so the next job can pick them up. |
| Flowsheet LML-link backfill | `jobs/flowsheet-lml-link-backfill/` | `flowsheet` rows where `album_id IS NULL AND entry_type='track'` AND `(legacy_release_id IS NULL OR legacy_link_attempted_at IS NOT NULL)` | Same logic as the forward path: links high-confidence matches, enqueues fallbacks for review. |
| Flowsheet linkage audit backfill | `jobs/flowsheet-linkage-audit-backfill/` | All `flowsheet` rows with `album_id` already populated | Stamps `linkage_source` retroactively for the legacy-linked rows so audits can attribute every linked row to a source. |

All jobs share the package layout in `CLAUDE.md`'s "Migrations are DDL-only" section: `"job-type": "one-shot"` in `package.json`, ECR-built Docker image, invoked via `docker run --rm --env-file .env <image>` during a low-traffic window.

### Tie-break (B-2.3)

When the canonical-entity lookup returns multiple library rows, `pickPrimaryLibraryRow` (`shared/database/src/library-tiebreak.ts`) picks one by:

1. Currently in rotation (most recent rotation row wins).
2. Format preference (CD > vinyl > vinyl 12" > vinyl 7" > vinyl 10" > cdr).
3. Most flowsheet plays in the last 12 months.
4. Lowest `library.id` (deterministic tiebreaker — proxies "first imported, longest in the catalog").

Returns `null` only when the candidate set raced with a concurrent delete; callers treat that as a transient no-match and let the next sweep retry. Both forward and backfill paths share this helper so the same album wins the tie-break in every context.

### Review queue (B-3.1)

`flowsheet_linkage_review` rows are drained one at a time by the CLI at `scripts/review-linkage.ts`:

```bash
npx tsx scripts/review-linkage.ts
```

For each case the operator sees the flowsheet artist/album/track text and the LML-ranked library candidates. The keys are `y` (accept the suggested candidate, stamp `flowsheet.album_id` + `linkage_source='human_review'`), `n` (reject; flowsheet stays unmatched so a future LML improvement can pick it up), or `skip` (no DB write; the case re-appears in the next session).

A web UI is out of scope for v1. Volume needs to materially exceed the CLI's throughput before that calculus changes.

### Observability (B-3.2)

`apps/backend/services/linkage-metrics.service.ts` exposes:

- **In-process counters** keyed by outcome (`linked_high_conf`, `gray_zone_review`, `no_candidate`, `lml_error`, `lml_timeout`). Both forward and backfill paths increment them.
- **SQL-backed gauges**:
  - `getCumulativeLinkageCoverage()` — fraction of all track rows with `album_id` set. Watch this fall as B-2.2 sweeps run.
  - `getRecentLinkageRate(hours)` — fraction of recently inserted rows that are linked. A falling ratio means the forward worker is behind.
- **Sentry tagging**: `reportLinkageError` tags every captured exception with `subsystem='lml-linkage'` and `path='forward'|'backfill'|'review'` so the operator can filter the Sentry issue stream by subsystem instead of by stack trace.

## Cross-epic interaction with Epic A

Epic A (catalog search ranking, see `docs/catalog-search/`) and Epic B share two surfaces:

| Surface | Role in Epic A | Role in Epic B |
| --- | --- | --- |
| `library.artist_name` (denormalized) | Drives the `search_doc` tsvector and the `library_artist_name_trgm_idx` trigram index. | Read by the LML-linkage forward path indirectly via `library` joins, but linkage matches on `canonical_entity_id`, not text. |
| `album_plays` materialized view | Powers the play-count factor in the catalog ranker. | The view aggregates `flowsheet WHERE entry_type='track' GROUP BY album_id`. **Every row Epic B links makes Epic A's ranker more accurate.** Going from 40% → ~55% linkage moves ~290K plays from "uncounted" to "counted" in the per-album rollup. |

Implication: Epic B is most valuable to Epic A when the backfill has run to completion. The deploy order is forward path first, then backfill, so coverage doesn't drift further during the multi-day backfill.

## Related issues

- Epic B: [#484](https://github.com/WXYC/Backend-Service/issues/484)
- B-0 calibration data: [#492](https://github.com/WXYC/Backend-Service/issues/492)
- B-2.1 forward path: [#498](https://github.com/WXYC/Backend-Service/issues/498)
- B-2.2 backfill: [#499](https://github.com/WXYC/Backend-Service/issues/499)
- B-2.3 tie-break: [#500](https://github.com/WXYC/Backend-Service/issues/500)
- B-3.1 review queue: [#501](https://github.com/WXYC/Backend-Service/issues/501)
- B-3.2 metrics: [#502](https://github.com/WXYC/Backend-Service/issues/502)
- B-3.3 (this doc): [#503](https://github.com/WXYC/Backend-Service/issues/503)
