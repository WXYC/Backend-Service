/**
 * Playlist proxy service.
 *
 * Subscribes to tubafrenzy's SSE stream at /playlists/recentStream, maintains
 * an in-memory copy of the current playlist, and enriches playcuts with
 * artwork URLs from the album_metadata table. Client requests are served
 * instantly from memory via getRecentEntries().
 *
 * Exported API:
 *   startPlaylistProxy() — open the SSE connection (call once at startup)
 *   getRecentEntries(n)  — current enriched playlist, sliced to n entries
 *   isConnected()        — true once the init event has been processed
 *
 * Internal helpers are also exported for testability:
 *   processInitEvent(data)    — parse + store the init payload
 *   processCreatedEvent(data) — add one entry
 *   processUpdatedEvent(data) — replace one entry
 *   processDeletedEvent(data) — remove one entry
 *   resetState()              — clear in-memory store (tests only)
 */
import { EventSource } from 'eventsource';
import { db, album_metadata } from '@wxyc/database';
import { inArray } from 'drizzle-orm';
import { generateAlbumCacheKey } from './metadata/metadata.cache.js';

const TUBAFRENZY_URL = process.env.TUBAFRENZY_URL ?? 'https://www.wxyc.info';

// --- Types ---

interface TubafrenzyPlaycutData {
  songTitle: string;
  artistName: string;
  releaseTitle: string;
  labelName: string;
  rotation: string;
  request: string;
}

interface TubafrenzyEntry {
  id: number;
  chronOrderID: number;
  hour: number;
  timeCreated: number;
  entryType: 'playcut' | 'talkset' | 'breakpoint' | 'showDelimiter';
  playcut?: TubafrenzyPlaycutData;
}

interface GroupedPlaycut {
  id: number;
  chronOrderID: number;
  hour: number;
  timeCreated: number;
  songTitle: string;
  artistName: string;
  releaseTitle: string;
  labelName: string;
  rotation: string;
  request: string;
  artworkURL?: string;
}

interface BaseEntry {
  id: number;
  chronOrderID: number;
  hour: number;
  timeCreated: number;
}

export interface GroupedResponse {
  playcuts: GroupedPlaycut[];
  talksets: BaseEntry[];
  breakpoints: BaseEntry[];
}

// --- In-memory store ---

let entries: TubafrenzyEntry[] = [];
let artworkMap: Map<number, string> = new Map(); // entry ID → artwork URL
let connected = false;

// --- Public API ---

/**
 * Whether the SSE connection has received its init event.
 */
export function isConnected(): boolean {
  return connected;
}

/**
 * Return the current enriched playlist, grouped by entry type.
 * Playcuts are sliced to `n`; talksets and breakpoints are returned in full.
 */
export function getRecentEntries(n: number): GroupedResponse {
  const playcuts: GroupedPlaycut[] = [];
  const talksets: BaseEntry[] = [];
  const breakpoints: BaseEntry[] = [];

  for (const entry of entries) {
    switch (entry.entryType) {
      case 'playcut':
        if (entry.playcut) {
          const grouped: GroupedPlaycut = {
            id: entry.id,
            chronOrderID: entry.chronOrderID,
            hour: entry.hour,
            timeCreated: entry.timeCreated,
            songTitle: entry.playcut.songTitle,
            artistName: entry.playcut.artistName,
            releaseTitle: entry.playcut.releaseTitle,
            labelName: entry.playcut.labelName,
            rotation: entry.playcut.rotation,
            request: entry.playcut.request,
          };
          const artwork = artworkMap.get(entry.id);
          if (artwork) {
            grouped.artworkURL = artwork;
          }
          playcuts.push(grouped);
        }
        break;
      case 'talkset':
        talksets.push({
          id: entry.id,
          chronOrderID: entry.chronOrderID,
          hour: entry.hour,
          timeCreated: entry.timeCreated,
        });
        break;
      case 'breakpoint':
        breakpoints.push({
          id: entry.id,
          chronOrderID: entry.chronOrderID,
          hour: entry.hour,
          timeCreated: entry.timeCreated,
        });
        break;
      // showDelimiter entries are omitted
    }
  }

  return {
    playcuts: playcuts.slice(0, n),
    talksets,
    breakpoints,
  };
}

/**
 * Open the SSE connection to tubafrenzy. Call once at startup.
 */
export function startPlaylistProxy(): void {
  connectSSE();
}

/**
 * Clear all in-memory state. For tests only.
 */
export function resetState(): void {
  entries = [];
  artworkMap = new Map();
  connected = false;
}

// --- SSE connection ---

let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
const HEARTBEAT_TIMEOUT = 60000;

