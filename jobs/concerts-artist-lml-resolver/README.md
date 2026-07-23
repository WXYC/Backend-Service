# concerts-artist-lml-resolver

Daily cron (BS#1614 headliner; BS#1763 support): resolve clean, still-unresolved `concerts.headlining_artist_raw` AND `concert_performers` (role=`support`) names to Discogs artist ids via library-metadata-lookup's verify-before-mint bulk endpoint (`POST /api/v1/artists/resolve/bulk`, LML#759), and stamp the verdicts onto their respective tables.

## Why this job exists

The daily `jobs/concerts-artist-resolver/` (05:15 UTC) FKs `headlining_artist_id` / `concert_performers.artist_id` through pure-SQL strict/alias matching against the WXYC library — which by construction can never resolve touring artists WXYC hasn't cataloged, headliners or their support acts. This job is the second lane: LML resolves the bare name against Discogs (identity store → cache corroboration → single-page live search, minting only on exactly one exact-form candidate with no cache conflict) and BS records the id (`headlining_discogs_artist_id` or `concert_performers.discogs_artist_id`, depending on role). For headliners, either lane now satisfies the curated feed (`GET /concerts?curated=true`, migration 0116); for supports, either lane flips the denormalized `concerts.has_resolved_support` flag (see step 5 below) — the curated feed doesn't read that flag yet (deferred to a later On Tour slice).

The LML#759 live drain (2026-07-13) pre-warmed `entity.identity` for the headliner backlog, so the first production run resolved mostly via the cheap `identity_store` tier — no one-shot/backfill mode is needed; steady-state the job handles the nightly trickle of newly scraped touring artists across both roles.

## What one run does

1. **Load candidates** (`targets.ts`, one `RoleTarget` per role): upcoming (`starts_on >= (now() AT TIME ZONE 'America/New_York')::date` — the venue-local Eastern date the read path also windows on, not server-clock `CURRENT_DATE`), non-tombstoned rows with BOTH id columns NULL, where the attempt-at marker is NULL or older than the no-match TTL.
   - **Headliner** (`loadHeadlinerCandidates`): tribute-context rows (word-start `\mtribute`, case-insensitive, in EITHER `concerts.title` or `headlining_artist_raw`) are excluded outright, mirroring the SQL lane — a tribute billing names the honoree, not the performer, so any identity this lane could mint for it is a mislabel by construction (the Stanczyks "REM Tribute to Lifes Rich Pageant" incident).
   - **Support** (`loadSupportCandidates`): joined to its parent `concerts` row (for the tombstone + upcoming-window filters — the junction row doesn't inherit the parent's tombstone via cascade). The tribute guard is **RAW-NAME-ONLY** — deliberately does NOT also exclude on the concert's `title`, matching `jobs/concerts-artist-resolver/support-db.ts`'s Phase-B arm: a support billed at a tribute-titled show is a real opener, not a mislabeled honoree.
2. **Gate** (`isCleanHeadliner`, imported from `jobs/triangle-shows-etl/headliner.ts` — the same module as the extraction rules, per the BS#1614 co-location constraint, applied to both roles' candidate names): withhold billing strings the extractor leaves dirty. This is an API-budget gate, not a correctness gate — under verify-before-mint a dirty name that slips through wastes one Discogs call and lands `not_found`.
3. **Dedupe** verbatim raw names **across both roles** (LML additionally dedupes on identity-match form server-side) and **page serially** (`CONCERTS_ARTIST_RESOLVE_PAGE_SIZE`, default 10, cap 25) through `resolveArtistNamesBulk` with a job-owned limiter, honoring the cooperative pause before each page. A name billed as both a headliner and a support act (on different concerts) resolves in exactly ONE LML call and fans the same verdict to both targets' rows.
4. **Route verdicts** (`orchestrate.ts`), fanning each one to all still-unresolved rows sharing the raw name, per target, NULL-guarded (each target only fills NULLs, never overwrites):
   - **resolved** → id + provenance (`headlining_discogs_artist_id_source` / `discogs_artist_id_source`, both `'lml_artist_resolve'`) + `artist_resolve_attempted_at`. **FK loop-close:** when exactly one `artists` row carries that `discogs_artist_id` (LIMIT-2 singleton check — the column is NOT unique), the same UPDATE also sets the role's library FK (`headlining_artist_id` / `concert_performers.artist_id`).
   - **ambiguous / not_found** → marker stamp only (responded no-match; arms the TTL re-ask).
   - **escalation_unavailable / thrown client errors** → **nothing**. "Couldn't ask" is not "asked and missed" (LML#759); the marker stays NULL and the rows retry next run. A page that comes back entirely `escalation_unavailable` stops the run early — the breaker is open.
5. **Recompute `has_resolved_support`** (`runJob`, after `runResolve` finishes; skipped under `--dry-run`): calls the shared `recomputeHasResolvedSupport` (`@wxyc/database`, extracted from `jobs/concerts-artist-resolver/recompute.ts` by BS#1763) so a support this run resolved via the Discogs-only lane is curated the SAME cron cycle — otherwise the flag would lag until `concerts-artist-resolver`'s own 05:15 recompute the following day. Unconditional (like that job's own step 4): the windowed recompute is idempotent and cheap, so running it even when this cycle resolved no supports is a no-op, not a waste.

The `(raw_name → verdict → row targets)` structure is deliberately role-agnostic — `targets.ts` registers `headlinerTarget` and `supportTarget` side by side in job.ts's `targets` array, sharing resolution and dedupe.

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

- `tests/unit/jobs/concerts-artist-lml-resolver/orchestrate.test.ts` — verdict matrix, early stop, error isolation, gate/dedupe/paging, and the cross-role multi-target seam (a name billed in two roles resolves once and fans to both — pins BS#1763's acceptance criterion at the orchestrator level with generic fake targets).
- `tests/unit/jobs/concerts-artist-lml-resolver/targets.test.ts` — candidate predicate shape (both roles), the shared FK-tie singleton pin, and the SET-clause contracts of both targets' write arms.
- `tests/unit/database/concerts-recompute.test.ts` — SQL-contract + outcome-counting tests for the shared `recomputeHasResolvedSupport` this job calls after `runResolve` (real module, not the `@wxyc/database` mock — see that file's own header for why).
- `tests/integration/concerts-artist-lml-resolver-writer.spec.js` — the headliner target's writer SQL against real Postgres (mirrored SQL; when `targets.ts`'s `headlinerTarget` changes, it must follow), TTL window, curated widening + partial-index EXPLAIN pin.
- `tests/integration/concerts-artist-lml-resolver-support-writer.spec.js` — the support target's writer SQL against real Postgres (mirrored SQL; when `targets.ts`'s `supportTarget` changes, it must follow), the raw-name-only tribute guard (a tribute-titled concert does NOT exclude its support), TTL window, and the `has_resolved_support` same-cycle flip for both the Discogs-only and FK-loop-close resolution lanes.
