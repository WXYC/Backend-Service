# concerts-artist-lml-resolver

Daily cron (BS#1614): resolve clean, still-unresolved `concerts.headlining_artist_raw` names to Discogs artist ids via library-metadata-lookup's verify-before-mint bulk endpoint (`POST /api/v1/artists/resolve/bulk`, LML#759), and stamp the verdicts onto `concerts`.

## Why this job exists

The daily `jobs/concerts-artist-resolver/` (05:15 UTC) FKs `headlining_artist_id` through pure-SQL strict/alias matching against the WXYC library — which by construction can never resolve touring artists WXYC hasn't cataloged. Measured 2026-07-11, that residual was effectively the entire unresolved population (0 strict / 1 alias match among 395). This job is the second lane: LML resolves the bare name against Discogs (identity store → cache corroboration → single-page live search, minting only on exactly one exact-form candidate with no cache conflict) and BS records the id in `headlining_discogs_artist_id`. Either lane now satisfies the curated feed (`GET /concerts?curated=true`, migration 0116).

The LML#759 live drain (2026-07-13) pre-warmed `entity.identity` for the whole backlog, so the first production run resolves mostly via the cheap `identity_store` tier — no one-shot/backfill mode is needed; steady-state the job handles the nightly trickle of newly scraped touring artists.

## What one run does

1. **Load candidates** (`targets.ts`): upcoming (`starts_on >= CURRENT_DATE`), non-tombstoned rows with BOTH id columns NULL, where the attempt-at marker is NULL or older than the no-match TTL.
2. **Gate** (`isCleanHeadliner`, imported from `jobs/triangle-shows-etl/headliner.ts` — the same module as the extraction rules, per the BS#1614 co-location constraint): withhold billing strings the extractor leaves dirty. This is an API-budget gate, not a correctness gate — under verify-before-mint a dirty name that slips through wastes one Discogs call and lands `not_found`.
3. **Dedupe** verbatim raw names (LML additionally dedupes on identity-match form server-side) and **page serially** (`CONCERTS_ARTIST_RESOLVE_PAGE_SIZE`, default 10, cap 25) through `resolveArtistNamesBulk` with a job-owned limiter, honoring the cooperative pause before each page.
4. **Route verdicts** (`orchestrate.ts`), fanning each one to all still-unresolved rows sharing the raw name (NULL-guarded — the job only fills NULLs, never overwrites):
   - **resolved** → `headlining_discogs_artist_id` + `headlining_discogs_artist_id_source = 'lml_artist_resolve'` + `artist_resolve_attempted_at`. **FK loop-close:** when exactly one `artists` row carries that `discogs_artist_id` (LIMIT-2 singleton check — the column is NOT unique), the same UPDATE also sets `headlining_artist_id`.
   - **ambiguous / not_found** → marker stamp only (responded no-match; arms the TTL re-ask).
   - **escalation_unavailable / thrown client errors** → **nothing**. "Couldn't ask" is not "asked and missed" (LML#759); the marker stays NULL and the rows retry next run. A page that comes back entirely `escalation_unavailable` stops the run early — the breaker is open.

The `(raw_name → verdict → row targets)` structure is deliberately role-agnostic: BS#1618 Phase D registers `concert_performers` junction rows as a second `RoleTarget` in `targets.ts`, sharing resolution and dedupe with the headliner lane.

## Environment

See `docs/env-vars.md` ("Concerts artist LML resolve") for the full contract: `CONCERTS_ARTIST_RESOLVE_PAGE_SIZE` (10), `CONCERTS_ARTIST_RESOLVE_NO_MATCH_TTL_DAYS` (30), `CONCERTS_ARTIST_RESOLVE_MAX_CONCURRENT` (1), `CONCERTS_ARTIST_RESOLVE_RATE_PER_MIN` (20), plus the shared `LIVE_ACTIVITY_LOOKBACK_SECONDS` (60; `0` disables the pause probe). Requires `DB_*`, `LIBRARY_METADATA_URL`, `LML_API_KEY`; `SENTRY_DSN` optional (SDK no-ops without it).

## Running

Deploy pipeline: pushed to ECR as an opaque Docker target and cron-registered from `package.json` `cron-schedule` (`35 5 * * *` UTC — after the 05:05 triangle-shows pull and the 05:15 SQL resolver, so the cheap arms get first claim and this job only sees their residual).

Manual invocation on the host:

```bash
docker run --rm --env-file .env <image>            # real run
docker run --rm --env-file .env <image> --dry-run  # enumerate + gate + page plan, no LML calls, no writes
```

Idempotent: re-running selects only rows still needing work (double-NULL id gate + marker TTL). Safe to invoke any time; the cooperative pause defers while DJs are actively adding flowsheet tracks.

## Tests

- `tests/unit/jobs/concerts-artist-lml-resolver/orchestrate.test.ts` — verdict matrix, early stop, error isolation, gate/dedupe/paging, the multi-target seam.
- `tests/unit/jobs/concerts-artist-lml-resolver/targets.test.ts` — candidate predicate shape, FK-tie singleton pin, SET-clause contracts.
- `tests/integration/concerts-artist-lml-resolver-writer.spec.js` — the writer SQL against real Postgres (mirrored SQL; when `targets.ts` changes, it must follow), TTL window, curated widening + partial-index EXPLAIN pin.