function connectSSE(): void {
  const url = `${TUBAFRENZY_URL}/playlists/recentStream`;
  console.log(`[playlist-proxy] Connecting to SSE: ${url}`);

  const es = new EventSource(url);

  es.addEventListener('init', (event: MessageEvent) => {
    reconnectDelay = 1000; // reset backoff on successful connection
    resetHeartbeatTimer(es);
    processInitEvent(event.data).catch((err) =>
      console.error('[playlist-proxy] Error processing init event:', err)
    );
  });

  es.addEventListener('created', (event: MessageEvent) => {
    resetHeartbeatTimer(es);
    processCreatedEvent(event.data).catch((err) =>
      console.error('[playlist-proxy] Error processing created event:', err)
    );
  });

  es.addEventListener('updated', (event: MessageEvent) => {
    resetHeartbeatTimer(es);
    processUpdatedEvent(event.data).catch((err) =>
      console.error('[playlist-proxy] Error processing updated event:', err)
    );
  });

  es.addEventListener('deleted', (event: MessageEvent) => {
    resetHeartbeatTimer(es);
    processDeletedEvent(event.data);
  });

  es.addEventListener('error', () => {
    console.error(`[playlist-proxy] SSE error, reconnecting in ${reconnectDelay}ms`);
    clearHeartbeatTimer();
    es.close();
    setTimeout(() => connectSSE(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });
}

function resetHeartbeatTimer(es: EventSource): void {
  clearHeartbeatTimer();
  heartbeatTimer = setTimeout(() => {
    console.warn('[playlist-proxy] Heartbeat timeout, reconnecting');
    es.close();
    connectSSE();
  }, HEARTBEAT_TIMEOUT);
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// --- Event processing (exported for testability) ---

/**
 * Process the init event: replace the entire in-memory store.
 */
export async function processInitEvent(data: string): Promise<void> {
  const parsed: TubafrenzyEntry[] = JSON.parse(data);
  entries = parsed;
  connected = true;
  console.log(`[playlist-proxy] Init: ${entries.length} entries`);
  await enrichPlaycuts();
}

/**
 * Process a created event: add one entry to the store.
 */
export async function processCreatedEvent(data: string): Promise<void> {
  const entry: TubafrenzyEntry = JSON.parse(data);
  entries.unshift(entry);
  console.log(`[playlist-proxy] Created: ${entry.entryType} #${entry.id}`);
  if (entry.entryType === 'playcut' && entry.playcut) {
    await enrichSinglePlaycut(entry);
  }
}

/**
 * Process an updated event: replace an existing entry by id.
 */
export async function processUpdatedEvent(data: string): Promise<void> {
  const entry: TubafrenzyEntry = JSON.parse(data);
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx !== -1) {
    entries[idx] = entry;
  } else {
    entries.unshift(entry);
  }
  console.log(`[playlist-proxy] Updated: ${entry.entryType} #${entry.id}`);
  if (entry.entryType === 'playcut' && entry.playcut) {
    await enrichSinglePlaycut(entry);
  }
}

/**
 * Process a deleted event: remove an entry by id.
 */
export function processDeletedEvent(data: string): void {
  const { id } = JSON.parse(data) as { id: number };
  entries = entries.filter((e) => e.id !== id);
  artworkMap.delete(id);
  console.log(`[playlist-proxy] Deleted: #${id}`);
}

// --- Enrichment ---

/**
 * Batch-enrich all playcut entries with artwork URLs from album_metadata.
 */
async function enrichPlaycuts(): Promise<void> {
  const playcutEntries = entries.filter((e) => e.entryType === 'playcut' && e.playcut);
  if (playcutEntries.length === 0) return;

  const cacheKeyToIds = new Map<string, number[]>();
  for (const entry of playcutEntries) {
    const key = generateAlbumCacheKey(entry.playcut!.artistName, entry.playcut!.releaseTitle);
    const ids = cacheKeyToIds.get(key) ?? [];
    ids.push(entry.id);
    cacheKeyToIds.set(key, ids);
  }

  const cacheKeys = [...cacheKeyToIds.keys()];

  try {
    const rows = await db
      .select({
        cache_key: album_metadata.cache_key,
        artwork_url: album_metadata.artwork_url,
      })
      .from(album_metadata)
      .where(inArray(album_metadata.cache_key, cacheKeys));

    artworkMap = new Map();
    for (const row of rows) {
      if (row.cache_key && row.artwork_url) {
        const entryIds = cacheKeyToIds.get(row.cache_key);
        if (entryIds) {
          for (const id of entryIds) {
            artworkMap.set(id, row.artwork_url);
          }
        }
      }
    }

    console.log(`[playlist-proxy] Enriched ${artworkMap.size} playcuts with artwork`);
  } catch (err) {
    console.error('[playlist-proxy] DB enrichment failed, serving un-enriched entries:', err);
    // Graceful degradation: artworkMap stays empty/stale
  }
}

/**
 * Enrich a single playcut entry with artwork from album_metadata.
 */
async function enrichSinglePlaycut(entry: TubafrenzyEntry): Promise<void> {
  if (!entry.playcut) return;

  const cacheKey = generateAlbumCacheKey(entry.playcut.artistName, entry.playcut.releaseTitle);

  try {
    const rows = await db
      .select({
        cache_key: album_metadata.cache_key,
        artwork_url: album_metadata.artwork_url,
      })
      .from(album_metadata)
      .where(inArray(album_metadata.cache_key, [cacheKey]));

    if (rows.length > 0 && rows[0].artwork_url) {
      artworkMap.set(entry.id, rows[0].artwork_url);
    }
  } catch (err) {
    console.error(`[playlist-proxy] Failed to enrich entry #${entry.id}:`, err);
  }
}
