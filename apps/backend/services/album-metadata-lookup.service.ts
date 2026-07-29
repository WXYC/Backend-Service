/**
 * Local read helpers backing the cache-first `/proxy/metadata/album` path
 * (BS#1331) and the external critic-review snippets attached to it
 * (album-critic-reviews slice, ADR 0012). All read BS's own persisted state
 * so the steady-state serve path skips the LML cascade entirely.
 *
 * Five exported helpers, keyed on the `album_id` of a matching `flowsheet`
 * row and staged so the handler resolves that id exactly once per request:
 *   - {@link selectLinkedFlowsheetRow} — normalized `(artist, release)` key →
 *     the matching linked flowsheet row (`album_id` plus the base,
 *     non-enrichment `record_label` / `label_id` / `metadata_status`
 *     columns, BS#1827), via the partial functional index
 *     `flowsheet_album_link_lookup_idx` (migration 0081). Deterministic
 *     `ORDER BY flowsheet.id DESC LIMIT 1` row-pick so multi-`album_id` keys
 *     (V/A multi-format, dual-pressings, librarian duplicates) can't flap
 *     between distinct albums across polls. One query resolves album_id AND
 *     the base fields together — see the `/proxy/metadata/album` handler's
 *     doc comment for how this feeds the local-first base block without a
 *     second, separately-racing round trip.
 *   - {@link resolveLinkedAlbumId} — thin `number | null` wrapper over
 *     {@link selectLinkedFlowsheetRow} for callers that only need the id
 *     (`jobs/album-critic-reviews-etl`, `scripts/seed-critic-reviews.ts`).
 *   - {@link lookupAlbumMetadataById} — PK-lookup on `album_metadata` for a
 *     resolved id; the 10 base columns the proxy response is built from plus
 *     the 8 LML-only enrichment fields (`discogs_artist_id` / `label` /
 *     `full_release_date` / `genres` / `styles` / `tracklist` /
 *     `artist_image_url` / `bio_tokens`, BS#1336) so a cache hit carries the
 *     same shape as the cold LML-fallthrough path.
 *   - {@link lookupCriticReviewsByAlbumId} — up to `CRITIC_REVIEWS_LIMIT`
 *     attributed snippets for a resolved id, independent of whether
 *     `album_metadata` enrichment has run.
 *   - {@link lookupCriticReviewsByAlbumIds} — batched sibling of
 *     {@link lookupCriticReviewsByAlbumId} for flowsheet feed-assembly
 *     (`attachCriticReviews`, `apps/backend/services/flowsheet.service.ts`):
 *     one indexed query for a whole page's `album_id`s instead of one per
 *     row, capped and ordered identically per album.
 *
 * The `/proxy/metadata/album` handler calls {@link selectLinkedFlowsheetRow}
 * once and feeds the resolved `album_id` to both the metadata and reviews
 * reads, so a concurrent flowsheet insert can't make the reads describe two
 * different albums for one request (the reads used to each re-resolve the
 * key, which was both racy and coupled reviews to the metadata read).
 *
 * A `null` metadata result means "no enriched local row for this id" — the
 * caller falls through to LML. Free-form flowsheet rows (`album_id IS NULL`)
 * can't resolve at all, so iOS surfaces for those still pay the LML
 * round-trip. That's accepted scope: the cache-first goal targets the
 * linked-row cohort (the steady state for entries old enough to be of
 * interest to a detail-view fetch).
 */
import { sql, eq, desc, inArray } from 'drizzle-orm';
import { db, album_metadata, album_critic_reviews } from '@wxyc/database';
import type { CriticReviewItem } from '@wxyc/shared/dtos';
import type { DiscogsResolvedToken, DiscogsTrackItem } from '@wxyc/lml-client';

