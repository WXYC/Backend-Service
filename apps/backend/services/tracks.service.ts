import { sql, eq, and, desc, isNotNull } from 'drizzle-orm';
import { db } from '../../../shared/database/src/client.js';
import {
  tracks,
  NewTrack,
  Track,
  flowsheet,
  bins,
  library,
  artists,
  rotation,
  album_metadata,
} from '@wxyc/database';
import { TrackSearchResult, TrackSearchParams } from '@wxyc/shared';
import { DiscogsProvider } from './metadata/providers/discogs.provider.js';

const discogsProvider = new DiscogsProvider();

/**
 * Search for tracks across cached Discogs tracks, flowsheet history, and DJ bins.
 * Results are deduplicated and ordered by rotation albums first, then similarity score.
 */
export async function searchTracks(params: TrackSearchParams): Promise<TrackSearchResult[]> {
  const { song, artist, album, label, n = 10 } = params;

  // Execute all three searches in parallel
  const [discogsResults, flowsheetResults, binResults] = await Promise.all([
    searchDiscogsTracksCache(song, artist, album, label, n),
    searchFlowsheetHistory(song, artist, album, label, n),
    searchBins(song, artist, album, label, n),
  ]);

  // Merge and deduplicate results
  const merged = deduplicateResults([...discogsResults, ...flowsheetResults, ...binResults]);

  // Sort: rotation albums first, then by title match
  merged.sort((a, b) => {
    // Rotation items come first
    if (a.rotation_id && !b.rotation_id) return -1;
    if (!a.rotation_id && b.rotation_id) return 1;

    // Within rotation, higher frequency comes first (H > M > L > S)
    if (a.rotation_id && b.rotation_id) {
      const freqOrder: Record<string, number> = { H: 4, M: 3, L: 2, S: 1 };
      const freqA = a.rotation_bin ? freqOrder[a.rotation_bin] || 0 : 0;
      const freqB = b.rotation_bin ? freqOrder[b.rotation_bin] || 0 : 0;
      if (freqA !== freqB) return freqB - freqA;
    }

    // Then prefer Discogs source (most accurate data)
    if (a.source === 'discogs' && b.source !== 'discogs') return -1;
    if (a.source !== 'discogs' && b.source === 'discogs') return 1;

    return 0;
  });

  return merged.slice(0, n);
}

/**
 * Search cached Discogs tracks using trigram similarity.
 */
async function searchDiscogsTracksCache(
  song: string,
  artist?: string,
  album?: string,
  label?: string,
  limit = 10
): Promise<TrackSearchResult[]> {
  // Build dynamic WHERE clause
  let whereClause = sql`${tracks.title} % ${song}`;

  if (artist) {
    whereClause = sql`${whereClause} AND ${tracks.artist_name} % ${artist}`;
  }
  if (album) {
    whereClause = sql`${whereClause} AND ${tracks.album_title} % ${album}`;
  }

  // Query tracks with rotation info
  const query = sql`
    SELECT
      t.id as track_id,
      t.title,
      t.position,
      t.duration,
      t.album_id,
      t.album_title,
      t.artist_name,
      l.label,
      r.id as rotation_id,
      r.play_freq,
      t.title <-> ${song} as title_dist
    FROM wxyc_schema.tracks t
    LEFT JOIN wxyc_schema.library l ON l.id = t.album_id
    LEFT JOIN wxyc_schema.rotation r ON r.album_id = t.album_id
      AND (r.kill_date > CURRENT_DATE OR r.kill_date IS NULL)
    WHERE ${whereClause}
    ${label ? sql`AND l.label % ${label}` : sql``}
    ORDER BY title_dist ASC
    LIMIT ${limit}
  `;

  const results = await db.execute(query);

  return (results.rows as any[]).map((row) => ({
    track_id: row.track_id,
    title: row.title,
    position: row.position,
    duration: row.duration,
    album_id: row.album_id,
    album_title: row.album_title,
    artist_name: row.artist_name,
    label: row.label,
    rotation_id: row.rotation_id,
    rotation_bin: row.play_freq, // Map DB column to API field
    source: 'discogs' as const,
  }));
}

/**
 * Search flowsheet history for previously played tracks.
 */
