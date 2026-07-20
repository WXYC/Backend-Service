import type { FSEntry } from '@wxyc/database';
import { isSpotifyUrl, isAppleMusicUrl } from '@wxyc/lml-client';

/**
 * Client-facing flowsheet-row projection (BS#1513).
 *
 * Several write-side and DJ-tooling paths historically serialized the *raw*
 * `flowsheet` row straight to clients:
 *   - the mutation handlers (`addEntry` / `deleteEntry` / `updateEntry` /
 *     `changeOrder`) returned the Drizzle `.returning()` row;
 *   - the DJ peek (`djs.service` `getPlaylistsForDJ`) returned
 *     `db.select().from(flowsheet)` rows.
 *
 * Both bypassed the V2 read-path projection (`FSEntryFieldsRaw` + `transformToV2`),
 * so internal-only columns rode client-facing payloads — search internals, the
 * row watermark, enrichment-lifecycle markers, linkage-audit fields, and the
 * BS#1499 composer columns. This module is the explicit allow-list those paths
 * now project through.
 *
 * `CLIENT_FACING_FLOWSHEET_COLUMNS` is an *allow-list*, not a deny-list: a new
 * column added to the `flowsheet` table is therefore NOT exposed on these
 * responses unless it is explicitly added here. That default-closed property is
 * the whole point of the ticket — it is what stopped `composer` / `composer_source`
 * from silently leaking when BS#1499 added them.
 *
 * Deliberately excluded (internal columns; no consumer reads them off these
 * responses — see the BS#1513 consumer audit):
 *   - `search_doc`            — STORED GENERATED tsvector, search hot path only
 *   - `updated_at`            — row watermark (conditional-GET reads the sibling
 *                               `flowsheet_watermark` table, never this column)
 *   - `enriching_since`       — enrichment claim timestamp
 *   - `metadata_attempt_at`   — metadata-backfill marker
 *   - `legacy_link_attempted_at` — broken-FK-recovery marker
 *   - `linkage_source` / `linkage_confidence` / `linked_at` — linkage audit (B-1.4)
 *   - `composer` / `composer_source` — BS#1499 write-only BMI export columns
 *   - `legacy_entry_id` / `legacy_release_id` — tubafrenzy surrogate keys /
 *                               mirror loop-guard; never on the V2 client wire
 *
 * `metadata_status` IS retained — a deliberate deviation from #1513's AC
 * wording (PR #1532 review): the wxyc-shared api.yaml SSOT declares it on
 * `FlowsheetEntryResponse` (the documented 200 of all four mutation endpoints),
 * `transformToV2` emits it on V2 track reads for iOS branch logic
 * (wxyc-ios-64#270), and `LiveFsUpdateEvent` requires it. The internal aspect
 * is write-protection — `pickUpdateEntryFields` blocks clients from *setting*
 * it — not read visibility.
 *
 * The retained set mirrors the flat descriptive fields the V2 wire already
 * carries (plus the inline metadata columns), so `dj-site`'s `convertV2Entry`
 * and the iOS V2 reader see exactly the fields they already consume.
 */
export const CLIENT_FACING_FLOWSHEET_COLUMNS = [
  'id',
  'show_id',
  'album_id',
  'rotation_id',
  'entry_type',
  'artist_name',
  'album_title',
  'track_title',
  'track_position',
  'record_label',
  'label_id',
  'play_order',
  'request_flag',
  'segue',
  'message',
  'add_time',
  'radio_hour',
  'dj_name',
  'metadata_status',
  'artwork_url',
  'discogs_url',
  'release_year',
  'spotify_url',
  'apple_music_url',
  'youtube_music_url',
  'bandcamp_url',
  'soundcloud_url',
  'artist_bio',
  'artist_wikipedia_url',
] as const;

/** The client-facing subset of a flowsheet row (see the allow-list above). */
export type ClientFacingFSEntry = Pick<FSEntry, (typeof CLIENT_FACING_FLOWSHEET_COLUMNS)[number]>;

