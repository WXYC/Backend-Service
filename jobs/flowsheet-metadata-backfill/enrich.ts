/**
 * Per-row enrichment: turn an LML response into either a flowsheet inline
 * UPDATE (free-form / unlinked rows) or an `album_metadata` UPSERT plus a
 * status-flip flowsheet UPDATE (linked rows). Mirrors the D3 worker pattern
 * in `apps/enrichment-worker/enrich.ts` (BS#899) and closes the historical
 * inline-only drain (BS#1027).
 *
 * Result shape:
 *   - Linked (album_id != null) + match: UPSERT `album_metadata` with the
 *     10-column payload (race-guarded by `updated_at < NOW()`), then
 *     UPDATE `flowsheet` to flip `metadata_status = 'enriched_match'` (plus
 *     the historical `metadata_attempt_at = now()` stamp) only.
 *   - Linked + no-match: UPSERT just the 4 synthesized search URLs into
 *     `album_metadata` (fill-null on conflict — BS#895, never clobbers an
 *     existing real value), then flip `metadata_status = 'enriched_no_match'`
 *     on `flowsheet`.
 *   - Unlinked (album_id IS NULL) + match: write the 10 metadata columns
 *     inline on `flowsheet`, flipping the status in the same .set() block.
 *   - Unlinked + no-match: write the 4 synthesized search URLs inline on
 *     `flowsheet`, flip the status.
 *   - On LML throw: caller catches and DOES NOT call this. The row stays at
 *     whatever `metadata_status` it entered with (`'pending'` for the main
 *     sweep, `'enriched_no_match'` for the W4 self-heal re-attempt — see
 *     `fromStatus` below) so the next sweep retries it.
 *   - `degraded_reason: 'upstream_unavailable'` or a `shedReasonOf` match,
 *     WITHOUT a usable match (BS#1995 Arm 3, tightened after review — B2 +
 *     S6): no write at all. LML's Discogs breaker was open and it never
 *     got to ask — writing a terminal `enriched_no_match` here is the
 *     2026-08-03/04 incident. Returns `'upstream_unavailable_skipped'`;
 *     the row stays at whatever `metadata_status` it entered with, same as
 *     an LML throw. WITH a usable match (LML's tail legs can complete
 *     before the breaker trips), falls through to the normal match path
 *     below instead — discarding a real answer would be worse than doing
 *     nothing.
 *
 * Idempotency guard (BS#895 / Epic C C6): the flowsheet WHERE narrows by
 * `id = $row.id AND metadata_status = $fromStatus`. Before BS#895 this
 * guarded on `metadata_attempt_at IS NULL` — the pre-BS#891 implicit
 * marker — because the backfill operated on rows the consumer never
 * claimed and the marker was the only control-flow signal available. Once
 * the C6 retune made `metadata_status = 'pending'` the sweep's own
 * selection predicate (`worklist.ts`), the guard had to move to the same
 * column or every row this job enriched would stay `'pending'` forever and
 * get re-selected — and re-billed to LML — on every subsequent hourly run.
 * `fromStatus` defaults to `'pending'` (the main sweep) and is overridden to
 * `'enriched_no_match'` by the W4 rotation self-heal pass
 * (`orchestrate.ts`), which re-attempts rows already in that terminal
 * state. Mirrors the worker's status-based guard shape
 * (`apps/enrichment-worker/enrich.ts`, `metadata_status='enriching'`) more
 * closely now, though the two still diverge on which status they guard
 * FROM and which they leave a row at on failure.
 *
 * `metadata_attempt_at` is still stamped alongside the status flip on every
 * responded outcome (match or no-match) — it is no longer the control-flow
 * gate, but stays as the historical/audit marker several other jobs still
 * read (`jobs/album-metadata-backfill`'s `verifyComplete`,
 * `flowsheet_album_id_enriched_idx`). See `docs/migrations.md` "Attempt-at
 * markers".
 *
 * BS#1336 NOTE: the worker now writes 8 additional LML-only columns
 * (discogs_artist_id, label, full_release_date, genres, styles, tracklist,
 * artist_image_url, bio_tokens) on its linked+match UPSERT. This job stays at
 * the 10-column shape for now (extending it needs `extended: true` on the
 * lookup; tracked in BS#1442). SAFE because the `set` clause omits those 8
 * columns → a backfill UPSERT preserves any worker-written values, never
 * clobbers. DO NOT add them to `set` as nulls without sourcing them via
 * `extended: true`, or the backfill would clobber the worker's writes.
 *
 * Spacer.gif filter + Discogs bio cleanup: imported from `@wxyc/metadata`
 * (BS#1242 deep-module rollout). The shared module is build-graph-safe for
 * jobs; replaces the inline duplicates previously pinned by parity tests.
 */

