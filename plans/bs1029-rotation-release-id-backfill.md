# BS#1029 — One-shot ETL: populate rotation Discogs release id from LML

## Goal

Pre-resolve every active rotation row's Discogs release id once via LML and persist to BS PG, so `getDiscogsReleaseIdByRotationId` becomes a deterministic SQL read instead of a runtime LML cascade. Unblocks BS#1030 (revert PR #987's tier-3 cascade + LRUs) and ends the 2026-05-21 incident's lineage (BS#994).

Out of scope: anything in `apps/backend/services/library.service.ts`. The read path stays as-is; BS#1030 changes it after this lands.

## Production state to address (per ticket)

- `rotation` total rows: 21,563
- `rotation.discogs_release_id` populated: 0 (tubafrenzy column is empty in prod)
- Active rows (`kill_date IS NULL OR > CURRENT_DATE`): 310
- Active rows with `album_id` linked: ~159
- `library_identity` rows: 0
- `library_identity.discogs_release_id` populated: 0 (structurally NULL until BS#801)

So both JOIN tiers in `getDiscogsReleaseIdByRotationId` return NULL for 100% of rotation rows today.

## Deliverable shape (PR contents)

Single PR. Five components, all required, in this order in the diff:

### 1. Migration 0085 — `discogs_release_id_source` enum + column

`shared/database/src/migrations/0085_rotation-discogs-release-id-source.sql`:

```sql
-- precondition-guard: not-required (ADD COLUMN with constant DEFAULT on
--   PG11+ is metadata-only; NOT NULL is satisfied for existing rows by the
--   default. Enum type DDL has no row-level invariants to violate.)
-- 0085 — provenance column for rotation.discogs_release_id (BS#1029).
--
-- Two-value enum capturing where rotation.discogs_release_id came from:
--   tubafrenzy_paste     — mirrored by jobs/rotation-etl from the
--                          tubafrenzy rotation form's paste-URL prefill.
--                          Music-director-verified.
--   lml_offline_backfill — written by jobs/rotation-release-id-backfill
--                          (one-shot ETL, BS#1029). Resolved via LML's
--                          POST /api/v1/lookup at backfill time.
--
-- Provenance lets the read path (BS#1030's revert + future tooling)
-- distinguish MD-verified ids from automatically-resolved ones; also lets
-- a future re-run of the backfill scope its UPDATEs to lml_offline_backfill
-- rows only, preserving any subsequent tubafrenzy paste.
--
-- Default 'tubafrenzy_paste' is set because:
--   (a) it makes the rotation-etl ON CONFLICT writer simpler (it doesn't
--       need to explicitly set source on the dominant path — tubafrenzy
--       paste is the only source rotation-etl uses).
--   (b) existing 21,563 rows already represent the "tubafrenzy is the
--       source of truth" world. They have release_id=NULL, but if/when
--       tubafrenzy fills them in, the source is correct by construction.
--
-- DDL-only — no row UPDATE. PG11+ stores the constant default in
-- pg_attribute (`atthasmissing`/`attmissingval`) and reads it virtually
-- for unmodified rows; no rewrite, no AccessExclusiveLock held beyond
-- the catalog edit. Same pattern as 0078's metadata_status default.

CREATE TYPE "wxyc_schema"."discogs_release_id_source_enum" AS ENUM('tubafrenzy_paste', 'lml_offline_backfill');--> statement-breakpoint
ALTER TABLE "wxyc_schema"."rotation" ADD COLUMN "discogs_release_id_source" "wxyc_schema"."discogs_release_id_source_enum" DEFAULT 'tubafrenzy_paste' NOT NULL;
```

`shared/database/src/schema.ts` additions:

```ts
export const discogsReleaseIdSourceEnum = wxyc_schema.enum('discogs_release_id_source_enum', [
  'tubafrenzy_paste',
  'lml_offline_backfill',
]);
```

In the `rotation` table definition, alongside `discogs_release_id`:

```ts
// Provenance for discogs_release_id. 'tubafrenzy_paste' is the default
// (set by rotation-etl's INSERT path and the column default), preserving
// the MD-verified-via-tubafrenzy invariant. 'lml_offline_backfill' is
// written by jobs/rotation-release-id-backfill (BS#1029) when LML
// resolves a release id and BS PG persists it.
discogs_release_id_source: discogsReleaseIdSourceEnum('discogs_release_id_source').notNull().default('tubafrenzy_paste'),
```

Journal entry: `{ idx: 85, when: 1779856000017, tag: "0085_rotation-discogs-release-id-source" }`. Per `docs/migrations.md` rule `hand-edit-when`, hand-edit the auto-stamped `when` to `previous_entry.when + 1`. Current tail (0084) is `1779856000016`, so 0085 must be `1779856000017`. Drizzle's runtime cursor uses `max(__drizzle_migrations.created_at)` as a high-watermark — any value `<= previous` is silently skipped in prod (#400 / #550 lineage).

Snapshot 85 emitted by `drizzle:generate`. Do not hand-edit the snapshot.

### 2. rotation-etl COALESCE guard (`jobs/rotation-etl/job.ts`)

Two changes to the `onConflictDoUpdate` block at line 109:

(a) `set.discogs_release_id` becomes COALESCE-preserving:

```ts
discogs_release_id: sql`COALESCE(excluded.${rotation.discogs_release_id}, ${rotation.discogs_release_id})`,
```

(b) `set.discogs_release_id_source` mirrors the COALESCE shape so the source value tracks who actually contributed the persisted id:

```ts
discogs_release_id_source: sql`
  CASE WHEN excluded.${rotation.discogs_release_id} IS NOT NULL
       THEN 'tubafrenzy_paste'::wxyc_schema.discogs_release_id_source_enum
       ELSE ${rotation.discogs_release_id_source}
  END
`,
```

(c) `setWhere` gets an updated predicate so the UPDATE doesn't fire when excluded contributes nothing:

```sql
-- existing OR-chain plus:
OR (excluded.discogs_release_id IS NOT NULL
    AND ${rotation.discogs_release_id} IS DISTINCT FROM excluded.discogs_release_id)
```

The old `${rotation.discogs_release_id} IS DISTINCT FROM excluded.discogs_release_id` term is REMOVED — it would still fire on the harmless `excluded=NULL, rotation=123` case and cause a no-op write that triggers CDC. The new gate is "excluded is non-NULL AND differs".

Comment block above the upsert documents the COALESCE invariant in plain English: _"tubafrenzy paste wins when it has a value; the offline backfill's writes are preserved otherwise. Existing pre-migration rows read the column's virtual DEFAULT (`'tubafrenzy_paste'`) per PG11+ `attmissingval` semantics, so they're already source-attributed without a rewrite; setWhere prevents redundant CDC writes when nothing actually changes. See BS#1029."_

INSERT path on line 96 stays as-is — new rows from tubafrenzy get `discogs_release_id_source = 'tubafrenzy_paste'` from the column default; no explicit field needed.

### 3. `jobs/rotation-release-id-backfill/` package

Mirrors the `flowsheet-metadata-backfill` shape; trimmed for the simpler 310-row UPDATE-only scope. Files:

```
jobs/rotation-release-id-backfill/
  job.ts                # entrypoint: init Sentry, fail-fast on LIBRARY_METADATA_URL, run orchestrator
  orchestrate.ts        # scan → for-each(lookup, write) → totals; DRY_RUN gate
  writer.ts             # idempotent UPDATE with race guard
  lml-fetch.ts          # mirrors flowsheet-metadata-backfill/lml-fetch.ts shape
  lml-limiter.ts        # re-exports + defaultLmlLimiter wired with BACKFILL_LML_*
  logger.ts             # mirrors flowsheet-metadata-backfill/logger.ts verbatim
  package.json          # workspace member, "job-type": "one-shot"
  tsconfig.json         # mirrors library-artwork-url-backfill
  tsup.config.ts        # mirrors library-artwork-url-backfill
  README.md             # invocation, env vars, DRY_RUN, verification SQL
```

**Algorithm (orchestrate.ts):**

```
SELECT id, artist_name, album_title
FROM wxyc_schema.rotation
WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
  AND discogs_release_id IS NULL
ORDER BY id ASC
```

The `discogs_release_id IS NULL` predicate is the idempotency gate. Rerunning the job after a partial run, or after a tubafrenzy paste lands mid-run, is safe and skips already-populated rows.

For each row:

1. `lookupMetadata(artist_name, album_title, undefined)` via `@wxyc/lml-client`, threaded through `defaultLmlLimiter`. `releaseId = response.results?.[0]?.artwork?.release_id ?? null` (same extraction the runtime tier-3 path uses at `library.service.ts:492`).
2. `writeReleaseId(id, releaseId)` (writer.ts):
   - If `releaseId === null`: increment `rows_unresolved`, no DB write.
   - If `releaseId !== null` and not DRY_RUN: `UPDATE rotation SET discogs_release_id = $releaseId, discogs_release_id_source = 'lml_offline_backfill' WHERE id = $id AND discogs_release_id IS NULL`. Inspect `result.count`: 1 → `rows_resolved`; 0 → `rows_raced` (a tubafrenzy paste landed between SELECT and UPDATE).
   - If DRY_RUN: log the planned UPDATE as `{ planned: true, rotation_id, release_id }`; increment `rows_resolved_dry`.
3. On LML throw: log `lml_error`, capture to Sentry with `rotation_id`, `artist`, `album` extras, increment `rows_lml_error`. Continue. Row stays `discogs_release_id IS NULL` and is retryable on next run.

**Counters (Sentry-traced, emitted as `step: 'finished'` log line):**

- `rows_scanned`
- `rows_resolved`
- `rows_resolved_dry` (DRY_RUN only)
- `rows_unresolved`
- `rows_lml_error`
- `rows_raced`
- `rows_sentinel_rejected` (added BS#1429 — LML returned a `<= 0` release id, pre-empted before write)

`rows_scanned == rows_resolved + rows_resolved_dry + rows_unresolved + rows_lml_error + rows_raced + rows_sentinel_rejected` is a runtime invariant we assert at end-of-run.

**Pacing (env-controlled, all reused from flowsheet-metadata-backfill):**

- `BACKFILL_LML_MAX_CONCURRENT=1` (default)
- `BACKFILL_LML_RATE_PER_MIN=20` (default)
- `BACKFILL_LML_PER_CALL_TIMEOUT_MS=8000` (default)
- 310 rows × 3 s = ~15.5 min total wall time

**Cooperative pause:** NOT included. The flowsheet-metadata-backfill cron uses `LIVE_ACTIVITY_LOOKBACK_SECONDS` because it touches `flowsheet` directly (CDC chain, search*doc tsvector regen, 6 indexes per row). This job UPDATEs `rotation` — a small table with 1 index — and writes only when `discogs_release_id IS NULL`, which races no real-time writer (rotation-etl is the only writer and is a 30-min cron, not real-time). The single LML chokepoint is already protected by `BACKFILL_LML*\*`. Adding a cooperative pause would be premature complexity.

**No partitioning, no batch cursor.** 310 rows. Single SELECT, single linear loop. Simpler is correct here.

**DRY_RUN env var:** `DRY_RUN=true` skips all UPDATEs, logs each planned write as `{ planned: true }`. For the verification path in tests and for a pre-prod safety check before invoking.

### 4. Dockerfile + workflow wiring

`Dockerfile.rotation-release-id-backfill`: copy of `Dockerfile.flowsheet-metadata-backfill` with paths swapped. Includes `ARG NPM_TOKEN` + `COPY ./.npmrc ./` in both stages + `rm -f .npmrc` after install (per the BS#1015 lesson). Env defaults:

```
ENV DB_STATEMENT_TIMEOUT_MS=60000      # rotation UPDATE is tiny; 60s is plenty
ENV DB_APPLICATION_NAME=wxyc-rotation-release-id-backfill
```

No `DB_SYNCHRONOUS_COMMIT=off` — sync_commit doesn't matter for ~310 single-row UPDATEs in a one-shot job.

Workflow wiring is automatic. `deploy-base.yml`'s `validate_inputs` step accepts any `jobs/<name>/` directory; `setup`'s Turbo affected-target detection picks up the new workspace; `deploy_vars` reads `"job-type": "one-shot"` from `package.json` and routes through the `one-shot-job` branch (image pushed to ECR; no crontab install). No file edits needed in `.github/workflows/`.

### 5. Tests

**Unit (`tests/unit/jobs/rotation-release-id-backfill/`):**

- `orchestrate.test.ts`
  - happy path: single resolvable row → `rows_resolved=1`, write made with `lml_offline_backfill` source
  - LML returns null (`response.results = []`) → `rows_unresolved=1`, no write
  - LML throws → `rows_lml_error=1`, captureError called with `rotation_id`/`artist`/`album`, no write
  - rerun idempotency: a row with non-NULL `discogs_release_id` is skipped (SELECT predicate excludes it)
  - race: writer's WHERE guard returns 0 rows updated → `rows_raced=1`
  - DRY_RUN: no UPDATEs executed; `rows_resolved_dry=1`; planned log emitted
  - counter invariant: `scanned == resolved + resolved_dry + unresolved + lml_error + raced + sentinel_rejected`
- `writer.test.ts`
  - UPDATE shape pinned: `SET discogs_release_id=$1, discogs_release_id_source='lml_offline_backfill' WHERE id=$2 AND discogs_release_id IS NULL`
  - returns `{ written: true }` when result.count=1
  - returns `{ written: false, raced: true }` when result.count=0
- `lml-fetch.test.ts` — env-default 8000, env-override, invalid fallback, limiter threaded
- `lml-limiter.test.ts` — re-export shape (the underlying primitives are tested in `@wxyc/lml-client`)
- `logger.test.ts` — `step` tagged on captureError

**Unit (`tests/unit/jobs/rotation-etl/`):**

- New `job.test.ts` block: `onConflictDoUpdate — discogs_release_id_source` (a job.test.ts file doesn't exist today — the rotation-etl folder only has fetch-legacy.test.ts and transform.test.ts). Asserts:
  - when `excluded.discogs_release_id IS NULL`, the SET preserves both columns (rendered SQL contains COALESCE + CASE-defaulting-to-self)
  - when `excluded.discogs_release_id IS NOT NULL`, source flips to `'tubafrenzy_paste'`
  - setWhere doesn't include the standalone `discogs_release_id IS DISTINCT FROM` term (anti-assert; prevents regression to noisy fires)

**Integration (`tests/integration/rotation-release-id-backfill.spec.js`):**

Pure SQL spec (same pattern as `album-metadata-upsert.spec.js`, per the PR #1021 lesson — drizzle-orm + babel-jest don't compose):

- Setup: insert 3 rotation rows (one already-populated, one resolvable, one not-resolvable). Inject a mock LML via `LIBRARY_METADATA_URL` pointing at a vitest/MSW-style local HTTP fixture (or skip the LML path entirely — DRY_RUN exercises the rest).
- Spec: run with DRY_RUN; assert (a) zero `discogs_release_id` UPDATEs happened; (b) JSON output shape includes `rows_scanned=3`, `rows_resolved_dry=1`, `rows_unresolved=1`, and `rows_scanned == sum(other counters)`; the already-populated row is excluded by the SELECT predicate so it's not in `rows_scanned`.

The "DRY_RUN against fixture" approach satisfies the acceptance criterion while sidestepping the cross-network LML call in CI. A second `DRY_RUN=true` pass is not separately tested — the `discogs_release_id IS NULL` SELECT predicate is the idempotency gate, and the first pass already verifies no writes happen. The gate is a unit-level assertion (orchestrate.test.ts's idempotency case).

### 6. Doc updates

- `CLAUDE.md` monorepo layout table: add `@wxyc/rotation-release-id-backfill` row.
- `docs/env-vars.md`: add to the "Backfill jobs" section the BACKFILL*LML*\* triple (already documented for flowsheet-metadata-backfill — note it's shared); document `DRY_RUN`; document the post-run verification SQL.

## Post-deploy verification (for PR body)

```sql
SELECT
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)) AS active_rows,
  COUNT(*) FILTER (WHERE (kill_date IS NULL OR kill_date > CURRENT_DATE)
                   AND discogs_release_id IS NOT NULL) AS active_resolved,
  COUNT(*) FILTER (WHERE discogs_release_id_source = 'lml_offline_backfill') AS backfill_attribution
FROM wxyc_schema.rotation;
```

Expected `active_resolved / active_rows ≥ 0.8` (ticket criterion). Lower values indicate the LML cold-cache pathology that BS#338 / LML#338 owns separately — not a backfill defect.

## Risks and how they're handled

| Risk                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backfill saturates LML mid-run (the BS#994 incident shape)                            | `BACKFILL_LML_*` gates inherited from flowsheet-metadata-backfill; concurrency 1, rate 20/min, per-call timeout 8s. Default behavior on first invocation matches the post-#1001 safety story.                                                                                                                                                                                 |
| rotation-etl overwrites the backfill's writes on the next 30-min tick                 | COALESCE on the upsert (the dominant correctness fix). Ships in this PR, not separately, per ticket constraint.                                                                                                                                                                                                                                                               |
| LML returns wrong release_id for an obscure artist (cf. Pleasure / Joyous regression) | LML's verification layer (LML#390 + #398 + #402, merged today 2026-05-28) handles iTunes/streaming-URL verification; the Discogs release path through `/lookup` already has its own match quality gates and is unchanged for resolved rows. Wrong-album risk is real but materially smaller than the picker 502 we're closing.                                                |
| DRY_RUN is forgotten on prod invocation, leaving the column NULL                      | Acceptable; rerun without DRY_RUN. Idempotent. Log line says `dry_run=true` prominently.                                                                                                                                                                                                                                                                                      |
| `discogs_release_id_source` default applies to existing rows with NULL release_id     | Awkward but harmless. Rows with release_id=NULL have a non-NULL source value that's semantically meaningful only when paired with a non-NULL release_id. The CHECK constraint to enforce "source non-NULL iff release_id non-NULL" is deliberately omitted — it'd block backfill UPDATEs that flip source first or atomically without re-validating the existing 21,253 rows. |

## What this PR does NOT do

- Does not touch `apps/backend/services/library.service.ts`. The read path stays three-tier; BS#1030 reverts tier-3 after this PR ships AND the backfill has been invoked in prod.
- Does not invoke the backfill in CI/CD. Manual invocation only — `Manual Build & Deploy` builds the image; an operator runs `docker run --rm --env-file .env <image>` in a maintenance window. The first prod run is a Slack-coordinated event noted in the PR description.
- Does not extend `library_identity.discogs_release_id`. That's BS#801's substrate work; this PR uses `rotation.discogs_release_id` as the write target per the ticket's Option A recommendation.
- Does not file BS#1030. The revert PR comes after the first prod backfill run completes and the dashboards confirm the resolution rate.

## Sequencing checklist for the PR description

1. Migration applied (auto-deploy or manual).
2. Image built (`Manual Build & Deploy` target=`rotation-release-id-backfill`).
3. First run on prod with `DRY_RUN=true` — eyeball the planned writes.
4. Second run without `DRY_RUN` — capture the JSON counters.
5. Verification SQL — confirm `active_resolved >= 0.8 * active_rows`.
6. File BS#1030's PR (separate worktree, separate branch).

## Open questions to flag in the PR body

- Should the backfill also emit a CloudWatch metric for `rows_resolved`? The `flowsheet-metadata-backfill` runbook reads JSON log lines instead; the lower volume here (one run per quarter at most) makes a metric overkill. Default: log line only.
- Future re-runs: when LML's catalog improves, should there be a way to re-resolve already-populated `lml_offline_backfill` rows without `discogs_release_id IS NULL`? Captured as a follow-up note in the README, not in this PR. Today the operator can `UPDATE … SET discogs_release_id = NULL WHERE discogs_release_id_source = 'lml_offline_backfill'` to re-arm the backfill; the gate column makes that surgical.

## Acceptance criteria (mirrors ticket)

- [ ] Migration 0085 adds `discogs_release_id_source` enum + column (NOT NULL DEFAULT `'tubafrenzy_paste'`)
- [ ] `jobs/rotation-release-id-backfill/` package with BACKFILL*LML*\* defaults, paced single-threaded LML calls
- [ ] `jobs/rotation-etl/job.ts` onConflict uses COALESCE; source flips on tubafrenzy contribution; setWhere doesn't fire on noisy excluded-NULL case
- [ ] Job idempotent (rerun short-circuits via `discogs_release_id IS NULL` SELECT predicate)
- [ ] DRY_RUN env prints planned writes without executing
- [ ] Unit + integration tests covering happy/raced/error/idempotent/dry-run/counter-invariant
- [ ] Sentry-traced counters: scanned/resolved/resolved_dry/unresolved/lml_error/raced
- [ ] CLAUDE.md + docs/env-vars.md updated
- [ ] Job appears under `jobs/` and is automatically picked up by `Manual Build & Deploy` (no workflow YAML edit needed)
- [ ] PR description includes the verification SQL + the run sequencing checklist

## Related

Parent: BS#994. Blocks: BS#1030 (revert). Inherits the safety story from: BS#995 / PR #1001 / PR #1017.
