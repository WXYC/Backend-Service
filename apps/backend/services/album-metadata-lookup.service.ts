/**
 * Local lookup helper for the cache-first `/proxy/metadata/album` path
 * (BS#1331). Resolves an `(artistName, releaseTitle)` tuple against BS's
 * own persisted state — `album_metadata` keyed by the `album_id` of a
 * matching `flowsheet` row — so the steady-state read path skips the LML
 * cascade entirely.
 *
 * Query shape is a two-step lookup with the partial functional index
 * `flowsheet_album_link_lookup_idx` (migration 0081) doing the work:
 *   1. Find one `album_id` whose `flowsheet` row matches the normalized
 *      lookup key (`lower(trim(artist)) || '-' || lower(trim(coalesce(
 *      album, '')))`). The partial index's `WHERE album_id IS NOT NULL`
 *      predicate aligns with the explicit `WHERE` here so the planner
 *      uses the index without a sort.
 *   2. PK-lookup on `album_metadata` by that `album_id`.
 *
 * The two-step form avoids the `ORDER BY flowsheet.id DESC LIMIT 1` sort
 * cost on hot keys (a popular release played hundreds of times would
 * otherwise force the planner to materialize all matching flowsheet rows
 * before taking the head). All flowsheet rows for the same album resolve
 * to the same `album_metadata` row anyway, so the row-pick within a key
 * is degenerate as long as we land on one matching `album_id`.
 *
 * Returns the 10 base columns the proxy response is built from plus the 8
 * LML-only enrichment fields (`discogs_artist_id` / `label` /
 * `full_release_date` / `genres` / `styles` / `tracklist` /
 * `artist_image_url` / `bio_tokens`) added by BS#1336. Before that, those
 * fields lived only on the cold LML-fallthrough response, so a cache hit
 * shed the artist+release subtree (dj-site / iOS V1 gate the artist
 * sub-panel on `discogsArtistId`); the enrichment-worker now persists them
 * (`extended: true`) and the read path surfaces them, so a hit carries the
 * same shape as the cold path.
 *
 * `null` return means "no enriched local row for this key" — the caller
 * should fall through to LML. Free-form flowsheet rows (`album_id IS
 * NULL`) by definition can't hit, so iOS surfaces for those still pay
 * the LML round-trip. That's accepted scope: the cache-first goal
 * targets the linked-row cohort (the steady state for entries old enough
 * to be of interest to a detail-view fetch).
 */
import { sql, eq, desc } from 'drizzle-orm';
import { db, flowsheet, album_metadata, album_critic_reviews } from '@wxyc/database';
import type { DiscogsResolvedToken, DiscogsTrackItem } from '@wxyc/lml-client';

const flowsheetLookupKey = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

/**
 * JS-side normalized lookup key. The order of trim() and toLowerCase()
 * is irrelevant for the column shapes in flowsheet (artist names and
 * album titles are ASCII or Latin-1 in steady state), but match the SQL
 * literally for forward-compatibility with Unicode-bearing rows. PG's
 * `trim()` strips only ASCII space by default while JS `.trim()` strips
 * all Unicode whitespace — divergence can produce silent cache misses
 * on NBSP-padded inputs. Documented here so future maintainers see the
 * gap; aligning would require a generated column or a normalize_key()
 * SQL function (migration), so deferred.
 */
function lookupKey(artist: string, album?: string): string {
  return `${artist.toLowerCase().trim()}-${(album ?? '').toLowerCase().trim()}`;
}

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
 * Resolve `(artistName, releaseTitle)` against persisted state.
 * Returns the row's metadata, or `null` when no `album_id`-bearing
 * flowsheet row exists for the key. `null` means "cold — go to LML".
 *
 * An empty/whitespace-only `artistName` short-circuits to `null` (the
 * caller's 400 path runs first, but this guard means a key of `'-'`
 * — which any blank-artist linked row would also produce — can't
 * accidentally serve arbitrary metadata).
 *
 * `releaseTitle` is similarly required for a meaningful hit: an
 * undefined/blank releaseTitle keys into `'<artist>-'`, which matches
 * any linked flowsheet row whose DJ left `album_title` blank, returning
 * whichever `album_id` that row carried. The artist-card surfaces that
 * call this endpoint without a releaseTitle are better served by an
 * LML lookup or a dedicated artist-only handler.
 */
