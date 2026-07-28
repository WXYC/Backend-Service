/**
 * Playlist proxy service.
 *
 * Historically this subscribed to tubafrenzy's SSE stream at
 * /playlists/recentStream and served GET /playlists/recentEntries from an
 * in-memory copy of the last 200 entries. WXYC/wiki#88 (Phase 3 of the
 * tubafrenzy decommission) removes tubafrenzy's outbound HTTP surface, so
 * this service now sources the same public contract directly from
 * Backend-Service's own Postgres `flowsheet` table.
 *
 * Query shape: the most recent MAX_ENTRIES (200) flowsheet rows (any
 * entry_type, ordered by flowsheet.id DESC — the same "most recent"
 * convention `flowsheet.service.ts`'s `getEntriesByPage` uses, since
 * flowsheet.id is globally monotonic across shows) are grouped into
 * playcuts/talksets/breakpoints exactly as the old SSE-fed in-memory store
 * was. Playcuts are then sliced to the caller's requested `n`; talksets and
 * breakpoints are returned in full (unsliced) — matching the pre-Phase-3
 * behavior byte-for-byte at the GroupedResponse shape level.
 *
 * entry_type -> tubafrenzy wire vocabulary mapping (see PR description for
 * the full rationale): 'track' -> playcut; 'talkset' | 'dj_join' |
 * 'dj_leave' | 'message' -> talkset; 'breakpoint' -> breakpoint;
 * 'show_start' | 'show_end' -> showDelimiter (omitted from every output
 * array, matching tubafrenzy's v=2 wire contract). This mirrors
 * `shared/legacy-mirror/src/http-mirror.ts`'s `mapEntryToTubafrenzy` /
 * `isNonTrackEntry`, the codebase's own canonical BS-entry_type ->
 * tubafrenzy-flowsheetEntryType mapping (flowsheetEntryType 7 covers both
 * real talksets and dj_join/dj_leave; 9/10 are show_start/show_end).
 *
 * Exported API:
 *   getRecentEntries(n) — query Postgres for the current playlist grouped
 *                         by entry type, sliced to n playcuts. Async (was
 *                         sync pre-Phase-3, since there is no more
 *                         in-memory buffer to read synchronously).
 */
import { db, flowsheet, album_metadata, rotation, library, artists } from '@wxyc/database';
import { sql, inArray, and, isNotNull, eq, desc } from 'drizzle-orm';

const MAX_ENTRIES = 200;
const HOUR_MS = 3_600_000;

/** Compute a normalized lookup key from artist and album for matching against flowsheet rows. */
function lookupKey(artist: string, album: string): string {
  return `${artist.toLowerCase().trim()}-${album.toLowerCase().trim()}`;
}

/** SQL expression that computes the same lookup key from flowsheet columns. */
const flowsheetLookupKey = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

/**
 * Whether a flowsheet row actively matches a rotation record, expressed as
 * the `rotation.rotation_bin` letter or NULL. Structurally identical to
 * `FSEntryFieldsRaw.rotation_bin` in `apps/backend/services/flowsheet.service.ts`
 * (kept in sync at the expression level, not literally imported/shared —
 * same convention `shared/legacy-mirror/src/rotation-match.ts`'s
 * `isActiveRotationMatch` already documents for this same three-cohort
 * match). Primary source is the FK join (`leftJoin(rotation, rotation.id =
 * flowsheet.rotation_id)`); the fallback subquery only fires when that join
 * misses and the entry looks like a real track (non-empty artist + album),
 * covering DJs who typed an entry by hand instead of using the rotation
 * picker. This is also the exact classification
 * `shared/legacy-mirror/src/http-mirror.ts`'s `mapEntryToTubafrenzy` used
 * to decide tubafrenzy's flowsheetEntryType=2 (rotation) at mirror time, so
 * reusing it here is the most faithful available reconstruction of what
 * tubafrenzy's own recentStream would have reported.
 */
const rotationBinExpr = sql<string | null>`
  COALESCE(
    ${rotation.rotation_bin},
    CASE WHEN ${flowsheet.rotation_id} IS NULL
      AND coalesce(${flowsheet.artist_name}, '') <> ''
      AND coalesce(${flowsheet.album_title}, '') <> ''
    THEN (
      SELECT r2.rotation_bin
      FROM ${rotation} r2
      LEFT JOIN ${library} l2 ON l2.id = r2.album_id
      LEFT JOIN ${artists} a2 ON a2.id = l2.artist_id
      WHERE r2.add_date <= ${flowsheet.add_time}::date
        AND (r2.kill_date IS NULL OR r2.kill_date > ${flowsheet.add_time}::date)
        AND (
          (${flowsheet.album_id} IS NOT NULL AND r2.album_id = ${flowsheet.album_id})
          OR (
            lower(trim(coalesce(r2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
            AND lower(trim(coalesce(r2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
          )
          OR (
            lower(trim(coalesce(a2.artist_name, ''))) = lower(trim(${flowsheet.artist_name}))
            AND lower(trim(coalesce(l2.album_title, ''))) = lower(trim(${flowsheet.album_title}))
          )
        )
      ORDER BY r2.id
      LIMIT 1
    )
    END
  )
`;

