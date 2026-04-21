import { sql } from 'drizzle-orm';
import { db, artists, library, flowsheet, library_artist_view, compilation_track_artist } from '@wxyc/database';

export type SuggestTrackResult = {
  track_title: string;
  album_title: string | null;
  record_label: string | null;
};

export type TrackDetailsResult = {
  album_title: string | null;
  record_label: string | null;
};

/**
 * Suggest artist names matching a prefix, ordered by total plays descending.
 *
 * Queries the library `artists` table (canonical catalog) using prefix ILIKE.
 */
export async function suggestArtists(prefix: string, limit = 5): Promise<string[]> {
  const query = sql`
    SELECT ${artists.artist_name} AS artist_name, SUM(COALESCE(${library.plays}, 0)) AS total_plays
    FROM ${artists}
    JOIN ${library} ON ${library.artist_id} = ${artists.id}
    WHERE ${artists.artist_name} ILIKE ${prefix + '%'}
    GROUP BY ${artists.artist_name}
    ORDER BY total_plays DESC
    LIMIT ${limit}
  `;

  const rows = await db.execute(query);
  return (rows as unknown as Array<{ artist_name: string }>).map((r) => r.artist_name);
}

/**
 * Suggest track titles for an artist, ordered by most recently played.
 *
 * Queries the flowsheet table (tracks that have been played on WXYC)
 * and compilation_track_artist as a secondary source. Returns the most
 * recent album_title and record_label for each matching track.
 */
export async function suggestTracks(prefix: string, artistName: string, limit = 5): Promise<SuggestTrackResult[]> {
  // Primary: flowsheet history
  const flowsheetQuery = sql`
    SELECT DISTINCT ON (${flowsheet.track_title})
      ${flowsheet.track_title} AS track_title,
      ${flowsheet.album_title} AS album_title,
      ${flowsheet.record_label} AS record_label
    FROM ${flowsheet}
    WHERE ${flowsheet.artist_name} ILIKE ${artistName}
      AND ${flowsheet.track_title} ILIKE ${prefix + '%'}
      AND ${flowsheet.entry_type} = 'track'
    ORDER BY ${flowsheet.track_title}, ${flowsheet.add_time} DESC
    LIMIT ${limit}
  `;

  const flowsheetRows = await db.execute(flowsheetQuery);
  const results = flowsheetRows as unknown as SuggestTrackResult[];

  if (results.length >= limit) {
    return results;
  }

  // Secondary: compilation track artist table
  const existingTitles = results.map((r) => r.track_title.toLowerCase());
  const ctaQuery = sql`
    SELECT ${compilation_track_artist.track_title} AS track_title,
           ${library.album_title} AS album_title,
           ${library.label} AS record_label
    FROM ${compilation_track_artist}
    JOIN ${library} ON ${library.id} = ${compilation_track_artist.library_id}
    WHERE ${compilation_track_artist.artist_name} ILIKE ${artistName}
      AND ${compilation_track_artist.track_title} ILIKE ${prefix + '%'}
    LIMIT ${limit}
  `;

  const ctaRows = await db.execute(ctaQuery);
  const ctaResults = ctaRows as unknown as SuggestTrackResult[];

  // Merge, deduplicating by track title
  for (const row of ctaResults) {
    if (results.length >= limit) break;
    if (!existingTitles.includes(row.track_title.toLowerCase())) {
      results.push(row);
      existingTitles.push(row.track_title.toLowerCase());
    }
  }

  return results;
}

/**
 * Get album and label for a confirmed artist + track combination.
 *
 * Checks flowsheet first (most recent play), then falls back to
 * library_artist_view for catalog entries.
 */
export async function getTrackDetails(artistName: string, trackTitle: string): Promise<TrackDetailsResult | null> {
  // Flowsheet: most recent play
  const flowsheetQuery = sql`
    SELECT ${flowsheet.album_title} AS album_title, ${flowsheet.record_label} AS record_label
    FROM ${flowsheet}
    WHERE ${flowsheet.artist_name} ILIKE ${artistName}
      AND ${flowsheet.track_title} ILIKE ${trackTitle}
      AND ${flowsheet.entry_type} = 'track'
    ORDER BY ${flowsheet.add_time} DESC
    LIMIT 1
  `;

  const flowsheetRows = await db.execute(flowsheetQuery);
  const flowsheetResults = flowsheetRows as unknown as TrackDetailsResult[];

  if (flowsheetResults.length > 0 && (flowsheetResults[0].album_title || flowsheetResults[0].record_label)) {
    return flowsheetResults[0];
  }

  // Fallback: library catalog (album + label by artist name)
  const libraryQuery = sql`
    SELECT ${library_artist_view.album_title} AS album_title,
           ${library_artist_view.label} AS record_label
    FROM ${library_artist_view}
    WHERE ${library_artist_view.artist_name} ILIKE ${artistName}
    ORDER BY ${library_artist_view.album_title}
    LIMIT 1
  `;

  const libraryRows = await db.execute(libraryQuery);
  const libraryResults = libraryRows as unknown as Array<{ album_title: string | null; record_label: string | null }>;

  if (libraryResults.length > 0) {
    return libraryResults[0];
  }

  return null;
}
