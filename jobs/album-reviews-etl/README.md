# album-reviews-etl

Nightly pull ETL (ADR 0011 / the album-reviews-sheet-sync plan): mirrors the "Album Review Responses" Google Form spreadsheet — ~1,650 DJ-written album reviews collected since March 2021, and still growing (the form is live) — into the `album_review_submissions` archive table (migration 0119). The first production run ingests the entire history; every night after is drift-repair. There is no separate one-shot import job.

This is the archive model, deliberately separate from the ADR 0006 in-app `reviews` model — see [`docs/adr/0011-album-review-submissions-separate-archive.md`](../../docs/adr/0011-album-review-submissions-separate-archive.md) before touching anything named "review".

## Schedule

`50 4 * * *` UTC (00:50 EDT / 23:50 EST) from `package.json` `cron-schedule`, registered by deploy-base — between the 04:45 freetext resolve and the 05:00 venue scraper; verified free against every job's slot. No cooperative pause: the job writes only `album_review_submissions` (never flowsheet-adjacent), ~1.6k rows, off-peak.

## Environment

See [`docs/env-vars.md`](../../docs/env-vars.md) for the full reference. Required: `ALBUM_REVIEWS_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON_B64` (base64 of the SA key JSON), plus the standard `DB_*` set. Optional: `ALBUM_REVIEWS_SHEET_RANGE` (default `Form Responses 1`), `DRY_RUN`, `SENTRY_DSN`. All resolvers fail fast at startup.

## Run / dry-run

```bash
# Build + run locally (against whatever DB_* points at):
npm run build --workspace=@wxyc/database --workspace=@wxyc/album-reviews-etl
npm start --workspace=@wxyc/album-reviews-etl

# Dry run: fetch + map + run guards, zero writes, one JSON report line:
DRY_RUN=true npm start --workspace=@wxyc/album-reviews-etl

# Production (image built by the deploy pipeline from Dockerfile.album-reviews-etl):
docker run --rm --env-file .env -e DRY_RUN=true <ecr>/wxyc_album_reviews_etl:<tag>
```

First-prod-run procedure: verify the crontab entry `# wxyc_album-reviews-etl` exists post-deploy, then trigger one manual `docker run` with `DRY_RUN=true` and eyeball the report before letting the schedule run live.

The DRY_RUN report is a **locked schema** — exactly these keys, one JSON line on stdout; treat as an interface:

```json
{
  "job": "album-reviews-etl",
  "dry_run": true,
  "fetched": 0,
  "valid": 0,
  "skipped_invalid": 0,
  "fallback_keys": 0,
  "would_write": 0
}
```

## GCP service-account setup (operator, once)

1. In a GCP project (create or reuse), enable the **Google Sheets API**.
2. Create a service account (no roles needed — sheet access is granted by sharing, not IAM), then create a JSON key for it and download the file.
3. Share the "Album Review Responses" spreadsheet with the SA's `client_email`, **Viewer**.
4. `base64 -i key.json` → set as `GOOGLE_SERVICE_ACCOUNT_JSON_B64` in the EC2 `.env` (manually or via the set-ec2-env-var workflow allowlist), alongside `ALBUM_REVIEWS_SHEET_ID`. Cron jobs re-read `.env` on every scheduled `docker run`, so no restart target is needed.

## Header-mapping contract (`map.ts`)

Columns resolve from the header row by **case-insensitive distinctive prefixes** — never by position (the sheet has dead columns and Forms appends new ones). Tolerant of reorder and additions; a missing REQUIRED header fails the run.

| Column                                               | Match rule                                                                                                               | Required |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- |
| `Timestamp`                                          | prefix                                                                                                                   | yes      |
| `Artist Name`                                        | prefix                                                                                                                   | yes      |
| `Album Name`                                         | prefix                                                                                                                   | yes      |
| `Please write your review here`                      | prefix                                                                                                                   | yes      |
| `Record Label`                                       | prefix                                                                                                                   | no       |
| `Please write a short 1-2 sentences…` (artist blurb) | prefix                                                                                                                   | no       |
| `Please identify at least 2…` (recommended tracks)   | prefix                                                                                                                   | no       |
| `Name of reviewer…`                                  | prefix                                                                                                                   | no       |
| `List any FCC violations…`                           | prefix                                                                                                                   | no       |
| `Buzzwords`                                          | **exact** — the prefix rule would collide with the dead long-form "Buzzwords about the album (examples include…)" column | no       |
| `Are you comfortable…` (social consent)              | prefix                                                                                                                   | no       |
| `Was this album released…` (last 6 months)           | prefix                                                                                                                   | no       |
| `What is this review for?`                           | prefix                                                                                                                   | no       |
| `rotated? (y/n)`                                     | prefix                                                                                                                   | no       |

Row validity: artist + album non-empty (drops the sheet's formula-residue junk row). Timestamps (`M/D/YYYY H:MM:SS`, sheet locale) parse as wall-clock America/New_York with DST-correct offsets via `nyWallClockToUtc`. Closed-vocabulary fields normalize to nullable booleans (`rotated`: y/Y→true, n-prefix→false; consent: y/ok-prefix→true, 'no'→false; released: Yes/No) with the raw strings kept verbatim; anything unrecognized stores null and warn-logs.

## Keying (load-bearing)

`source_key = 'form:' + <ISO-8601 UTC of the parsed timestamp>` — unique across all current rows, and the UPSERT conflict target (partial-unique index `WHERE source_key IS NOT NULL`). A data row with no parseable timestamp (exactly 1 today) keys as `nots:<norm_artist>:<norm_album>:<sha256[0:8](reviewer_raw)>`, warn-logged: the reviewer-hash suffix makes two distinct timestamp-less reviews of the same album collision-proof, and it deliberately EXCLUDES the review body so curation edits propagate as updates. An edited reviewer string on such a row mints a new row — acceptable, warn-logged.

## Invariants (do not weaken)

- **Never delete.** A row vanishing from the sheet leaves the DB row untouched (org data-safety rule). The job has no delete path at all.
- **Never overwrite `album_id`.** The link pass is the column's only writer, links only on EXACTLY ONE library match (0092 SQL twin over `artist_name` + `album_artist`, TS-side `normalizeAlbumTitle` on the album leg), and its UPDATE is guarded `WHERE album_id IS NULL` — manual corrections always win. `album_id` and `add_date` are omitted from the writer's ON CONFLICT set, so a sheet edit can never clobber either.
- **Honest `last_modified`.** The writer's `setWhere` (IS DISTINCT FROM over every content column) suppresses no-op UPDATEs; an unchanged sheet reports `inserted=0, updated=0` and touches no `last_modified`.
- **PII stays internal.** `reviewer_raw` and `social_consent_raw` hold names / name-adjacent asides the form promised not to share; no read endpoint emits them.

## Run guards + observability

Zero valid rows, a >50%-invalid sheet, or valid-rows-but-zero-written all throw (non-zero exit) so cron monitoring can't stay green through a wholesale regression. Per-row upsert errors are caught, counted in the `finished` log, and Sentry-deduped per (step, digit-normalized message class). Counters: `{fetched, valid, skipped_invalid, fallback_keys, inserted, updated, unchanged, linked, link_ambiguous, link_unmatched}`. Logger is the per-job copy (`logger.ts`, incl. `captureWarning`); traces default off per the cron convention.