/**
 * Thin re-export shim — `resolveLinkedAlbumId` moved to `@wxyc/database`
 * (BS#1829, `shared/database/src/album-resolve.ts`) so the upcoming
 * `jobs/album-critic-reviews-etl/` (#1830) can call the SAME resolver a
 * `jobs/` workspace can't reach into `apps/backend` for. This path is
 * preserved deliberately (mirrors the `@wxyc/legacy-mirror` BS#1707
 * extraction and `concerts-recompute.ts`'s BS#1763 shim in
 * `jobs/concerts-artist-resolver/recompute.ts`): `apps/backend/controllers/
 * proxy.controller.ts` still imports from here, so its import site doesn't
 * need touching. New code should import from `@wxyc/database` directly, as
 * `scripts/seed-critic-reviews.ts` now does.
 *
 * `selectLinkedFlowsheetRow` (BS#1827, folded from a separate
 * `resolveLinkedFlowsheetBase` into the combined-row shape in round 2 of the
 * same slice) lives alongside it in the same `@wxyc/database` module and is
 * re-exported here for the same reason — only
 * `apps/backend/controllers/proxy.controller.ts` needs it today, so there's
 * no `jobs/` consumer yet, but keeping both resolvers importable from one
 * place avoids a second import site to remember.
 */
export { resolveLinkedAlbumId, selectLinkedFlowsheetRow, type LinkedFlowsheetRow } from '@wxyc/database';

/**
 * Persisted album metadata projection. Matches the 18 columns on
 * `album_metadata` (10 base + 8 LML-only, BS#1336). Read straight from
 * `album_metadata` (no COALESCE over `flowsheet.col`) — D3 made
 * `album_metadata` the canonical write target, and the sibling
 * `playlist-proxy.service.ts` already reads `album_metadata` directly. Less
 * brittle to D4 (#900) which drops the inline `flowsheet.*_url` columns.
 *
 * `tracklist` / `bio_tokens` are untyped jsonb at the schema layer
 * (`shared/database`, which takes no DTO dependency); they're typed here at
 * the read boundary as the LML DTO shapes the enrichment-worker persists.
 */
export interface PersistedAlbumMetadata {
  artwork_url: string | null;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
  // LML-only enrichment fields (BS#1336).
  discogs_artist_id: number | null;
  label: string | null;
  full_release_date: string | null;
  genres: string[] | null;
  styles: string[] | null;
  tracklist: DiscogsTrackItem[] | null;
  artist_image_url: string | null;
  bio_tokens: DiscogsResolvedToken[] | null;
}

/**
 * PK-lookup of persisted `album_metadata` for an already-resolved
 * `library.id`. Returns `null` when the row doesn't exist yet (race window:
 * flowsheet INSERT landed but the enrichment-worker hasn't UPSERTed
 * `album_metadata` yet). Falling through to LML in that window is the right
 * behavior — the worker is already paying the LML cost concurrently, but a
 * stale or pre-enrichment response would otherwise persist in the iOS cache
 * for the duration of the response Cache-Control TTL.
 *
 * The caller resolves `albumId` via {@link resolveLinkedAlbumId} once and
 * passes it to both this read and {@link lookupCriticReviewsByAlbumId}, so a
 * concurrent flowsheet insert can't make metadata and reviews describe two
 * different albums for one request.
 */