// --- Types ---

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

type RecentRow = {
  id: number;
  entry_type: string;
  add_time: Date;
  radio_hour: Date | null;
  track_title: string | null;
  artist_name: string | null;
  album_title: string | null;
  record_label: string | null;
  request_flag: boolean | null;
  rotation_bin: string | null;
};

/** tubafrenzy wire-vocabulary bucket a flowsheet.entry_type maps to. `null` means omit (showDelimiter). */
type EntryBucket = 'playcut' | 'talkset' | 'breakpoint' | null;

function classifyEntryType(entryType: string): EntryBucket {
  switch (entryType) {
    case 'track':
      return 'playcut';
    case 'talkset':
    case 'dj_join':
    case 'dj_leave':
    case 'message':
      return 'talkset';
    case 'breakpoint':
      return 'breakpoint';
    case 'show_start':
    case 'show_end':
      return null;
    default:
      return null;
  }
}

/**
 * Top-of-hour epoch ms for a row, matching tubafrenzy's `hour` wire field.
 *
 * Breakpoints use `flowsheet.radio_hour` when present — the exact top-of-hour
 * tubafrenzy marks (schema.ts: "the row's logging instant, ~1 min before the
 * hour" — flooring add_time would round a pre-hour breakpoint down to the
 * PRIOR hour, per BS#1448/#1449). Falls back to the floor-add_time formula
 * for rows that predate the radio_hour backfill.
 *
 * Every other entry type floors add_time to the top of the hour, reusing
 * `shared/legacy-mirror/src/http-mirror.ts`'s `mapEntryToTubafrenzy`
 * `radioHour` formula verbatim (`Math.floor(startMs / 3_600_000) *
 * 3_600_000`) — that function computes the same "hour" concept for the
 * mirror-write direction (BS -> tubafrenzy), so reusing its formula here is
 * the most faithful reconstruction of what tubafrenzy's own recentStream
 * `hour` field would have held.
 */
function computeHourMs(row: RecentRow): number {
  if (row.entry_type === 'breakpoint' && row.radio_hour) {
    return row.radio_hour.getTime();
  }
  const startMs = row.add_time.getTime();
  return Math.floor(startMs / HOUR_MS) * HOUR_MS;
}

function toBaseEntry(row: RecentRow): BaseEntry {
  return {
    id: row.id,
    // flowsheet.id is globally monotonic across shows (see
    // flowsheet.service.ts's getEntriesByRange / getEntriesByShow comments),
    // making it the natural analog of tubafrenzy's chronOrderID — a stable,
    // strictly-increasing chronological order key. Not a reconstruction of
    // tubafrenzy's own GLOBAL_ORDER_ID numbering (show*1000+seq), which no
    // longer exists once tubafrenzy is decommissioned; consumers only rely
    // on chronOrderID for ordering/dedup, not on its numeric scheme.
    chronOrderID: row.id,
    hour: computeHourMs(row),
    timeCreated: row.add_time.getTime(),
  };
}

// --- Public API ---

/**
 * Query Postgres for the current playlist, grouped by entry type.
 *
 * Playcuts are sliced to `n` (most recent first); talksets and breakpoints
 * are returned in full — matching the pre-Phase-3 in-memory behavior, which
 * capped its whole buffer at MAX_ENTRIES (200, any type) and only sliced
 * the playcuts sub-array at read time.
 */
