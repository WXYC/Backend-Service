/**
 * Finalize UPDATE for the enrichment consumer (BS#892 / Epic C C2).
 *
 * Mirrors `jobs/flowsheet-metadata-backfill/enrich.ts` in shape — the same
 * 10-column on-match payload, the same 4-column on-no-match payload, the
 * same spacer.gif filter, the same synthesized search URLs — but with a
 * different idempotency guard and a different terminal state.
 *
 * BS#1336 adds 8 LML-only enrichment columns to the *linked* (album_id
 * non-null) on-match album_metadata payload only — `discogs_artist_id`,
 * `label`, `full_release_date`, `genres`, `styles`, `tracklist`,
 * `artist_image_url`, `bio_tokens`. The unlinked inline-flowsheet path and
 * the no-match arms keep the original 10/4-column shapes (flowsheet carries
 * none of the 8 columns). Sourcing them requires `extended: true` on the LML
 * lookup, set in handler.ts.
 *
 * Idempotency guard: WHERE narrows by `metadata_status = 'enriching'`. The
 * claim primitive (`claim.ts`) is the only writer that flips a row to
 * `enriching`, so the WHERE here can match only a row this worker (or a
 * sibling that already lost the claim race) is the registered claimer of.
 *
 * Terminal state:
 *   - LML returned artwork  → `metadata_status = 'enriched_match'`
 *   - LML returned no match → `metadata_status = 'enriched_no_match'`
 *   - LML threw             → caller catches; row stays `enriching`. The
 *                             C6 stranded-claim sweep (#895) reverts it to
 *                             `pending` past `enriching_since + 60s` so the
 *                             next CDC tick (or sweep) retries.
 *
 * No `metadata_attempt_at` stamping here. That column was the implicit
 * state machine the enum (BS#891) replaced; the consumer writes the explicit
 * status and leaves the marker alone. The backfill still stamps the marker
 * because its WHERE is `metadata_attempt_at IS NULL` — a historical-drain
 * concern that doesn't apply to the live consumer path.
 *
 * Spacer.gif filter + Discogs bio cleanup: imported from `@wxyc/metadata`
 * (BS#1242 deep-module rollout — the last build-graph-safe consumer to
 * collapse onto the shared module). `synthesizeSearchUrls` stays inline
 * pending a cross-caller decision on the `spotify_url` divergence
 * (BS#1184 / BS#1192: shared `synthesizeSearchUrls` omits Spotify; the
 * inline version here persists a synthesized URL). Pinned by parity test:
 *   - tests/unit/apps/enrichment-worker/synthesize-search-urls-parity.test.ts (BS#889 / BS#1189)
 *
 * BS#1915 (bounded self-heal of unresolved streaming links). The linked-match
 * arm merges each of the three per-service streaming fields (spotify,
 * apple_music, bandcamp) with the fresh LML verdict via `mergeStreamingField`
 * (never downgrading an already-`verified` field, forcing `absent` fields'
 * url to null and terminal, and leaving `unresolved` fields transient/
 * retry-eligible). `streaming_reask_attempts` — one shared per-album counter,
 * not per-service, since a single LML re-ask resolves all three services'
 * verdicts at once — increments ONLY on a genuine re-ask against an EXISTING,
 * already-matched row (see BS#1924 below); a fresh album's first-ever write
 * leaves the column at its schema DEFAULT 0, because the first ask is not a
 * re-ask. Migration 0135 (schema) carries the full design rationale;
 * `precheck.ts` is the read side that gates further re-asks at
 * `STREAMING_REASK_ATTEMPT_CAP`.
 *
 * BS#1923 (TOCTOU fix). The original merge read the album's PRIOR persisted
 * streaming state via a separate SELECT *before* the LML round-trip, then
 * wrote the merge verdict computed against that now-stale snapshot. A live
 * CDC verify landing during the round-trip (rare, but real) could get
 * silently clobbered back to `unresolved` plus a search URL — the write
 * never looked at the row as it actually stood at write time. The fix folds
 * the merge directly into the UPSERT's `onConflictDoUpdate` `set` clause as
 * SQL `CASE` expressions over the LIVE `album_metadata` columns
 * (`buildStreamingFieldConflictSet`), so the read and the write are the same
 * atomic statement — there is no longer a separate read to go stale. The
 * INSERT branch (a genuinely fresh album) still merges in plain JS against
 * an all-NULL state, since there is no live row to race against there.
 *
 * BS#1924 (re-ask counter miscount fix). The counter used to increment
 * whenever the write hit the `onConflictDoUpdate` branch — but a BS#1089
 * no-match SHELL row (search-URL-only) already has an `album_metadata` row,
 * so its first REAL match also hits that branch and miscounted 0->1 before
 * any actual re-ask happened. The increment is now gated on the row already
 * carrying a load-bearing match (`artwork_url` OR `discogs_url` present)
 * *before* this write — a shell->matched transition leaves the counter at 0.
 */