export async function lookupAlbumMetadataById(albumId: number): Promise<PersistedAlbumMetadata | null> {
  const rows = await db
    .select({
      artwork_url: album_metadata.artwork_url,
      discogs_url: album_metadata.discogs_url,
      release_year: album_metadata.release_year,
      spotify_url: album_metadata.spotify_url,
      apple_music_url: album_metadata.apple_music_url,
      youtube_music_url: album_metadata.youtube_music_url,
      bandcamp_url: album_metadata.bandcamp_url,
      soundcloud_url: album_metadata.soundcloud_url,
      artist_bio: album_metadata.artist_bio,
      artist_wikipedia_url: album_metadata.artist_wikipedia_url,
      // LML-only enrichment fields (BS#1336).
      discogs_artist_id: album_metadata.discogs_artist_id,
      label: album_metadata.label,
      full_release_date: album_metadata.full_release_date,
      genres: album_metadata.genres,
      styles: album_metadata.styles,
      tracklist: album_metadata.tracklist,
      artist_image_url: album_metadata.artist_image_url,
      bio_tokens: album_metadata.bio_tokens,
    })
    .from(album_metadata)
    .where(eq(album_metadata.album_id, albumId))
    .limit(1);

  // `tracklist` / `bio_tokens` are untyped jsonb columns (the schema layer
  // takes no DTO dependency), so drizzle infers them as `unknown`. Cast to
  // the typed projection here — the enrichment-worker is the sole writer and
  // persists the LML DTO shapes verbatim.
  return (rows[0] ?? null) as PersistedAlbumMetadata | null;
}

/**
 * Cap on the number of snippets returned per album. The playcut detail view
 * shows a short list, and an unbounded array on this hot serve path is a
 * payload-size risk; a re-seed that somehow inserted dozens of rows for one
 * album shouldn't bloat every response. Newest-first (see ORDER BY below)
 * means the cap keeps the most recent coverage.
 */
const CRITIC_REVIEWS_LIMIT = 5;

/**
 * Attributed external critic snippets for an already-resolved `library.id`
 * (album-critic-reviews slice, ADR 0012). The caller resolves the id via
 * {@link resolveLinkedAlbumId} once and shares it with
 * {@link lookupAlbumMetadataById}, so a given request describes the same
 * album for both metadata and reviews.
 *
 * Returns `[]` (never `null`) when the album has no seeded snippets — the
 * caller attaches `criticReviews` only when the array is non-empty, so an
 * empty result keeps the response shape identical to an un-seeded album. This
 * read is independent of whether `album_metadata` enrichment has run: a linked
 * album with seeded reviews but no metadata row still surfaces its reviews.
 *
 * Ordered newest-first (`published_at DESC NULLS LAST`, then `id DESC` as a
 * stable tiebreak for undated rows and same-day rows) and capped at
 * `CRITIC_REVIEWS_LIMIT`. `published_at` is a `date` column; drizzle returns
 * it as an ISO `YYYY-MM-DD` string, which is exactly the `publishedDate`
 * wire shape.
 *
 * The return type is the generated `CriticReviewItem` from `@wxyc/shared`
 * (SSOT: the schema of the same name in wxyc-shared `api.yaml`, contract
 * WXYC/wxyc-shared#242). Only the six wire fields are surfaced; the internal
 * columns (`id`, `album_id`, `discogs_release_id`, `source_key`, timestamps)
 * never leave the service. `url` projects from the `source_url` column and
 * `publishedDate` from `published_at`; optional fields are omitted when null
 * so iOS `decodeIfPresent` and dj-site optional chaining stay
 * decode-compatible.
 */
export async function lookupCriticReviewsByAlbumId(albumId: number): Promise<CriticReviewItem[]> {
  const rows = await db
    .select({
      source: album_critic_reviews.source,
      source_url: album_critic_reviews.source_url,
      snippet: album_critic_reviews.snippet,
      author: album_critic_reviews.author,
      published_at: album_critic_reviews.published_at,
      rating: album_critic_reviews.rating,
    })
    .from(album_critic_reviews)
    .where(eq(album_critic_reviews.album_id, albumId))
    .orderBy(sql`${album_critic_reviews.published_at} DESC NULLS LAST`, desc(album_critic_reviews.id))
    .limit(CRITIC_REVIEWS_LIMIT);

  return rows.map(projectCriticReviewRow);
}

/**
 * Row shape shared by {@link lookupCriticReviewsByAlbumId} and
 * {@link lookupCriticReviewsByAlbumIds} — the six `album_critic_reviews`
 * columns both queries select (everything except the internal `id` /
 * `album_id` / `discogs_release_id` / `source_key` / timestamps).
 */
