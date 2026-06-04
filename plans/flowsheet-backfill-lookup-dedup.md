# flowsheet-metadata-backfill — run-scoped (artist, album) lookup dedup

**Tracker:** Spinoff from [BS#1011](https://github.com/WXYC/Backend-Service/issues/1011) (Slot 6 of [BS#1279](https://github.com/WXYC/Backend-Service/issues/1279) / [Project #32](https://github.com/orgs/WXYC/projects/32)). Filed as a peer issue to BS#1011 — the BS#1011 acceptance shape ("drain to completion, then retire") still holds; this work just reduces the wall clock to get there.

## Why

A read of prod RDS on 2026-06-03 shows the BS#1011 body materially understates the remaining drain. The body claimed `~10k–15k rows`; actual `metadata_attempt_at IS NULL` pending is **631,354** — ~50× more than the ticket assumed. Of those, 628,561 (~99.6%) are unlinked (`album_id IS NULL`), confirming that `album-level-backfill` (BS#1041) has effectively drained the linked tail and what remains is the free-form residual.

At the current pacing (BACKFILL_LML_RATE_PER_MIN=20 ceiling, ~14/min effective due to cooperative pause), the drain takes **~22-31 cumulative days of container runtime** to complete — roughly a calendar month at the current daily cadence. The drain is healthy under the BS#995 pacing gate (10.2s real-time LML p95 in the last 3h, 0.07% lml_error rate) but slow.

A `COUNT(*), COUNT(DISTINCT (artist_name, album_title))` over the same pending unlinked set:

| Metric                                                | Value      |
| ----------------------------------------------------- | ---------- |
| Pending unlinked rows                                 | 628,561    |
| Distinct `(artist_name, album_title)` pairs           | 362,258    |
| **Dedup multiplier**                                  | **~1.74×** |
| Rows with NULL `album_title` (dedup-on-artist subset) | 61,679     |

A run-scoped dedup cache on `(artist, album)` cuts the LML call budget from 628k to 362k — **~42% reduction** — without changing pacing, without new schema, without cross-repo work, and without changing the BS#1011 acceptance criteria. Wall clock drops from ~31 days to ~18 days at the current 14/min effective rate.

## Design — Path B (run-scoped unbounded Map)

A module-level `LookupCache` class wraps the cron's `lookupMetadata` shim. Before calling LML, consult the cache; on miss, call LML and store the response; on hit, return the cached response. Cache lives for the cron container's lifetime and dies with the daily `docker rm -f`. No LRU, no eviction policy, no size cap — the daily-bounded container lifetime is the eviction strategy.

Selected over Path A (per-batch grouping) because id-ordered batches have low intra-batch repetition (~1.05-1.2× multiplier); the full 1.74× multiplier requires cross-batch state. Selected over Path C (run-scoped LRU) because the cron's daily restart is a sufficient memory bound — the LRU complexity buys nothing for a job we're retiring under Epic C anyway.

### Cache key

```
normalize(artist) + '\0' + normalize(album ?? '')
```

Where `normalize(s) = s.trim().normalize('NFKC').toLowerCase()`. The NUL separator ensures `('A', 'BC')` and `('AB', 'C')` don't collide.

The album-undefined case uses `''` as the album segment so all rows with NULL `album_title` for the same artist dedup against each other (matches LML's lookup semantics — undefined album falls back to artist-only search).

### What gets cached: the full LookupResponse; per-track URLs deleted on read; cascade-timeout responses NOT cached

The cache stores the full `LookupResponse` object (~5KB JSON). The per-track URL stripping is the **cache's** concern, not the orchestrator's or `enrich.ts`'s:

- `LookupCache.set(artist, album, response)` stores the raw, unmodified response. Misses are counted _here_ (not on `get()`'s not-found branch) — so an LML throw before `set()` does not inflate `cache_misses`. `overwrites` tracks the race-to-store case; under today's sequential orchestrator any non-zero value signals a concurrency regression.
- `LookupCache.get(artist, album)` returns the cached response with **five** per-track URL fields _deleted_ (not assigned `undefined`) on the artwork block: `spotify_url`, `youtube_music_url`, `bandcamp_url`, `soundcloud_url`, and `apple_music_url`. The original cached object is not mutated; the cache returns a shallow-copy of the response, the results array, the result item, and the artwork block per call (including for the empty-results and no-artwork branches). `delete` matters for any consumer that uses `'field' in obj`, `Object.keys`, or `Object.assign` — the field is truly absent.

This means `enrich.ts`'s existing `??` fallback (`artwork.spotify_url ?? searchUrls.spotify_url`) does the right thing untouched for the four search URLs: on cache miss `lml-fetch.ts` returns LML's response as-is and the fallback's left side wins; on cache hit the per-track URL fields are absent so `??` drops through to `synthesizeSearchUrls(row)`.

`apple_music_url` is the exception. The naive `apple_music_url: artwork.apple_music_url ?? null` on a cache hit writes `null`, which the `album_metadata` UPSERT's `setWhere updated_at < NOW()` happily applies (the predicate always passes within a batch — R1's `updated_at` is microseconds in the past). That would clobber R1's verified Apple URL with R2's null on every duplicate, converting the cache from "skip an LML call" into "actively destroy album-level Apple metadata". `enrich.ts` uses a conditional spread on the `'apple_music_url' in artwork` witness instead — present means LML decided (string or null), so we record it; absent means the cache stripped it, so we OMIT the column from both the UPSERT and the inline flowsheet UPDATE so the prior value is preserved.

This matters because every URL in this set is track-aware on LML's side: the four search URLs are synthesized per `(artist, track)` (BS#1185), and `apple_music_url` is LML's per-track iTunes-verified URL via `find_track_url` returning `/song/<id>` URLs (BS#1192 — null is load-bearing because a wrong Apple URL claims a verified iTunes match for the wrong track). Caching them at the album level and applying to a different track would surface a mismatched search query, or — for Apple — a confidently-wrong track-direct link. Stripping at the cache boundary contains the dedup-path semantics in one file.

The album-level fields safely shared verbatim across rows with the same `(artist, album)`: `artwork_url`, `release_url`, `release_year`, `artist_bio`, `wikipedia_url`.

**Cascade-timeout guard.** LML returns a 200 OK with `{timeout: true, results: []}` when its server-side hard cap fires and the cascade is abandoned mid-execution (LML#370). The `timeout` field is on the typed `LookupResponse`; the shape is indistinguishable from a real no-match at the `results` level, so the discriminator is the dedicated `timeout` flag. The cache treats these as **transient signals about LML load, not answers**, and refuses to store them — `lml-fetch.ts:lookupMetadata` calls `activeCache.set` only when `response.timeout !== true`. Without this guard, the first cascade-timeout for an `(artist, album)` would lock in `enriched_no_match` for every subsequent row of the key for the rest of the run AND stamp them via `applyEnrichment`'s marker write, so the next cron tick also skips them — converting transient LML degradation into permanent metadata loss.

**Per-row throttle skip on hit.** `LookupFn` returns `{ response, cacheHit }`; the orchestrator skips `BACKFILL_THROTTLE_MS` between rows when `cacheHit === true`. The throttle exists to pace LML calls, and a cache hit makes none — sleeping after one is pure wall-clock waste. At the documented 42% hit rate this recovers ~7.3h per run on top of the LML-call savings.

**Caveat acknowledged:** caching on `(artist, album)` and applying to multiple tracks accepts a small risk that LML's track-presence verification would have returned a different release for a different track on the same album. For the backfill's use case (album-level metadata for historical flowsheet views), this is acceptable. Documented in code + plan.

### Memory bound (by construction, no enforcement)

Today's cron run processes ~14k rows in ~16h. Post-dedup at 1.74×, the cache fills to ~8k entries × ~5KB ≈ **~40MB peak**. Container has tens of GB of headroom. No bound enforcement in code; daily restart is the cleanup. A soft warning log at `cache.size > 50000` is added so a regression that would push the cache past 250MB surfaces in logs without changing behavior.

### Stats

`LookupCache.stats()` returns `{ size, hits, misses, overwrites }`. Wired into the existing `batch_done` log line as **four flat fields alongside the totals** — `cache_hits`, `cache_misses`, `cache_size`, `cache_overwrites` — matching the existing shape of `enriched_match`, `lml_error`, etc. Not a nested `cache: { ... }` object; the existing log consumers expect flat keys.

`cache_misses` and `cache_size` are cumulative since process start, matching the cumulative shape of `scanned` / `enriched_match`. `cache_overwrites` flags the race-to-store case (two concurrent callers both went to LML and both wrote); under today's sequential orchestrator any non-zero value signals a concurrency regression.

The `cacheStats()` callback is wrapped in try/catch by the orchestrator — an observability throw emits `cache_stats_error: <message>` on the log line instead of aborting the drain. A successful batch's per-row enrichments are already committed by the time `batch_done` logs; degrading observability is strictly better than dropping a batch from the deploy story.

Updated `batch_done` log payload shape:

```json
{
  "batch_index": N,
  "last_id": …,
  "scanned": …,
  "enriched_match": …,
  "enriched_match_raced": …,
  "enriched_no_match": …,
  "enriched_no_match_raced": …,
  "lml_error": …,
  "cache_hits": …,
  "cache_misses": …,
  "cache_size": …,
  "cache_overwrites": …
}
```

Post-deploy verification reads these from EC2 container logs (no Sentry needed).

## File touch list

| File                                                               | Status | LOC  | Notes                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs/flowsheet-metadata-backfill/lookup-cache.ts`                 | new    | ~80  | `LookupCache` class + `defaultLookupCache` singleton; `get()` strips streaming URLs from a shallow-copy of the artwork block before returning                                                         |
| `jobs/flowsheet-metadata-backfill/lml-fetch.ts`                    | edit   | ~15  | cache consult before `sharedLookupMetadata`, store on success; stripping is the cache's job, not the shim's                                                                                           |
| `jobs/flowsheet-metadata-backfill/orchestrate.ts`                  | edit   | ~10  | emit flat `cache_hits` / `cache_misses` / `cache_size` fields in the `batch_done` log line                                                                                                            |
| `tests/unit/jobs/flowsheet-metadata-backfill/lookup-cache.test.ts` | new    | ~140 | key normalization (including NFKC with real accented name), hit/miss accounting, NULL-vs-empty-vs-real-album disambiguation, streaming-URL stripping verification, original-cached-object-not-mutated |
| `tests/unit/jobs/flowsheet-metadata-backfill/lml-fetch.test.ts`    | edit   | ~50  | cache miss → LML call + store; cache hit → no LML call; LML error → no cache store; cache hit returns response with streaming URLs blanked                                                            |

**Total:** ~295 LOC including tests. One workspace, one job directory. `enrich.ts` is not touched — the existing `??` fallback already handles the cache-hit case correctly once the cache strips streaming URLs on `get()`.

## Tests

### Unit

- `lookup-cache.test.ts`:
  - Normalization (case + whitespace): `'The Beatles' vs 'the beatles' vs '  the beatles  '` hit the same slot.
  - NFKC (real accented name): `'Beyoncé'` typed as the composed form (U+00E9) and the decomposed form (`'Beyonce' + '́'`) hit the same slot. The test asserts the actual cached value is returned for both inputs, not just that the keys are equal — guards against an accidental `'NFC'` typo in `String.prototype.normalize()`.
  - NULL-vs-empty-vs-real album disambiguation (parameterized): `[('The Beatles', null), ('The Beatles', undefined), ('The Beatles', '')]` ALL hit slot A; `('The Beatles', 'Abbey Road')` hits slot B; `('The Beatles', 'Let It Be')` hits slot C. Three slots, not one — confirms the NUL separator prevents `('Beatles', '') === ('Beatle', 's')` style collisions.
  - Hit/miss counters: count correctly across N gets.
  - Size: grows monotonically as new keys are added; same key doesn't grow size.
  - Streaming-URL stripping on `get()`: store a response with `artwork.spotify_url='https://...'`, get returns response with `artwork.spotify_url === undefined`. Apply to all four streaming fields.
  - Original cached object not mutated: store response R, call get() which returns stripped copy S, assert `R.results[0].artwork.spotify_url` is unchanged after the get.

- `lml-fetch.test.ts`:
  - Cache miss path: shim calls injected `sharedLookupMetadata` exactly once, stores result, returns it.
  - Cache hit path: subsequent call with same (artist, album) does NOT invoke `sharedLookupMetadata`, returns cached.
  - Cache hit returns response with streaming URLs blanked (the stripping happens at cache.get level; this test is the integration assertion).
  - LML error path: error propagates; cache size unchanged.
  - Track-arg ignored: same (artist, album) with different track hits cache, returns same (stripped) response.
  - Module isolation: tests construct their own `LookupCache` instance; do not mutate `defaultLookupCache`.

### Integration (deferred, with rationale)

The existing `tests/integration/flowsheet-metadata-backfill.spec.js` (if present; otherwise the unit-test ladder is sufficient) covers the orchestrator + LML mock end-to-end. The dedup behavior is observable via the existing fixture — two flowsheet rows with the same (artist, album) generate exactly one LML mock call instead of two. Adding a new integration test is low-value because the unit tests already exercise the cache hit/miss/error/stripping matrix; if the integration suite has a flowsheet-metadata-backfill spec, extend it with one dedup assertion (lookups counter unchanged across batches of dedupable rows). If not, skip the new integration test.

## Rollout

1. Deploy via the normal auto-deploy pipeline on merge to `main` (`deploy-auto.yml`).
2. The currently-running cron container (`run_id=cd6b251d-…`, started 2026-06-03 06:00 UTC) is unaffected by deploy — it's a one-shot job running today's pass. It will exit when it runs out of rows or be killed by tomorrow's 06:00 UTC cron tick.
3. **Tomorrow's 06:00 UTC tick** (post-deploy) picks up the new image with caching enabled. Cache is on by default; no env-var flag.
4. Within the first hour of the next run, the `batch_done` log line emits `cache_hits` / `cache_misses` / `cache_size`. Verify dedup is working: `cache_hits / (cache_hits + cache_misses)` should be ≥30% after batch 2-3 (intra-batch repeats); steady-state should approach the global `1 - 1/1.74 = 43%` hit rate as the cache fills.
5. Confirm wall-clock improvement empirically over the next few days: the daily run's `scanned` total at exit should roughly **double** for the same wall-clock budget (because half the rows skip the LML call entirely).

No flag flip, no separate deploy gate, no LML-side change. Deploy lands → next cron tick uses the new image.

## Operational verification

**Primary signal (logs):** `cache_hits` / `cache_misses` / `cache_size` in the `batch_done` JSON log on EC2. Pull via `docker logs flowsheet-metadata-backfill-cron`.

**Secondary signal (Sentry):** spans for `lml.lookup` from the backfill (transaction matches `flowsheet-metadata-backfill`) should drop by ~42% in count compared to a same-batch-size baseline. Query: `span.description:*lookup* caller:flowsheet-metadata-backfill` over a 24h window — count post-deploy vs the 2026-06-03 baseline of ~13.5k spans/day.

**Tertiary signal (real-time LML p95):** should be **unchanged or slightly improved** because the cron is sending fewer requests to LML at the same pacing. If p95 degrades, that's not the cache — investigate independently.

## Risk register

- **Cache poisoning by an LML quirk.** A single LML response with bad data (e.g., wrong Discogs match for "Sonic Youth | Daydream Nation") gets applied to every row in the run sharing that key. Mitigation: same surface as the current per-row writes — LML's first-call accuracy is already the trust boundary. The existing `applyEnrichment`'s race detector (`.returning({ id })`) doesn't help here. **Accepted risk:** a bad LML result currently lands on one row; with caching, it lands on the average 1.74. The blast radius is bounded by the daily container restart.

- **Memory growth.** Unbounded Map fills over the run lifetime. Worst case at today's volume: ~40MB. Worst case if batch size or pacing changes: scales linearly with rows processed per run. Soft-warning log at `size > 50000` catches a regression where the cache would push past ~250MB. **Accepted risk** for the current daily-bounded shape; revisit if cron lifetime changes.

- **Track-level URL mismatch.** Per-track URL fields (`spotify_url`, `youtube_music_url`, `bandcamp_url`, `soundcloud_url`, `apple_music_url`) are deleted from the cache's returned response so enrich.ts's `??` fallback resynthesizes them per row. Album-level metadata (release_id, artwork_url, release_year, artist_bio, wikipedia_url) is shared. The chance of LML returning a different release for the same (artist, album) but different track is low given LML's matching heuristic. **Accepted risk** for album-level metadata; **mitigated** for per-track URLs by the cache-boundary strip.

- **Test isolation regression.** The `defaultLookupCache` singleton can leak state between tests if a test imports it directly. Mitigation pattern (convention, not lint-enforced): every test constructs its own `LookupCache` instance and wires it via `__setLookupCacheForTesting`, which itself throws when `NODE_ENV !== 'test'` so the seam can never accidentally swap a production singleton mid-run.

- **Sentry cache_stats convention.** The existing `cache.*` semantic spans pattern (LML#433 / [project_lml_cache_semantic_spans](https://github.com/WXYC/Backend-Service/blob/main/MEMORY.md)) lives in LML. This dedup cache is in BS, not LML. **Decision:** do NOT add `cache.get` / `cache.put` spans — the per-batch log line is sufficient observability for a job we're retiring. Defer Sentry-style instrumentation to Epic C #892 if cache patterns proliferate.

## Rollback

- **Code-level revert:** `git revert <merge-sha>` and re-deploy. Cache code is fully additive; reverting restores per-row LML calls. No data shape changes.
- **No env-var feature flag** (no `BACKFILL_LOOKUP_DEDUP_ENABLED`). The change is low-risk + scope-isolated; flags are speculative complexity. If we discover a need to disable in flight, the revert path is fast enough.

## Out of scope

- **Cross-run persistence.** A new `unlinked_metadata` table would persist verdicts across daily container restarts. Multiplier doesn't justify schema work for a job under retirement.
- **LRU eviction.** Path C. Defensive complexity for a use case we don't have.
- **LML bulk endpoint.** LML's `/api/v1/lookup/bulk` takes album_ids, not artist+album strings. Cross-repo change to add a string-keyed bulk endpoint is unbudgeted and out of scope.
- **Runtime backend changes.** PR #1326 / BS#885 shipped `LmlLookupCoordinator` for the runtime backend. Different semantics (5-min LRU + in-flight coalescing for request-time traffic). Parallel cache, not unified.
- **Apple Music URL synthesis.** BS#1192 — null is load-bearing. The cache deletes `apple_music_url` on hit (it's track-aware on LML's side, like the four search URLs). Instead of synthesizing, `enrich.ts` uses a conditional spread on `'apple_music_url' in artwork` and omits the column from the write when the cache stripped it; this preserves R1's verified URL on the album_metadata row rather than letting R2's null clobber it via the UPSERT's `updated_at < NOW()` setWhere (see "What gets cached" above). No synthesis is added.
- **Worker dedup.** `apps/enrichment-worker` (BS#892) is in flight and has its own design surface for caching. Don't pre-empt.

## Dependencies

None outside the workspace. `@wxyc/lml-client.LookupResponse` is the only cross-package type referenced.

## Links

- BS#1011 — parent operational ticket. This work reduces wall clock to that ticket's completion.
- BS#1279 — Project #32 close-out tracker, Slot 6.
- BS#995 — pacing PR #1001 (LmlLimiter). Compatible — dedup sits in front of the rate gate.
- BS#1041 — album-level backfill (linked rows). This work targets the unlinked tail BS#1041 leaves behind.
- BS#1185 — streaming URL synthesis equivalence. Justifies dropping LML's streaming URLs on the dedup path.
- BS#885 / PR #1326 — `LmlLookupCoordinator` (runtime backend). Conceptually parallel; this work applies the same shape to the backfill.
- Epic C BS#877 / BS#892 / BS#895 — the retirement story. This work doesn't change retirement criteria; just accelerates the timeline.
