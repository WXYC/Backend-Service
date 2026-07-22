# rotation-release-id-pollution-check

Weekly recurring check (BS#1522) that re-runs the [#1517](https://github.com/WXYC/Backend-Service/issues/1517) rotation release-id pollution audit against prod and alerts on the _delta_ — a newly-appearing wrong-album row or a provenance anomaly — instead of leaving detection to a DJ noticing a wrong dropdown (~4 weeks for #1515). First Python job in the `jobs/` fleet; the deploy pipeline treats it as an opaque Docker target (see `Dockerfile.rotation-release-id-pollution-check` at the repo root).

Schedule: `0 7 * * 1` (Monday 07:00 UTC = 03:00 ET), from `package.json` `cron-schedule`, registered on the EC2 crontab by `deploy-base.yml` like every sibling cron.

## What it does

Two detections per run, both read-only (this job never writes; remediation is manual — see below):

1. **Mismatch scoring.** Fetches every active rotation row whose `discogs_release_id_source` is `lml_offline_backfill` or `discogs_direct_backfill` and scores the stored Discogs release's title against the row's reference title (rotation free-text, else the catalog row via `album_id -> library`), using `pollution_engine.py` — the literal #1517 auditor, imported, never copied, so manual and scheduled runs cannot disagree on scoring (`ALBUM_MATCH_FLOOR = 80`, `SUSPECT_FLOOR = 60`, `difflib.SequenceMatcher` similarity with NFKD normalization and parenthetical stripping).
2. **Provenance anomaly.** The 2026-05-29 bypass-LML rescue lineage is retired (#1521): no sanctioned writer emits `discogs_direct_backfill` anymore, so any rotation row (active **or** killed) carrying that stamp outside the frozen `PROVENANCE_BASELINE` in `job.py` means a writer has regressed. SQL-only, so it still reports when LML is down.

## Alerting

Sentry `capture_message` at `warning`, **fingerprinted per `rotation_id`**: `[job, "mismatch", <id>]` / `[job, "provenance", <id>]`. That fingerprint is the load-bearing design — a stable unremediated row regroups into its existing Sentry issue on later runs (no re-notification), a remediated row stops firing and auto-resolves, and only a genuinely new bad write opens a fresh issue. `suspect` (score 60–79) never alerts: the 2026-07-05 calibration found that band 100% false-positive (non-Latin romanization, edition/mixtape suffixes). If LML is degraded (`error > max(5, 25% of scanned)`), one run-level event fires (`[job, "run-degraded"]`) instead of silence or N per-row noise.

Alerts are message events, not span attributes, so the BS-cron `SENTRY_TRACES_SAMPLE_RATE=0` default (the BS#1402/#1428 trap) is irrelevant here.

**What an alert means / what to do:** a `mismatch` alert means a stored `discogs_release_id` likely points at the wrong album and tier 1 of `resolveRotationPickerSource` is serving it to DJs. Verify the row manually (the alert extras carry both titles and the score), then apply the #1517 remediation recipe — repoint when the correct release is unambiguous, else NULL `discogs_release_id` + reset the source to `tubafrenzy_paste`, always with `SELECT`-before-`UPDATE` and `WHERE id = ? AND discogs_release_id = ?` guards, and always clearing `lml_identity_id` when the effective release id changes (BS#1380). Committed reference implementations: `scripts/audit/bs_rotation_release_id_remediation.py` and `scripts/audit/bs_1528_md_remediation.py`. A `provenance` alert means new `discogs_direct_backfill` writes exist — find and stop the writer first (#1521 is the retirement decision), then remediate the rows.

Rows verified correct by a human despite a degenerate reference ("s/t", catalog codes, artist-as-title) should be flipped to `md_verified` provenance (enum value from migration 0109) rather than suppressed here — that source is deliberately outside this job's default scope, so the row drops out of the candidate set data-side. `KNOWN_ACCEPTED_ROTATION_IDS` in `job.py` exists only as the fallback when a flip hasn't landed yet.

## Counter shape

The `step: finished` JSON log line (four-tag contract: `repo`, `tool`, `step`, `run_id`) carries: `scanned`, `ok`, `suspect`, `mismatch`, `error`, `alerted`, `suppressed`, `provenance_anomalies`. Invariant: `scanned == ok + suspect + mismatch + error`; `alerted + suppressed == mismatch`. `provenance_anomalies` is independent of `scanned` (its query includes killed rows and skips LML).

## Provenance baseline

`PROVENANCE_BASELINE` is the frozen set of rotation ids stamped `discogs_direct_backfill` in prod — **active and killed** — snapshotted during the 2026-07-06 go-live session (203 ids, after the #1528 leave/repoint rows were flipped to `md_verified`). **Update rule: a superset is safe, a subset false-alerts.** Ids that leave the stamped set (remediation, `md_verified` flips) need no baseline edit — they simply stop matching the query. Only additions matter, and an addition should only ever happen as the acknowledgment step of an investigated `provenance` alert (the stamp has no sanctioned writer; never pre-authorize). To recompute for verification: `SELECT id FROM wxyc_schema.rotation WHERE discogs_release_id_source = 'discogs_direct_backfill' ORDER BY id` (read-only, **no kill filter** — the provenance query includes killed rows).

> **Lesson (2026-07-06):** the first baseline was derived from the #1517 auditor's CSV, which runs `include_killed=False`. The go-live DRY_RUN smoke then flagged 38 anomalies — 32 killed stragglers (stamped before the #1521 retirement, later aged out on `kill_date`) plus a few active rows the audit's active-filter excluded. A read-only classifier confirmed **0 post-retirement active adds** (no writer regression), so all 38 were a baseline-coverage gap, not a threat. Build the baseline from the source-only query above, never from the active-only audit CSV.

## Environment

Required (job aborts at init if missing): `DB_HOST`/`DB_PORT`/`DB_USERNAME`/`DB_PASSWORD`/`DB_NAME`, `LIBRARY_METADATA_URL`, `LML_API_KEY`, and `SENTRY_DSN` (waived under `DRY_RUN` — an alerting job that can't alert must fail loudly, not run silently). All are already in the EC2 `.env` for the sibling LML-calling crons; no additions needed.

Optional (in-code defaults): `DRY_RUN=true` (log would-fire alerts instead of sending), `BACKFILL_LML_RATE_PER_MIN` (20, BS#995), `BACKFILL_LML_RESOLVE_TIMEOUT_MS` (15000), `LIVE_ACTIVITY_LOOKBACK_SECONDS` (60; 0 disables the BS#735 cooperative pause), `LIVE_ACTIVITY_PAUSE_MS` (30000), `LIVE_ACTIVITY_MAX_PAUSE_MS` (1800000 = 30 min; 0 uncapped), `WXYC_SCHEMA_NAME` (`wxyc_schema`).

`LIVE_ACTIVITY_MAX_PAUSE_MS` is the cumulative wall-clock budget the cooperative pause may spend deferring to live DJs across one run. Once exhausted the run logs `live_activity_pause_budget_exhausted` and finishes without further pausing (the audit is read-only and LML-paced, so completing the weekly signal beats aborting). It is defense-in-depth behind the real fix for BS#1636: the psycopg connection runs with `autocommit=True` so the pause probe's `now()` advances between probes instead of freezing at `transaction_timestamp()` — without that, a single track logged after the run starts made the liveness SQL true forever and wedged Run 1 for 34h.

## Manual runs

On the EC2 host (image already present after any deploy):

```bash
docker run --rm --env-file .env -e DRY_RUN=true \
  $AWS_ECR_URI/rotation-release-id-pollution-check:latest
```

Drop `-e DRY_RUN=true` for a real alerting run. For the classic CSV/summary artifacts, run the engine directly instead (it takes `--csv`/`--summary`/`--sources`/`--limit`):

```bash
docker run --rm --env-file .env -v /tmp/audit-out:/out \
  $AWS_ECR_URI/rotation-release-id-pollution-check:latest \
  python3 pollution_engine.py --csv /out/pollution.csv --summary /out/pollution.md
```

## Local usage

`scripts/audit/bs_rotation_release_id_pollution.py` is a thin wrapper (anchored to its own `__file__`, so it works from any CWD) that imports this package's `pollution_engine` — use it for ad-hoc runs against a local clone exactly as documented in the #1517 saga. Self-tests need no DB/LML/Sentry:

```bash
python3 jobs/rotation-release-id-pollution-check/pollution_engine.py --self-test
python3 jobs/rotation-release-id-pollution-check/job.py --self-test
```

Both also run as a Docker build gate (image build fails on a scoring regression) and from `tests/unit/jobs/rotation-release-id-pollution-check.test.ts` (jest shell-out; hard-requires `python3`, which is present on `ubuntu-latest` runners and org dev machines — it fails loudly rather than skipping, because a silent skip would defeat the gate).

## Related

- #1517 — the one-shot audit + remediation this automates; #1520/#1524 the auditor PRs
- #1521 — rescue-lineage retirement; the provenance branch enforces it
- #1528 — the MD pass on the 11 degenerate-reference rows; produced `md_verified` (migration 0109)
- #1522 — this job's ticket (option rationale recorded there)
