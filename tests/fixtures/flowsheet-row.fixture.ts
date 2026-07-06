import type { FSEntry } from '@wxyc/database';

/**
 * Shared BS#1513 leak-regression fixtures.
 *
 * `INTERNAL_FLOWSHEET_COLUMNS` — the columns that must never ride a
 * client-facing flowsheet payload: search internals, the row watermark,
 * enrichment-lifecycle markers, linkage-audit fields, the BS#1499 composer
 * columns, and the tubafrenzy legacy keys. Deliberately maintained as a
 * deny-list SEPARATE from the shipping `CLIENT_FACING_FLOWSHEET_COLUMNS`
 * allow-list: tests asserting these keys absent would go vacuous if they
 * derived from the same enumeration they check. When a new internal column
 * lands on `flowsheet`, add it HERE (one place) and every consuming suite
 * starts covering it.
 *
 * Consumed by the three suites pinning the leak defense at each layer:
 *   - projector:  tests/unit/utils/flowsheet-projection.test.ts
 *   - mutations:  tests/unit/controllers/flowsheet.controller.test.ts
 *   - DJ peek:    tests/unit/services/djs.getPlaylistsForDJ.test.ts
 */
export const INTERNAL_FLOWSHEET_COLUMNS = [
  'search_doc',
  'updated_at',
  'enriching_since',
  'metadata_attempt_at',
  'legacy_link_attempted_at',
  'linkage_source',
  'linkage_confidence',
  'linked_at',
  'composer',
  'composer_source',
  'legacy_entry_id',
  'legacy_release_id',
] as const;

/**
 * A fully-populated raw flowsheet row — every column non-null (bar `message`,
 * which is mutually exclusive with track fields) so an accidental inclusion
 * of an internal column surfaces as a truthy value on the projected object
 * rather than a silently-passing `null`/`undefined`.
 */
export function makeFullFlowsheetRow(overrides: Record<string, unknown> = {}): FSEntry {
  return {
    id: 42,
    show_id: 1946734,
    album_id: 20,
    rotation_id: 7,
    legacy_entry_id: 9999,
    legacy_release_id: 8888,
    entry_type: 'track',
    track_title: 'la paradoja',
    track_position: 'A1',
    album_title: 'DOGA',
    artist_name: 'Juana Molina',
    record_label: 'Sonamos',
    label_id: 3,
    play_order: 5,
    request_flag: false,
    segue: true,
    message: null,
    add_time: new Date('2024-01-01T20:00:00Z'),
    radio_hour: new Date('2024-01-01T20:00:00Z'),
    updated_at: new Date('2024-01-01T20:05:00Z'),
    artwork_url: 'https://example.com/art.jpg',
    discogs_url: 'https://discogs.com/release/1',
    release_year: 2022,
    spotify_url: 'https://open.spotify.com/album/1',
    apple_music_url: 'https://music.apple.com/album/1',
    youtube_music_url: 'https://music.youtube.com/1',
    bandcamp_url: 'https://juana.bandcamp.com/1',
    soundcloud_url: 'https://soundcloud.com/juana/1',
    artist_bio: 'Argentine musician.',
    artist_wikipedia_url: 'https://en.wikipedia.org/wiki/Juana_Molina',
    dj_name: 'DJ Test',
    linkage_source: 'lml_high_confidence',
    linkage_confidence: 0.98,
    linked_at: new Date('2024-01-01T20:01:00Z'),
    composer: 'Juana Molina',
    composer_source: 'artist_proxy',
    legacy_link_attempted_at: new Date('2024-01-01T20:02:00Z'),
    metadata_attempt_at: new Date('2024-01-01T20:03:00Z'),
    metadata_status: 'enriched_match',
    enriching_since: new Date('2024-01-01T20:04:00Z'),
    // search_doc is a STORED GENERATED tsvector; opaque string on the wire.
    search_doc: "'juana':1A 'molina':2A",
    ...overrides,
  } as unknown as FSEntry;
}