import { and, eq, sql } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import { shedReasonOf, type DiscogsMatchResult, type GatedLookupResponse, type LookupResponse } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

/**
 * The two `metadata_status` values `applyEnrichment` / `stampDeadLetter` can
 * be called with a row already in. Typed as a narrow string union (not the
 * drizzle enum object) so the unit harness — which mocks `@wxyc/database`
 * without the real enum — can construct values without importing schema.ts.
 */
export type EnrichFromStatus = 'pending' | 'enriched_no_match';

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // BS#1027 / Epic D: non-null → UPSERT album_metadata + flowsheet marker
  // stamp only; null → write the 10 metadata columns inline on flowsheet
  // (free-form entries, until their linkage resolves). Sourced from the
  // orchestrator's SELECT (`loadBatch` in orchestrate.ts).
  album_id: number | null;
  // BS#1294 (1c): the linked album's `library.discogs_unavailable` flag,
  // pre-read by the orchestrator's batch loader (LEFT JOIN library) and
  // passed through to the lookupMetadata gate (BS#1293). Optional/undefined
  // for unlinked rows (album_id IS NULL — no library row to join) and in
  // hand-built test fixtures that predate this field; the lookup helper
  // treats both the same as `false`.
  discogs_unavailable?: boolean;
};

export type EnrichOutcome =
  | 'enriched_match'
  | 'enriched_match_raced'
  | 'enriched_no_match'
  | 'enriched_no_match_raced'
  | 'upstream_unavailable_skipped';

/**
 * Synthesize the four search URLs the runtime path falls back to on
 * no-match. Must match the write-path shape of
 * `apps/backend/services/metadata/metadata.service.ts#fetchMetadata`
 * exactly — the inline copy is duplicated rather than imported for the
 * same build-graph isolation reason as `lml-fetch.ts`. The parity test at
 * `tests/unit/jobs/flowsheet-metadata-backfill/synthesize-search-urls-parity.test.ts`
 * pins the equivalence so the two cannot drift (BS#889 / BS#1189).
 *
 * Apple Music is intentionally absent (BS#1192): LML's `apple_music_url`
 * is load-bearing — null means "no verified iTunes match" — and persisting
 * a `music.apple.com/search?term=…` URL on the write path launders that
 * signal into a clickable button that drops users on the in-app search
 * page. The read path (`proxy.controller.getAlbumMetadata`) still fills
 * Apple at request time for the iOS Tragic Magic surface, where there's
 * no persisted row to poison.
 *
 * Per-service semantics (deliberately asymmetric):
 *   - Spotify:       trackTitle > albumTitle > artistName. Path-style URL
 *                    (`https://open.spotify.com/search/<query>`) matches
 *                    LML's `_build_streaming_search_url` byte-for-byte so
 *                    iOS reads back the same URL whether LML surfaced it
 *                    or BS synthesized it (BS#1185 + LML#401).
 *   - YouTube Music: trackTitle > albumTitle > artistName (3-tier).
 *   - Bandcamp:      albumTitle > artistName (album-leaning).
 *   - SoundCloud:    trackTitle > artistName (track-leaning, NO album
 *                    fallback — album-only SoundCloud queries return
 *                    unrelated DJ mixes more often than the album).
 */
export const synthesizeSearchUrls = (
  row: EnrichRow
): { spotify_url: string; youtube_music_url: string; bandcamp_url: string; soundcloud_url: string } => {
  const artist = row.artist_name;
  const album = row.album_title ?? undefined;
  const track = row.track_title ?? undefined;

  const spotifyQuery = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
  const youtubeQuery = track ? `${artist} ${track}` : album ? `${artist} ${album}` : artist;
  const bandcampQuery = album ? `${artist} ${album}` : artist;
  const soundcloudQuery = track ? `${artist} ${track}` : artist;

  return {
    spotify_url: `https://open.spotify.com/search/${encodeURIComponent(spotifyQuery)}`,
    youtube_music_url: `https://music.youtube.com/search?q=${encodeURIComponent(youtubeQuery)}`,
    bandcamp_url: `https://bandcamp.com/search?q=${encodeURIComponent(bandcampQuery)}`,
    soundcloud_url: `https://soundcloud.com/search?q=${encodeURIComponent(soundcloudQuery)}`,
  };
};