async function searchFlowsheetHistory(
  song: string,
  artist?: string,
  album?: string,
  label?: string,
  limit = 10
): Promise<TrackSearchResult[]> {
  let whereClause = sql`f.track_title % ${song} AND f.track_title IS NOT NULL`;

  if (artist) {
    whereClause = sql`${whereClause} AND f.artist_name % ${artist}`;
  }
  if (album) {
    whereClause = sql`${whereClause} AND f.album_title % ${album}`;
  }
  if (label) {
    whereClause = sql`${whereClause} AND f.record_label % ${label}`;
  }

  const query = sql`
    SELECT DISTINCT ON (f.track_title, f.artist_name, f.album_title)
      f.track_title as title,
      f.album_id,
      f.album_title,
      f.artist_name,
      f.record_label as label,
      r.id as rotation_id,
      r.play_freq,
      f.track_title <-> ${song} as title_dist
    FROM wxyc_schema.flowsheet f
    LEFT JOIN wxyc_schema.rotation r ON r.id = f.rotation_id
      AND (r.kill_date > CURRENT_DATE OR r.kill_date IS NULL)
    WHERE ${whereClause}
    ORDER BY f.track_title, f.artist_name, f.album_title, title_dist ASC
    LIMIT ${limit}
  `;

  const results = await db.execute(query);

  return (results.rows as any[]).map((row) => ({
    title: row.title,
    album_id: row.album_id,
    album_title: row.album_title || '',
    artist_name: row.artist_name || '',
    label: row.label,
    rotation_id: row.rotation_id,
    rotation_bin: row.play_freq, // Map DB column to API field
    source: 'flowsheet' as const,
  }));
}

/**
 * Search DJ bin entries for saved tracks.
 */
async function searchBins(
  song: string,
  artist?: string,
  album?: string,
  label?: string,
  limit = 10
): Promise<TrackSearchResult[]> {
  let whereClause = sql`b.track_title % ${song} AND b.track_title IS NOT NULL`;

  // Build join conditions for filtering
  const joinLibrary = artist || album || label;

  const query = sql`
    SELECT DISTINCT ON (b.track_title, a.artist_name, l.album_title)
      b.track_title as title,
      b.album_id,
      l.album_title,
      a.artist_name,
      l.label,
      r.id as rotation_id,
      r.play_freq,
      b.track_title <-> ${song} as title_dist
    FROM wxyc_schema.bins b
    INNER JOIN wxyc_schema.library l ON l.id = b.album_id
    INNER JOIN wxyc_schema.artists a ON a.id = l.artist_id
    LEFT JOIN wxyc_schema.rotation r ON r.album_id = b.album_id
      AND (r.kill_date > CURRENT_DATE OR r.kill_date IS NULL)
    WHERE ${whereClause}
    ${artist ? sql`AND a.artist_name % ${artist}` : sql``}
    ${album ? sql`AND l.album_title % ${album}` : sql``}
    ${label ? sql`AND l.label % ${label}` : sql``}
    ORDER BY b.track_title, a.artist_name, l.album_title, title_dist ASC
    LIMIT ${limit}
  `;

  const results = await db.execute(query);

  return (results.rows as any[]).map((row) => ({
    title: row.title,
    album_id: row.album_id,
    album_title: row.album_title || '',
    artist_name: row.artist_name || '',
    label: row.label,
    rotation_id: row.rotation_id,
    rotation_bin: row.play_freq, // Map DB column to API field
    source: 'bin' as const,
  }));
}

/**
 * Deduplicate search results based on track title + artist + album.
 * Prefer entries with more complete data (track_id, rotation info).
 */