type CriticReviewRow = {
  source: string;
  source_url: string;
  snippet: string;
  author: string | null;
  published_at: string | null;
  rating: string | null;
};

/**
 * Project one `album_critic_reviews` row onto the wire shape, omitting
 * optional fields when null so the response carries only present keys
 * (matches the metadata handler's "assign only when present" convention).
 * Extracted so the single-album and batched lookups can't drift on the
 * projection (source → source, url ← source_url, publishedDate ←
 * published_at).
 */
function projectCriticReviewRow(row: CriticReviewRow): CriticReviewItem {
  const item: CriticReviewItem = {
    source: row.source,
    url: row.source_url,
    snippet: row.snippet,
  };
  if (row.author) item.author = row.author;
  if (row.published_at) item.publishedDate = row.published_at;
  if (row.rating) item.rating = row.rating;
  return item;
}

/**
 * Batched sibling of {@link lookupCriticReviewsByAlbumId} for flowsheet
 * feed-assembly (`attachCriticReviews`, album-critic-reviews slice / ADR
 * 0012). ONE query for a whole page's worth of linked track rows — a
 * `WHERE album_id = ANY(...)` scan against the same
 * `album_critic_reviews_album_id_source_url_uq` index the single-album read
 * uses — rather than one query per row (the no-N+1 guarantee `upcoming_show`
 * / `attachUpcomingShows` documents; project #32 perf posture).
 *
 * Returns `[]` immediately without touching the DB when `albumIds` is empty
 * (the caller's prefilter already short-circuits this in practice, but the
 * guard makes the function safe to call directly).
 *
 * Per-album ordering and cap match the single-album read exactly
 * (`published_at DESC NULLS LAST`, then `id DESC` as a stable tiebreak,
 * capped at `CRITIC_REVIEWS_LIMIT`): the query orders globally by
 * `(album_id, published_at DESC NULLS LAST, id DESC)` so every album's rows
 * arrive already in the right order, then this function groups them by
 * `album_id` in JS and stops appending once a bucket hits the cap — cheaper
 * than a `ROW_NUMBER() OVER (PARTITION BY album_id ...)` window for the
 * per-request row counts this endpoint sees, and it reuses
 * {@link projectCriticReviewRow} so the wire projection can't drift from the
 * single-album read.
 *
 * A key absent from the returned map means that album has no seeded
 * snippets — the caller (`attachCriticReviews`) treats "absent" and "empty
 * array" identically (both leave `critic_reviews` unset on the entry).
 */
export async function lookupCriticReviewsByAlbumIds(albumIds: number[]): Promise<Map<number, CriticReviewItem[]>> {
  const result = new Map<number, CriticReviewItem[]>();
  if (albumIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      album_id: album_critic_reviews.album_id,
      source: album_critic_reviews.source,
      source_url: album_critic_reviews.source_url,
      snippet: album_critic_reviews.snippet,
      author: album_critic_reviews.author,
      published_at: album_critic_reviews.published_at,
      rating: album_critic_reviews.rating,
    })
    .from(album_critic_reviews)
    .where(inArray(album_critic_reviews.album_id, albumIds))
    .orderBy(
      album_critic_reviews.album_id,
      sql`${album_critic_reviews.published_at} DESC NULLS LAST`,
      desc(album_critic_reviews.id)
    );

  for (const row of rows) {
    let bucket = result.get(row.album_id);
    if (bucket === undefined) {
      bucket = [];
      result.set(row.album_id, bucket);
    }
    // Rows for a given album_id arrive already newest-first (the ORDER BY
    // above), so capping here — rather than re-sorting per group — preserves
    // that order and just stops once a bucket is full.
    if (bucket.length < CRITIC_REVIEWS_LIMIT) {
      bucket.push(projectCriticReviewRow(row));
    }
  }

  return result;
}