/**
 * Pick the first present artwork from an LML response, or null on no-match.
 *
 * Walks `results` in order rather than reading only `results[0].artwork`
 * (BS#961). LML's `search_type: 'direct'` shape always carries the artwork
 * on `results[0]`, so the walk resolves on the first iteration there — but
 * `search_type: 'compilation'` responses can return several `library_item`
 * rows where an earlier entry's `artwork` is null and a later entry's is
 * populated (LML's `items_with_artwork` pairs each library item with its own
 * independently-resolved artwork, or `None`). Reading only index 0 silently
 * dropped that artwork; walking the array covers both shapes with one code
 * path, so no `search_type` branching is needed here.
 *
 * "No artwork" covers three LML response shapes that all mean the same
 * thing operationally: empty `results`, every result missing an `artwork`
 * field, or every result's `artwork` explicitly null. All three end up
 * writing search URLs and stamping the marker.
 */
export const extractArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
  for (const result of response.results ?? []) {
    if (result.artwork) return result.artwork;
  }
  return null;
};

/**
 * Apply a single LML response to a flowsheet row.
 *
 * Returns the outcome so the orchestrator can count it. Errors propagate
 * up — this function does not swallow.
 *
 * `opts.fromStatus` (default `'pending'`) is the `metadata_status` value the
 * row must currently hold — the idempotency/race-guard predicate, and the
 * state the W4 rotation self-heal pass (`orchestrate.ts`) overrides to
 * `'enriched_no_match'` when re-attempting an already-terminal row. See the
 * module docstring for why this replaced the old marker-IS-NULL guard.
 *
 * The `.returning({ id: ... })` call is the race detector: when the
 * orchestrator's SELECT and this UPDATE bracket a concurrent writer's claim
 * on the same row (the CDC worker flipping it off `fromStatus`), the
 * WHERE's `metadata_status = $fromStatus` no longer matches and Postgres
 * updates 0 rows. Returning an empty array tells the caller "someone else
 * beat us" — `*_raced` outcome — so metrics separate "I personally enriched
 * this row" from "this row was enriched by *someone* during the run." The
 * data outcome is identical either way (both writers produce the same
 * payload).
 */
