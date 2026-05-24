/**
 * Playlist proxy service.
 *
 * Subscribes to tubafrenzy's SSE stream at /playlists/recentStream, maintains
 * an in-memory copy of the current playlist, and enriches playcuts with
 * artwork URLs. During Epic D's dual-source transition, the enrichment uses
 * `COALESCE(album_metadata.artwork_url, flowsheet.artwork_url)` over a
 * LEFT JOIN — preferring the newer `album_metadata` table when populated,
 * falling back to the legacy inline column when it isn't. D4 (#900) will
 * drop the column and collapse the COALESCE; until then the dual-read
 * preserves the pre-D5 coverage. See BS#1012, BS#1042.
 * Client requests are served instantly from memory via getRecentEntries().
 *
 * Exported API:
 *   startPlaylistProxy() — open the SSE connection (call once at startup)
 *   stopPlaylistProxy()  — close the SSE connection and cancel pending reconnects
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
import { db, flowsheet, album_metadata } from '@wxyc/database';
import { sql, inArray, and, isNotNull, eq } from 'drizzle-orm';

const TUBAFRENZY_URL = process.env.TUBAFRENZY_URL ?? 'https://www.wxyc.info';
const MAX_ENTRIES = 200;

/** Compute a normalized lookup key from artist and album for matching against flowsheet rows. */
function lookupKey(artist: string, album: string): string {
  return `${artist.toLowerCase().trim()}-${album.toLowerCase().trim()}`;
}

/** SQL expression that computes the same lookup key from flowsheet columns. */
const flowsheetLookupKey = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

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
 * Close the SSE connection, cancel pending reconnects, and clear state.
 */
export function stopPlaylistProxy(): void {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connected = false;
}

/**
 * Clear all in-memory state. For tests only.
 */
export function resetState(): void {
  stopPlaylistProxy();
  entries = [];
  artworkMap = new Map();
}

// --- SSE connection ---
//
// Reconnection relies on two mechanisms:
//   1. The `eventsource` package detects TCP-level disconnections and
//      emits an `error` event, which triggers reconnection with backoff.
//   2. Tubafrenzy sends `:heartbeat` SSE comments every 30 seconds,
//      keeping the TCP connection alive so idle timeouts don't fire.
//
// There is intentionally no application-level heartbeat timer here.
// SSE comments are invisible to addEventListener (per the spec), so any
// timer that resets only on named events will misfire on an idle-but-alive
// connection, causing unnecessary reconnects and EventSource leaks.

let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
let currentEventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectSSE(): void {
  const url = `${TUBAFRENZY_URL}/playlists/recentStream`;
  console.log(`[playlist-proxy] Connecting to SSE: ${url}`);

  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  const es = new EventSource(url);
  currentEventSource = es;

  es.addEventListener('init', (event: MessageEvent) => {
    reconnectDelay = 1000;
    processInitEvent(event.data).catch((err) => console.error('[playlist-proxy] Error processing init event:', err));
  });

  es.addEventListener('created', (event: MessageEvent) => {
    processCreatedEvent(event.data).catch((err) =>
      console.error('[playlist-proxy] Error processing created event:', err)
    );
  });

  es.addEventListener('updated', (event: MessageEvent) => {
    processUpdatedEvent(event.data).catch((err) =>
      console.error('[playlist-proxy] Error processing updated event:', err)
    );
  });

  es.addEventListener('deleted', (event: MessageEvent) => {
    processDeletedEvent(event.data);
  });

  es.addEventListener('error', () => {
    console.error(`[playlist-proxy] SSE error, reconnecting in ${reconnectDelay}ms`);
    es.close();
    if (currentEventSource === es) currentEventSource = null;
    reconnectTimer = setTimeout(() => connectSSE(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  });
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

  // Trim oldest entries to prevent unbounded growth
  if (entries.length > MAX_ENTRIES) {
    const removed = entries.splice(MAX_ENTRIES);
    for (const r of removed) artworkMap.delete(r.id);
  }

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

/** COALESCE(album_metadata.artwork_url, flowsheet.artwork_url) — Epic D dual-source read. */
const coalescedArtworkUrl = sql<string>`coalesce(${album_metadata.artwork_url}, ${flowsheet.artwork_url})`;

/**
 * Batch-enrich all playcut entries with artwork URLs.
 *
 * Reads `COALESCE(album_metadata.artwork_url, flowsheet.artwork_url)` over a
 * LEFT JOIN — prefers the newer album_metadata source when populated, falls
 * back to flowsheet's inline column during the Epic D transition (BS#1042).
 *
 * The WHERE filters on `f.artwork_url IS NOT NULL` so the planner can use
 * the existing partial index `flowsheet_artwork_lookup_idx` (migration 0057)
 * for the lookup-key probe. That set is a strict subset of the OLD path's
 * coverage, so no pre-D5 keys are lost. Once album_metadata reaches parity
 * with flowsheet.artwork_url (BS#1042), D5's INNER-JOIN-only shape can
 * return and D4 (#900) can drop the column.
 */
async function enrichPlaycuts(): Promise<void> {
  const playcutEntries = entries.filter((e) => e.entryType === 'playcut' && e.playcut);
  if (playcutEntries.length === 0) return;

  const keyToIds = new Map<string, number[]>();
  for (const entry of playcutEntries) {
    const key = lookupKey(entry.playcut!.artistName, entry.playcut!.releaseTitle);
    const ids = keyToIds.get(key) ?? [];
    ids.push(entry.id);
    keyToIds.set(key, ids);
  }

  const keys = [...keyToIds.keys()];

  try {
    const rows = await db
      .select({
        key: flowsheetLookupKey,
        artwork_url: coalescedArtworkUrl,
      })
      .from(flowsheet)
      .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
      .where(and(inArray(flowsheetLookupKey, keys), isNotNull(flowsheet.artwork_url)))
      .groupBy(flowsheetLookupKey, coalescedArtworkUrl);

    // Build new map and only swap on success — preserves existing artwork on DB failure
    const newMap = new Map<number, string>();
    for (const row of rows) {
      if (row.key && row.artwork_url) {
        const entryIds = keyToIds.get(row.key);
        if (entryIds) {
          for (const id of entryIds) {
            newMap.set(id, row.artwork_url);
          }
        }
      }
    }
    artworkMap = newMap;

    console.log(`[playlist-proxy] Enriched ${artworkMap.size} playcuts with artwork`);
  } catch (err) {
    console.error('[playlist-proxy] DB enrichment failed, preserving existing artwork data:', err);
  }
}

/**
 * Enrich a single playcut entry with artwork. Same COALESCE + LEFT JOIN +
 * partial-index alignment as enrichPlaycuts — see comment there.
 */
async function enrichSinglePlaycut(entry: TubafrenzyEntry): Promise<void> {
  if (!entry.playcut) return;

  const key = lookupKey(entry.playcut.artistName, entry.playcut.releaseTitle);

  try {
    const rows = await db
      .select({ artwork_url: coalescedArtworkUrl })
      .from(flowsheet)
      .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
      .where(and(inArray(flowsheetLookupKey, [key]), isNotNull(flowsheet.artwork_url)))
      .limit(1);

    if (rows.length > 0 && rows[0].artwork_url) {
      artworkMap.set(entry.id, rows[0].artwork_url);
    }
  } catch (err) {
    console.error(`[playlist-proxy] Failed to enrich entry #${entry.id}:`, err);
  }
}
