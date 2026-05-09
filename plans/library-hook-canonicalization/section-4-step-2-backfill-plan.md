# §4 step 2 — Library identity backfill (plan)

Status: **draft** (awaiting `/review-plan`)
Plan reference: [`library-hook-canonicalization-plan.md` §4 step 2](https://github.com/WXYC/wiki/blob/main/plans/library-hook-canonicalization-plan.md#4-migration-approach), §3.2.2.2 (writer contract), §3.4.1 (confidence matrix), §3.2.3 (gate-check)
Substrate dependency: PR #743 (merged + deployed 2026-05-08); migration 0075 live.
Audit precondition: PR #742 (merged 2026-05-08; lock-pattern PASS).

## 1. Goal

Materialize the new `library_identity` + `library_identity_source` tables (created empty by 0075) from the union of existing identity artifacts scattered across five sources, so the §3.2.3 backfill-complete gate passes (`truly_unresolved_rows < 1000`) and §4 step 3 (dual-write) can be unlocked.

## 2. Scope (per plan §4 step 2)

The five source artifacts the plan names:

| #   | Source                                | Location                                  | Shape                                                                           | Coverage estimate                                                       |
| --- | ------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| S1  | Backend `library.canonical_entity_id` | Backend PG (local)                        | `discogs:<release_id>`                                                          | unknown — populated by existing `library-canonical-entity-backfill` job |
| S2  | LML `entity.identity`                 | discogs-cache PG (`DATABASE_URL_DISCOGS`) | per-artist external IDs (Discogs, MB, Wikidata, Spotify, Apple Music, Bandcamp) | 23,816 rows (per plan §1)                                               |
| S3  | discogs-cache `flowsheet_match`       | discogs-cache PG                          | `(artist_norm, album_norm) → discogs entity` resolution rows                    | 23,408 (per plan §1.1)                                                  |
| S4  | discogs-cache `fuzzy_resolved`        | discogs-cache PG                          | sibling table to `flowsheet_match`; trigram-resolved                            | included in plan §1's "fragmented" list                                 |
| S5  | semantic-index `reconciliation_log`   | SQLite at `data/wxyc_artist_graph.db`     | artist-level identity history                                                   | 53,849 rows (all NULL `confidence` per plan §1)                         |

All five become input legs to a single one-shot backfill job that writes to `library_identity_source` (one row per `(library_id, source)`) and recomputes `library_identity` per the §3.2.2.2 dual-table writer contract.

## 3. Why this is too big for a single PR

The five sources span three different databases (Backend PG, discogs-cache PG, semantic-index SQLite) and at least three different identity granularities:

- **release-level** (S1, S3, S4): join key is `library.id` → release/master
- **artist-level** (S2, S5): join key is `library.artist_id` → artist
- **track-level** (S4 partial): some `fuzzy_resolved` rows are at `mb_recording_mbid` granularity

A single PR doing all five would need: three external DB clients, a unified merge engine, the dual-table writer, cross-source agreement detection, partition support, idempotency tests, and integration tests against three external databases. Estimated 2,500-4,000 LOC; review burden is too high.

## 4. Sub-PR breakdown (proposed)

Five sub-PRs landing serially. Each sub-PR is independently revertable, leaves `library_identity` in a coherent state, and improves coverage toward the gate.

### Sub-PR 2.0 — Skeleton + S1 (Backend `canonical_entity_id`)

**Goal:** stand up the new one-shot job with the §3.2.2.2 dual-table writer, populated from the single easiest source (Backend's existing `canonical_entity_id` column).

**Job:** new package `jobs/library-identity-backfill/` (one-shot, `"job-type": "one-shot"` in `package.json`). Mirrors the existing `library-canonical-entity-backfill/` shape (job.ts → orchestrate.ts → resolve.ts modules; `BATCH_SIZE`, `THROTTLE_MS`, `PARTITION_INDEX/COUNT` env knobs).

**Source-1 reader (S1):** SELECT every `library` row where `canonical_entity_id LIKE 'discogs:%'`. Decompose to `(library_id, source='discogs_release', external_id=<release_id>, method='exact_match', confidence=1.00, last_verified_at=canonical_entity_resolved_at)`. The `discogs:` namespace and `exact_match` mapping is justified by the existing job's `AUTO_ACCEPT_CONFIDENCE = 0.95` — but per the §3.4.1 confidence matrix, `exact_match` is locked at 1.00, and the existing job's "direct hit with release_id" semantics qualify as exact_match (not name_variation/trigram). Document this remap in the resolver module.

**Writer:** Drizzle `db.transaction()` per-library_id, with `SELECT … FOR UPDATE` on `library_identity` per §3.2.2.2 concurrency contract. Single-source case: per-source row INSERTed, main row UPSERTed with `method='exact_match', confidence=1.00, agreement_sources=NULL`.

**Idempotency:** WHERE filter `library.canonical_entity_id LIKE 'discogs:%' AND library.id NOT IN (SELECT library_id FROM library_identity)`. Restartable; rows already written are skipped.

**Reversibility:** `DELETE FROM library_identity_source WHERE method='exact_match' AND notes='backfill:S1'` + cascade rebuild of `library_identity` rows. Per-source `notes` field tags the source for unwind.

**Dry-run mechanism (locked):** `DRY_RUN=true` env var checked at the top of `orchestrate.ts` before any DB write. When set, the job runs the same SELECTs (counts + sample rows) but skips both per-source INSERTs and main-row UPSERTs. Output is a single JSON object on stdout with this exact schema:

```json
{
  "source": "S1",
  "scanned": 64321,
  "would_write_sources": 12450,
  "would_upsert_mains": 12450,
  "skipped": {
    "already_in_library_identity": 51800,
    "no_canonical_entity_id": 70,
    "non_discogs_namespace": 1
  }
}
```

The `skipped` breakdown keys are stable strings matching the orchestrator's filter predicates (one key per `WHERE` rejection reason). Integration tests assert each key's presence and that `scanned == would_write_sources + sum(skipped.values())`. Dry-run path is integration-tested (run with `DRY_RUN=true` against a fixture DB; assert zero rows in `library_identity*` after); this guards against accidentally introducing a write path that the env-var guard misses. Pattern lifted from request-o-matic's `--dry-run` flag style; new for Backend-Service one-shot jobs.

**Acceptance:**

- `DRY_RUN=true docker run ...` reports per-source row counts as JSON without writing.
- **Env-var documentation:** sub-PR 2.0 adds `DRY_RUN` to `docs/env-vars.md` under a new "ETL Jobs / one-shot backfill" subsection. Verify `THROTTLE_MS`, `BATCH_SIZE`, `PARTITION_INDEX`, `PARTITION_COUNT` are documented (they're shared with `library-canonical-entity-backfill`); if not, add them in the same PR as a coordinated cleanup. `SEMANTIC_INDEX_DB_PATH` deferred to sub-PR 2.3.
- Real run populates `library_identity` for every `library` row that has a non-NULL `canonical_entity_id` matching the discogs scheme.
- §3.2.3 gate-check query (`scripts/check-library-identity-gate.sql`) reports `truly_unresolved_rows = (library row count) − (S1 backfilled count)` — partial gate; nowhere near `< 1000` yet but progress visible.
- Integration test against Postgres confirms transaction atomicity (force-rollback mid-transaction; assert no partial rows).
- Integration test confirms `DRY_RUN=true` leaves both `library_identity*` tables untouched.
- Partition test (PARTITION_COUNT=4 PARTITION_INDEX=0..3) confirms disjoint output.

**Estimated LOC:** ~600 (job + tests).

### Sub-PR 2.1 — S2 (LML `entity.identity` via Backend's mirrored `artists` columns)

**Goal:** add the LML-derived artist-level identity as a second source. Triggers within-row cross-source agreement detection — when an artist has ≥2 populated external IDs (discogs_artist + wikidata + mb_artist, etc.), those sources are corroborating per LML's matcher, so the main-row recompute applies §3.4.1.1 Rule 2 → `cross_source_agreement 0.95`.

**Reader (single-DB, post-investigation):** Backend's `library × artists` JOIN supplies all six identity columns directly — `artists.discogs_artist_id`, `musicbrainz_artist_id`, `wikidata_qid`, `spotify_artist_id`, `apple_music_artist_id`, `bandcamp_id` are already populated by `jobs/artist-identity-etl/` (null-fill from LML's `entity.identity`). No cross-DB read is needed for the IDs themselves; the existing artist-identity ETL is the authority.

**Provenance index (cross-DB, single bulk read at job start):** for honest per-row `(method, confidence)`, the reader bulk-loads LML's `entity.identity ⨝ entity.reconciliation_log` once at job start:

```sql
SELECT DISTINCT ON (l.identity_id, l.source)
       i.library_name, l.source, l.method, l.confidence
FROM entity.identity i
JOIN entity.reconciliation_log l ON l.identity_id = i.id
ORDER BY l.identity_id, l.source, l.created_at DESC
```

This gives the latest reconciliation attempt per `(identity_id, source)` tuple — the actual method LML used (`exact_match`, `name_variation`, `member_group`, `alias_match`) and its confidence. Build an in-memory `Map<(library_name, source), {method, confidence}>`. Memory budget: ~24K identity rows × ≤6 sources × ~100 bytes = ~15 MB. Trivial.

The LML reconciliation_log was discovered to already carry this provenance during 2.1 design prep; it superseded the original "locked at `alias_match 0.85`" interim. WXYC/library-metadata-lookup#270 (which proposed adding method+confidence to `entity.identity`) was closed because the data is already in `reconciliation_log`.

**Granularity fanout:** a library row with `artist_id=N` and any release_id receives the same six artist-level external IDs as every other library row with the same artist. Document this fanout in the resolver — it's correct because identity (Spotify ID, MB UUID) is artist-level, not release-level. The per-source rows tagged with the artist-level source names (`discogs_artist`, `mb_artist`, etc.) — distinct from S1's `discogs_release` — so the writer's `ON CONFLICT (library_id, source)` PK never collides.

**Confidence assignment (real, per-row):**

- For each `(library_name, source)` pair found in the provenance index → use the real `(method, confidence)` from the latest reconciliation_log row.
- Narrow fallback: when the provenance index has no entry for that pair (rare hand-edit case where artists.{column} is non-null but no reconciliation_log entry exists) → `method='alias_match', confidence=0.85`. Tag with `notes='backfill:S2,fallback=no-log'` so post-run audit can detect drift.
- Per-source rows tagged `notes='backfill:S2'` for the normal case.

**Within-row cross-source agreement:** when an `entity.identity` row has ≥2 non-null external IDs, those sources were resolved together by LML's matcher and refer to the same artist. The resolver returns `agreementSources = [list of populated sources]` to the writer; the §3.4.1.1 recompute applies Rule 2 → main-row method becomes `cross_source_agreement` with `confidence = MAX(0.95, MIN-of-corroborating-confidences)`.

**S1 ↔ S2 cross-source agreement (deferred to follow-up):** S1 is release-level (`discogs_release_id`), S2 is artist-level (`discogs_artist_id`). They corroborate only via release → artist resolution, which requires either (a) Backend's existing `artists.discogs_artist_id` columns (the simpler path; works when the release's master/release was resolved by the same LML matcher that also resolved the artist), or (b) Wikidata's `discogs_mapping` table (the multi-cache pre-index from plan §5.2). Both are out of scope for sub-PR 2.1; documented as a follow-up. Within-row agreement is enough to land 2.1's gate-improving coverage.

**Idempotency:** WHERE filter excludes `(library_id, source)` pairs already in `library_identity_source`. Distinct from 2.0's `library_id`-level filter — 2.1 reads every library row whose artist has any non-null identity column, even if 2.0 already wrote a `discogs_release` row for that library_id. The writer's `ON CONFLICT (library_id, source) DO UPDATE` plus the WHERE filter make rerun safe.

**Job dispatch:** new env var `BACKFILL_LEG=S1|S2`, default `S1`. `job.ts` switches between `runBackfillS1` (existing) and `runBackfillS2` (new) at the top of `main()`. Future legs (2.2a, 2.2b, 2.3) extend this enum.

**DRY_RUN report (locked schema for S2):**

```json
{
  "source": "S2",
  "scanned": 12345,
  "would_write_sources": 24680,
  "would_upsert_mains": 12100,
  "skipped": {
    "no_identity_columns": 200,
    "all_sources_already_in_library_identity_source": 45
  }
}
```

`would_write_sources` exceeds `scanned` because each library row fans out to up to 6 per-source rows; `would_upsert_mains` is bounded by distinct library_ids touched.

**Estimated LOC:** ~400 (provenance index reader + S2 resolver + orchestrator dispatch + tests).

### Sub-PR 2.2 — S3+S4 (discogs-cache `flowsheet_match` + `fuzzy_resolved`)

**Goal:** add the release-level matchers from discogs-cache. These are the highest-volume sources after S1 (23,408 + ? rows).

**Reader:** new module `sources/discogs-cache-matches.ts`. Reads from the same `DATABASE_URL_DISCOGS` connection as S2. Filters to rows where the join columns can be normalized to `(library.norm_artist, library.norm_title)` per the §3.3 normalization function (already deployed via wxyc-etl 0.3.0).

**Method assignment:** per §3.4.1:

- `flowsheet_match` rows where `distinct_entities=1` → `method='exact_match', confidence=1.00`
- `flowsheet_match` rows where `distinct_entities>1` (the 4,594 / 23,408 ambiguous matches per plan §1.1.2) → `method='trigram', confidence=0.7+0.3*<trgm_score>` clamped to [0.70, 0.95]. If `trgm_score` not available, `method='alias_match'`, `confidence=0.75`.
- `fuzzy_resolved` rows → `method='trigram'` with the source's `trgm_score` translated.

**Pre-implementation spike (lands as a brief audit doc before 2.2 starts):** the spike covers TWO questions, not one:

1. **`trgm_score` shape** — verify that `flowsheet_match.trgm_score` and `fuzzy_resolved.trgm_score` exist in the discogs-cache schema and document their value ranges. The plan §3.4.1 trigram formula `0.7 + 0.3 * trgm_score` assumes `trgm_score ∈ [0, 1]`; if discogs-cache stores it differently (e.g., 0-100), we re-scale before applying the formula.
2. **`discogs_master_id` vs `discogs_release_id` resolution granularity** — verify whether `flowsheet_match` and `fuzzy_resolved` rows carry a release ID, a master ID, both, or are ambiguous. The substrate's `library_identity` schema has BOTH columns; writing to the wrong one breaks the cross-source agreement detector and the §3.2.2.2 main-row recompute. Decide one of: (a) S3+S4 always populate `discogs_release_id` only, (b) S3+S4 always populate `discogs_master_id` only, (c) S3+S4 populate whichever the source row pins (one or the other, never both, never empty), or (d) S3+S4 populate both via a master→release expansion (yields multiple library rows from one source row — likely wrong, document why if rejected).

Spike output: a one-page memo at `plans/library-hook-canonicalization/audits/discogs-cache-match-score-shape.md` confirming both findings + null-fractions. If the spike reveals nontrivial mapping logic (e.g., `flowsheet_match` and `fuzzy_resolved` use different score scales, or one lacks the score column entirely, or master-vs-release resolution differs between the two), split sub-PR 2.2 into 2.2a (`flowsheet_match` only) + 2.2b (`fuzzy_resolved` only) with the spike memo flagged as the bisect point.

**Estimated LOC:** ~500 (pending spike outcome; 2.2a + 2.2b each ~300 if split).

### Sub-PR 2.3 — S5 (semantic-index `reconciliation_log`)

**Goal:** add the semantic-index artist-level resolutions.

**Reader:** new module `sources/semantic-index-reconciliation.ts`. Opens the SQLite file via env var `SEMANTIC_INDEX_DB_PATH` (default `/data/wxyc_artist_graph.db`).

**Deployment strategy (locked, decided pre-2.3):** the semantic-index DB is rebuilt nightly on EC2 by `nightly_sync.py` and lives at `/home/ec2-user/semantic-index-data/wxyc_artist_graph.db` on the same EC2 host that runs Backend-Service. The backfill job's `docker run` mounts that directory read-only: `-v /home/ec2-user/semantic-index-data:/data:ro`. No file copy, no download — the backfill reads the most recent nightly snapshot in place. This is a one-shot job, so the read happens once at the start of the run; nightly rotation during the run does not affect us (the open SQLite handle holds the inode). `SEMANTIC_INDEX_DB_PATH` documented in `docs/env-vars.md` as part of sub-PR 2.3, with the EC2-mount recipe in the README.

**Caveat:** plan §1 notes "all 53,849 rows have NULL `confidence`". So we're inferring confidence from the `method` column. Per §3.4.1 we have to assign a confidence; the safest mapping is `method='reconciled'` → `confidence=0.85` (above threshold, below exact_match) until semantic-index emits real confidences in a follow-up.

**Estimated LOC:** ~300.

### Sub-PR 2.4 — Gate verification + cleanup

**Goal:** run the gate-check and confirm `truly_unresolved_rows < 1000`. If so, the §3.2.3 gate-check passes and §4 step 3 (dual-write) is unblocked. If not, identify the residual set and propose either a follow-up source leg or a deliberate plan amendment.

**No code changes** assumed; this PR is the gate-check report + project-tracker update.

If the gate doesn't pass (≥1000 truly unresolved rows), this PR enumerates the residual set and picks one of the following pre-defined options (no ambiguous "deliberate plan amendment" wording):

1. **Confidence thresholds too strict.** Reduce S2/S5 interim floor from 0.85 to 0.75 (still above the 0.70 audit threshold). Re-run sub-PRs 2.1 and 2.3 idempotently — the existing rows tagged `notes='backfill:S2,...'` are updated in place per §3.2.2 supersedure rules. No code changes; only env-var override + re-run.
2. **Insufficient source coverage.** File a new ticket for an additional source leg (e.g., LML manual-override CSV ingestion, a tubafrenzy `flowsheet` join for very-old rows, or a semantic-index enhancement to emit real confidences). The new source becomes sub-PR 2.5+ following the same dual-table writer pattern.
3. **Threshold itself is wrong.** File a `WXYC/wiki` PR amending plan §3.2.3 to lower the gate threshold (e.g., from 1000 to 5000 truly-unresolved rows). Requires explicit reviewer sign-off and reasoning recorded in the plan amendment commit.

The decision tree is binary at gate-check time: pick exactly one option and link the follow-up ticket / PR. No silent option-D escape.

## 5. Cross-cutting concerns

### 5.1 Atomicity (per §3.2.2.2)

Each sub-PR uses the same dual-table writer:

```ts
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT 1 FROM library_identity WHERE library_id = ${libraryId} FOR UPDATE`);
  // step 1: per-source upserts
  for (const sourceRow of sources) {
    await tx.execute(sql`INSERT INTO library_identity_source ... ON CONFLICT (library_id, source) DO UPDATE ...`);
  }
  // step 2: recompute and upsert the main row
  await tx.execute(
    sql`INSERT INTO library_identity ... SELECT ... FROM library_identity_source WHERE library_id = ${libraryId} ON CONFLICT (library_id) DO UPDATE ...`
  );
});
```

**Concurrency mechanism (corrected; do not rely on `SELECT FOR UPDATE` alone):** the `SELECT … FOR UPDATE` per §3.2.2.2 protects an existing main row from concurrent recompute, but it is **a no-op when the main row does not yet exist** — Postgres returns zero rows and acquires no lock, so concurrent first-inserts to the same `library_id` are NOT serialized by it. The actual serialization mechanisms in this backfill are:

1. **`ON CONFLICT (library_id) DO UPDATE`** on the main-row UPSERT — the unique index serializes concurrent inserts at the row level. One concurrent writer wins the insert; the other takes the UPDATE branch atomically.
2. **§5.6 serial sub-PR landing rule** — sub-PRs land one at a time, so two source legs are never writing the same `library_id` concurrently outside a single transaction. Within a sub-PR, partition disjointness (`PARTITION_INDEX/COUNT` shards by `library.id % count`) prevents two parallel containers from touching the same `library_id`.
3. **`SELECT … FOR UPDATE`** still appears in the writer pseudocode and is correct for the case where a prior sub-PR's writes are already present (e.g., 2.1 reading a row 2.0 wrote earlier — the lock is acquired and serializes against any concurrent reader). It is the right mechanism for a recurring writer (the eventual /lookup-driven writer in §4 step 3); for this one-shot backfill it's defense-in-depth, not the primary safety net.

**Implementer takeaway:** rely on `ON CONFLICT` for first-insert atomicity and on the §5.6 + partition rules for cross-leg / cross-container disjointness. Do NOT extend the job in a way that assumes `SELECT FOR UPDATE` serializes first-inserts; that's a Postgres semantic the writer does not give us.

**Lock granularity (when the lock fires at all):** `SELECT … FOR UPDATE` locks only the main `library_identity` row, not the per-source rows in `library_identity_source`. This is sufficient because per-source writes are scoped to disjoint `(library_id, source)` pairs across sub-PRs (S1 writes `source='discogs_release'`; S2 writes `source ∈ {discogs_artist, mb_*, wikidata, spotify, apple_music, bandcamp}`).

### 5.1.1 Supersedure semantics across sub-PRs (resolves the §3.2.2 vs §3.4.1.1 tension)

Sub-PR 2.0 writes single-source rows; the §3.2.2 supersedure rules and §3.4.1.1 composition rules don't conflict because there's only one source. As soon as sub-PR 2.1 lands and writes a second source for the same `library_id`, the writer must run the main-row **recompute** per §3.4.1.1 — and the result may have **lower** numeric confidence than the prior single-source main row (e.g., S1 alone gave `exact_match` 1.00; S1+S2 with cross-ref gives `cross_source_agreement` 0.95). On the surface this looks like a §3.2.2 Rule 3 violation ("If existing row has `confidence > new confidence` AND existing `method ∈ {exact_match, manual}`: new write is rejected"), but it isn't. The resolution per the plan's own rules:

- §3.2.2's supersedure rules apply to **per-source rows** (`library_identity_source`), guarding against a single source overwriting a higher-confidence single source.
- §3.4.1.1 Rule 5 ("Demotion requires evidence equal-or-stronger") explicitly contemplates the main-row case: `cross_source_agreement` at 0.95 is considered stronger evidence than a single-source `exact_match` at 1.00 because it's corroborated. Rule 5 says cross*source_agreement at 0.95 \_can* supersede exact_match 1.00 on the main row.
- Rule 1 (`manual` 1.00 hard floor) is the only case where the main row resists recompute. The backfill never writes `manual` (that's reserved for §3.2.4 manual-override workflow), so this can't apply.

**Implementation rule:** the main-row UPSERT is **unconditional within the transaction** when at least one per-source row was added or modified during this run. The `ON CONFLICT (library_id) DO UPDATE` clause replaces the main-row values from the recompute, regardless of whether the new confidence is higher or lower than the existing. The prior main row is moved to `library_identity_history` with `superseded_reason='backfill_recompute'` (a new reason value to distinguish from `'rerun'`, since this is a deliberate cross-source merge, not a /lookup re-attempt).

**Sub-PR 2.0 implication:** S1 writes are **not "provisional"** — they're correct for the single-source case. When 2.1 lands, the main-row recompute may reduce numeric confidence (e.g., 1.00 → 0.95) but per Rule 5 the `cross_source_agreement` is considered stronger evidence. The reduction is intentional and recorded in history. No retroactive recomputation of S1 per-source rows is needed; only the main-row values change.

**Test fixture (lands in sub-PR 2.0):** unit test for the main-row recompute function with these inputs and expectations (per §3.4.1.1 worked examples):

| Setup (per-source rows present)                                                             | Expected main row                                                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| S1 alone: `discogs_release` exact_match 1.00                                                | `exact_match` 1.00, `agreement_sources=NULL`                                                                                   |
| S1 + S2 no cross-ref: `discogs_release` exact_match 1.00, `discogs_artist` alias_match 0.85 | `alias_match` 0.85 (Rule 4: MIN), `agreement_sources=NULL`                                                                     |
| S1 + S2 with cross-ref: same + Wikidata `discogs_mapping` says they corroborate             | `cross_source_agreement` 0.95 (Rule 2: MAX(0.95, MIN(1.00, 0.85))=0.95), `agreement_sources=[discogs_release, discogs_artist]` |
| S1 + S2 + S5 with cross-ref: + `wikidata_qid` from S5 alias_match 0.85                      | `cross_source_agreement` 0.95, agreement_sources includes all three                                                            |

The recompute function lives in sub-PR 2.0 even though only the first row is exercised by 2.0's actual writes — it's the public API that 2.1+ will call into, so unit-testing it in 2.0 prevents drift.

### 5.2 Cross-source agreement (per §3.2.5)

`cross_ref_present(s1, s2)` is a Postgres function (or TypeScript helper) that returns true when two per-source rows resolve to entities sharing a known cross-reference. Implementation:

- Discogs ↔ Wikidata: `wikidata.discogs_mapping` table
- Discogs ↔ MusicBrainz: MB `artist_url` rows pointing at Discogs
- MB ↔ Wikidata: MB `external_url` rows pointing at Wikidata

The cross-ref function reads from the wikidata-cache and musicbrainz-cache PG instances. It can be precomputed for each `(s1, s2)` pair into an in-memory cross-ref index at job start (avoid per-row PG roundtrips).

Defer the multi-cache cross-ref index to sub-PR 2.1 where it first becomes useful (S1+S2 = first multi-source case).

### 5.3 Reversibility

Each source leg writes a `notes='backfill:S<N>'` tag. Unwind:

```sql
DELETE FROM library_identity_source WHERE notes LIKE 'backfill:S2%';
-- then recompute every affected library_id's library_identity main row
```

A `unwind.sh` script ships with each sub-PR and is tested in CI against a fixture DB.

### 5.4 Idempotency on rerun

Each sub-PR's reader checks "does `(library_id, source)` already exist in `library_identity_source`?" — if so, skip (or update `last_verified_at` only). The §3.2.2 supersedure rules apply: if the existing row has higher confidence, the new write is rejected (history-only).

### 5.5 Live-activity probe (cooperative pause)

Per `flowsheet-metadata-backfill`'s `LIVE_ACTIVITY_LOOKBACK_SECONDS` knob: skip a batch if a flowsheet entry was added within the last 60s. This is identity backfill, not flowsheet backfill, so the probe is more relaxed — defer to whatever Backend-Service has documented for "low-traffic window" job runs (per the migrations CLAUDE.md). Likely no live-activity probe needed; document the rationale.

### 5.6 PR sequencing rule

Each sub-PR depends on its predecessors (sub-PR 2.1 depends on 2.0's job skeleton; sub-PR 2.2 depends on 2.0+2.1). Concurrent merges of two sub-PRs would conflict on `jobs/library-identity-backfill/` files. **Land them serially.**

## 6. Out of scope

- LML `/api/v1/lookup` v2 with `include_identity: true` (E2 step 0a — `wxyc-shared/api.yaml` v0.6.0 work). The backfill reads from existing artifacts; it does not call LML's `/lookup` endpoint.
- Refactoring the existing `library-canonical-entity-backfill` job. That job continues to write `library.canonical_entity_id` legacy columns during the dual-write window (§4 steps 1-4). Per #742 audit, no lock conflict.
- Manual-override workflow (§3.2.4 — separate epic).
- Reader cutover (§4 step 4 — gated on §4 step 3).
- Schema changes to `library_identity*` tables — substrate is fixed by 0075.

## 7. Open questions (resolved during plan review)

1. **Confidence for S2 fallback** — RESOLVED: locked at `method='alias_match', confidence=0.85` (interim, pending LML per-row method+confidence audit). See sub-PR 2.1 details and §5.1.1 supersedure semantics. Rationale: `entity.identity` aggregates multiple LML resolution paths without per-row provenance, so blanket `exact_match 1.00` would inflate confidence beyond truth; 0.85 places S2 above the 0.70 audit threshold but below `name_variation`'s floor.
2. **Confidence for S5** — RESOLVED: hardcoded `method='alias_match', confidence=0.85` matching the S2 tier. Reason: `reconciliation_log` has all NULL confidence per plan §1, and `reconciliation_log.method` does not have a 1:1 mapping to §3.4.1's method enum. A follow-up may improve this once semantic-index emits real confidences.
3. **Cross-source agreement implementation site** — RESOLVED: TypeScript pre-index at job start. Reads from wikidata-cache + musicbrainz-cache PG in bulk; builds an in-memory `Map<discogs_id, Set<mb_id|wikidata_qid>>` index. Per-row cross-ref check is then O(1). Postgres-side cross-DB queries rejected as too brittle (three external DBs to coordinate).
4. **Job name** — RESOLVED: `jobs/library-identity-backfill/` for plan-text alignment.
5. **Sub-PR 2.2 split decision** — DEFERRED to spike: per the new §4.2 spike memo, the discogs-cache `trgm_score` shape audit determines whether sub-PR 2.2 stays unified or splits into 2.2a + 2.2b.
6. **Multi-source merge cadence** — RESOLVED: incremental per source leg, with explicit supersedure semantics documented in §5.1.1. Each sub-PR's main-row recompute is unconditional and prior main rows go to `library_identity_history` with `superseded_reason='backfill_recompute'`.

## 8. Risk + rollback

| Risk                                                                                                                                  | Mitigation                                                                                                                                                                               | Rollback                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-row writer is too slow (60K+ rows × 5 sources × transaction overhead)                                                             | Bench in CI; estimate ~5 wall-clock minutes per source leg at 100 ms/row × 64K rows / 4 partitions                                                                                       | Stop the job; per-source `notes='backfill:S<N>'` cleanup scripts                                                                                               |
| Cross-DB connectivity (DATABASE_URL_DISCOGS, semantic-index SQLite) flakes                                                            | Read-only connections, separate pools, retry with backoff. Docker bind-mount for SQLite                                                                                                  | Jobs are restartable; transient failures don't corrupt state                                                                                                   |
| Confidence mapping for S2/S5 (locked at `alias_match` 0.85) turns out to be too pessimistic, suppressing real high-confidence matches | Sub-PR 2.4 gate-check report exposes confidence distribution; if a large fraction of unresolved rows have S2 hits but no main-row write, escalate to LML per-row method+confidence audit | Once LML emits per-row method+confidence in `entity.identity`, re-run sub-PR 2.1 with the upgraded reader; existing 0.85 rows are superseded per §3.2.2 Rule 4 |
| Cross-source agreement detection is incorrect                                                                                         | Unit tests against fixture data covering each agreement combination; integration tests against staging DB                                                                                | Drop `agreement_sources` from main rows; fall back to Rule 4 (MIN)                                                                                             |
| Substrate's `library_identity_audit_idx` becomes hot during backfill                                                                  | Backfill writes are sequential per partition; index maintenance is amortized over the run. If hot, consider dropping the index during backfill and rebuilding after                      | Drop + recreate index post-backfill                                                                                                                            |
| Job runs concurrently with the existing `library-canonical-entity-backfill` and they fight for DB connections                         | Existing job uses auto-commit, ~5/sec throughput. New job is similar pace per partition. Should not exhaust the postgres-js pool (default `max=10`); configurable via env.               | Run them in disjoint windows if pool exhaustion observed                                                                                                       |

## 9. Estimated total

5 sub-PRs, ~2,300 LOC across job code + tests, ~3-4 weeks at one PR/3-4 days cadence. Sub-PR 2.4 (gate verification) may compress if gate naturally passes after 2.0-2.3.

## 10. Next concrete step (after `/review-plan` approval)

Implement **Sub-PR 2.0** (skeleton + S1). Deliverables:

- `jobs/library-identity-backfill/` package
- Job entrypoint + orchestrator + S1 reader + dual-table writer
- Unit tests (resolver, atomicity, partition)
- Integration test against PG fixture
- `package.json` declaring `"job-type": "one-shot"`
- `Dockerfile` + ECR push wiring (mirrors the existing one-shot jobs)
- README with the run command + env vars + rollback recipe

Ticket: file new BS issue **"§4 step 2 sub-PR 2.0 — library-identity-backfill skeleton + S1 source"**, sub-issue under epic #663 (E2 — Backend half).
