---
title: 'discogs-cache match score shape (sub-PR 2.2 spike)'
status: draft
related:
  - WXYC/wiki plans/library-hook-canonicalization-plan.md §3.4.1, §1.1.2
  - Backend-Service/plans/library-hook-canonicalization/section-4-step-2-backfill-plan.md §4 sub-PR 2.2
date: 2026-05-09
---

# discogs-cache match score shape (sub-PR 2.2 spike)

## Summary

The two questions in the sub-PR 2.2 spike both resolve to **"the assumption in the plan does not hold"**:

1. **Neither `flowsheet_match` nor `fuzzy_resolved` has a `trgm_score` column.** `flowsheet_match` is an _exact equi-join_ table (post-normalization) — there is no fuzzy score because there is no fuzzy match. `fuzzy_resolved` discards the per-row trigram score during its resolve step; the score lives only on the upstream `fuzzy_full` staging table as `combined = similarity(artist) + similarity(album)`, range `[0, 2]` (sum of two pg_trgm `similarity()` calls).
2. **Only `flowsheet_match` carries Discogs IDs (both `master_id` and `release_id`, with `master_id` preferred and nullable). `fuzzy_resolved` carries no Discogs ID at all** — it pins a `(artist_norm, album_norm)` pair to a Backend `library.id`. So the master-vs-release decision matters only for S3 (flowsheet_match); for S4 (fuzzy_resolved) the question is moot — there is nothing Discogs-shaped to write.

These two findings are independent and the mapping logic for S3 and S4 diverges materially. **Sub-PR 2.2 should split into 2.2a (`flowsheet_match`) + 2.2b (`fuzzy_resolved`).**

The tables themselves are not part of the discogs-cache schema in `discogs-etl/schema/create_database.sql`; they are working tables built by Backend-Service's one-shot reconciliation scripts (`Backend-Service/scripts/discogs-bridge-flowsheet.sql` and `fuzzy-trigram-flowsheet.sql`) that run inside the discogs-cache Postgres container during the §4 step 2 backfill. The plan §1.1's "23,408 / 4,594" counts are row counts inside the materialized `flowsheet_match` from a 2026-04-28 reconciliation run, not a permanent table that consumers can query in steady state.

## Question 1 — `trgm_score` shape

### `flowsheet_match`

Columns produced by `Backend-Service/scripts/discogs-bridge-flowsheet.sql:144-161`:

| column              | type           | source                                                               |
| ------------------- | -------------- | -------------------------------------------------------------------- |
| `artist_norm`       | TEXT           | normalized flowsheet artist                                          |
| `album_norm`        | TEXT           | normalized flowsheet album                                           |
| `distinct_entities` | INT            | `count(DISTINCT coalesce(NULLIF(r.master_id, 0), -r.id))` (line 149) |
| `master_id`         | INT (nullable) | `MIN(NULLIF(r.master_id, 0))` (line 150)                             |
| `release_id`        | INT            | `MIN(r.id)` (line 151)                                               |

There is **no `trgm_score` column**. `flowsheet_match` is built by an exact equi-join on the normalized strings (lines 153-158): `regexp_replace(...lower(f_unaccent(...))...) = fp.artist_norm` AND the same on title. Every row is a 1.0-similarity match by construction; storing a score would be redundant.

The plan §3.4.1 trigram formula `0.7 + 0.3 * trgm_score` therefore does not apply to `flowsheet_match` rows. The plan's own §4 sub-PR 2.2 lines 106-107 already split the cases:

- `distinct_entities = 1` → `method='exact_match', confidence=1.00`
- `distinct_entities > 1` → the plan attempts `method='trigram', confidence=0.7+0.3*<trgm_score>` but **`trgm_score` does not exist**, so the documented fallback (`method='alias_match', confidence=0.75`) is the only viable mapping. Recommend dropping the trigram branch from S3's mapping spec — it is dead code.

