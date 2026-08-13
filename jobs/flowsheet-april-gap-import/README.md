# flowsheet-april-gap-import

One-shot dry-run-by-default import (BS#2119): backfill the closed BS#351 residue — `flowsheet` entries tubafrenzy holds that Backend-Service never received. **Dry-run is the default; writes require `--execute`.**

## Problem

[BS#351](https://github.com/WXYC/Backend-Service/issues/351) — "Flowsheet ETL incremental sync drops track entries with START_TIME=0" — was fixed forward on 2026-04-20. Before that fix, `jobs/flowsheet-etl`'s incremental sync resolved a row's timestamp from `START_TIME` alone; most tubafrenzy track entries carry `START_TIME=0` (only `show_start`/`show_end` markers have a non-zero value), so every affected track was silently skipped. No backfill of the already-skipped rows ever ran, and the sync's watermark had already moved past them by the time the bug was found.

The cohort is **closed**: the bug has been fixed since April, and nothing still produces this shape.

## Scope decision (read before widening the window)

A review of the original BS#2119 issue found the cohort is not homogeneous:

- **399 rows across 15 shows, 2026-04-16 → 2026-04-20** — the unambiguous #351 residue. This is the **default** import scope.
- **4 rows across 3 shows, 2026-08-09 → 2026-08-11** — post-Phase-3 residue, and **ambiguous**. Post-Phase-3 the flowsheet is Backend-canonical; `deleteEntry` (`apps/backend/middleware/legacy/flowsheet.mirror.ts`) mirrors a BS delete as best-effort raw SQL over SSH. An id present upstream and absent in Backend is therefore EITHER a failed insert-webhook (import is correct) OR a successful DJ delete whose delete-mirror failed (import **resurrects a deletion**). "Insert-only" does not defend against resurrection — a resurrected row is still a legitimate, conflict-free INSERT. Separately, `deleteEntry`'s own comment documents that tubafrenzy's `SEQUENCE_WITHIN_SHOW` and Backend's `play_order` are assigned independently and diverge (Backend counts lifecycle markers tubafrenzy never materializes), so importing `SEQUENCE_WITHIN_SHOW` verbatim into a show that already holds Backend-canonical rows can land it at the wrong position.

**The mechanism handles the full id set** — `GAP_IMPORT_WINDOW_START`/`GAP_IMPORT_WINDOW_END` are plain date-window bounds with nothing April-specific about them. **Only the default is narrowed.** Reaching the 4 August rows means explicitly widening the window after a per-row provenance check (was this id's absence a failed webhook, or a failed delete-mirror?) — a human decision, not something this job's default should make silently. See [BS#1543](https://github.com/WXYC/Backend-Service/issues/1543) item 2 for that check; **this job does not subsume BS#1543's 4-row item** — do not claim that in any run report or issue comment.

## Mechanism

1. **Discover** (`discoverCandidates`): fetch `FLOWSHEET_ENTRY_PROD` rows from tubafrenzy via a live MySQL query bounded to `[GAP_IMPORT_WINDOW_START, GAP_IMPORT_WINDOW_END)` (`jobs/flowsheet-etl/fetch-legacy.ts`'s `fetchLegacyEntriesInWindow`), then re-apply `resolveEntryTimestamp` and an exact window check to every row — the SQL side casts deliberately wide (an `OR` across `START_TIME`/`TIME_CREATED`/`TIME_LAST_MODIFIED`, mirroring `fetchLegacyEntries`'s existing `sinceMs` filter shape), so this is the precise filter.
2. **Backend-side floor**: refuse unless `COUNT(flowsheet.legacy_entry_id) IS NOT NULL` is at least `GAP_IMPORT_MIN_BACKEND_ID_COUNT` (default 2.5M, against a measured ~2.63M). An undersized count means the read failed, not that Backend is empty.
3. **Diff**: check which candidate ids already exist in `flowsheet.legacy_entry_id`; the remainder is the missing cohort.
4. **Cohort ceiling**: refuse if the missing cohort exceeds `GAP_IMPORT_MAX_COHORT_SIZE` (default 2000, against today's measured 403). Larger is a comparison bug, not a discovery. A per-show breakdown is logged either way (including on refusal) for diagnostics.
5. **Resolve `show_id`**: map each row's `legacy_show_id` to a Backend `shows.id` via the extracted `buildShowIdMap`. A row whose `legacy_show_id` has no Backend mapping is **excluded from insertion** (not inserted with a null `show_id`) and counted separately — every show in this cohort is expected to already exist in Backend (see the issue's measurements), so an unmapped row is a signal something's off, not a normal case.
6. **Resolve `dj_name` and `album_id`**: pre-insert read-only SELECTs (see "Column mapping" below).
7. **Dry-run**: log the full report (candidate/missing counts, per-show breakdown, the exact `legacy_entry_id` list that would be inserted) and stop. **No writes in this mode, ever.**
8. **`--execute`**: batch the insert rows (`GAP_IMPORT_BATCH_SIZE`, default 25) with a cooperative live-DJ pause (`waitForQuietPeriod`, shared `checkLiveActivity`) before each batch and a fixed gap (`GAP_IMPORT_BATCH_GAP_MS`, default 30s) between batches, pacing the CDC enrichment worker's shared LML rate limiter (BS#1748's `TokenBucket` is process-wide, not per-caller — a burst of ~25 simultaneous track inserts mid-show could shed live rows). `ANALYZE flowsheet` runs once after any batch that wrote.

## Column mapping

Reuses `jobs/flowsheet-etl/transform.ts`'s pure mappers verbatim (extracted from `job.ts` by this same issue's prerequisite PR — see "Extraction prerequisite" below): `mapProdEntryType`, `resolveEntryTimestamp` (the #351 fix itself — `START_TIME → TIME_CREATED → TIME_LAST_MODIFIED` fallback), `resolveRadioHour`, `resolveArtistName`, `resolveMessage`. `jobs/flowsheet-april-gap-import/build-row.ts`'s `buildInsertRow` is the pure column-mapping function; `album_title`/`track_title`/`record_label` are wrapped in `truncate(…, 128)` at the call site (mirroring `flowsheet-etl/job.ts:459-463`) — `artist_name` and `message` self-truncate inside `resolveArtistName`/`resolveMessage`.

| Backend column            | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `legacy_entry_id`         | `FLOWSHEET_ENTRY_PROD.ID`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `show_id`                 | existing `shows.legacy_show_id` → `shows.id` map (no `shows` writes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `entry_type`              | `mapProdEntryType(FLOWSHEET_ENTRY_TYPE_CODE_ID)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `add_time`                | `resolveEntryTimestamp(START_TIME, TIME_CREATED, TIME_LAST_MODIFIED)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `play_order`              | `SEQUENCE_WITHIN_SHOW` verbatim (per-show, no unique constraint — see `schema.ts`'s 2026-05-01 incident memo)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `radio_hour`              | `resolveRadioHour(entryType, RADIO_HOUR)` — breakpoints only                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `artist_name` / `message` | `resolveArtistName` / `resolveMessage` — **load-bearing for the talkset/breakpoint rows**, whose display text routes to `message`, not `artist_name`                                                                                                                                                                                                                                                                                                                                                                                       |
| `legacy_release_id`       | `LIBRARY_RELEASE_ID` (the `0 → null` sentinel is inherited from `fetch-legacy.ts`, not reimplemented)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `request_flag` / `segue`  | `REQUEST_FLAG` / `SEGUE_FLAG`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dj_name`                 | **pre-insert read-only SELECT**: `COALESCE(auth_user.dj_name, shows.legacy_dj_name)` per resolved `show_id` — the same PII-safe chain the live mirror and `flowsheet-etl` use (BS#1393 / BS#1371). **Never** `auth_user.name` or tubafrenzy's `DJ_NAME` column. **Not** `flowsheet-etl/job.ts`'s `resolveDjNames` — that helper is a post-insert `UPDATE … WHERE dj_name IS NULL`, which would violate insert-only and, under `ON CONFLICT DO NOTHING`, could touch a pre-existing Backend row whose `legacy_entry_id` happens to collide. |
| `album_id`                | opportunistic pre-insert read-only SELECT on `library.legacy_release_id`; `null` when unlinked — the recurring `legacy-linkage-resolve` cron (every 30 minutes) covers the rest. Optimization only, never a correctness dependency.                                                                                                                                                                                                                                                                                                        |
| `metadata_status`         | column default (`'pending'`) — not set explicitly, matching the donor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Insert-only — hard constraint

Every id in the cohort is confirmed absent from Backend by the diff step, so a pure INSERT touches no Backend-canonical row. `ON CONFLICT (legacy_entry_id) DO NOTHING` — **never `DO UPDATE`** — absorbs live churn between the diff read and the write (and a re-run of this job entirely): the attempted set and the inserted set can differ, which is why every batch uses `RETURNING legacy_entry_id` rather than assuming what it attempted is what landed. This is also why `jobs/flowsheet-etl` itself is never reused for the run: its upsert carries a broad `SET` list, so running it with `LEGACY_ETL_ALLOW_BACKWARDS_WRITE=1` would `UPDATE` all ~2.6M existing legacy-linked rows from tubafrenzy's mirror copy — the exact hazard `jobs/flowsheet-etl/backwards-write-guard.ts` exists to prevent.

## Extraction prerequisite

`jobs/flowsheet-etl/job.ts` invokes `run()` at module scope, so _importing anything from it_ starts the ETL and trips the backwards-write refusal. This job never imports from `job.ts`. The pure mappers it needs live in `jobs/flowsheet-etl/transform.ts` (`isMessageEntryType`, `resolveArtistName`, `resolveMessage`, alongside the pre-existing `mapProdEntryType`/`resolveEntryTimestamp`/`resolveRadioHour`), the show-id map builder lives in the new `jobs/flowsheet-etl/show-id-map.ts` (takes a `DbClient`, so it doesn't belong in the DB-free `transform.ts`), and the date-window fetch lives in `jobs/flowsheet-etl/fetch-legacy.ts`'s `fetchLegacyEntriesInWindow`. `jobs/legacy-linkage-resolve/job.ts` is avoided the same way — it also self-invokes, guarded only by `NODE_ENV !== 'test'`.

Cross-job source reuse mirrors the `jobs/concerts-artist-lml-resolver` → `jobs/triangle-shows-etl` (`isCleanHeadliner`) precedent: `Dockerfile.flowsheet-april-gap-import` `COPY`s `jobs/flowsheet-etl`'s source into the builder stage (never into the prod image — tsup bundles it into this job's own `dist` at build time).

## Safety rails

1. **Backend-side floor** (`GAP_IMPORT_MIN_BACKEND_ID_COUNT`, default 2.5M) — refuses on an undersized read.
2. **Cohort ceiling** (`GAP_IMPORT_MAX_COHORT_SIZE`, default 2000) — refuses on an oversized missing-set.
3. **Dry-run by default**, `--execute` to write.
4. **`RETURNING legacy_entry_id`** on every insert batch — the operator's rollback record is what actually landed, not what was attempted.
5. **Unmapped-show exclusion** — a candidate whose `legacy_show_id` has no Backend `shows.id` mapping is skipped and counted (`excludedUnmappedShowCount`), never inserted with a null `show_id`.
6. **`ANALYZE flowsheet`** after any batch that wrote, per [`docs/bulk-update-playbook.md`](../../docs/bulk-update-playbook.md).
7. **`closeLegacyConnection()`** in `job.ts`'s `finally` — `fetch-legacy.ts` instantiates `MirrorSQL.instance()` at module scope; a job that doesn't close it hangs on exit (SSH keepalive).
8. **Cooperative live-DJ pause + SIGTERM graceful stop** — mirrors `flowsheet-ghost-row-sweep` / `streaming-url-remediation`.

A 403-row (or even 2000-row) window fetch never produces a MySQL `IN (...)` predicate with a raw-text-length problem — the date-window query is a fixed handful of `BETWEEN` clauses regardless of match count — so this job does not need to chunk an id list against tubafrenzy the way an id-list-based fetch would.

## Enrichment residue guard

Imported rows land `metadata_status='pending'`, which `filterForEnrichment` (the CDC enrichment worker, `apps/enrichment-worker`) picks up on any track INSERT — but these rows' `add_time` is April-dated, which is **always** outside `jobs/flowsheet-metadata-backfill`'s `BACKFILL_RECOVERY_WINDOW_HOURS` (default 6h) gap-recovery sweep. If the CDC worker misses a row (a restart, a dropped notification), **nothing else will ever pick it up** — the hourly safety net that exists for exactly this situation is blind to historical `add_time` by construction.

**Do not "fix" this by widening `BACKFILL_RECOVERY_WINDOW_HOURS`.** That knob's whole purpose is excluding the ~748k-row undrained historical backlog #1011 left behind; widening it (even temporarily) re-admits that entire backlog to the hourly sweep.

Instead:

- After an `--execute` run, the job logs an immediate post-insert `metadata_status` distribution for exactly the inserted ids (`metadataStatusDistribution`). This is a **snapshot, not a terminal answer** — the CDC worker races this job's own batch gaps, so it's informative but not final.
- The same log line carries a ready-to-run verification query (`verificationQueryText`) with the inserted ids embedded, e.g.:

  ```sql
  SELECT metadata_status, COUNT(*) FROM wxyc_schema.flowsheet
  WHERE legacy_entry_id = ANY(ARRAY[2001,2002,...]) GROUP BY metadata_status;
  ```

  Re-run this from the run log a while after the run (enough time for the worker to have caught up — tens of minutes is generous) to check for stragglers still at `pending`.

- If stragglers are found, the remediation is a **targeted, id-scoped fix** for just those rows — not a global recovery-window change. No such targeted re-enrichment tool exists yet; if this recurs, file it as its own issue rather than reaching for `BACKFILL_RECOVERY_WINDOW_HOURS`.

## Run procedure

```bash
# Dry-run (default) — review the per-show breakdown and the would-insert id list.
docker run --rm --name flowsheet-april-gap-import --env-file .env \
  <ECR-URI>/flowsheet-april-gap-import:<tag>

# Execute — writes.
docker run --rm --name flowsheet-april-gap-import --env-file .env \
  <ECR-URI>/flowsheet-april-gap-import:<tag> --execute
```

Blocked on [BS#2118](https://github.com/WXYC/Backend-Service/issues/2118) (`flowsheet.id`-as-recency bug) landing first — a historical insert gets the highest `id`s in the table, and four read paths currently treat `id` as a chronological proxy. BS#2118 blocks the **run**, not this job's development; nothing here should be executed against production until it's resolved.

## Environment variables

See [`docs/env-vars.md`](../../docs/env-vars.md#flowsheet-april-gap-import-jobsflowsheet-april-gap-import-bs2119) for the full reference (`GAP_IMPORT_WINDOW_START`/`END`, `GAP_IMPORT_BATCH_SIZE`, `GAP_IMPORT_BATCH_GAP_MS`, `GAP_IMPORT_MIN_BACKEND_ID_COUNT`, `GAP_IMPORT_MAX_COHORT_SIZE`, the shared `LIVE_ACTIVITY_*` cooperative-pause vars) plus the shared SSH/MySQL tunnel vars (`SSH_HOST`/`SSH_USERNAME`/`SSH_PASSWORD`/`REMOTE_DB_*`) already present in the shared host `.env`.

## Testing

- `tests/unit/jobs/flowsheet-april-gap-import/window.test.ts` — date-window resolution + defaults.
- `tests/unit/jobs/flowsheet-april-gap-import/build-row.test.ts` — the pure column mapper.
- `tests/unit/jobs/flowsheet-april-gap-import/orchestrate.test.ts` — the full control flow (safety-rail refusals, dry-run vs. `--execute`, batching, unmapped-show exclusion, `ON CONFLICT DO NOTHING` partial-insert accounting, cooperative pause, SIGTERM stop) via injected seams, plus focused tests of the real DB-touching helpers against the `db.execute`/`returning` mock.

## What's out of scope

- **The 4 August rows.** Deliberately excluded from the default window — see "Scope decision" above and BS#1543.
- **Running this job.** Gated on BS#2118. This issue builds and tests the mechanism only.
- **A dedicated targeted re-enrichment tool** for enrichment stragglers — see "Enrichment residue guard" above.

## Related

- [BS#351](https://github.com/WXYC/Backend-Service/issues/351) — root cause, fixed forward 2026-04-20 with no backfill
- [BS#1543](https://github.com/WXYC/Backend-Service/issues/1543) — turndown data-finalization; the 4-row post-Phase-3 item is a separate, NOT subsumed, provenance check
- [BS#2118](https://github.com/WXYC/Backend-Service/issues/2118) — `flowsheet.id`-as-recency bug; blocks the RUN of this job
- [BS#1888](https://github.com/WXYC/Backend-Service/issues/1888) — the `liveFs:insert` broadcast whose track-scoped filter this import interacts with
