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
 * Rotation-badge resolution runs in two lanes (BS#1862). The primary source
 * is the FK join (`leftJoin(rotation, rotation.id = flowsheet.rotation_id)`),
 * computed cheaply in the main window query. The fallback — a text/album_id
 * match against active rotations for entries a DJ typed by hand instead of
 * picking from rotation (`rotation_id IS NULL`) — is deferred to a single
 * batched query over the SLICED (<= n) playcuts only, run post-slice
 * alongside artwork enrichment. It used to be a correlated subquery in the
 * SELECT list evaluated for every one of the 200 window rows, which
 * seq-scanned the 64k-row `library` table per row and cost ~2.4s
 * server-side regardless of `n` (BS#1862); batching it drops the cost to
 * ~10-30ms while preserving the exact COALESCE(FK, fallback) semantics.
 *
 * Metadata enrichment (BS#2103). The v=2 grouped playcut additionally carries
 * the same per-play metadata `GET /flowsheet` serves — streaming links, bio,
 * genres/styles, release year, artist id, critic reviews, upcoming show — under
 * the camelCase key names shipped iOS 3.2 already decodes. Those clients resolve
 * `PlaylistAPIVersion.v1` and cannot be moved onto `/flowsheet` (the
 * `playlist_api_version` flag is global and would break 3.1 outright), so the
 * data has to come to them on this endpoint. See `enrichPlaycutMetadata`.
 * v=1 (Android) is deliberately untouched.
 *
 * On-air status (BS#2105). The v=2 grouped envelope additionally carries a
 * top-level `onAir` field, a sibling of `playcuts`/`talksets`/`breakpoints`,
 * so a 3.2 client on this legacy path renders the on-air banner with the live
 * DJ's handle instead of hiding it. Unlike every other field on this
 * endpoint, `onAir`'s wire shape is NOT a plain object — it is whatever
 * Swift's SYNTHESIZED `Codable` produces for the shipped `OnAir` enum
 * (`{"dj":{"_0":name}}` / `{"automation":{}}`), which is why it goes through
 * a dedicated `WireOnAir` union and `encodeOnAir` helper rather than the
 * ad-hoc object literals the rest of this file builds. See `encodeOnAir`.
 * v=1 (Android) is untouched here too.
 *
 * Exported API:
 *   getRecentEntries(n) — query Postgres for the current playlist grouped
 *                         by entry type, sliced to n playcuts. Async (was
 *                         sync pre-Phase-3, since there is no more
 *                         in-memory buffer to read synchronously).
 */
import * as Sentry from '@sentry/node';
import { db, flowsheet, album_metadata, rotation, library, artists } from '@wxyc/database';
import { sql, inArray, and, isNotNull, eq, desc, asc } from 'drizzle-orm';
import type { CriticReviewItem } from '@wxyc/shared/dtos';
import {
  ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK,
  suppressMislabeledStreamingUrls,
} from '../utils/album-metadata-projection.js';
import type { ConcertDTO } from './concerts.service.js';
import { attachUpcomingShows, attachCriticReviews, getOnAirDJName } from './flowsheet.service.js';

const MAX_ENTRIES = 200;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Compute a normalized lookup key from artist and album for matching against flowsheet rows. */
function lookupKey(artist: string, album: string): string {
  return `${artist.toLowerCase().trim()}-${album.toLowerCase().trim()}`;
}

/** SQL expression that computes the same lookup key from flowsheet columns. */
const flowsheetLookupKey = sql<string>`lower(trim(${flowsheet.artist_name})) || '-' || lower(trim(coalesce(${flowsheet.album_title}, '')))`;

/**
 * True iff `value` contains a character that makes `new URL()`'s verdict a
 * statement about a DIFFERENT string than the one we are about to emit.
 *
 * `wireUrl` validates with the WHATWG parser but emits the original text, so
 * every place the two disagree is a parser differential the wire inherits:
 *
 *   - **Backslash.** For the http(s) special schemes WHATWG folds `\` to `/`,
 *     so `new URL('https://www.discogs.com\\@evil.example/release/1')` reports
 *     hostname `www.discogs.com`. Foundation/RFC 3986 do NOT fold it, so the
 *     same bytes resolve to host `evil.example` on iOS. This is the identical
 *     differential `shared/lml-client/src/streaming-url-guard.ts`'s
 *     `safeHostname` opens with `if (url.includes('\\')) return null` (BS#1710);
 *     same reasoning, same verdict, at this seam.
 *   - **ASCII whitespace and control characters.** WHATWG *strips* raw tab, LF
 *     and CR anywhere in the input and percent-encodes other C0 characters and
 *     the space before parsing, so `'https://e.com/a\tb'` validates as
 *     `https://e.com/ab` — a URL that is not what we would emit. `.trim()`
 *     only reaches the ends. Foundation rejects the raw form, which is the
 *     throwing decode this whole helper exists to avoid.
 */
function hasWireUrlParserDifferential(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    // C0 controls + space (<= 0x20), DEL (0x7f), backslash (0x5c).
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * Normalize a persisted URL for the wire, or `undefined` to omit the key.
 *
 * iOS decodes every URL-typed playcut field with
 * `try container.decodeIfPresent(URL.self, forKey:)`. That is *throwing*, not
 * tolerant: a present-but-unparseable value raises `DecodingError` and fails
 * the whole `Playcut` decode, which empties the playlist for that listener.
 * `/flowsheet` can pass these through raw because its consumer decodes them as
 * strings; this endpoint cannot.
 *
 * Only an absolute `http`/`https` URL survives. Everything else — `''`,
 * whitespace, a relative path, a bare hostname, a scheme-relative `//host/...`,
 * a non-web scheme — is dropped rather than risked. Dropping a field costs one
 * missing button; emitting a bad one costs the whole playlist.
 *
 * REJECT, don't normalize. The emitted value is the trimmed ORIGINAL, never
 * `parsed.href`, so anything `new URL()` silently rewrites while parsing is a
 * differential between what was validated and what ships — see
 * {@link hasWireUrlParserDifferential}, which rejects those inputs outright.
 * Emitting `parsed.href` instead would close the same differentials, but it
 * would also percent-encode the ~21 production values carrying raw non-ASCII in
 * the path (`https://en.wikipedia.org/wiki/Nilüfer_Yanya` -> `…/Nil%C3%BCfer_…`),
 * which ship verbatim today and decode fine on iOS. Rejecting touches only the
 * hazardous inputs, leaves every good byte alone, and matches the repo's
 * existing precedent at the LML boundary (BS#1710).
 */
function wireUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (hasWireUrlParserDifferential(trimmed)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  if (parsed.hostname === '') return undefined;
  return trimmed;
}

/**
 * Normalize a free-text wire field: the trimmed value, or `undefined` to omit
 * the key when it is null, empty, or whitespace-only.
 *
 * Same normalization {@link wireUrl} applies, for the same reason one step
 * further down: a `'   '` bio is not a bio, and an emitted whitespace string
 * renders as an empty, unexplained section on the shipped 3.2 UI. These fields
 * decode as `String` (non-throwing), so the stake is a blank section rather
 * than a blank playlist — but the rule should not differ per field type.
 */
function wireText(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Normalize a nullable `text[]` metadata column for the wire, or `undefined`
 * to omit the key when nothing usable survives.
 *
 * `album_metadata.genres` / `.styles` are `text[]` whose ELEMENTS are nullable,
 * so a row written with a NULL member comes back as `[null]` — and `[null]`
 * has a truthy `.length`. iOS 3.2 decodes both with
 * `try container.decodeIfPresent([String].self, forKey:)`, which THROWS on a
 * null member and fails the whole `Playcut` decode, blanking the playlist for
 * that listener: the exact catastrophe {@link wireUrl} exists to prevent, on
 * the one remaining throwing decode that had no guard. Non-strings and
 * blank/whitespace-only members are dropped on the same "a value that carries
 * no information is not worth a decode risk" rule.
 */
function wireStringArray(values: ReadonlyArray<string | null> | null | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const kept: string[] = [];
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text !== '') kept.push(text);
  }
  return kept.length > 0 ? kept : undefined;
}

/** Set a URL-typed wire field iff the persisted value survives {@link wireUrl}. */
function setUrlField(target: GroupedPlaycut, key: UrlWireKey, value: string | null | undefined): void {
  const url = wireUrl(value);
  if (url !== undefined) {
    target[key] = url;
  }
}

/**
 * The wire shape iOS 3.2's `OnAir` enum's SYNTHESIZED Codable expects
 * (BS#2105) — not something anyone would guess from the JSON alone.
 *
 * `OnAir` (`Shared/Playlist/Sources/Playlist/OnAir.swift`) is `enum OnAir {
 * case dj(String); case automation; case unknown }` with no custom
 * `init(from:)`, so it decodes/encodes via Swift's default synthesized
 * `Codable`. Measured by executing the real encoder against the shipped enum,
 * not inferred:
 *   `JSONEncoder().encode(OnAir.dj("bill b"))` -> `{"dj":{"_0":"bill b"}}`
 *   `JSONEncoder().encode(OnAir.automation)`   -> `{"automation":{}}`
 * `_0` is the synthesized label Swift gives an unlabeled single associated
 * value. The `_0` literal exists in exactly this ONE place in the codebase —
 * {@link encodeOnAir} is the only function permitted to construct it.
 *
 * `.unknown` has no wire form here: the caller omits the `onAir` key entirely
 * rather than emit `{"unknown":{}}` — both decode to `OnAir.unknown` (an
 * absent key falls through `?? .unknown` in `Playlist.init(from:)`), but the
 * explicit form costs bytes for nothing.
 */
export type WireOnAir = { dj: { _0: string } } | { automation: Record<string, never> };

/**
 * Encode `getOnAirDJName()`'s two DEFINITIVE outcomes into {@link WireOnAir}.
 *
 * `getOnAirDJName`'s own contract: a non-null name means a human is on air
 * (including the `ANONYMOUS_ON_AIR_NAME` = `"WXYC"` fallback for a legacy
 * sign-on with no resolvable handle); `null` is reserved EXCLUSIVELY for
 * confirmed automation. This mirrors that exactly, just re-keyed for this
 * endpoint's hazardous Swift-synthesized shape instead of `/flowsheet`'s
 * plain `{dj_name}` projection (`flowsheet.controller.ts`).
 *
 * The THIRD outcome — the resolver rejected — never reaches this function.
 * It is handled at the call site by omitting the `onAir` key entirely (see
 * `getRecentEntries`), which is also why this signature takes `string |
 * null` rather than `string | null | undefined`.
 */
function encodeOnAir(name: string | null): WireOnAir {
  return name !== null ? { dj: { _0: name } } : { automation: {} };
}

// --- Types ---

/**
 * One v=2 grouped playcut.
 *
 * The legacy fields (`songTitle` … `request`) are tubafrenzy's original wire
 * shape and must not change — iOS 3.1 still reads them, and its safety rests
 * entirely on unknown keys being ignorable.
 *
 * Everything from `artworkURL` down is optional enrichment, keyed to match the
 * `CodingKeys` block of `Playcut` in wxyc-ios-64 @ v3.2-AppStoreSubmission4
 * (`Shared/Playlist/Sources/Playlist/PlaylistEntry.swift`). That block is the
 * SSOT: the legacy wire is camelCase, unlike `/flowsheet`'s snake_case, with
 * two deliberate exceptions — `upcoming_show` and `critic_reviews` stay
 * snake_case because they round-trip through nested Swift types that carry
 * their own snake_case `Codable`. A wrong key name fails SILENTLY: JSONDecoder
 * drops it and the feature simply never appears.
 *
 * Every URL-typed field is emitted only when it parses as an absolute http(s)
 * URL — see {@link wireUrl}. iOS decodes these with
 * `try container.decodeIfPresent(URL.self, …)`, which THROWS on a
 * present-but-invalid value and fails the entire `Playcut` decode, blanking
 * the playlist for that listener. Absent or `null` is always safe; `""` is not.
 */
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
  discogsURL?: string;
  releaseYear?: number;
  spotifyURL?: string;
  appleMusicURL?: string;
  youtubeMusicURL?: string;
  bandcampURL?: string;
  soundcloudURL?: string;
  artistBio?: string;
  artistWikipediaURL?: string;
  genres?: string[];
  styles?: string[];
  artistId?: number;
  /** Key camelCase, VALUE snake_case (`enriched_match`, …) — the raw enum. */
  metadataStatus?: string;
  discogsUnavailable?: boolean;
  discogsUnavailableNote?: string;
  /** snake_case on purpose: nested `Concert` with its own snake_case Codable. */
  upcoming_show?: ConcertDTO;
  /** snake_case on purpose: nested `CriticReviewItem[]`, same rationale. */
  critic_reviews?: CriticReviewItem[];
}

/** The URL-typed wire fields — every one of them a throwing decode on iOS. */
type UrlWireKey =
  | 'artworkURL'
  | 'discogsURL'
  | 'spotifyURL'
  | 'appleMusicURL'
  | 'youtubeMusicURL'
  | 'bandcampURL'
  | 'soundcloudURL'
  | 'artistWikipediaURL';

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
  /**
   * On-air status (BS#2105), a sibling of `playcuts`/`talksets`/`breakpoints`
   * rather than a per-playcut field. Present as {@link WireOnAir} when
   * `getOnAirDJName()` resolved (either a named DJ or confirmed automation);
   * OMITTED entirely when the resolver rejected — never `{"unknown":{}}`.
   *
   * Declared LAST deliberately: `JSON.stringify` emits insertion order, and
   * the cross-repo golden (`tests/fixtures/recent-entries-v2-wire-golden.json`)
   * pins the resulting bytes. `getRecentEntries` below sets it last via a
   * trailing conditional spread for the same reason. This differs from
   * `Playlist`'s Swift `CodingKeys` order (`playcuts, breakpoints, talksets,
   * showMarkers, onAir`) — irrelevant to the decoder, load-bearing only for
   * the golden diff.
   */
  onAir?: WireOnAir;
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
  segue: boolean | null;
  // Marker text: the label the v=1 flat format emits as `artistName` on
  // breakpoint / showDelimiter entries (consumer-invisible — see the v=1
  // serializer), and the source of tubafrenzy's own breakpoint/showDelimiter
  // artistName via the mirror. Unused by the v=2 grouped output.
  message: string | null;
  rotation_id: number | null;
  album_id: number | null;
  // FK-lane rotation_bin only (rotation.rotation_bin via the rotation_id
  // join). NULL here does NOT mean "not in rotation" — a hand-typed entry
  // with rotation_id NULL can still match an active rotation via the
  // post-slice fallback lane. See resolveFallbackRotation.
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

/**
 * Fetch the most recent `limit` flowsheet rows (any entry_type, ordered by
 * flowsheet.id DESC), with the FK-lane rotation_bin joined in. Shared by both
 * the v=2 grouped path (`getRecentEntries`, limit = MAX_ENTRIES) and the v=1
 * flat path (`getRecentEntriesFlat`, limit = the caller's n). The fallback
 * rotation lane runs separately, post-classification (BS#1862).
 */
async function fetchRecentRows(limit: number): Promise<RecentRow[]> {
  return db
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
      segue: flowsheet.segue,
      message: flowsheet.message,
      rotation_id: flowsheet.rotation_id,
      album_id: flowsheet.album_id,
      // FK-lane rotation_bin only. The correlated fallback subquery this used
      // to COALESCE with was removed (BS#1862) — it seq-scanned `library`
      // for every window row and cost ~2.4s. The fallback runs post-slice in
      // resolveFallbackRotation over the track rows that survive classification.
      rotation_bin: rotation.rotation_bin,
    })
    .from(flowsheet)
    .leftJoin(rotation, eq(rotation.id, flowsheet.rotation_id))
    .orderBy(desc(flowsheet.id))
    .limit(limit);
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
  // BS#2105: resolve on-air status concurrently with the window query, not
  // behind it. getOnAirDJName has no dependency on `rows`, and it is itself
  // two SEQUENTIAL queries (getNShows(1) + at most one user PK lookup) —
  // parking it in the enrichment Promise.all below (round trip 2 of 3) could
  // make it that wave's critical path. Starting it here instead hides it
  // entirely behind the 200-row window query.
  //
  // `.catch(() => undefined)` is attached to THIS promise, not wrapped around
  // the whole Promise.all. getRecentEntries has no other try/catch: a
  // rejection here would otherwise propagate to playlist.controller.ts, which
  // fail-softs to a 503 for the ENTIRE legacy mobile fleet. An on-air blip
  // must cost only the banner (the `onAir` key is omitted below when this
  // resolves `undefined`), never the playlist.
  const [rows, onAirDjName] = await Promise.all([
    fetchRecentRows(MAX_ENTRIES),
    getOnAirDJName().catch(() => undefined),
  ]);

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
  const [artworkMap, fallbackRotationMap, metadataMap, criticReviewMap] = await Promise.all([
    enrichPlaycuts(slicedPlaycuts),
    resolveFallbackRotation(slicedPlaycuts),
    enrichPlaycutMetadata(slicedPlaycuts),
    // Keys off `album_id`, which is already on the window row — no dependency
    // on the metadata batch, so it belongs in this wave, not behind it.
    resolveCriticReviews(slicedPlaycuts),
  ]);
  // Second (and last) round trip: the concerts attach's id arm keys off
  // `artist_id`, which only the metadata batch above resolves.
  const upcomingShowMap = await resolveUpcomingShows(slicedPlaycuts, metadataMap);

  const playcuts: GroupedPlaycut[] = slicedPlaycuts.map((row) => {
    // COALESCE(FK rotation_bin, fallback rotation_bin) — the exact semantics
    // the old inline COALESCE(rotation.rotation_bin, <correlated subquery>)
    // produced, now split across two lanes for performance (BS#1862).
    const rotationBin = row.rotation_bin ?? fallbackRotationMap.get(row.id) ?? null;
    const grouped: GroupedPlaycut = {
      id: row.id,
      chronOrderID: row.id,
      hour: computeHourMs(row),
      timeCreated: row.add_time.getTime(),
      songTitle: row.track_title ?? '',
      artistName: row.artist_name ?? '',
      releaseTitle: row.album_title ?? '',
      labelName: row.record_label ?? '',
      rotation: rotationBin !== null ? 'true' : 'false',
      request: row.request_flag ? 'true' : 'false',
    };
    setUrlField(grouped, 'artworkURL', artworkMap.get(row.id));
    const meta = metadataMap.get(row.id);
    if (meta) {
      applyPlaycutMetadata(grouped, meta);
    }
    // Key order is wire-visible (JSON.stringify emits insertion order, and the
    // cross-repo golden pins the bytes): upcoming_show before critic_reviews.
    const upcomingShow = upcomingShowMap.get(row.id);
    if (upcomingShow) {
      grouped.upcoming_show = upcomingShow;
    }
    const criticReviews = criticReviewMap.get(row.id);
    if (criticReviews?.length) {
      grouped.critic_reviews = criticReviews;
    }
    return grouped;
  });

  return {
    playcuts,
    talksets: talksetRows.map(toBaseEntry),
    breakpoints: breakpointRows.map(toBaseEntry),
    // Last key deliberately — see the GroupedResponse.onAir doc comment.
    // Omitted (not `{"unknown":{}}`) when the resolver rejected above.
    ...(onAirDjName !== undefined && { onAir: encodeOnAir(onAirDjName) }),
  };
}

// --- v=1 flat contract (Android; tubafrenzy's FlowsheetEntryJsonSerializer.toJson) ---

/** Playcut fields nested under `playcut` in the v=1 flat wire format. */
interface FlatPlaycutFields {
  artistName: string;
  songTitle: string;
  releaseTitle: string;
  labelName: string;
  rotation: string;
  request: string;
  segue: string;
}

/**
 * One entry in the v=1 flat array (see §2.2 of the tubafrenzy decommission
 * plan / tubafrenzy's `FlowsheetEntryJsonSerializer.toJson`). Every entry
 * carries the base fields + an `entryType` discriminator. Playcuts nest their
 * typed fields under `playcut`; breakpoints and showDelimiters carry an
 * `artistName` label (consumer-invisible — the Android DTO has no top-level
 * artistName and reads the breakpoint hour from `hour`; iOS consumes the v=2
 * grouped shape, not this one — but emitted for byte-faithfulness).
 */
export interface FlatEntry {
  id: number;
  chronOrderID: number;
  hour: number;
  timeCreated: number;
  entryType: 'playcut' | 'talkset' | 'breakpoint' | 'showDelimiter';
  playcut?: FlatPlaycutFields;
  artistName?: string;
}

type FlatBucket = 'playcut' | 'talkset' | 'breakpoint' | 'showDelimiter';

/**
 * Flat-format entry_type classification. Unlike `classifyEntryType` (v=2),
 * this never drops a row: show_start/show_end map to `showDelimiter` (v=1
 * includes them). Unknown types fall to `talkset`, the benign non-track
 * bucket — the BS entry_type enum is closed, so this is defensive only.
 */
function classifyFlatEntryType(entryType: string): FlatBucket {
  switch (entryType) {
    case 'track':
      return 'playcut';
    case 'breakpoint':
      return 'breakpoint';
    case 'show_start':
    case 'show_end':
      return 'showDelimiter';
    case 'talkset':
    case 'dj_join':
    case 'dj_leave':
    case 'message':
    default:
      return 'talkset';
  }
}

function toFlatEntry(row: RecentRow, fallbackRotationMap: Map<number, string>): FlatEntry {
  const base = {
    id: row.id,
    chronOrderID: row.id,
    hour: computeHourMs(row),
    timeCreated: row.add_time.getTime(),
  };
  switch (classifyFlatEntryType(row.entry_type)) {
    case 'playcut': {
      // Same COALESCE(FK, fallback) rotation semantics as the v=2 path.
      const rotationBin = row.rotation_bin ?? fallbackRotationMap.get(row.id) ?? null;
      return {
        ...base,
        entryType: 'playcut',
        playcut: {
          artistName: row.artist_name ?? '',
          songTitle: row.track_title ?? '',
          releaseTitle: row.album_title ?? '',
          labelName: row.record_label ?? '',
          rotation: rotationBin !== null ? 'true' : 'false',
          request: row.request_flag ? 'true' : 'false',
          segue: row.segue ? 'true' : 'false',
        },
      };
    }
    case 'talkset':
      return { ...base, entryType: 'talkset' };
    case 'breakpoint':
      // tubafrenzy stored the breakpoint label as the uppercased message (the
      // mirror's `message.toUpperCase() || 'BREAKPOINT'`); reproduce it.
      return { ...base, entryType: 'breakpoint', artistName: (row.message ?? '').trim().toUpperCase() || 'BREAKPOINT' };
    case 'showDelimiter':
      // The mirror sent the show marker's `message` as tubafrenzy's artistName.
      return { ...base, entryType: 'showDelimiter', artistName: row.message ?? '' };
  }
}

/**
 * Query Postgres for the current playlist as the v=1 flat array (the Android
 * contract; BS#1866). Returns the most recent min(n, MAX_ENTRIES) rows of ANY
 * type — matching tubafrenzy's `getNRecentFlowsheetEntries(n)` semantic where
 * `n` bounds total entries, not playcuts — serialized flat with the
 * `entryType` discriminator. showDelimiter (show_start/show_end) entries are
 * INCLUDED, unlike the v=2 grouped path. No artwork enrichment (v=1 never
 * carried it — Android does its own artwork lookup client-side).
 */
export async function getRecentEntriesFlat(n: number): Promise<FlatEntry[]> {
  const rows = await fetchRecentRows(Math.min(n, MAX_ENTRIES));

  // Rotation fallback only needs the track rows (the playcut candidates).
  const trackRows = rows.filter((row) => classifyFlatEntryType(row.entry_type) === 'playcut');
  const fallbackRotationMap = await resolveFallbackRotation(trackRows);

  return rows.map((row) => toFlatEntry(row, fallbackRotationMap));
}

/**
 * The `X-Last-Modified` value for a window: the max `timeCreated` (add_time
 * epoch ms) across the given entries, or 0 for an empty window. tubafrenzy's
 * header is its cache's last-modified instant; the plan (§2.4) specifies the
 * max timeCreated of the served window, which increases whenever a newer entry
 * appears. Computed from the served payload, so the v=2 value can miss a
 * showDelimiter that the grouped shape drops — inconsequential, since v=2
 * (iOS) never sends `?since`, and the bridge's `?since` path stays on legacy.
 *
 * The same gap makes `X-Last-Modified` NOT a valid change-detector for
 * `onAir` (BS#2105): a sign-on/sign-off writes no playcut/talkset/breakpoint
 * of its own, so this header does not move the moment the banner would.
 * Freshness for `onAir` is bounded instead by the endpoint's own
 * `Cache-Control: public, max-age=30` (set in playlist.controller.ts) — up to
 * 30s of staleness at any caching intermediary, on top of the client's poll
 * interval, is accepted here as a documented tradeoff, not a bug to reopen.
 */
export function lastModifiedFromTimestamps(timestamps: number[]): number {
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
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
 * deterministic tie-break — lowest album_id wins, independent of scan/plan
 * order — was originally an `array_agg(artwork_url ORDER BY album_id ASC)[1]`
 * (commit d0b8317d, closes #1105), which materializes every matching
 * artwork_url per group just to discard all but the first. BS#1800 replaced
 * it with `SELECT DISTINCT ON (lookup key)` ordered by the same
 * `(lookup key, album_id ASC)`: Postgres still scans every matching row but
 * never builds the intermediate array, and — since a tie on `album_id` can
 * only occur for rows sharing the same `album_metadata` row, hence the same
 * `artwork_url` — the selected value is identical to the array_agg form.
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
      .selectDistinctOn([flowsheetLookupKey], {
        // See the enrichPlaycuts docstring above for the split-format
        // tie-break rationale (BS#1105 / BS#1800): DISTINCT ON the lookup
        // key, ordered by the same key then album_id ASC, picks the
        // lowest-album_id row's artwork_url per group without materializing
        // an array.
        key: flowsheetLookupKey,
        artwork_url: album_metadata.artwork_url,
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
      .orderBy(flowsheetLookupKey, asc(album_metadata.album_id));

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

/**
 * One row of the batched metadata lookup — `/flowsheet`'s own projection,
 * restricted to the fields iOS 3.2's `Playcut` declares a `CodingKey` for.
 */
type PlaycutMetadataRow = {
  id: number;
  discogs_url: string | null;
  release_year: number | null;
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null;
  artist_wikipedia_url: string | null;
  genres: string[] | null;
  styles: string[] | null;
  artist_id: number | null;
  discogs_unavailable: boolean | null;
  discogs_unavailable_note: string | null;
  metadata_status: string | null;
};

/**
 * Batch-fetch the `/flowsheet` metadata projection for the sliced playcuts
 * (BS#2103).
 *
 * ONE query for the whole page, joined and projected exactly as
 * `flowsheet.service.ts`'s read paths do — same two LEFT JOINs, same shared
 * `ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK` COALESCE expressions
 * (`utils/album-metadata-projection.ts`). Reusing that definition rather than
 * re-deriving it is the point: the two-source `coalesce(album_metadata.X,
 * flowsheet.X)` fallback keeps free-form plays (no `album_id`, metadata held
 * inline) enriched, and it cannot drift from `/flowsheet` as Epic D advances.
 *
 * `artwork_url` is deliberately NOT in this projection. Artwork keeps its own
 * resolution (`enrichPlaycuts`, the BS#1105 split-format lookup-key tie-break,
 * unchanged by this ticket), which also keeps this path off the inline
 * artwork column on `flowsheet` so Epic D's D4 column drop (#900) stays
 * unblocked here — a property the unit suite pins by source-grep, hence the
 * circumlocution.
 *
 * The predicate is `flowsheet.id IN (…)` over at most `n` (<= 100) primary
 * keys, so this is an index lookup, not a scan. It runs inside
 * `getRecentEntries`'s existing `Promise.all` alongside the artwork and
 * rotation-fallback batches, so it costs no extra serial round trip. The
 * endpoint is reverse-proxied by wxyc.info under a 2s fail-soft timeout, which
 * is why "one batched query, in parallel" is a hard requirement and not a
 * preference.
 *
 * Degrades to an empty map on query failure — the playcut goes out with its
 * legacy fields only, rather than 503-ing the entire legacy mobile fleet.
 * Same posture as `enrichPlaycuts` / `resolveFallbackRotation`.
 */
async function enrichPlaycutMetadata(candidates: Array<{ id: number }>): Promise<Map<number, PlaycutMetadataRow>> {
  if (candidates.length === 0) return new Map();

  try {
    const rows = await db
      .select({
        id: flowsheet.id,
        ...ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK,
        // Sourced off `library` directly, exactly as FSEntryFieldsRaw does:
        // the resolved catalog artist (BS#1625) and the MD-set
        // discogs-unavailable flag + note (BS#1908). NULL here means "no
        // library row", which the serializer reads as "omit the field".
        artist_id: library.artist_id,
        discogs_unavailable: library.discogs_unavailable,
        discogs_unavailable_note: library.discogs_unavailable_note,
        metadata_status: flowsheet.metadata_status,
      })
      .from(flowsheet)
      .leftJoin(library, eq(library.id, flowsheet.album_id))
      .leftJoin(album_metadata, eq(album_metadata.album_id, flowsheet.album_id))
      .where(
        inArray(
          flowsheet.id,
          candidates.map((candidate) => candidate.id)
        )
      );

    // No cast: `rows` keeps drizzle's inferred shape, so this insert is what
    // ties {@link PlaycutMetadataRow} to the projection. If
    // ALBUM_METADATA_PROJECTION_WITHOUT_ARTWORK ever loses a field, the
    // inferred row stops satisfying the map's value type and THIS line fails
    // to compile — instead of typechecking clean and silently assigning
    // `undefined` to a live wire field, which a cast would have allowed.
    const map = new Map<number, PlaycutMetadataRow>();
    for (const row of rows) {
      map.set(row.id, row);
    }
    return map;
  } catch (err) {
    console.error('[playlist-proxy] metadata enrichment failed:', err);
    return new Map();
  }
}

/**
 * The minimal row shape `attachUpcomingShows` reads and writes — the same
 * `Pick`-of-`IFSEntry` fields its own `UpcomingShowAttachable` bound declares.
 */
type UpcomingShowTarget = {
  id: number;
  entry_type: 'track';
  artist_id: number | null;
  artist_name: string | null;
  upcoming_show?: ConcertDTO | null;
};

/** The minimal row shape `attachCriticReviews` reads and writes. */
type CriticReviewTarget = {
  id: number;
  entry_type: 'track';
  album_id: number | null;
  critic_reviews?: CriticReviewItem[];
};

/**
 * Attach `upcoming_show` (BS#1607/#1613) by calling `/flowsheet`'s own helper
 * rather than re-deriving its id-arm/name-arm hybrid match, which has its own
 * regression suite.
 *
 * Batched and page-scoped: `attachUpcomingShows` reads a per-ET-day memoized
 * concerts map (`getUpcomingShowsMapsCached`, BS#1616 — usually zero queries on
 * the hot poll). This is the one enrichment that CANNOT join the first
 * `Promise.all`: its id arm keys off `artist_id`, which only the metadata batch
 * resolves.
 *
 * Wrapped in a try/catch the `/flowsheet` call sites don't need: this endpoint
 * is polled on a fixed interval by every legacy mobile client through a proxy
 * that fails soft at 2s, so a concerts-table blip must cost the CTA, not the
 * playlist. The catch reports to Sentry — matching the helper it wraps, which
 * reports its own internal failures there — because a `console.error` on a
 * fleet-wide outage is a signal nobody receives. It does NOT discard the map:
 * the attach mutates `targets` in place, so anything already written stays
 * valid and is harvested below.
 */
async function resolveUpcomingShows(
  candidates: RecentRow[],
  metadataMap: Map<number, PlaycutMetadataRow>
): Promise<Map<number, ConcertDTO>> {
  const resolved = new Map<number, ConcertDTO>();
  if (candidates.length === 0) return resolved;

  const targets: UpcomingShowTarget[] = candidates.map((row) => ({
    id: row.id,
    entry_type: 'track',
    artist_id: metadataMap.get(row.id)?.artist_id ?? null,
    artist_name: row.artist_name,
  }));

  try {
    await attachUpcomingShows(targets);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: 'playlist-proxy-upcoming-shows' },
      extra: { candidate_count: candidates.length },
    });
  }

  for (const target of targets) {
    if (target.upcoming_show) {
      resolved.set(target.id, target.upcoming_show);
    }
  }
  return resolved;
}

/**
 * Attach `critic_reviews` (BS#1870) by calling `/flowsheet`'s own helper rather
 * than re-deriving its id-arm-only exact album match.
 *
 * Runs in `getRecentEntries`'s FIRST `Promise.all`, not after the metadata
 * batch: `attachCriticReviews` reads only `entry_type` and `album_id`, and
 * `album_id` comes straight off the window row (`RecentRow.album_id`) — it has
 * no `artist_id` dependency, unlike {@link resolveUpcomingShows}. Serializing
 * it behind the metadata batch bought nothing and cost a whole round trip on an
 * endpoint that is polled on a fixed interval behind a 2s fail-soft proxy which
 * 503s the entire legacy mobile fleet on timeout.
 *
 * Flag-gated behind `CRITIC_REVIEWS_ENABLED` inside the helper (zero queries
 * when off), one indexed lookup when on. Same Sentry-reporting, keep-what-
 * landed catch as {@link resolveUpcomingShows}.
 */
async function resolveCriticReviews(candidates: RecentRow[]): Promise<Map<number, CriticReviewItem[]>> {
  const resolved = new Map<number, CriticReviewItem[]>();
  if (candidates.length === 0) return resolved;

  const targets: CriticReviewTarget[] = candidates.map((row) => ({
    id: row.id,
    entry_type: 'track',
    album_id: row.album_id,
  }));

  try {
    await attachCriticReviews(targets);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { subsystem: 'playlist-proxy-critic-reviews' },
      extra: { candidate_count: candidates.length },
    });
  }

  for (const target of targets) {
    if (target.critic_reviews?.length) {
      resolved.set(target.id, target.critic_reviews);
    }
  }
  return resolved;
}

/**
 * Project one metadata row onto the v=2 playcut under the iOS 3.2 key names.
 *
 * Present-or-absent throughout: a null column omits its key entirely rather
 * than emitting `null`, which keeps every URL field structurally incapable of
 * carrying `""`. Strings are trimmed and dropped when blank ({@link wireText}),
 * URL fields additionally survive only as absolute http(s) with no parser
 * differential ({@link wireUrl}), and `genres` / `styles` are filtered to their
 * non-empty string members ({@link wireStringArray}).
 *
 * `metadataStatus` is deliberately CONDITIONAL — see
 * {@link hasRenderableInlineMetadata} for the rule and the measurement behind
 * it. `flowsheet.metadata_status` is `NOT NULL DEFAULT 'pending'`, so the
 * column always has a value; the WIRE key rides only when this function (plus
 * the caller's artwork assignment) actually put renderable metadata on the
 * playcut. A fully-unenriched playcut therefore IS byte-identical to its
 * pre-BS#2103 shape.
 */
/**
 * True iff the playcut carries at least one of the 12 inline metadata fields
 * iOS 3.2's `Playcut.hasV2Metadata` ORs together — the fields
 * `PlaycutDetailView.loadMetadata()` can actually render.
 *
 * This predicate exists because on shipped 3.2, `metadataStatus` is a CONTROL
 * field, not data: a terminal value (`enriched_match` / `enriched_no_match` /
 * `failed_no_retry`) makes the detail view render straight from the inline
 * fields and never call `/proxy/metadata/album`
 * (v3.2-AppStoreSubmission4, `PlaycutDetailView.swift:289`). For a
 * terminal-but-EMPTY row that short-circuit produces a blank card where
 * today's status-less payload gets a live lookup — measured 2026-08-11 at 579
 * of 37,054 production playcuts (1.56%), landing in roughly 40% of n=50
 * responses. So `applyPlaycutMetadata` emits `metadataStatus` exactly when
 * this predicate holds and withholds it otherwise, keeping the fallback fetch
 * for rows the payload gives the client nothing to render. The cost is nil in
 * practice: rows WITH inline fields (≈98.4% of terminal rows) keep the
 * round-trip-free inline render this endpoint's enrichment exists for.
 *
 * The honest tradeoff, stated plainly: on this endpoint the field stops being
 * a faithful lifecycle report and becomes "terminal AND useful". That is
 * acceptable ONLY because this wire's consumers are shipped 3.2 (which reads
 * it purely as the control signal above) and 3.1 (which ignores it). Do not
 * copy this rule to `/flowsheet` v2, whose consumers treat the status as data
 * (Spotlight re-donation keys off terminal transitions, issue #443).
 *
 * Field list is hand-synced with THREE iOS enumerations of the same 12 fields
 * (see `Playcut.hasV2Metadata`'s doc comment in
 * `Shared/Playlist/Sources/Playlist/PlaylistEntry.swift`, which names the
 * other two); this is the server-side fourth. `artistId`, `upcoming_show`,
 * `critic_reviews`, `discogsUnavailable` and `discogsUnavailableNote` are
 * deliberately excluded, mirroring their exclusion from the iOS predicate —
 * none of them is playcut-detail metadata, so none of them can prevent the
 * empty render this guard exists to stop.
 */
function hasRenderableInlineMetadata(grouped: GroupedPlaycut): boolean {
  return (
    grouped.artworkURL !== undefined ||
    grouped.discogsURL !== undefined ||
    grouped.releaseYear !== undefined ||
    grouped.spotifyURL !== undefined ||
    grouped.appleMusicURL !== undefined ||
    grouped.youtubeMusicURL !== undefined ||
    grouped.bandcampURL !== undefined ||
    grouped.soundcloudURL !== undefined ||
    grouped.artistBio !== undefined ||
    grouped.artistWikipediaURL !== undefined ||
    grouped.genres !== undefined ||
    grouped.styles !== undefined
  );
}

function applyPlaycutMetadata(grouped: GroupedPlaycut, meta: PlaycutMetadataRow): void {
  // BS#1714: a persisted spotify_url/apple_music_url whose host isn't
  // Spotify/Apple was mislabeled at the LML boundary before #1712 shipped and
  // must not reach the hardwired iOS "Spotify"/"Apple Music" button. Same
  // guard, same helper, as the /flowsheet serve seam.
  const { spotify_url, apple_music_url } = suppressMislabeledStreamingUrls(meta);

  setUrlField(grouped, 'discogsURL', meta.discogs_url);
  setUrlField(grouped, 'spotifyURL', spotify_url);
  setUrlField(grouped, 'appleMusicURL', apple_music_url);
  setUrlField(grouped, 'youtubeMusicURL', meta.youtube_music_url);
  setUrlField(grouped, 'bandcampURL', meta.bandcamp_url);
  setUrlField(grouped, 'soundcloudURL', meta.soundcloud_url);
  setUrlField(grouped, 'artistWikipediaURL', meta.artist_wikipedia_url);

  if (meta.release_year !== null) {
    grouped.releaseYear = meta.release_year;
  }
  const artistBio = wireText(meta.artist_bio);
  if (artistBio !== undefined) {
    grouped.artistBio = artistBio;
  }
  // Empty arrays collapse to an omitted key, mirroring transformToV2's
  // `?.length ? … : null` (BS#1441): a '{}' album_metadata row carries no
  // information. `[null]` and `['']` collapse the same way — see
  // wireStringArray for why `.length` alone is not a safe test here.
  const genres = wireStringArray(meta.genres);
  if (genres !== undefined) {
    grouped.genres = genres;
  }
  const styles = wireStringArray(meta.styles);
  if (styles !== undefined) {
    grouped.styles = styles;
  }
  if (meta.artist_id !== null) {
    grouped.artistId = meta.artist_id;
  }
  // Option-3 serve rule (BS#2103 review): the status accompanies renderable
  // metadata or stays home. Evaluated HERE — after every one of the 12
  // predicate fields above (and the caller's earlier artworkURL assignment)
  // has run — so the check reads the post-guard WIRE payload, not the DB row:
  // a row whose only persisted values were guarded off the wire counts as
  // empty. Position in the key order is unchanged from the unconditional
  // version; only presence is conditional.
  if (meta.metadata_status !== null && hasRenderableInlineMetadata(grouped)) {
    grouped.metadataStatus = meta.metadata_status;
  }
  // BS#1908 present-or-absent: null means "no library row", which is not the
  // same claim as `false`. Same projection rule transformToV2 applies.
  if (meta.discogs_unavailable !== null) {
    grouped.discogsUnavailable = meta.discogs_unavailable;
  }
  const discogsUnavailableNote = wireText(meta.discogs_unavailable_note);
  if (discogsUnavailableNote !== undefined) {
    grouped.discogsUnavailableNote = discogsUnavailableNote;
  }
}

interface FallbackCandidate {
  id: number;
  rotation_id: number | null;
  album_id: number | null;
  artist_name: string | null;
  album_title: string | null;
  add_time: Date;
}

/**
 * Resolve the rotation-badge FALLBACK for hand-typed playcuts, batched
 * (BS#1862).
 *
 * The primary rotation source is the FK join in `getRecentEntries`'s window
 * query (`rotation.rotation_bin` via `flowsheet.rotation_id`). This fallback
 * covers only the cohort that join can't reach: track entries a DJ typed by
 * hand instead of picking from the rotation UI (`rotation_id IS NULL`) that
 * nonetheless match an active rotation record. It reconstructs the exact
 * match tubafrenzy's own flowsheetEntryType=2 (rotation) classification
 * used, three branches:
 *   (a) direct album_id match (`flowsheet.album_id = rotation.album_id`);
 *   (b) rotation's own denormalized artist/album text;
 *   (c) rotation -> library -> artists text (rotations added via the picker
 *       carry an album_id link but may have NULL artist_name/album_title).
 * As in the original, a row must have a non-empty artist AND album to be a
 * candidate, and the lowest `rotation.id` match wins.
 *
 * Why batched instead of the original per-row correlated subquery: that
 * subquery was evaluated for every one of the 200 window rows (before the
 * slice), and branch (c) forced a full seq scan of the 64k-row `library`
 * table per row — ~2.4s server-side, constant in `n` (BS#1862). Here the
 * active-rotation set is materialized ONCE (an index nested-loop into
 * library, not a per-row seq scan) and matched against the <= n sliced
 * candidates, dropping the cost to ~10-30ms.
 *
 * The `active_rot` date bounds are a padded superset of the candidate batch's
 * play dates (min-1d .. max+1d) so a single materialized scan covers every
 * candidate; the final join re-applies the exact per-candidate active-window
 * predicate (`add_date <= play_date < kill_date`), so correctness does not
 * depend on the bound padding. Degrades to an empty map on query failure
 * (badge shows 'false' rather than 500-ing the endpoint), mirroring
 * enrichPlaycuts.
 *
 * @returns Map of flowsheet.id -> rotation_bin for the candidates that
 *          matched an active rotation. Absent ids had no fallback match.
 */
async function resolveFallbackRotation(candidates: FallbackCandidate[]): Promise<Map<number, string>> {
  // Only hand-typed track rows with a non-null, non-empty artist AND album,
  // and no FK rotation link, are fallback candidates — the exact gate the
  // original CASE used (`flowsheet.rotation_id IS NULL AND
  // coalesce(artist_name,'') <> '' AND coalesce(album_title,'') <> ''`). NOT
  // trimmed: the original SQL gate is untrimmed, and trimming here would drop a
  // whitespace-only-artist linked row that the album_id branch could still
  // badge (SQL `trim()` collapses it to '' downstream, matching the original).
  const eligible = candidates.filter(
    (c) => c.rotation_id == null && (c.artist_name ?? '') !== '' && (c.album_title ?? '') !== ''
  );
  if (eligible.length === 0) return new Map();

  // Padded (±1 day) UTC date bounds spanning the batch, so the materialized
  // active-rotation set is a superset of every candidate's per-day active
  // window. The DB session is UTC (RDS default) and `add_time::date` casts in
  // session TZ, so a UTC date bound matches; the ±1d padding is cheap
  // insurance against any session-TZ skew. The final join re-checks each
  // candidate's exact window regardless, so the padding only affects how many
  // rotation rows are materialized, never the result.
  const times = eligible.map((c) => c.add_time.getTime());
  const boundLo = new Date(Math.min(...times) - DAY_MS).toISOString().slice(0, 10);
  const boundHi = new Date(Math.max(...times) + DAY_MS).toISOString().slice(0, 10);

  // One VALUES row per candidate: (flowsheet id, album_id, normalized artist,
  // normalized album, play date). Normalization is done IN SQL — the same
  // `lower(trim(coalesce(...)))` the active_rot side uses — so both sides of
  // the equality join share Postgres semantics. Normalizing the candidate
  // side in JS instead (`.toLowerCase().trim()`) would desync the join: JS
  // `.trim()` strips all whitespace, but Postgres `trim()` strips only spaces,
  // so an artist/album with an edge tab or newline would normalize differently
  // on the two sides and match (or miss) differently than the original query.
  const candRows = eligible.map(
    (c) =>
      sql`(${c.id}::int, ${c.album_id}::int, lower(trim(coalesce(${c.artist_name}::text, ''))), lower(trim(coalesce(${c.album_title}::text, ''))), ${c.add_time.toISOString()}::timestamptz::date)`
  );

  try {
    const result = await db.execute(sql`
      WITH cand(fid, album_id, norm_artist, norm_album, play_date) AS (
        VALUES ${sql.join(candRows, sql`, `)}
      ),
      active_rot AS MATERIALIZED (
        SELECT
          r2.id,
          r2.rotation_bin,
          r2.album_id,
          r2.add_date,
          r2.kill_date,
          lower(trim(coalesce(r2.artist_name, ''))) AS r_artist,
          lower(trim(coalesce(r2.album_title, ''))) AS r_album,
          lower(trim(coalesce(a2.artist_name, ''))) AS lib_artist,
          lower(trim(coalesce(l2.album_title, ''))) AS lib_album
        FROM ${rotation} r2
        LEFT JOIN ${library} l2 ON l2.id = r2.album_id
        LEFT JOIN ${artists} a2 ON a2.id = l2.artist_id
        WHERE r2.add_date <= ${boundHi}::date
          AND (r2.kill_date IS NULL OR r2.kill_date > ${boundLo}::date)
      )
      SELECT DISTINCT ON (cand.fid) cand.fid AS fid, ar.rotation_bin AS rotation_bin
      FROM cand
      JOIN active_rot ar
        ON ar.add_date <= cand.play_date
       AND (ar.kill_date IS NULL OR ar.kill_date > cand.play_date)
      WHERE (cand.album_id IS NOT NULL AND ar.album_id = cand.album_id)
         OR (ar.r_artist = cand.norm_artist AND ar.r_album = cand.norm_album)
         OR (ar.lib_artist = cand.norm_artist AND ar.lib_album = cand.norm_album)
      ORDER BY cand.fid, ar.id
    `);

    const map = new Map<number, string>();
    for (const row of result as unknown as Array<{ fid: number; rotation_bin: string | null }>) {
      if (row.rotation_bin != null) {
        map.set(Number(row.fid), row.rotation_bin);
      }
    }
    return map;
  } catch (err) {
    console.error('[playlist-proxy] rotation fallback resolution failed:', err);
    return new Map();
  }
}