### `fuzzy_resolved`

Columns produced by `Backend-Service/scripts/fuzzy-trigram-flowsheet.sql:146-176`:

| column                | type           | source                                                                        |
| --------------------- | -------------- | ----------------------------------------------------------------------------- |
| `artist_norm`         | TEXT           | normalized flowsheet artist                                                   |
| `album_norm`          | TEXT           | normalized flowsheet album                                                    |
| `resolved_library_id` | INT (nullable) | resolved Backend `library.id` after canonical-stamp tie-break (lines 169-174) |

There is **no `trgm_score` column** here either. The trigram score lives only on the upstream staging table `fuzzy_full` (`Backend-Service/scripts/fuzzy-trigram-flowsheet.sql:128-142`):

```sql
similarity(fr.artist_norm, ln.artist_norm) + similarity(fr.album_norm, ln.album_norm) AS combined
```

The thresholds applied (lines 140-141) are `similarity(artist) >= 0.85` AND `similarity(album) >= 0.70`, so on rows that survive into `fuzzy_full`:

- per-side scores are PostgreSQL `real` in `[0.0, 1.0]` (pg_trgm `similarity()` semantics — already on the [0,1] scale assumed by §3.4.1, no rescaling needed)
- `combined` (sum of two scores) is in `[0.85 + 0.70, 2.0] = [1.55, 2.0]`

`fuzzy_resolved` then GROUPs by pair (lines 148-155) and keeps only `array_agg(library_id ORDER BY combined DESC, library_id)`, dropping the `combined` value itself. The score is recoverable only by re-querying `fuzzy_full` (which the script does not persist past the run) or by recomputing `similarity()` at backfill time.

**Recommendation for S4 confidence mapping:** sub-PR 2.2b should either (a) modify `fuzzy-trigram-flowsheet.sql` to add a `trgm_artist_score` + `trgm_album_score` pair to `fuzzy_resolved` (preferred — surgical edit, ~3 lines, the cost of one re-run), or (b) accept a fixed `confidence=0.85` for all `fuzzy_resolved` rows (matches the existing `linkage_confidence=0.85` baked into the prod-side UPDATE per `fuzzy-trigram-flowsheet.sql:39, 86`). Option (b) is the lower-risk path if a re-run is undesirable, since 0.85 is already what prod was stamped with on 2026-04-28; it just doesn't scale with similarity.

### Null fractions

Unable to determine from source — these are working tables from a one-shot run, not a queryable steady-state asset. The 2026-04-28 run materialized `flowsheet_match` with 23,408 rows of which 4,594 had `distinct_entities > 1` (per plan §1.1.2 line 83), but the tables themselves are not retained between runs. The backfill job will need to re-materialize them inside its own transaction or re-export the snapshot from the Backend-Service operator's working DB.

## Question 2 — Discogs ID granularity

### `flowsheet_match` (S3)

Both columns are populated, with `master_id` nullable:

```sql
-- discogs-bridge-flowsheet.sql:149-151
count(DISTINCT coalesce(NULLIF(r.master_id, 0), -r.id)) AS distinct_entities,
MIN(NULLIF(r.master_id, 0)) AS master_id,
MIN(r.id) AS release_id
```

