/**
 * HTTP client for the tubafrenzy mirror API.
 *
 * Replaces raw SQL for addEntry/updateEntry mirror operations.
 * Calls POST/PATCH on tubafrenzy's /playlists/api/flowsheetEntry endpoint,
 * which goes through FlowsheetEntryService so listeners (cache, SSE, Lucene) fire.
 */

const TUBAFRENZY_URL = process.env.TUBAFRENZY_URL ?? 'https://www.wxyc.info';
const MIRROR_API_KEY = process.env.MIRROR_API_KEY ?? '';

/** In-memory map: Backend-Service play_order → tubafrenzy entry ID */
const entryIdMap = new Map<number, number>();

interface MirrorEntry {
  entry_type: string;
  artist_name?: string | null;
  track_title?: string | null;
  album_title?: string | null;
  record_label?: string | null;
  album_id?: number | null;
  rotation_id?: number | null;
  request_flag?: boolean;
  message?: string | null;
  add_time?: Date | string | number | null;
  play_order: number;
}

/**
 * POST a new entry to tubafrenzy. Returns the created entry's ID, or null on failure.
 * Never throws — errors are logged and swallowed (fire-and-forget).
 */
export async function mirrorCreateEntry(body: Record<string, unknown>): Promise<number | null> {
  try {
    const response = await fetch(`${TUBAFRENZY_URL}/playlists/api/flowsheetEntry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIRROR_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[mirror] POST failed: ${response.status} ${text}`);
      return null;
    }
    const json = await response.json();
    return json.id ?? null;
  } catch (e) {
    console.error('[mirror] POST error:', e);
    return null;
  }
}

/**
 * PATCH an existing entry on tubafrenzy by its tubafrenzy ID.
 * Never throws — errors are logged and swallowed (fire-and-forget).
 */
export async function mirrorUpdateEntry(
  tubafrenzyId: number,
  body: Record<string, unknown>
): Promise<void> {
  try {
    const response = await fetch(`${TUBAFRENZY_URL}/playlists/api/flowsheetEntry`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MIRROR_API_KEY}`,
      },
      body: JSON.stringify({ id: tubafrenzyId, ...body }),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[mirror] PATCH failed: ${response.status} ${text}`);
    }
  } catch (e) {
    console.error('[mirror] PATCH error:', e);
  }
}

export function cacheEntryId(playOrder: number, tubafrenzyId: number): void {
  entryIdMap.set(playOrder, tubafrenzyId);
}

export function getCachedEntryId(playOrder: number): number | undefined {
  return entryIdMap.get(playOrder);
}

export function clearEntryIdMap(): void {
  entryIdMap.clear();
}

/**
 * Maps a Backend-Service FSEntry to the tubafrenzy POST JSON body.
 * radioShowID is omitted — tubafrenzy auto-resolves from the current show.
 * nowPlayingFlag is always 0 (dropped — nothing in tubafrenzy reads it).
 */
export function mapEntryToTubafrenzy(entry: MirrorEntry): Record<string, unknown> {
  const startMs = entry.add_time ? new Date(entry.add_time as any).getTime() : Date.now();
  const radioHour = Math.floor(startMs / 3_600_000) * 3_600_000;

  const entryType = entry.entry_type;

  // Non-track entries
  if (isNonTrackEntry(entryType, entry.message)) {
    let message = entry.message?.trim() ?? '';
    let flowsheetEntryType = 7; // default talkset
    let startTime = 0;

    if (entryType === 'show_start') {
      flowsheetEntryType = 9;
      startTime = startMs;
    } else if (entryType === 'show_end') {
      flowsheetEntryType = 10;
      startTime = startMs;
    } else if (entryType === 'dj_join' || entryType === 'dj_leave') {
      flowsheetEntryType = 7;
    } else if (entryType === 'talkset' || entryType === 'message') {
      flowsheetEntryType = 7;
      message = '------ talkset -------';
    } else if (entryType === 'breakpoint') {
      flowsheetEntryType = 8;
      message = message.toUpperCase() || 'BREAKPOINT';
    } else {
      // Legacy pattern matching
      if (message.toLowerCase().includes('breakpoint')) {
        flowsheetEntryType = 8;
        message = message.toUpperCase();
      } else if (
        message.toLowerCase().includes('start of show') ||
        message.toLowerCase().includes('signed on')
      ) {
        flowsheetEntryType = 9;
        startTime = startMs;
      } else if (
        message.toLowerCase().includes('end of show') ||
        message.toLowerCase().includes('signed off')
      ) {
        flowsheetEntryType = 10;
        startTime = startMs;
      } else {
        message = '------ talkset -------';
      }
    }

    return {
      radioHour,
      flowsheetEntryType,
      artistName: message,
      startTime,
    };
  }

  // Track entries
  let flowsheetEntryType = 0;
  if (entry.rotation_id && entry.rotation_id > 0) {
    flowsheetEntryType = 2;
  } else if (entry.album_id && entry.album_id > 0) {
    flowsheetEntryType = 6;
  }

  return {
    radioHour,
    flowsheetEntryType,
    artistName: entry.artist_name ?? '',
    songTitle: entry.track_title ?? '',
    releaseTitle: entry.album_title ?? '',
    labelName: entry.record_label ?? '',
    request: entry.request_flag ?? false,
    nowPlayingFlag: 0,
    libraryReleaseID: entry.album_id ?? 0,
    rotationReleaseID: entry.rotation_id ?? 0,
  };
}

/**
 * Maps a Backend-Service FSEntry to the tubafrenzy PATCH JSON body.
 * Only includes fields that can be updated on an existing entry.
 */
export function mapUpdateToTubafrenzy(entry: MirrorEntry): Record<string, unknown> {
  let flowsheetEntryType = 0;
  if (entry.rotation_id && entry.rotation_id > 0) {
    flowsheetEntryType = 2;
  } else if (entry.album_id && entry.album_id > 0) {
    flowsheetEntryType = 6;
  }

  return {
    artistName: entry.artist_name ?? '',
    songTitle: entry.track_title ?? '',
    releaseTitle: entry.album_title ?? '',
    labelName: entry.record_label ?? '',
    request: entry.request_flag ?? false,
    libraryReleaseID: entry.album_id ?? 0,
    rotationReleaseID: entry.rotation_id ?? 0,
    flowsheetEntryType,
  };
}

function isNonTrackEntry(entryType: string, message?: string | null): boolean {
  return (
    entryType === 'show_start' ||
    entryType === 'show_end' ||
    entryType === 'dj_join' ||
    entryType === 'dj_leave' ||
    entryType === 'talkset' ||
    entryType === 'breakpoint' ||
    entryType === 'message' ||
    (!!message?.trim() && entryType !== 'track')
  );
}