/**
 * Project a raw flowsheet row onto the client-facing allow-list, dropping every
 * internal column. Written as an explicit field-by-field object literal (rather
 * than a loop) so that TypeScript enforces the shape against `ClientFacingFSEntry`
 * and a schema change that renames a client-facing column is a compile error.
 *
 * BS#1714: `spotify_url` / `apple_music_url` are host-guarded on the way out — a
 * value whose host isn't Spotify/Apple (mislabeled at the LML boundary before
 * #1712 shipped) is dropped to `null` rather than emitted under the hardwired
 * iOS "Spotify"/"Apple Music" button. Every other column passes through as-is.
 */
export function projectFlowsheetEntry(row: FSEntry): ClientFacingFSEntry {
  return {
    id: row.id,
    show_id: row.show_id,
    album_id: row.album_id,
    rotation_id: row.rotation_id,
    entry_type: row.entry_type,
    artist_name: row.artist_name,
    album_title: row.album_title,
    track_title: row.track_title,
    track_position: row.track_position,
    record_label: row.record_label,
    label_id: row.label_id,
    play_order: row.play_order,
    request_flag: row.request_flag,
    segue: row.segue,
    message: row.message,
    add_time: row.add_time,
    radio_hour: row.radio_hour,
    dj_name: row.dj_name,
    metadata_status: row.metadata_status,
    artwork_url: row.artwork_url,
    discogs_url: row.discogs_url,
    release_year: row.release_year,
    // BS#1714: null a non-Spotify/non-Apple value; leave a nullish or genuine
    // value untouched — same `!= null &&` shape as `sanitizeLookupStreamingUrls`.
    spotify_url: row.spotify_url != null && !isSpotifyUrl(row.spotify_url) ? null : row.spotify_url,
    apple_music_url: row.apple_music_url != null && !isAppleMusicUrl(row.apple_music_url) ? null : row.apple_music_url,
    youtube_music_url: row.youtube_music_url,
    bandcamp_url: row.bandcamp_url,
    soundcloud_url: row.soundcloud_url,
    artist_bio: row.artist_bio,
    artist_wikipedia_url: row.artist_wikipedia_url,
  };
}

/**
 * JSON-tolerant sibling of {@link projectFlowsheetEntry} for flowsheet rows
 * that arrive as parsed JSON rather than a typed `FSEntry` — notably the CDC
 * `to_jsonb(NEW)` payload the anonymous `liveFs:update` SSE broadcast forwards
 * (BS#1534), where dates are ISO strings and the static `FSEntry` shape doesn't
 * apply. It loops the same `CLIENT_FACING_FLOWSHEET_COLUMNS` allow-list — one
 * list, zero drift with the typed projector — and copies only the columns
 * actually present on the row, so a partial row is not padded with invented
 * keys. Values pass through untouched (an ISO-string date stays an ISO string),
 * with the sole exception of the BS#1714 host guard below: a `spotify_url` /
 * `apple_music_url` that is present but whose host isn't Spotify/Apple is nulled
 * (the same suppression {@link projectFlowsheetEntry} applies), so the CDC
 * `liveFs:update` SSE never carries a mislabeled URL under the hardwired iOS
 * "Spotify"/"Apple Music" button. A column absent from the row stays absent.
 */
export function pickClientFacingColumns(row: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const column of CLIENT_FACING_FLOWSHEET_COLUMNS) {
    if (Object.hasOwn(row, column)) {
      // eslint-disable-next-line security/detect-object-injection -- keys are the fixed allow-list const, not caller input
      projected[column] = row[column];
    }
  }
  // BS#1714 host guard. Values arrive as parsed JSON (`unknown`); the guards
  // narrow a non-string to `false`, so the cast to the `string | null` these
  // columns actually hold is safe. Only null a key that is present — a partial
  // row that omitted it stays omitted (the "not padded with invented keys"
  // contract above).
  if (Object.hasOwn(projected, 'spotify_url') && !isSpotifyUrl(projected.spotify_url as string | null)) {
    projected.spotify_url = null;
  }
  if (Object.hasOwn(projected, 'apple_music_url') && !isAppleMusicUrl(projected.apple_music_url as string | null)) {
    projected.apple_music_url = null;
  }
  return projected;
}