`master_id` is NULL when **all** matched releases lacked a Discogs master (singles, demos, obscure pressings — see `discogs-etl/CLAUDE.md`'s "master_id Column Lifecycle" section). `release_id` is always populated.

The downstream bridge (lines 168-196) then prefers master-keyed lookups and falls back to release-keyed:

```sql
'discogs:master:'  || master_id::text  AS master_cid,
'discogs:release:' || release_id::text AS release_cid,
...
via_master AS (... WHERE c.master_id IS NOT NULL),
via_release AS (...)
SELECT ... FROM (via_master UNION ALL via_release)
```

This means the source row genuinely pins **one** of `discogs_master_id` (preferred when non-NULL) or `discogs_release_id` (fallback when master is NULL). Writing both onto a single `library_identity_source` row would misrepresent the resolution: the upstream chose one or the other, not both.

**Recommendation for S3: option (c) — populate whichever the source row pins.** Concretely:

- `flowsheet_match.master_id IS NOT NULL` → write `discogs_master_id = master_id`, leave `discogs_release_id` NULL.
- `flowsheet_match.master_id IS NULL` → write `discogs_release_id = release_id`, leave `discogs_master_id` NULL.
- Never both, never neither.

Rejection reasons for the other options:

- (a) release-only loses the master signal that the bridge specifically prefers, breaking cross-source agreement with sub-PR 2.1's S2 (LML `entity.identity`) which is artist-level not release-level — but the master-vs-release distinction is the only handle for compilation/single de-conflation downstream of §3.4.1 confidence recompute.
- (b) master-only drops ~10-30% of rows (estimate from "obscure pressings" caveat; unable to determine exact NULL fraction from source) and would force re-keyed lookups during recompute.
- (d) master→release expansion creates 1-to-many `library_identity_source` rows where the upstream materialized 1-to-1; this misrepresents source provenance and inflates `agreement_sources` in §3.2.2.2 main-row recompute. Reject.

### `fuzzy_resolved` (S4)

The table carries **no Discogs ID at all** — neither `master_id` nor `release_id` appears in the column list (`fuzzy-trigram-flowsheet.sql:147-176`). The output is `(artist_norm, album_norm, resolved_library_id)`, where `resolved_library_id` is a Backend `library.id` arrived at via:

1. trigram-similar `(artist_norm, album_norm)` matches against `library_norm` (lines 130-141)
2. canonical-stamp tie-break that uses `library.canonical_entity_id` from `library_stamps` to disambiguate format variants (lines 157-176)

So S4 contributes **identity at the Backend `library_id` level**, not at the Discogs entity level. It cannot populate `discogs_master_id` or `discogs_release_id` directly.

**Recommendation for S4:** S4 does not write Discogs ID columns at all. Its `library_identity_source` row ties `(library_id, source='trigram_match')` and contributes to the §3.2.2.2 main-row recompute via `agreement_sources` (cross-source agreement with whichever Discogs IDs S1/S2/S3 already wrote for that `library_id`). If §3.2.2.2 requires at least one external-ID column to be populated for a per-source row to be valid, S4 needs a special dispensation in the writer contract — flag during 2.2b implementation.

A plausible secondary path: for any `fuzzy_resolved.resolved_library_id` whose Backend `library.canonical_entity_id` is `'discogs:master:N'` or `'discogs:release:N'`, S4 _could_ propagate that stamp into the per-source row. But this is a copy of S1's signal under a different `method`, not new identity information; recommend skipping unless 2.2b implementation reveals coverage holes the simpler path does not fill.

## Sub-PR 2.2 split decision

**Split into 2.2a (`flowsheet_match` only) + 2.2b (`fuzzy_resolved` only).** Justification:

| dimension          | flowsheet_match (2.2a)                                                        | fuzzy_resolved (2.2b)                                             |
| ------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| score column       | absent (exact match by construction)                                          | absent (discarded; available only on upstream `fuzzy_full`)       |
| confidence mapping | `exact_match 1.00` (n=1) / `alias_match 0.75` (n>1) — no trgm fallback needed | fixed `0.85` OR add scores to source SQL + use `0.7+0.3*<scaled>` |
| Discogs ID         | both columns present, source pins one (master preferred)                      | absent — resolves to library_id only                              |
| writer contract    | standard (one external ID per row)                                            | special-case (no external ID, agreement-only)                     |

The two mapping logics diverge enough that a single PR would carry two unrelated risk profiles. Splitting bisects cleanly: 2.2a can land + revert without touching 2.2b's writer contract changes; 2.2b's "no external ID" special case can be reviewed in isolation.