/**
 * Resolve `(artistName, releaseTitle)` to the `library.id` of a matching
 * linked flowsheet row, or `null` when no `album_id`-bearing flowsheet row
 * exists for the key. Shared Step-1 for both the album-metadata read
 * (`lookupAlbumMetadataByKey`) and the critic-reviews read
 * (`lookupCriticReviewsByAlbumKey`) so they resolve the *same* album key
 * for a given query.
 *
 * Uses the partial functional index `flowsheet_album_link_lookup_idx`. The
 * explicit `flowsheet.album_id IS NOT NULL` predicate matches the index's
 * WHERE clause verbatim so the planner uses the partial index. `ORDER BY
 * flowsheet.id DESC LIMIT 1` makes the row-pick deterministic on
 * multi-album_id keys (V/A multi-format, dual-pressing, librarian
 * duplicates — verified to exist in the live `album_id` corpus). Two
 * requests for the same lookup key resolve to the same row, eliminating a
 * flapping-response edge that would otherwise let iOS see two different
 * albums for the same query across polls. Sort cost is bounded: the
 * most-popular key has hundreds of matches, not thousands; the post-filter
 * `id DESC` sort on the small match set is sub-ms in practice.
 *
 * An empty/whitespace-only `artistName` or `releaseTitle` short-circuits to
 * `null`: the key `'<artist>-'` (blank release) would otherwise match any
 * linked flowsheet row whose DJ left `album_title` blank and return an
 * arbitrary `album_id`.
 */
async function resolveLinkedAlbumId(artistName: string, releaseTitle?: string): Promise<number | null> {
  const trimmedArtist = artistName.trim();
  const trimmedRelease = (releaseTitle ?? '').trim();
  if (trimmedArtist.length === 0 || trimmedRelease.length === 0) return null;

  const key = lookupKey(trimmedArtist, trimmedRelease);

  const candidate = await db
    .select({ album_id: flowsheet.album_id })
    .from(flowsheet)
    .where(sql`${flowsheetLookupKey} = ${key} AND ${flowsheet.album_id} IS NOT NULL`)
    .orderBy(desc(flowsheet.id))
    .limit(1);

  return candidate[0]?.album_id ?? null;
}

export async function lookupAlbumMetadataByKey(
  artistName: string,
  releaseTitle?: string
): Promise<PersistedAlbumMetadata | null> {
  // Step 1: resolve the album_id via the partial functional index.
  const albumId = await resolveLinkedAlbumId(artistName, releaseTitle);
  if (albumId === null) return null;

  // Step 2: PK-lookup on album_metadata. Returns null when the row
  // doesn't exist yet (race window: flowsheet INSERT landed but the
  // enrichment-worker hasn't UPSERTed album_metadata yet). Falling
  // through to LML in that window is the right behavior — the worker
  // is already paying the LML cost concurrently, but a stale or
  // pre-enrichment response would otherwise persist in the iOS cache
  // for the duration of the response Cache-Control TTL.
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
 * Wire projection of one external critic-review snippet, matching the
 * `CriticReviewItem` schema in wxyc-shared `api.yaml` (album-critic-reviews
 * slice, ADR 0012). Only the six wire fields are surfaced; the internal
 * columns (`id`, `album_id`, `discogs_release_id`, `source_key`, timestamps)
 * never leave the service. `url` maps to the `source_url` column;
 * `publishedDate` maps to `published_at`. Optional fields are omitted from
 * the response when null so iOS `decodeIfPresent` and dj-site optional
 * chaining stay decode-compatible.
 */
export interface CriticReviewItem {
  source: string;
  url: string;
  snippet: string;
  author?: string;
  publishedDate?: string;
  rating?: string;
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
 * Resolve `(artistName, releaseTitle)` to its attributed external critic
 * snippets (album-critic-reviews slice, ADR 0012). Shares Step-1
 * (`resolveLinkedAlbumId`) with `lookupAlbumMetadataByKey`, so a given query
 * resolves the same `library.id` for both metadata and reviews.
 *
 * Returns `[]` (never `null`) when the key doesn't resolve to a linked album
 * or the album has no seeded snippets — the caller attaches `criticReviews`
 * only when the array is non-empty, so an empty result keeps the response
 * shape identical to an un-seeded album.
 *
 * Ordered newest-first (`published_at DESC NULLS LAST`, then `id DESC` as a
 * stable tiebreak for undated rows and same-day rows) and capped at
 * `CRITIC_REVIEWS_LIMIT`. `published_at` is a `date` column; drizzle returns
 * it as an ISO `YYYY-MM-DD` string, which is exactly the `publishedDate`
 * wire shape.
 */
export async function lookupCriticReviewsByAlbumKey(
  artistName: string,
  releaseTitle?: string
): Promise<CriticReviewItem[]> {
  const albumId = await resolveLinkedAlbumId(artistName, releaseTitle);
  if (albumId === null) return [];

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

  // Project to the wire shape, omitting optional fields when null so the
  // response carries only present keys (matches the metadata handler's
  // "assign only when present" convention).
  return rows.map((row) => {
    const item: CriticReviewItem = {
      source: row.source,
      url: row.source_url,
      snippet: row.snippet,
    };
    if (row.author) item.author = row.author;
    if (row.published_at) item.publishedDate = row.published_at;
    if (row.rating) item.rating = row.rating;
    return item;
  });
}