function deduplicateResults(results: TrackSearchResult[]): TrackSearchResult[] {
  const seen = new Map<string, TrackSearchResult>();

  for (const result of results) {
    const key = `${result.title?.toLowerCase()}|${result.artist_name?.toLowerCase()}|${result.album_title?.toLowerCase()}`;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, result);
    } else {
      // Prefer entries with track_id (from Discogs cache)
      if (!existing.track_id && result.track_id) {
        seen.set(key, result);
      }
      // Prefer entries with rotation info
      else if (!existing.rotation_id && result.rotation_id) {
        seen.set(key, result);
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Fetch tracklist from Discogs and cache in the tracks table.
 */
export async function fetchAndCacheTracksForAlbum(
  albumId: number,
  artistName: string,
  albumTitle: string
): Promise<Track[]> {
  // Check if we already have tracks cached for this album
  const existingTracks = await getTracksForAlbum(albumId);
  if (existingTracks.length > 0) {
    return existingTracks;
  }

  // Check if we have a cached Discogs release ID
  const metadata = await db
    .select({ discogs_release_id: album_metadata.discogs_release_id })
    .from(album_metadata)
    .where(eq(album_metadata.album_id, albumId))
    .limit(1);

  let discogsReleaseId = metadata[0]?.discogs_release_id;

  // If no cached release ID, search Discogs
  if (!discogsReleaseId) {
    const searchResult = await discogsProvider.searchRelease(artistName, albumTitle);
    if (!searchResult) {
      console.log(`[TracksService] No Discogs release found for: ${artistName} - ${albumTitle}`);
      return [];
    }
    discogsReleaseId = searchResult.id;
  }

  // Fetch release details with tracklist
  const releaseDetails = await discogsProvider.getReleaseDetails(discogsReleaseId);
  if (!releaseDetails?.tracklist || releaseDetails.tracklist.length === 0) {
    console.log(`[TracksService] No tracklist found for release ID: ${discogsReleaseId}`);
    return [];
  }

  // Insert tracks into cache
  const newTracks: NewTrack[] = releaseDetails.tracklist
    .filter((track) => track.type_ === 'track' || !track.type_) // Filter out headings, etc.
    .map((track) => ({
      album_id: albumId,
      discogs_release_id: discogsReleaseId!,
      position: track.position || undefined,
      title: track.title,
      duration: track.duration || undefined,
      artist_name: artistName,
      album_title: albumTitle,
    }));

  if (newTracks.length === 0) {
    return [];
  }

  const insertedTracks = await db.insert(tracks).values(newTracks).returning();
  console.log(`[TracksService] Cached ${insertedTracks.length} tracks for album ID: ${albumId}`);

  return insertedTracks;
}

/**
 * Get cached tracks for an album.
 */
export async function getTracksForAlbum(albumId: number): Promise<Track[]> {
  return db
    .select()
    .from(tracks)
    .where(eq(tracks.album_id, albumId))
    .orderBy(tracks.position);
}

/**
 * Get rotation albums that don't have cached tracks yet.
 */
export async function getRotationAlbumsWithoutTracks(): Promise<
  Array<{ album_id: number; artist_name: string; album_title: string }>
> {
  const query = sql`
    SELECT DISTINCT
      l.id as album_id,
      a.artist_name,
      l.album_title
    FROM wxyc_schema.rotation r
    INNER JOIN wxyc_schema.library l ON l.id = r.album_id
    INNER JOIN wxyc_schema.artists a ON a.id = l.artist_id
    LEFT JOIN wxyc_schema.tracks t ON t.album_id = l.id
    WHERE (r.kill_date > CURRENT_DATE OR r.kill_date IS NULL)
      AND t.id IS NULL
    ORDER BY l.album_title
  `;

  const results = await db.execute(query);
  return results.rows as Array<{ album_id: number; artist_name: string; album_title: string }>;
}

/**
 * Get recently-played albums (last 30 days) that don't have cached tracks.
 */
export async function getRecentlyPlayedAlbumsWithoutTracks(): Promise<
  Array<{ album_id: number; artist_name: string; album_title: string }>
> {
  const query = sql`
    SELECT DISTINCT
      f.album_id,
      f.artist_name,
      f.album_title
    FROM wxyc_schema.flowsheet f
    LEFT JOIN wxyc_schema.tracks t ON t.album_id = f.album_id
    WHERE f.album_id IS NOT NULL
      AND f.add_time > CURRENT_DATE - INTERVAL '30 days'
      AND t.id IS NULL
      AND f.artist_name IS NOT NULL
      AND f.album_title IS NOT NULL
    ORDER BY f.album_title
  `;

  const results = await db.execute(query);
  return results.rows as Array<{ album_id: number; artist_name: string; album_title: string }>;
}
