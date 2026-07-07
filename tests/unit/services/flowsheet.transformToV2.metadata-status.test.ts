import { transformToV2 } from '../../../apps/backend/services/flowsheet.service';
import { IFSEntry, IFSEntryMetadata } from '../../../apps/backend/controllers/flowsheet.controller';

// `metadata_status` (BS#891) is projected from the IFSEntry onto the V2 wire
// format for track rows. iOS branches on it to decide whether to show inline
// enrichment data or fall back to the proxy-fetch path (WXYC/wxyc-ios-64#270).

const nullMetadata: IFSEntryMetadata = {
  artwork_url: null,
  discogs_url: null,
  release_year: null,
  spotify_url: null,
  apple_music_url: null,
  youtube_music_url: null,
  bandcamp_url: null,
  soundcloud_url: null,
  artist_bio: null,
  artist_wikipedia_url: null,
  genres: null,
  styles: null,
};

const createTrackEntry = (overrides: Partial<IFSEntry> = {}): IFSEntry => ({
  id: 1,
  show_id: 100,
  album_id: null,
  rotation_id: null,
  entry_type: 'track',
  track_title: 'la paradoja',
  track_position: null,
  album_title: 'DOGA',
  artist_name: 'Juana Molina',
  record_label: 'Sonamos',
  label_id: null,
  play_order: 1,
  request_flag: false,
  segue: false,
  message: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  dj_name: null,
  rotation_bin: null,
  on_streaming: null,
  legacy_entry_id: null,
  legacy_release_id: null,
  linkage_source: null,
  linkage_confidence: null,
  linked_at: null,
  metadata_status: 'pending',
  enriching_since: null,
  radio_hour: null,
  metadata: nullMetadata,
  ...overrides,
});

describe('transformToV2 metadata_status projection (BS#891)', () => {
  it.each(['pending', 'enriching', 'enriched_match', 'enriched_no_match', 'failed_no_retry'] as const)(
    'projects metadata_status=%s onto V2 track entries',
    (status) => {
      const entry = createTrackEntry({ metadata_status: status });
      const result = transformToV2(entry);
      expect(result.metadata_status).toBe(status);
    }
  );

  it('omits metadata_status from V2 non-track entries (show_start)', () => {
    // metadata_status only applies to track rows. The V2 contract for marker
    // types (show_start, show_end, dj_join, dj_leave, talkset, breakpoint,
    // message) deliberately drops it — these rows never carry inline
    // metadata so the field would be noise.
    const entry = createTrackEntry({
      entry_type: 'show_start',
      metadata_status: 'pending',
    });
    const result = transformToV2(entry);
    expect(result).not.toHaveProperty('metadata_status');
  });
});
