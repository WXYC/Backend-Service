# digital-archive-bind

One-shot inventory + bind job (BS#2319, epic [WXYC/wxyc-dj-ios#135](https://github.com/WXYC/wxyc-dj-ios/issues/135) digital archive). Scans the AzuraCast auto-DJ media Space read-only, reads ID3 tags, groups files into candidate albums, matches them against `rotation`/`library`, and writes `digital_asset` (`needs_review`) + `digital_asset_file` rows for a human to review via a CSV round trip.

Dry-run by default. `--apply` writes. It never writes to the Space.

## Why

The auto-DJ Space holds ~23.5k audio objects in ~4,000–4,500 albums with no `library.id` anywhere — the object keys are inconsistent (`rotation/Heavy/01_take_a_number.mp3` beside `rotation/Heavy/roméo_poirier_-_off_the_record_-_03_langsam.mp3`), but the ID3 tags are reliable. The manifest tables from [WXYC/Backend-Service#2318](https://github.com/WXYC/Backend-Service/issues/2318) are empty until something inventories the store, and the playback endpoint ([WXYC/Backend-Service#2320](https://github.com/WXYC/Backend-Service/issues/2320)) serves only `status = 'bound'` rows — nothing is playable until this runs.

## Pipeline

1. **Inventory** (`store.ts`) — paginated `ListObjectsV2` over the whole bucket, read-only by construction (see "Read-only, enforced" below).
2. **Classify** (`classify.ts`) — skip `.albumart/`, `.covers/`, `.waveforms/`, `station IDs/`, `test/`, `shows/`, directory markers, and non-audio extensions; keep `library/freeform/`, `library/recently_rotated/`, and `rotation/{Heavy,Medium,Light,Singles}/`. `mp3`/`aac`/`flac`/`m4a`/`wav` are all in scope.
3. **Tags** (`tags.ts`) — AzuraCast's media API (`GET /api/station/main/files`) when `AZURACAST_API_KEY` is set, else a per-file 256KB ranged-GET ID3v2 parse (`id3.ts`, ID3v2.3/2.4, no third-party dependency).
4. **Group** (`group.ts`) — files sharing normalized `(album_artist ?? artist, album)` become one candidate album, split further by disc number (a multi-disc set is one candidate per disc, since `digital_asset`'s unique key includes `disc_number`).
5. **Match** (`match.ts`, `candidates.ts`) — rotation-derived prefixes (`recently_rotated/`, `rotation/{bin}/`) match against `rotation` first; `freeform/` matches against `library`. Two tiers, exact then a deterministic punctuation/diacritic-folded "fuzzy" tier (never a similarity score — see `normalize.ts`'s header for why). An exact-tier ambiguity is never given a second chance at the fuzzy tier.
6. **Write** (`write.ts`) — plan and execute the DB writes. See "Per-slot rule" below.
7. **Review** (`csv.ts`, `review.ts`) — `--export`/`--import` round-trip the review CSV.

## Per-slot rule

The upsert key is `(library_id, provenance, disc_number)`; `provenance` is always `'rotation_upload'` here. `digital_asset_store.name` is `'azuracast'`.

| existing slot  | what happens                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| none           | insert `needs_review`                                                                                                                                                                                     |
| `needs_review` | untouched — a re-run is a no-op                                                                                                                                                                           |
| `rejected`     | skipped, but **always reported** with its object keys + slot. `--rebind-keys <file>` re-opens it for exactly the object keys named in that file, regardless of the prior rejection.                       |
| `bound`        | **never written, under any flag.** The candidate's object keys are compared against the bound asset's `digital_asset_file` rows; a mismatch is reported as drift (a live-playout file replaced or moved). |

Both defaults are deliberately conservative: neither writes into a slot a human already decided, and a blocked or drifted candidate is never silently indistinguishable from "nothing found." See BS#2319's issue comments 1 and 2 for the full reasoning — they supersede parts of the original issue body and are the actual spec this job implements.

A fifth case the per-slot rule table doesn't cover: two _different_ candidate groups in the **same run** can resolve to the same empty slot — a `freeform/` copy and a `rotation/Heavy/` copy of the same album both present in the Space at once. The first one seen is queued for insert; the rest are reported as a same-run collision and left unwritten, since a plain multi-row `INSERT` would otherwise hit the unique index and abort the whole batch rather than just the duplicate.

## Watermark cost

Migration 0159 attaches `touch_library_watermark` to `digital_asset` `FOR EACH STATEMENT` on INSERT / `UPDATE OF status, library_id` / DELETE / TRUNCATE. Every advance forces every device to re-download the full gzipped NDJSON catalog and rebuild its FTS5 index, so the write phase costs **at most one INSERT statement and one UPDATE statement per `--apply` run**, never one per album:

- All new-slot inserts land in one multi-row `INSERT`.
- All `--rebind-keys` reopens land in one multi-row `UPDATE`.
- `digital_asset_file` carries no trigger, so its writes are free to batch however is convenient.

A plain `--apply` run (no `--rebind-keys` matches) costs exactly one advance. A run that also reopens rejected slots costs at most two. The whole inventory/tag-read/match pass runs with no open transaction — the DB write is the last, short step, once everything is already in memory.

## Read-only, enforced

`store.ts` imports exactly `S3Client`, `ListObjectsV2Command`, and `GetObjectCommand` from `@aws-sdk/client-s3` — no `Put*`/`Delete*`/`Copy*`/`*MultipartUpload*` command anywhere in this job. `tests/unit/jobs/digital-archive-bind/store.test.ts` greps the module's own source for those names, so a future edit that adds a write command fails a test rather than failing silently.

## Running

```bash
# Size the run. Zero writes.
docker run --rm --env-file .env <image>

# Write it.
docker run --rm --env-file .env <image> --apply

# Recover an orphan the merge.ts collision-DELETE left behind (see the
# per-slot rule above) -- rebind.txt is one object key per line, `#` comments allowed.
docker run --rm --env-file .env -v "$PWD/rebind.txt:/rebind.txt" <image> --apply --rebind-keys /rebind.txt

# Export the needs_review cohort for review.
docker run --rm --env-file .env -v "$PWD:/out" <image> --export /out/review.csv

# Hand review.csv to a reviewer. They fill the `decision` column with
# `bound` or `rejected` (and optionally `note`), leaving undecided rows blank.

# Write the reviewer's decisions back. Only needs_review rows can transition.
docker run --rm --env-file .env -v "$PWD:/out" <image> --import /out/review.csv
```

`--export`/`--import` make no S3 calls and run no inventory scan — they read/write `digital_asset` directly.

## Environment

| var                                                 | default                               | meaning                                                                                 |
| --------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `DIGITAL_ARCHIVE_STORE_AZURACAST_ACCESS_KEY_ID`     | —                                     | required; DigitalOcean Spaces read-only key                                             |
| `DIGITAL_ARCHIVE_STORE_AZURACAST_SECRET_ACCESS_KEY` | —                                     | required                                                                                |
| `DIGITAL_ARCHIVE_STORE_AZURACAST_ENDPOINT`          | `https://nyc3.digitaloceanspaces.com` | S3-compatible endpoint                                                                  |
| `DIGITAL_ARCHIVE_STORE_AZURACAST_REGION`            | `nyc3`                                |                                                                                         |
| `DIGITAL_ARCHIVE_STORE_AZURACAST_BUCKET`            | `wxyc`                                |                                                                                         |
| `AZURACAST_API_KEY`                                 | unset                                 | when set, tags come from AzuraCast's media API instead of the ID3v2 ranged-GET fallback |
| `AZURACAST_BASE_URL`                                | `https://remote.wxyc.org`             | AzuraCast host (behind Cloudflare Access)                                               |

The `DIGITAL_ARCHIVE_STORE_AZURACAST_*` naming matches `digital_asset_store.name = 'azuracast'` and the env var convention WXYC/Backend-Service#2320's allowlist uses (`DIGITAL_ARCHIVE_STORE_<UPPERCASE_NAME>_*`).

**The AzuraCast API response shape in `tags.ts` is best-effort** from the issue body's own description ("returns artist/title/album/length/path per file") and has not been verified against a live `remote.wxyc.org` response. A field AzuraCast doesn't actually send resolves to `null`, which `group.ts` already treats as "ungroupable" rather than misbinding — so an unverified mapping degrades to more files needing the ID3 fallback, not a wrong bind. Verify the field mapping against a real response before the first prod run with the key set.

## Tests

- `tests/unit/jobs/digital-archive-bind/classify.test.ts` — the skip-list / content-prefix classification.
- `tests/unit/jobs/digital-archive-bind/id3.test.ts` — the ID3v2 parser against hand-built fixture headers (full tag, no track number, `TPOS` disc, UTF-16, NUL padding, truncated buffer).
- `tests/unit/jobs/digital-archive-bind/normalize.test.ts`, `match.test.ts` — the grouping/matching keys and matcher precedence (exact beats fuzzy; an exact-tier ambiguity never falls through to fuzzy).
- `tests/unit/jobs/digital-archive-bind/group.test.ts` — album grouping, including the per-disc split.
- `tests/unit/jobs/digital-archive-bind/csv.test.ts` — the review CSV export/import round trip.
- `tests/unit/jobs/digital-archive-bind/plan-writes.test.ts` — the per-slot rule (pure planner, no DB).
- `tests/unit/jobs/digital-archive-bind/store.test.ts` — MD5-from-ETag, and the read-only import guard.
- `tests/unit/jobs/digital-archive-bind/report.test.ts` — the summary report never silently drops a blocked/drifted row.
- `tests/integration/digital-archive-bind-write.spec.js` — the real `write.ts`/`match.ts`/`candidates.ts` functions against a real Postgres: a fixture album matched against seeded `library`/`rotation` rows produces the expected `needs_review` row, a re-run is a no-op, and `applyReviewDecisions` flips exactly the rows it's given, only from `needs_review`.
