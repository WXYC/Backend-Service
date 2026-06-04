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
 * Returns the 10 columns the proxy response is built from. Excludes
 * LML-only enrichment fields (`genres` / `styles` / `tracklist` / `label`
 * / `discogs_artist_id` / `full_release_date` / `artist_image_url` /
 * `bio_tokens`) — those aren't on `album_metadata`. iOS V1 callers that
 * read those fields get them omitted on cache hit; the response is still
 * decode-compatible (every iOS V1 type marks them optional), but the
 * Playcut Detail card renders fewer chips. Re-fetching them from LML at
 * request time would defeat the cache-first goal; persisting them is the
 * follow-up path (a future album_metadata schema extension).
 *
 * `null` return means "no enriched local row for this key" — the caller
 * should fall through to LML. Free-form flowsheet rows (`album_id IS
 * NULL`) by definition can't hit, so iOS surfaces for those still pay
 * the LML round-trip. That's accepted scope: the cache-first goal
 * targets the linked-row cohort (the steady state for entries old enough
 * to be of interest to a detail-view fetch).
 */
import { sql, eq } from 'drizzle-orm';
import { db, flowsheet, album_metadata } from '@wxyc/database';

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
 * Persisted album metadata projection. Matches the 10 columns on
 * `album_metadata`. Read straight from `album_metadata` (no COALESCE
 * over `flowsheet.col`) — D3 made `album_metadata` the canonical write
 * target, and the sibling `playlist-proxy.service.ts` already reads
 * `album_metadata` directly. Less brittle to D4 (#900) which drops the
 * inline `flowsheet.*_url` columns.
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
export async function lookupAlbumMetadataByKey(
  artistName: string,
  releaseTitle?: string
): Promise<PersistedAlbumMetadata | null> {
  const trimmedArtist = artistName.trim();
  const trimmedRelease = (releaseTitle ?? '').trim();
  if (trimmedArtist.length === 0 || trimmedRelease.length === 0) return null;

  const key = lookupKey(trimmedArtist, trimmedRelease);

  // Step 1: find the album_id via the partial functional index. Explicit
  // `flowsheet.album_id IS NOT NULL` predicate matches the index's WHERE
  // clause verbatim so the planner uses the partial index regardless of
  // whether the SELECT projection happens to materialize the album_id.
  // LIMIT 1 short-circuits the index scan as soon as the first match
  // lands. The choice of "first" within a multi-album_id key is
  // unspecified (e.g. two physical formats of the same album sharing
  // artist+title text); the answer is degenerate for the common case
  // where album_metadata exists for the album_id and is fine for the
  // V/A multi-format edge — the proxy response is per-album anyway and
  // either album_id's metadata is a reasonable hit.
  const candidate = await db
    .select({ album_id: flowsheet.album_id })
    .from(flowsheet)
    .where(sql`${flowsheetLookupKey} = ${key} AND ${flowsheet.album_id} IS NOT NULL`)
    .limit(1);

  const albumId = candidate[0]?.album_id;
  if (albumId === undefined || albumId === null) return null;

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
    })
    .from(album_metadata)
    .where(eq(album_metadata.album_id, albumId))
    .limit(1);

  return rows[0] ?? null;
}
