import type { FSEntry } from '@wxyc/database';
import {
  projectFlowsheetEntry,
  CLIENT_FACING_FLOWSHEET_COLUMNS,
} from '../../../apps/backend/utils/flowsheet-projection';

/**
 * BS#1513. The mutation (`addEntry`/`deleteEntry`/`updateEntry`/`changeOrder`)
 * and DJ peek/playlist paths used to serialize the raw `flowsheet` row from
 * Drizzle `.returning()` / `db.select().from(flowsheet)` — every column,
 * including internal ones. `projectFlowsheetEntry` is the explicit client-facing
 * allow-list those paths now run their rows through.
 *
 * These are the columns that must never ride a client-facing flowsheet payload.
 * They are either search internals, job/enrichment lifecycle markers, linkage
 * audit fields, the row watermark, or the BS#1499 composer columns — none of
 * which any consumer (dj-site `convertV2Entry`, iOS V2 reader) reads off these
 * responses. See the issue's consumer audit.
 */
const INTERNAL_COLUMNS = [
  'search_doc',
  'updated_at',
  'metadata_status',
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
 * A fully-populated raw flowsheet row — every column non-null so that an
 * accidental inclusion of an internal column would surface as a truthy value
 * on the projected object rather than a silently-passing `null`.
 */
function makeFullRow(): FSEntry {
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
  } as unknown as FSEntry;
}

describe('projectFlowsheetEntry (BS#1513)', () => {
  it('drops every internal column from the projected payload', () => {
    const projected = projectFlowsheetEntry(makeFullRow());
    for (const internalKey of INTERNAL_COLUMNS) {
      expect(projected).not.toHaveProperty(internalKey);
    }
  });

  it('preserves every client-facing column with its original value', () => {
    const row = makeFullRow();
    const projected = projectFlowsheetEntry(row);
    for (const key of CLIENT_FACING_FLOWSHEET_COLUMNS) {
      expect(projected[key]).toEqual(row[key]);
    }
  });

  it('exposes exactly the allow-listed keys — no more, no less', () => {
    const projected = projectFlowsheetEntry(makeFullRow());
    expect(new Set(Object.keys(projected))).toEqual(new Set(CLIENT_FACING_FLOWSHEET_COLUMNS));
  });

  it('keeps the discriminator (entry_type) and description fields convertV2Entry reads', () => {
    // dj-site's POST /flowsheet consumer (convertV2Entry) branches on
    // entry_type and reads these flat fields; dropping any would break the
    // optimistic-insert reconciliation. Pins that contract.
    const projected = projectFlowsheetEntry(makeFullRow());
    for (const key of [
      'id',
      'show_id',
      'play_order',
      'entry_type',
      'artist_name',
      'album_title',
      'track_title',
      'record_label',
      'request_flag',
      'segue',
      'album_id',
      'rotation_id',
      'artwork_url',
      'add_time',
    ] as const) {
      expect(projected).toHaveProperty(key);
    }
  });

  it('does not mutate the input row', () => {
    const row = makeFullRow();
    const before = { ...row };
    projectFlowsheetEntry(row);
    expect(row).toEqual(before);
  });

  it('projects a message/marker row without inventing track fields', () => {
    const row = {
      ...makeFullRow(),
      entry_type: 'talkset',
      message: 'Talkset',
      track_title: null,
    } as unknown as FSEntry;
    const projected = projectFlowsheetEntry(row);
    expect(projected.message).toBe('Talkset');
    expect(projected.entry_type).toBe('talkset');
    expect(projected).not.toHaveProperty('search_doc');
  });
});
