/**
 * Local read helpers backing the cache-first `/proxy/metadata/album` path
 * (BS#1331) and the external critic-review snippets attached to it
 * (album-critic-reviews slice, ADR 0012). All three read BS's own persisted
 * state so the steady-state serve path skips the LML cascade entirely.
 *
 * Three exported helpers, keyed on the `album_id` of a matching `flowsheet`
 * row and staged so the handler resolves that id exactly once per request:
 *   - {@link resolveLinkedAlbumId} — normalized `(artist, release)` key →
 *     one `library.id`, via the partial functional index
 *     `flowsheet_album_link_lookup_idx` (migration 0081). Deterministic
 *     `ORDER BY flowsheet.id DESC LIMIT 1` row-pick so multi-`album_id` keys
 *     (V/A multi-format, dual-pressings, librarian duplicates) can't flap
 *     between distinct albums across polls.
 *   - {@link lookupAlbumMetadataById} — PK-lookup on `album_metadata` for a
 *     resolved id; the 10 base columns the proxy response is built from plus
 *     the 8 LML-only enrichment fields (`discogs_artist_id` / `label` /
 *     `full_release_date` / `genres` / `styles` / `tracklist` /
 *     `artist_image_url` / `bio_tokens`, BS#1336) so a cache hit carries the
 *     same shape as the cold LML-fallthrough path.
 *   - {@link lookupCriticReviewsByAlbumId} — up to `CRITIC_REVIEWS_LIMIT`
 *     attributed snippets for a resolved id, independent of whether
 *     `album_metadata` enrichment has run.
 *
 * The `/proxy/metadata/album` handler calls {@link resolveLinkedAlbumId}
 * once and feeds the id to both the metadata and reviews reads, so a
 * concurrent flowsheet insert can't make the two reads describe two
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
 * Resolve `(artistName, releaseTitle)` to the `library.id` of a matching
 * linked flowsheet row, or `null` when no `album_id`-bearing flowsheet row
 * exists for the key. Shared Step-1 for both the album-metadata read
 * (`lookupAlbumMetadataById`) and the critic-reviews read
 * (`lookupCriticReviewsByAlbumId`). Callers that need both — the
 * `/proxy/metadata/album` handler — resolve the key *once* here and pass the
 * id to both reads, so a concurrent flowsheet insert can't make the two
 * reads disagree on which album they describe. The seed writer
 * (`scripts/seed-critic-reviews.ts`) imports this to key its UPSERTs against
 * the exact same normalized flowsheet key the serve path reads.
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
export async function resolveLinkedAlbumId(artistName: string, releaseTitle?: string): Promise<number | null> {
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
 * Wire projection of one external critic-review snippet (album-critic-reviews
 * slice, ADR 0012). Only the six wire fields are surfaced; the internal columns
 * (`id`, `album_id`, `discogs_release_id`, `source_key`, timestamps) never
 * leave the service. `url` maps to the `source_url` column; `publishedDate`
 * maps to `published_at`. Optional fields are omitted from the response when
 * null so iOS `decodeIfPresent` and dj-site optional chaining stay
 * decode-compatible.
 *
 * SSOT: the canonical shape is the `CriticReviewItem` schema in wxyc-shared
 * `api.yaml` (contract WXYC/wxyc-shared#242, PR WXYC/wxyc-shared#243). That PR
 * must merge and `@wxyc/shared` must publish before this endpoint change ships
 * — the dependency is encoded as BS#1719 blocked-by wxyc-shared#242 so the
 * specs can't drift. This interface is a deliberate temporary hand-mirror kept
 * field-for-field in sync with that schema; once the generated type is
 * published, replace this declaration with an import of the generated
 * `CriticReviewItem` (this is the only local copy — the controller and seed
 * both consume it from here).
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
