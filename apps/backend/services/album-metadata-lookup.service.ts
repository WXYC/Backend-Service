/**
 * Local lookup helper for the cache-first `/proxy/metadata/album` path
 * (BS#1331). Resolves an `(artistName, releaseTitle)` tuple against BS's
 * own persisted state — `album_metadata` joined to `flowsheet` via the
 * normalized lookup key — so the steady-state read path skips the LML
 * cascade entirely.
 *
 * The key, predicate, and JOIN shape match `playlist-proxy.service.ts`
 * deliberately so they share the partial functional index
 * `flowsheet_album_link_lookup_idx` (migration 0081). INNER JOIN to
 * `album_metadata` naturally drops `flowsheet.album_id IS NULL` rows
 * (FK can't match NULL), which mirrors the index's WHERE predicate so
 * the planner uses the partial index instead of seq-scanning the
 * ~2.6M-row flowsheet table.
 *
 * Returns the 10 metadata columns the proxy response is built from.
 * Excludes LML-only enrichment fields (genres/styles/tracklist/label/
 * discogs_artist_id/full_release_date/artist_image_url/bio_tokens) —
 * those aren't on `album_metadata`, and re-fetching them would defeat
 * the whole point of the cache-first path. iOS surfaces that already
 * tolerate their absence on the V2 inline read path (which projects
 * the same 10 columns) keep working unchanged.
 *
 * `null` return means "no enriched local row for this key" — the
 * caller should fall through to LML. A row with all metadata columns
 * NULL but yielding YT/BC/SC URLs (the BS#873 catch-arm shape) still
 * counts as a hit; per BS#1192 the proxy serves those persisted nulls
 * faithfully instead of laundering them with request-time search-URL
 * synthesis.
 */
import { sql, eq, and, desc } from 'drizzle-orm';
import { db, flowsheet, album_metadata } from '@wxyc/database';

const flowsheetLookupKey = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

function lookupKey(artist: string, album?: string): string {
  return `${artist.toLowerCase().trim()}-${(album ?? '').toLowerCase().trim()}`;
}

/**
 * Persisted album metadata projection. Matches the 10 columns on
 * `album_metadata`, served with the same `coalesce(album_metadata,
 * flowsheet)` precedence the V2 flowsheet endpoint uses
 * (`flowsheet.service.ts`) so the read paths stay consistent during
 * the Epic D dual-writer window.
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
 * Returns the most-recent (`ORDER BY flowsheet.id DESC LIMIT 1`)
 * matching row's coalesced metadata, or `null` when no enriched
 * `album_id`-bearing flowsheet row exists for the key. `null` means
 * "cold — go to LML"; a row with all-null columns means "catch-arm
 * shape — serve what BS already knows."
 */
export async function lookupAlbumMetadataByKey(
  artistName: string,
  releaseTitle?: string
): Promise<PersistedAlbumMetadata | null> {
  const key = lookupKey(artistName, releaseTitle);
  const rows = await db
    .select({
      artwork_url: sql<string | null>`coalesce(${album_metadata.artwork_url}, ${flowsheet.artwork_url})`,
      discogs_url: sql<string | null>`coalesce(${album_metadata.discogs_url}, ${flowsheet.discogs_url})`,
      release_year: sql<number | null>`coalesce(${album_metadata.release_year}, ${flowsheet.release_year})`,
      spotify_url: sql<string | null>`coalesce(${album_metadata.spotify_url}, ${flowsheet.spotify_url})`,
      apple_music_url: sql<string | null>`coalesce(${album_metadata.apple_music_url}, ${flowsheet.apple_music_url})`,
      youtube_music_url: sql<
        string | null
      >`coalesce(${album_metadata.youtube_music_url}, ${flowsheet.youtube_music_url})`,
      bandcamp_url: sql<string | null>`coalesce(${album_metadata.bandcamp_url}, ${flowsheet.bandcamp_url})`,
      soundcloud_url: sql<string | null>`coalesce(${album_metadata.soundcloud_url}, ${flowsheet.soundcloud_url})`,
      artist_bio: sql<string | null>`coalesce(${album_metadata.artist_bio}, ${flowsheet.artist_bio})`,
      artist_wikipedia_url: sql<
        string | null
      >`coalesce(${album_metadata.artist_wikipedia_url}, ${flowsheet.artist_wikipedia_url})`,
    })
    .from(flowsheet)
    .innerJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
    .where(and(eq(flowsheetLookupKey, key)))
    .orderBy(desc(flowsheet.id))
    .limit(1);

  return rows[0] ?? null;
}