export async function getRecentEntries(n: number): Promise<GroupedResponse> {
  const rows: RecentRow[] = await db
    .select({
      id: flowsheet.id,
      entry_type: flowsheet.entry_type,
      add_time: flowsheet.add_time,
      radio_hour: flowsheet.radio_hour,
      track_title: flowsheet.track_title,
      artist_name: flowsheet.artist_name,
      album_title: flowsheet.album_title,
      record_label: flowsheet.record_label,
      request_flag: flowsheet.request_flag,
      rotation_bin: rotationBinExpr,
    })
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .orderBy(desc(flowsheet.id))
    .limit(MAX_ENTRIES);

  const playcutRows: RecentRow[] = [];
  const talksetRows: RecentRow[] = [];
  const breakpointRows: RecentRow[] = [];

  for (const row of rows) {
    switch (classifyEntryType(row.entry_type)) {
      case 'playcut':
        playcutRows.push(row);
        break;
      case 'talkset':
        talksetRows.push(row);
        break;
      case 'breakpoint':
        breakpointRows.push(row);
        break;
      // null (showDelimiter: show_start / show_end) is omitted entirely.
    }
  }

  const slicedPlaycuts = playcutRows.slice(0, n);
  const artworkMap = await enrichPlaycuts(slicedPlaycuts);

  const playcuts: GroupedPlaycut[] = slicedPlaycuts.map((row) => {
    const grouped: GroupedPlaycut = {
      id: row.id,
      chronOrderID: row.id,
      hour: computeHourMs(row),
      timeCreated: row.add_time.getTime(),
      songTitle: row.track_title ?? '',
      artistName: row.artist_name ?? '',
      releaseTitle: row.album_title ?? '',
      labelName: row.record_label ?? '',
      rotation: row.rotation_bin !== null ? 'true' : 'false',
      request: row.request_flag ? 'true' : 'false',
    };
    const artwork = artworkMap.get(row.id);
    if (artwork) {
      grouped.artworkURL = artwork;
    }
    return grouped;
  });

  return {
    playcuts,
    talksets: talksetRows.map(toBaseEntry),
    breakpoints: breakpointRows.map(toBaseEntry),
  };
}

// --- Enrichment ---

interface PlaycutCandidate {
  id: number;
  artist_name: string | null;
  album_title: string | null;
}

/**
 * Batch-enrich the given playcut rows with artwork URLs from album_metadata,
 * joined via flowsheet.album_id (BS#1012 / D5).
 *
 * The legacy library is per-physical-format (BS#1105): one lookup key
 * (`lower(trim(artist_name)) || '-' || lower(trim(coalesce(album_title,
 * '')))`) can match multiple album_metadata rows (a CD and an LP issue of
 * the same album, each with its own artwork_url) — including rows the
 * candidate's own `flowsheet.album_id` doesn't point at, since a sibling
 * format's flowsheet row may carry artwork this one's album_id lacks. The
 * deterministic tie-break, preserved verbatim from the pre-Phase-3
 * implementation (commit d0b8317d, closes #1105): aggregate every matching
 * artwork_url into an array ordered by album_id ascending and take the
 * first element — deterministically the lowest album_id's artwork,
 * independent of scan/plan order.
 */
async function enrichPlaycuts(candidates: PlaycutCandidate[]): Promise<Map<number, string>> {
  if (candidates.length === 0) return new Map();

  const keyToIds = new Map<string, number[]>();
  for (const candidate of candidates) {
    const key = lookupKey(candidate.artist_name ?? '', candidate.album_title ?? '');
    const ids = keyToIds.get(key) ?? [];
    ids.push(candidate.id);
    keyToIds.set(key, ids);
  }

  const keys = [...keyToIds.keys()];

  try {
    const rows = await db
      .select({
        key: flowsheetLookupKey,
        // See the enrichPlaycuts docstring above for the split-format
        // tie-break rationale (BS#1105).
        artwork_url: sql<string>`(array_agg(${album_metadata.artwork_url} order by ${album_metadata.album_id} asc))[1]`,
      })
      .from(flowsheet)
      // INNER JOIN to album_metadata drops `flowsheet.album_id IS NULL` rows
      // naturally (the FK can't match NULL). That matches the partial-index
      // predicate `flowsheet_album_link_lookup_idx ... WHERE album_id IS NOT
      // NULL` (migration 0081) so the planner indexes the lookup_key probe
      // instead of seq-scanning the 2.6M-row flowsheet table. See incident
      // #511 for what happens when the planner falls off the index.
      // `flowsheet_artwork_lookup_idx` (migration 0057) was DROPPED in
      // migration 0082 — this query never relied on it.
      .innerJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
      .where(and(inArray(flowsheetLookupKey, keys), isNotNull(album_metadata.artwork_url)))
      .groupBy(flowsheetLookupKey);

    const map = new Map<number, string>();
    for (const row of rows) {
      if (row.key && row.artwork_url) {
        const entryIds = keyToIds.get(row.key);
        if (entryIds) {
          for (const id of entryIds) {
            map.set(id, row.artwork_url);
          }
        }
      }
    }
    return map;
  } catch (err) {
    console.error('[playlist-proxy] artwork enrichment failed:', err);
    return new Map();
  }
}