export const applyEnrichment = async (
  row: EnrichRow,
  response: LookupResponse,
  opts: { fromStatus?: EnrichFromStatus } = {}
): Promise<EnrichOutcome> => {
  const fromStatus = opts.fromStatus ?? 'pending';
  const artwork = extractArtwork(response);

  // BS#1995 Arm 3 (narrow classification fix, tightened after review — B2 +
  // S6): LML's Discogs circuit breaker being open surfaces on this
  // response's TAIL legs (artwork / enrichment / identity —
  // `lookup/orchestrator.py:1251`/`:1282`) as `degraded: true,
  // degraded_reason: 'upstream_unavailable'`, and the shared client's
  // bounded-limiter shed shape (BS#1748, not reachable from this job's
  // unbounded limiter today, but tested defensively) as an `outcome`
  // discriminator via `shedReasonOf` — LML never got to ask Discogs at all.
  // Writing a terminal `enriched_no_match` here is exactly the
  // 2026-08-03/04 incident: a breaker-open response is indistinguishable
  // from a genuine no-match at the `results` level, so 17 hours of flapping
  // silently froze 26,387 rows.
  //
  // ONLY skip when there is no usable verdict: LML's degraded-response
  // builder still returns whatever the tail legs already produced BEFORE
  // the breaker tripped (`fetch_artwork` runs before
  // `enrich_metadata`/identity resolution, both of which can raise the
  // breaker-open error), so a shed/degraded response CAN carry a complete,
  // trustworthy match. Discarding a populated match here would silently
  // downgrade a real answer to a retry and add load to the exact Discogs
  // ceiling this PR protects — worse than doing nothing. When `artwork` IS
  // present, fall through to the normal match path below exactly as if the
  // response weren't degraded at all.
  //
  // When there's no usable verdict, skip the write entirely — no status
  // flip, no `metadata_attempt_at` stamp, no `album_metadata` UPSERT — so
  // the row stays at whatever `fromStatus` it entered this call with
  // (normally `'pending'`) and is retried on a later sweep, by which point
  // the orchestrator's breaker gate (`orchestrate.ts`'s
  // `waitForClosedBreaker`) should already be pausing the drain rather than
  // continuing to burn through the worklist.
  //
  // Deliberately narrower than the sibling shapes below, which all stay
  // terminal regardless of artwork.
  //
  // BS#1998 UPDATE: this guard's coverage widened without its code
  // changing. When BS#1995 shipped, LML's SEARCH leg (`core/search.py`)
  // swallowed the same breaker-open condition into a bare `Outcome.empty()`
  // with no marker, so the incident's dominant shape was indistinguishable
  // from a genuine no-match and stayed terminal here. LML#1126/#1128 closed
  // that: the search leg now records `state.upstream_shed`, which
  // `lookup/orchestrator.py` projects onto the same `degraded: true` /
  // `degraded_reason: 'upstream_unavailable'` fields the tail legs always
  // set — so the condition above already catches it. Nothing to widen.
  //
  // The corollary matters more: a bare empty carrying NO marker is now
  // unambiguously a genuine no-match, and terminalizing it is correct. Do
  // not "fix" the regression pin in `enrich.test.ts` that asserts this —
  // flipping it would stop the drain terminalizing anything at all.
  // `degraded_reason: 'deadline_exceeded'` / `response.timeout === true`
  // are both documented, deliberate terminal outcomes for this class-5
  // offline-drain caller (see `shared/lml-client/src/policy.ts`'s BS#1914
  // decision record and `lml-fetch.ts`'s BS#1064/BS#1180 timeout-budget
  // history) — do not widen this branch to catch them.
  // The cast is safe, not a type-hole: `@wxyc/lml-client`'s `lookupMetadata`
  // already resolves `GatedLookupResponse` (`LookupResponse` plus the
  // optional shed `outcome` discriminator) under the hood — `lml-fetch.ts`'s
  // local `LookupResult` just narrows the declared type to the base
  // `LookupResponse`. Mirrors the established pattern at
  // `apps/backend/services/lml/lookup-coordinator.ts` (`fetchUncached`'s
  // return type), which types its own result as `GatedLookupResponse`
  // specifically so `shedReasonOf` can read `.outcome` without a cast.
  const shedReason = shedReasonOf(response as GatedLookupResponse);
  const isUnansweredShed =
    (response.degraded_reason === 'upstream_unavailable' || shedReason !== undefined) && artwork === null;
  if (isUnansweredShed) {
    return 'upstream_unavailable_skipped';
  }

  const searchUrls = synthesizeSearchUrls(row);

  // Status-guarded flowsheet UPDATE used on the linked path. The status
  // flip (to the terminal `enriched_match`/`enriched_no_match` value) lives
  // alone in the .set() because the 10 metadata columns landed in
  // album_metadata a step earlier; the flowsheet write only records "we
  // attempted this row" and moves it off `fromStatus` so the next sweep
  // skips it.
  const guardWhere = and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, fromStatus));

  if (artwork) {
    const payload = {
      artwork_url: filterSpacerGif(artwork.artwork_url),
      discogs_url: artwork.release_url ?? null,
      // Discogs returns 0 as "year unknown"; coerce to null so the column
      // doesn't carry a sentinel that iOS renders as literal "0". Mirrors
      // the runtime path in `metadata.service.ts#extractAlbumMetadata` (#1002).
      release_year: artwork.release_year || null,
      // Streaming search URLs: prefer LML's, fall back to synthesized.
      // Apple Music has no fallback — null is load-bearing "no verified
      // iTunes match" signal (BS#1192).
      //
      // All five track-aware URL columns use a conditional spread on the
      // `'<field>' in artwork` witness to preserve R1's verified value on
      // cache hits (BS#1338). The run-scoped LookupCache deletes each of
      // the five keys from the artwork object on hit
      // (lookup-cache.ts:TRACK_AWARE_URL_FIELDS) because LML returns them
      // per-track and the row that populated the cache wasn't necessarily
      // the same track. Without the witness, the `??` fallback would
      // synthesize a search URL (or write null, for apple_music_url) on
      // R2, then the album_metadata UPSERT's `setWhere updated_at < NOW()`
      // guard would happily apply it — that predicate always passes
      // within a single batch (R1's updated_at is microseconds in the
      // past), so R2's per-row write clobbers R1's verified deep-link
      // (apple_music_url: BS#1192 destructive null; the four search URLs:
      // BS#1338 verified→synthesized degradation). The conditional spread
      // OMITS the column from both the album_metadata UPSERT
      // (INSERT + onConflictDoUpdate.set) and the inline unlinked UPDATE
      // on cache-stripped hits, so the prior value survives untouched.
      // Present-in-artwork still records LML's decision (string for the
      // four search URLs; string or null for apple_music_url) on misses.
      // Mirrors the strip-deletes-keys contract documented at
      // lookup-cache.ts:62-73.
      ...('spotify_url' in artwork ? { spotify_url: artwork.spotify_url ?? searchUrls.spotify_url } : {}),
      ...('apple_music_url' in artwork ? { apple_music_url: artwork.apple_music_url ?? null } : {}),
      ...('youtube_music_url' in artwork
        ? { youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url }
        : {}),
      ...('bandcamp_url' in artwork ? { bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url } : {}),
      ...('soundcloud_url' in artwork ? { soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url } : {}),
      artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
      artist_wikipedia_url: artwork.wikipedia_url ?? null,
    };

    if (row.album_id !== null) {
      // Linked + match: 10-col payload lands in album_metadata; flowsheet
      // UPDATE only flips the status (+ the historical marker stamp). The
      // album_metadata UPSERT is idempotent (same album_id → same row) and
      // guarded by `updated_at < NOW()` so a delayed backfill cycle can't
      // overwrite a fresher runtime or worker enrichment of the same
      // album_id.
      await db
        .insert(album_metadata)
        .values({ album_id: row.album_id, ...payload, updated_at: sql`NOW()` })
        .onConflictDoUpdate({
          target: album_metadata.album_id,
          set: { ...payload, updated_at: sql`NOW()` },
          setWhere: sql`${album_metadata.updated_at} < NOW()`,
        });
      const updated = await db
        .update(flowsheet)
        .set({ metadata_attempt_at: sql`now()`, metadata_status: 'enriched_match' })
        .where(guardWhere)
        .returning({ id: flowsheet.id });
      return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
    }

    // Unlinked + match: write the 10 columns inline on flowsheet — as
    // before BS#1027. These rows can't enrich into album_metadata until
    // linkage resolves; D4's column-drop is gated on no unlinked
    // enrichments remaining.
    const updated = await db
      .update(flowsheet)
      .set({
        ...payload,
        // Status flip + marker stamp live inside the same .set() so a
        // partial UPDATE can't leave a row "attempted" without writing the
        // data we just fetched (#639 codified this single-block contract).
        metadata_attempt_at: sql`now()`,
        metadata_status: 'enriched_match',
      })
      .where(sql`"id" = ${row.id} AND "metadata_status" = ${fromStatus}`)
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
  }

  // No-match: synthesize search URLs and stamp. The other 7 metadata
  // columns are NOT touched on either branch. The backfill encounters rows
  // that may already have prior values from out-of-band paths (e.g. the
  // 2026-04-28 inline recovery, `scripts/backfill-metadata.ts`), so nulling
  // them on a no-match would be silent data loss.
  if (row.album_id !== null) {
    // Linked + no-match: UPSERT just the 4 search URLs into album_metadata
    // (Apple stays out per BS#1192). INSERT path leaves the other 6 columns
    // NULL (no LML match to fill them). UPDATE path uses FILL-NULL conflict
    // semantics — `COALESCE(album_metadata.col, excluded.col)`, mirroring
    // `jobs/flowsheet-linked-reenrichment`'s `upsertAlbumMatchFillNull` —
    // so a column only fills when it's currently NULL and an existing REAL
    // value (a verified streaming link the `streaming-url-upgrade` sibling
    // job wrote, or a prior out-of-band value) is never overwritten by a
    // low-value synthesized `.../search/...` template. This is load-bearing
    // as of BS#895 / epic #1810 W4: the rotation self-heal pass routes
    // already-terminal `enriched_no_match` linked rows back through this
    // exact UPSERT on every re-attempt, so a plain unconditional `set`
    // (the pre-W4 shape, when this branch was reached at most once per row)
    // would let a self-heal re-attempt silently clobber an upgraded URL.
    await db
      .insert(album_metadata)
      .values({
        album_id: row.album_id,
        spotify_url: searchUrls.spotify_url,
        youtube_music_url: searchUrls.youtube_music_url,
        bandcamp_url: searchUrls.bandcamp_url,
        soundcloud_url: searchUrls.soundcloud_url,
        updated_at: sql`NOW()`,
      })
      .onConflictDoUpdate({
        target: album_metadata.album_id,
        set: {
          spotify_url: sql`COALESCE(${album_metadata.spotify_url}, excluded."spotify_url")`,
          youtube_music_url: sql`COALESCE(${album_metadata.youtube_music_url}, excluded."youtube_music_url")`,
          bandcamp_url: sql`COALESCE(${album_metadata.bandcamp_url}, excluded."bandcamp_url")`,
          soundcloud_url: sql`COALESCE(${album_metadata.soundcloud_url}, excluded."soundcloud_url")`,
          // Explicit NOW() — never COALESCE'd. Freezing updated_at would
          // neuter the setWhere race guard below.
          updated_at: sql`NOW()`,
        },
        // Race guard: never clobber a fresher worker/runtime/upgrade write
        // that landed after this UPSERT's snapshot was read.
        setWhere: sql`${album_metadata.updated_at} < NOW()`,
      });
    const updated = await db
      .update(flowsheet)
      .set({ metadata_attempt_at: sql`now()`, metadata_status: 'enriched_no_match' })
      .where(guardWhere)
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
  }

  const updated = await db
    .update(flowsheet)
    .set({
      spotify_url: searchUrls.spotify_url,
      youtube_music_url: searchUrls.youtube_music_url,
      bandcamp_url: searchUrls.bandcamp_url,
      soundcloud_url: searchUrls.soundcloud_url,
      metadata_attempt_at: sql`now()`,
      metadata_status: 'enriched_no_match',
    })
    .where(sql`"id" = ${row.id} AND "metadata_status" = ${fromStatus}`)
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};

