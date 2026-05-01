# `@wxyc/rotation-dedupe`

One-shot job: collapse duplicate active rotation rows for the same `(album_id, rotation_bin)` by killing all but the most recent. Companion to migration `0071_rotation_active_album_bin_uniq` (issue #694).

## Why

The `wxyc_schema.rotation` table contains exact-duplicate active rows for the same `album_id` in the same bucket. Tubafrenzy historically allowed multiple rotation entries for the same album over time (one per "rotation cycle") and those entries were preserved through the sync into Backend-Service without collapsing. The dj-site rotation dropdown renders every active row, so a single album with nine duplicate rows surfaces nine times in its bucket. Live evidence from 2026-05-01: Little Brother — _And Justus For All Mixtape_ (album_id 39330, rotation_bin H) had 9 active rows, all `add_date=2007-05-16`.

This job is the one-time cleanup. The unique partial index in migration 0071 prevents recurrence.

## What it does

For each `(album_id, rotation_bin)` group with multiple **active** rows (`kill_date IS NULL OR kill_date > CURRENT_DATE`):

1. Pick a keeper: the row with the most recent `add_date` (ties broken by lowest `id`).
2. Set `kill_date = CURRENT_DATE` on every other active row in the group.

The whole pass runs inside a single transaction so either all kills land or none do. Idempotent: re-running on a fully-deduped table is a no-op (zero groups match, zero rows are killed).

## How to run

Build via `Manual Build & Deploy` with `target=rotation-dedupe`, then SSH to EC2:

```bash
docker run --rm --env-file .env <image> 2>&1 | tee log
```

Run during a low-traffic window. Expected wall time: a few seconds — the active rotation set is small (a few hundred rows on prod).

After running, verify the diagnostic query from issue #694 returns zero rows:

```sql
SELECT album_id, rotation_bin, COUNT(*) AS dup_rows
FROM wxyc_schema.rotation
WHERE kill_date IS NULL OR kill_date > CURRENT_DATE
GROUP BY album_id, rotation_bin
HAVING COUNT(*) > 1;
```

## Environment variables

Standard database variables (per `Backend-Service/CLAUDE.md`):

- `DB_HOST`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD` (required)
- `DB_PORT` (default `5432`)
- `WXYC_SCHEMA_NAME` (default `wxyc_schema`)
- `DB_STATEMENT_TIMEOUT_MS` (Dockerfile sets `300000` / 5 min — single-pass UPDATE is short but the timeout matches sibling backfills)
- `DB_SYNCHRONOUS_COMMIT` (Dockerfile sets `off` — the WHERE filter is idempotent so async commit is safe)
- `DB_APPLICATION_NAME` (Dockerfile sets `wxyc-rotation-dedupe`)

Observability:

- `SENTRY_DSN` (optional) — when unset the SDK silently no-ops.
- `SENTRY_RELEASE` (optional) — set automatically by the deploy action.
- `SENTRY_TRACES_SAMPLE_RATE` (default `0`) — flip to `1.0` for one-shot pilots that need span / trace data.

## Output

JSON log lines on stdout (errors on stderr) per the Phase A observability contract. Every line carries the four tags `repo`, `tool`, `step`, `run_id`. Key steps:

- `started` — fields: `active_rows_before`.
- `finished` — fields: `groups_collapsed`, `rows_killed`, `active_rows_before`, `active_rows_after`, `elapsed`, `elapsed_ms`.
- `failed` — error path; the process exits 1.

## Related

- Issue [#694](https://github.com/WXYC/Backend-Service/issues/694) — duplicate active rotation rows.
- Migration `0071_rotation_active_album_bin_uniq` — unique partial index on `(album_id, rotation_bin) WHERE active`.
- Issue [#689](https://github.com/WXYC/Backend-Service/issues/689) — different read-side issue (NULL `album_id` rows dropped by INNER JOIN); not in scope here.