import { and, eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { album_metadata, db, flowsheet } from '@wxyc/database';
import type { DiscogsMatchResult, LookupResponse, StreamingResolutionStatus } from '@wxyc/lml-client';
import { cleanDiscogsBio, filterSpacerGif } from '@wxyc/metadata';

/**
 * Bound on `album_metadata.streaming_reask_attempts` (BS#1915). Once an
 * album has been re-asked this many times with a field still `unresolved`,
 * `precheck.ts` stops treating it as re-ask-eligible — the "no unbounded
 * re-ask loop" half of the #1747 amplifier guard. A named, tunable constant
 * (not env-derived, mirroring the codebase's per-caller hardcoded-override
 * convention in `shared/lml-client/src/policy.ts` for values with no
 * expected operational need to tune live) so precheck.ts, enrich.ts, and
 * the streaming-reask sweep can't drift against three independent copies.
 */
export const STREAMING_REASK_ATTEMPT_CAP = 3;

/** One persisted streaming-service field's state: its resolution verdict (if any) and its url (if verified). */
export interface StreamingFieldState {
  status: StreamingResolutionStatus | null;
  url: string | null;
}

/**
 * Infer the effective incoming per-service verdict for one streaming field
 * on a fresh LML response, combining LML#1053's explicit `streaming_status`
 * (when present) with the legacy url-presence signal.
 *
 * Explicit status always wins. A bare non-null url with NO explicit status
 * is inferred `'verified'` — a url existing IS the verification, and this
 * keeps the merge backward compatible with LML responses that predate the
 * LML#1053 producer rollout (or a path that resolves a url without ever
 * populating `streaming_status`), which is exactly today's `matchResponse`
 * shape in the existing test suite. No url and no explicit status is
 * genuinely unknown — returns `undefined` rather than inventing a verdict
 * LML never actually asserted (an `unresolved` or `absent` guess here would
 * corrupt the merge's terminal/negative-cache guarantees).
 */
export function inferIncomingStreamingStatus(
  explicitStatus: StreamingResolutionStatus | undefined,
  url: string | null | undefined
): StreamingResolutionStatus | undefined {
  if (explicitStatus) return explicitStatus;
  return url ? 'verified' : undefined;
}

/**
 * Merge one persisted streaming-service field with a fresh incoming verdict
 * (already combined via `inferIncomingStreamingStatus`).
 *
 * Rules, in priority order:
 *   1. `current.status === 'verified'` → return `current` unchanged. A
 *      verified URL is NEVER overwritten — not by a fresh 'verified' (which
 *      would carry the same URL anyway), and certainly not by a later
 *      'unresolved'/'absent' flap from a re-ask.
 *   2. `incomingStatus === undefined` → the service was not consulted (or
 *      its verdict was genuinely unknown) this round; return `current`
 *      unchanged. Never invent a verdict LML didn't assert.
 *   3. incoming `'verified'` → adopt the incoming url and status. This is the
 *      one transition allowed to supersede a prior terminal `absent` (a
 *      release that finally appeared on the service) — checked ahead of rule
 *      4 so a genuine positive always wins.
 *   4. `current.status === 'absent'` → terminal, return `current` unchanged.
 *      A negative-cached field is NEVER downgraded by a later
 *      `unresolved`/`absent` flap: that would resurrect it for re-ask
 *      (`precheck.ts` selects on `unresolved`), the exact per-play amplifier
 *      BS#1747/#1089 killed. Only rule 3's genuine `verified` may supersede it.
 *   5. incoming `'absent'` → adopt terminal `absent`; url forced null
 *      regardless of any stray incoming url (LML's contract pairs `absent`
 *      with a null url, but the guard is defensive).
 *   6. incoming `'unresolved'` → transient; status flips to `'unresolved'`,
 *      url carries forward from `current` (never fabricated — a non-verified
 *      service carries no url by LML's contract).
 */
export function mergeStreamingField(
  current: StreamingFieldState,
  incomingStatus: StreamingResolutionStatus | undefined,
  incomingUrl: string | null | undefined
): StreamingFieldState {
  if (current.status === 'verified') return current;
  if (incomingStatus === undefined) return current;
  if (incomingStatus === 'verified') return { status: 'verified', url: incomingUrl ?? null };
  if (current.status === 'absent') return current;
  if (incomingStatus === 'absent') return { status: 'absent', url: null };
  return { status: 'unresolved', url: current.url };
}

/** A field with no synthesized search-URL fallback (Apple Music, BS#1192) never falls back — its non-verified branches keep/null the live URL directly instead of substituting a fresh search URL. */
const NO_FALLBACK = null;

/** A never-persisted album: `mergeStreamingField` treats this identically to a row whose streaming columns are all still NULL. */
const FRESH_STREAMING_STATE: StreamingFieldState = { status: null, url: null };

/**
 * One field's `onConflictDoUpdate` `set` fragments (BS#1923): SQL `CASE`
 * expressions over the LIVE `statusCol`/`urlCol` values, translating
 * `mergeStreamingField`'s rules so the merge and the write are the same
 * atomic statement — no separate SELECT that could go stale during the LML
 * round-trip.
 *
 * `incomingStatus`/`incomingUrl` are plain JS values fixed for this call
 * (this round's LML verdict) — only the "current persisted state" side of
 * the merge needs to become SQL, since that is the side a concurrent writer
 * could have changed since this call started. Per incoming verdict:
 *
 *   - `undefined` (never consulted this round): status is left unchanged
 *     (whatever the live row already holds). A field WITH a search-URL
 *     fallback still recomputes it fresh whenever the live status isn't
 *     `'verified'` — unrelated to whether this field was asked this round;
 *     that mirrors the pre-#1915 last-writer-wins fallback recompute. A
 *     field with no fallback (Apple Music) leaves its url unchanged too.
 *   - `'verified'`: status becomes `'verified'` unconditionally (rule 3 of
 *     `mergeStreamingField` supersedes a prior `'absent'`); url adopts
 *     `incomingUrl` UNLESS the live row is already `'verified'`, in which
 *     case the live url is kept — a verified field is never downgraded,
 *     evaluated against the row as it stands at write time, not a stale
 *     snapshot.
 *   - `'absent'`: status becomes `'absent'` unless the live row is already
 *     `'verified'` (kept). url becomes the fallback (or NULL with no
 *     fallback) in that same non-verified branch — `current.status ===
 *     'absent'` (keep) and adopting `'absent'` fresh collapse to the same
 *     final url here, so one branch covers both.
 *   - `'unresolved'`: status becomes `'unresolved'` unless the live row is
 *     already `'verified'` OR already `'absent'` (both terminal, kept). url
 *     recomputes the fresh fallback in the non-verified branch for a field
 *     WITH a fallback (same recompute as the `undefined` case); for Apple
 *     Music (no fallback) the url never changes for an `'unresolved'`
 *     verdict, in every reachable branch — so it is left as the live column
 *     untouched.
 *
 * Every `${statusCol} = 'verified'` (and `'absent'`) comparison below is
 * written out at its use site rather than factored into a shared
 * sub-fragment — a flat template per branch, directly inspectable by a test
 * via `.sql`/`.values` without needing to recurse through nested `SQL`
 * objects (see `buildStreamingFieldConflictSet`'s unit tests). These
 * predicates read the LIVE row (evaluated by Postgres against the
 * pre-UPDATE row, same as every other `set` expression in an
 * `ON CONFLICT DO UPDATE`) — this is exactly what closes the TOCTOU window:
 * whatever a concurrent CDC verify wrote before this UPDATE commits is what
 * these CASEs see.
 */
export function buildStreamingFieldConflictSet(
  statusCol: AnyColumn,
  urlCol: AnyColumn,
  incomingStatus: StreamingResolutionStatus | undefined,
  incomingUrl: string | null,
  fallbackUrl: string | null
): { status: SQL; url: SQL } {
  const hasFallback = fallbackUrl !== NO_FALLBACK;

  if (incomingStatus === undefined) {
    return {
      status: sql`${statusCol}`,
      url: hasFallback
        ? sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${fallbackUrl} END`
        : sql`${urlCol}`,
    };
  }

  if (incomingStatus === 'verified') {
    return {
      status: sql`'verified'`,
      url: sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${incomingUrl} END`,
    };
  }

  if (incomingStatus === 'absent') {
    return {
      status: sql`CASE WHEN ${statusCol} = 'verified' THEN ${statusCol} ELSE 'absent' END`,
      url: sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${fallbackUrl} END`,
    };
  }

  // incomingStatus === 'unresolved'
  return {
    status: sql`CASE WHEN ${statusCol} = 'verified' OR ${statusCol} = 'absent' THEN ${statusCol} ELSE 'unresolved' END`,
    url: hasFallback ? sql`CASE WHEN ${statusCol} = 'verified' THEN ${urlCol} ELSE ${fallbackUrl} END` : sql`${urlCol}`,
  };
}

/**
 * UPSERT a matched album's full metadata payload into `album_metadata`.
 *
 * The re-ask (`onConflictDoUpdate`) branch merges the three streaming-verdict
 * fields against the LIVE row via SQL `CASE` expressions
 * (`buildStreamingFieldConflictSet`, BS#1923) instead of a separate
 * SELECT-then-merge-then-write — closing the TOCTOU window a concurrent CDC
 * verify could land in during the LML round-trip. It also bumps the shared
 * `streaming_reask_attempts` counter, but ONLY when the row already carried a
 * load-bearing match before this write (BS#1924) — a fresh album's INSERT
 * (below) and a BS#1089 no-match shell's first real match both leave the
 * counter at its schema DEFAULT 0.
 *
 * Extracted from `finalizeRow`'s linked-match arm so BOTH callers share one
 * write path: the live CDC handler (via `finalizeRow`, which also owns the
 * flowsheet-row-scoped composer write) and the hourly streaming-reask sweep
 * (`streaming-reask.ts`), which has no flowsheet row to finalize — it
 * operates directly on `album_metadata` for an already-terminal album.
 */
export async function upsertMatchedAlbumMetadata(
  albumId: number,
  artwork: DiscogsMatchResult,
  searchUrls: { spotify_url: string; youtube_music_url: string; bandcamp_url: string; soundcloud_url: string }
): Promise<void> {
  const spotifyIncomingStatus = inferIncomingStreamingStatus(artwork.streaming_status?.spotify, artwork.spotify_url);
  const appleMusicIncomingStatus = inferIncomingStreamingStatus(
    artwork.streaming_status?.apple_music,
    artwork.apple_music_url
  );
  const bandcampIncomingStatus = inferIncomingStreamingStatus(artwork.streaming_status?.bandcamp, artwork.bandcamp_url);
  const spotifyIncomingUrl = artwork.spotify_url ?? null;
  const appleMusicIncomingUrl = artwork.apple_music_url ?? null;
  const bandcampIncomingUrl = artwork.bandcamp_url ?? null;

  // INSERT branch (a genuinely fresh album — no live row to race against):
  // merge in plain JS against an all-NULL prior state. This is a pure
  // computation over this call's own incoming verdict, with no DB read
  // involved, so there is no snapshot that could go stale.
  const freshSpotify = mergeStreamingField(FRESH_STREAMING_STATE, spotifyIncomingStatus, spotifyIncomingUrl);
  const freshAppleMusic = mergeStreamingField(FRESH_STREAMING_STATE, appleMusicIncomingStatus, appleMusicIncomingUrl);
  const freshBandcamp = mergeStreamingField(FRESH_STREAMING_STATE, bandcampIncomingStatus, bandcampIncomingUrl);

  // The album_metadata UPSERT is idempotent (same album_id → same row) and
  // guarded by `updated_at < NOW()` so a concurrent stale write (e.g. a
  // delayed drift-repair backfill) can't overwrite a fresher enrichment.
  const payload = {
    artwork_url: filterSpacerGif(artwork.artwork_url),
    discogs_url: artwork.release_url ?? null,
    // Discogs returns 0 as "year unknown"; coerce to null so iOS doesn't
    // render literal "0". Mirrors metadata.service.ts (#1002).
    release_year: artwork.release_year || null,
    // A verified streaming URL wins outright; anything else (absent /
    // unresolved / never-consulted) falls back to the synthesized search
    // URL for Spotify and Bandcamp — unchanged from pre-#1915 behavior, and
    // never a downgrade of a prior verified URL. Apple Music has NO
    // fallback — null is load-bearing "no verified iTunes match" (BS#1192),
    // disambiguated by `apple_music_status` instead of silently freezing a
    // transient null (BS#1915). This INSERT-branch payload only ever runs
    // against a fresh (all-NULL) prior, so there is nothing to downgrade
    // here — the conflict branch below is where that guarantee is load-
    // bearing.
    spotify_url: freshSpotify.status === 'verified' ? freshSpotify.url : searchUrls.spotify_url,
    spotify_status: freshSpotify.status,
    apple_music_url: freshAppleMusic.url,
    apple_music_status: freshAppleMusic.status,
    youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
    bandcamp_url: freshBandcamp.status === 'verified' ? freshBandcamp.url : searchUrls.bandcamp_url,
    bandcamp_status: freshBandcamp.status,
    soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
    artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
    artist_wikipedia_url: artwork.wikipedia_url ?? null,
    // LML-only enrichment fields (BS#1336). Present on `artwork` only
    // because handler.ts now sets `extended: true`; without it these would
    // all write null. Persisting them lets the BS#1331 cache-first read
    // path emit the artist+release subtree on a hit instead of shedding
    // it. `profile_tokens` maps to the `bio_tokens` column (iOS's
    // `bioTokens`). No cleanup/synthesis here — raw passthroughs of what
    // LML resolved for the top-1 release match; the read side
    // (`buildLocalMetadataResponse`) projects + filters to match the
    // cold-fallthrough wire shape.
    discogs_artist_id: artwork.discogs_artist_id ?? null,
    label: artwork.label ?? null,
    full_release_date: artwork.full_release_date ?? null,
    genres: artwork.genres ?? null,
    styles: artwork.styles ?? null,
    tracklist: artwork.tracklist ?? null,
    artist_image_url: artwork.artist_image_url ?? null,
    bio_tokens: artwork.profile_tokens ?? null,
  };

  // BS#1923: the conflict (re-ask) branch replaces the plain-JS merged
  // values above with CASE expressions over the LIVE row — see
  // `buildStreamingFieldConflictSet`'s header for the rule-by-rule
  // translation from `mergeStreamingField`.
  const spotifyConflict = buildStreamingFieldConflictSet(
    album_metadata.spotify_status,
    album_metadata.spotify_url,
    spotifyIncomingStatus,
    spotifyIncomingUrl,
    searchUrls.spotify_url
  );
  const appleMusicConflict = buildStreamingFieldConflictSet(
    album_metadata.apple_music_status,
    album_metadata.apple_music_url,
    appleMusicIncomingStatus,
    appleMusicIncomingUrl,
    NO_FALLBACK
  );
  const bandcampConflict = buildStreamingFieldConflictSet(
    album_metadata.bandcamp_status,
    album_metadata.bandcamp_url,
    bandcampIncomingStatus,
    bandcampIncomingUrl,
    searchUrls.bandcamp_url
  );

  await db
    .insert(album_metadata)
    .values({ album_id: albumId, ...payload, updated_at: sql`NOW()` })
    .onConflictDoUpdate({
      target: album_metadata.album_id,
      set: {
        ...payload,
        spotify_status: spotifyConflict.status,
        spotify_url: spotifyConflict.url,
        apple_music_status: appleMusicConflict.status,
        apple_music_url: appleMusicConflict.url,
        bandcamp_status: bandcampConflict.status,
        bandcamp_url: bandcampConflict.url,
        // BS#1924: bump the shared per-album re-ask counter ONLY when the
        // row already carried a load-bearing match (artwork_url OR
        // discogs_url present) BEFORE this write — a genuine re-ask of an
        // already-enriched album. Both column refs read the PRE-UPDATE row
        // (Postgres evaluates every `SET` expression in one UPDATE against
        // the row as it stood before the statement, same as the streaming
        // CASEs above), so a BS#1089 no-match SHELL row (search-URL only,
        // both those columns still NULL) resolving its first REAL match
        // does NOT miscount as a re-ask — that shell->matched transition
        // leaves the counter at 0, same as a brand-new INSERT.
        streaming_reask_attempts: sql`CASE
          WHEN ${album_metadata.artwork_url} IS NOT NULL OR ${album_metadata.discogs_url} IS NOT NULL
          THEN ${album_metadata.streaming_reask_attempts} + 1
          ELSE ${album_metadata.streaming_reask_attempts}
        END`,
        updated_at: sql`NOW()`,
      },
      setWhere: sql`${album_metadata.updated_at} < NOW()`,
    });
}

/**
 * Bump the shared per-album `streaming_reask_attempts` counter with no
 * other write — the hourly streaming-reask sweep's outcome when LML
 * responds but returns no artwork at all for a candidate that previously
 * matched (a rare Discogs-side flap, not the common case). Spending an
 * attempt without a fresh verdict still counts toward the bound: an album
 * that keeps failing to re-match must still eventually stop being retried.
 * Does NOT touch `updated_at`'s `setWhere` guard semantics — this is a
 * plain UPDATE, not the insert/upsert `finalizeRow` path uses.
 */
export async function bumpStreamingReaskAttempts(albumId: number): Promise<void> {
  await db
    .update(album_metadata)
    .set({
      streaming_reask_attempts: sql`${album_metadata.streaming_reask_attempts} + 1`,
      updated_at: sql`NOW()`,
    })
    .where(eq(album_metadata.album_id, albumId));
}

export type EnrichRow = {
  id: number;
  artist_name: string;
  album_title: string | null;
  track_title: string | null;
  // Epic D / BS#899: non-null → UPSERT album_metadata + flowsheet status
  // flip only; null → write the 10 metadata columns inline on flowsheet
  // (free-form entries, until their linkage resolves). Source: CDC payload
  // via filterForEnrichment.
  album_id: number | null;
};

export type FinalizeOutcome =
  'enriched_match' | 'enriched_match_raced' | 'enriched_no_match' | 'enriched_no_match_raced';

/**
 * BMI composer provenance (BS#1499). Enum-like text on the flowsheet row,
 * mirroring the `linkage_source` precedent in the same table — kept open as
 * text (not a pg enum) so a future source (e.g. `musicbrainz_work`, flagged
 * by LML#699) needs no enum migration. Const-asserted so every `.set({...})`
 * call below is type-checked against exactly these three values.
 */
export type ComposerSource = 'discogs_track' | 'discogs_release' | 'artist_proxy';
type ComposerResolution = { composer: string; composer_source: ComposerSource };

/**
 * Resolve the BMI composer for a playcut from LML's writer credits, with an
 * artist-as-proxy fallback when nothing resolved (the dominant ~79% case per
 * LML#699 — expected, not a regression; it mirrors tubafrenzy's existing
 * auto-fill-BMI_COMPOSER-from-Artist default).
 *
 * Names join with `'; '` because Discogs writer names can themselves contain
 * commas ("Last, First"), so a comma delimiter would be ambiguous; #1500's
 * BMI export owns the field/record delimiters.
 *
 * This ternary is the SOLE site mapping `writer_credits.provenance` →
 * `composer_source`; no other caller should invent a value.
 */
export const resolveComposer = (row: EnrichRow, artwork: DiscogsMatchResult | null): ComposerResolution => {
  const wc = artwork?.writer_credits;
  // Drop blank names so a stray empty entry can't yield an empty composer
  // mislabeled as a real Discogs credit (#1500's BMI export reads this
  // verbatim); fall through to the artist proxy when nothing real remains.
  const names = wc?.names?.filter((n) => n.trim());
  if (wc && names?.length) {
    return {
      composer: names.join('; '),
      composer_source: wc.provenance === 'track' ? 'discogs_track' : 'discogs_release',
    };
  }
  return { composer: row.artist_name, composer_source: 'artist_proxy' };
};

/**
 * Synthesized search URLs (per-service semantics deliberately asymmetric):
 *   - Spotify:       trackTitle > albumTitle > artistName. Path-style URL
 *                    matches LML's `_build_streaming_search_url` byte-for-byte
 *                    so iOS reads back the same URL whether LML surfaced it
 *                    or BS synthesized it (BS#1185 + LML#401).
 *   - YouTube Music: trackTitle > albumTitle > artistName
 *   - Bandcamp:      albumTitle > artistName (album-leaning)
 *   - SoundCloud:    trackTitle > artistName (NO album fallback — album-only
 *                    SoundCloud queries surface unrelated DJ mixes)
 *
 * Apple Music is intentionally absent (BS#1192): LML's null return on
 * `apple_music_url` is load-bearing ("no verified iTunes match"), and a
 * keyword-search fallback would launder that signal into a clickable
 * button. The read path proxy still fills Apple at request time.
 *
 * Must match the write-path shape of
 * `apps/backend/services/metadata/metadata.service.ts#fetchMetadata`.
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

export const extractArtwork = (response: LookupResponse): DiscogsMatchResult | null => {
  const first = response.results?.[0];
  if (!first) return null;
  if (!first.artwork) return null;
  return first.artwork;
};

/**
 * Finalize an enriching row with LML's response.
 *
 * Returns the outcome so the dispatcher can count it. The `_raced` variants
 * fire when the flowsheet UPDATE's `.returning({ id })` is empty: the WHERE
 * no longer matches because something else (the C6 cron's stranded-claim
 * sweep, a manual triage operator, or a hypothetical out-of-band writer)
 * flipped `metadata_status` off `'enriching'` between claim and finalize.
 * Same data outcome from the row's perspective; the metric separates "this
 * consumer finalized it" from "the row was finalized by someone."
 *
 * Linked vs unlinked (Epic D / BS#899): if `row.album_id` is non-null the
 * 10-column metadata payload goes into `album_metadata` keyed by album_id
 * (UPSERT), and the flowsheet UPDATE only flips `metadata_status`. If
 * `album_id` is null (free-form entries), the 10 columns are written
 * inline on `flowsheet` as before. The album_metadata UPSERT happens
 * *before* the flowsheet status flip — if either write fails the C6 sweep
 * recovers the stranded `enriching` row and a retry of the (idempotent)
 * UPSERT + flowsheet UPDATE finishes the work.
 *
 * Errors propagate up — the dispatcher's catch arm decides whether to leave
 * the row stranded (transient LML failure → C6 sweep recovers) or to write
 * a terminal `failed_no_retry` (out of scope for PR-2; the filter ensures
 * every reachable row has the inputs LML needs).
 */
export const finalizeRow = async (row: EnrichRow, response: LookupResponse): Promise<FinalizeOutcome> => {
  const artwork = extractArtwork(response);
  const searchUrls = synthesizeSearchUrls(row);
  // BS#1499: composer is a per-playcut property, so it rides the flowsheet
  // UPDATE in all four arms below (never the album-keyed album_metadata
  // UPSERT). Resolved once here; artist-as-proxy fallback on absent credit.
  const { composer, composer_source } = resolveComposer(row, artwork);

  if (artwork) {
    if (row.album_id !== null) {
      // Linked + match: the 10(+3 streaming-status +1 attempts)-col payload
      // lands in album_metadata; flowsheet UPDATE only flips status. See
      // `upsertMatchedAlbumMetadata` for the merge + UPSERT (BS#1915 also
      // calls it directly from the hourly streaming-reask sweep, which has
      // no flowsheet row to finalize).
      await upsertMatchedAlbumMetadata(row.album_id, artwork, searchUrls);
      const updated = await db
        .update(flowsheet)
        // composer rides the flowsheet UPDATE, not the album_metadata UPSERT
        // above (per-playcut, not album-level — BS#1499).
        .set({ metadata_status: 'enriched_match', composer, composer_source })
        .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
        .returning({ id: flowsheet.id });
      return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
    }

    // Unlinked + match: write the 10 columns inline on flowsheet, as before
    // D3. These rows can't enrich into album_metadata until linkage
    // resolves; D4's column-drop is gated on no unlinked enrichments
    // remaining (see #1012 + the broader linkage-completion gate).
    const updated = await db
      .update(flowsheet)
      .set({
        artwork_url: filterSpacerGif(artwork.artwork_url),
        discogs_url: artwork.release_url ?? null,
        release_year: artwork.release_year || null,
        // Apple Music has no fallback — null is load-bearing (BS#1192).
        spotify_url: artwork.spotify_url ?? searchUrls.spotify_url,
        apple_music_url: artwork.apple_music_url ?? null,
        youtube_music_url: artwork.youtube_music_url ?? searchUrls.youtube_music_url,
        bandcamp_url: artwork.bandcamp_url ?? searchUrls.bandcamp_url,
        soundcloud_url: artwork.soundcloud_url ?? searchUrls.soundcloud_url,
        artist_bio: artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
        artist_wikipedia_url: artwork.wikipedia_url ?? null,
        metadata_status: 'enriched_match',
        // BS#1499: per-playcut composer, alongside the inline metadata columns.
        composer,
        composer_source,
      })
      .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
      .returning({ id: flowsheet.id });
    return updated.length === 0 ? 'enriched_match_raced' : 'enriched_match';
  }

  // No-match: synthesized search URLs only. The other 7 metadata columns are
  // left untouched — preserves any prior out-of-band values (e.g. recovery
  // writes from #686-era scripts). Mirrors the backfill's deliberate
  // divergence from the runtime path (see backfill enrich.ts header).
  if (row.album_id !== null) {
    // Linked + no-match: UPSERT just the 4 search URLs into album_metadata
    // (Apple stays out per BS#1192). INSERT path leaves the other 6 columns
    // NULL (no LML match to fill them); UPDATE path leaves them untouched
    // on existing rows (preserves any prior out-of-band values, same
    // semantics as the unlinked path).
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
          spotify_url: searchUrls.spotify_url,
          youtube_music_url: searchUrls.youtube_music_url,
          bandcamp_url: searchUrls.bandcamp_url,
          soundcloud_url: searchUrls.soundcloud_url,
          updated_at: sql`NOW()`,
        },
        setWhere: sql`${album_metadata.updated_at} < NOW()`,
      });
    const updated = await db
      .update(flowsheet)
      // composer rides the flowsheet UPDATE, not the album_metadata UPSERT
      // above (per-playcut, not album-level — BS#1499). On no-match this is
      // the artist-as-proxy value.
      .set({ metadata_status: 'enriched_no_match', composer, composer_source })
      .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
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
      metadata_status: 'enriched_no_match',
      // BS#1499: per-playcut composer (artist-as-proxy on no-match).
      composer,
      composer_source,
    })
    .where(and(eq(flowsheet.id, row.id), eq(flowsheet.metadata_status, 'enriching')))
    .returning({ id: flowsheet.id });
  return updated.length === 0 ? 'enriched_no_match_raced' : 'enriched_no_match';
};