/**
 * Best-effort dead-letter stamp for a *permanently*-failing row (BS#1562,
 * status-flip updated for BS#895 / Epic C C6).
 *
 * When `applyEnrichment` throws with an SQLSTATE that re-running the same row
 * would always reproduce (e.g. a mojibake title whose synthesized Bandcamp
 * URL overflows `flowsheet.bandcamp_url varchar(512)` — SQLSTATE 22001), the
 * row needs to leave the sweep's selection predicate or the id-cursor
 * re-selects — and re-fails on — it every run, and the pending cohort never
 * converges (breaking BS#1011's "cohort COUNT == 0 → retire the cron"
 * completion criterion, and its C6-successor "recovery sweep finds < 100
 * rows" criterion).
 *
 * This dead-letters the row: it flips `metadata_status = 'failed_no_retry'`
 * (the enum's own terminal value for "exceeded the retry budget," per
 * `metadataStatusEnum` in schema.ts) and stamps `metadata_attempt_at = now()`
 * (writing none of the URLs that overflowed), so the row leaves both the
 * main sweep's `fromStatus` cohort and — since `failed_no_retry` is not
 * `enriched_no_match` — the W4 rotation self-heal candidate set, while
 * staying distinguishable from a successful enrichment (its metadata columns
 * stay NULL) and visible for manual triage. `opts.fromStatus` (default
 * `'pending'`) is the status the row must currently hold; the WHERE mirrors
 * `applyEnrichment`'s guard so a concurrent writer's claim still wins.
 *
 * MUST be best-effort: any throw from the stamp itself is swallowed so it can
 * never re-wedge the drain the way the original poison-pill jam did (BS#1561).
 * The orchestrator's id-cursor advances regardless, so at worst a stamp that
 * fails to land leaves the row for a future sweep — never a stall.
 */
export const stampDeadLetter = async (rowId: number, opts: { fromStatus?: EnrichFromStatus } = {}): Promise<void> => {
  const fromStatus = opts.fromStatus ?? 'pending';
  try {
    await db
      .update(flowsheet)
      .set({ metadata_attempt_at: sql`now()`, metadata_status: 'failed_no_retry' })
      // Raw `id AND metadata_status = $fromStatus` predicate, mirroring
      // applyEnrichment's guard above — a concurrent writer's claim still
      // wins, and there's nothing to write but the status flip + marker.
      .where(sql`"id" = ${rowId} AND "metadata_status" = ${fromStatus}`);
  } catch {
    // Swallow: dead-lettering is a drain-hygiene optimization, not a
    // correctness requirement. Re-throwing here would defeat the whole
    // purpose (isolating the poison row so the cursor advances). The enrich
    // failure was already logged and captured by the caller.
  }
};
