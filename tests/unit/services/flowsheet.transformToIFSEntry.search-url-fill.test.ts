import { transformToIFSEntry, type FSEntryRaw } from '../../../apps/backend/services/flowsheet.service';

/**
 * #2339. `transformToIFSEntry` is the single producer of every IFSEntry that
 * reaches `/flowsheet` (top-level fields), `/v2/flowsheet` (`transformToV2`,
 * nested `metadata`), and the mutation/peek echoes (BS#1513's
 * `CLIENT_FACING_FLOWSHEET_COLUMNS` allow-list projects off the same
 * IFSEntry). This pins the request-time streaming-URL fallback fill —
 * `fillSynthesizedSearchUrls` — at that one seam, so a still-absent value
 * degrades to a synthesized search URL identically to `GET
 * /proxy/metadata/album` (BS#1184/#1185) instead of reaching the wire as
 * `null`.
 */

const makeRaw = (overrides: Partial<FSEntryRaw> = {}): FSEntryRaw => ({
  id: 1,
  show_id: 100,
  album_id: null,
  entry_type: 'track',
  artist_name: 'Juana Molina',
  album_title: 'DOGA',
  track_title: 'la paradoja',
  track_position: null,
  record_label: 'Sonamos',
  label_id: null,
  rotation_id: null,
  rotation_bin: null,
  artist_id: null,
  request_flag: false,
  segue: false,
  message: null,
  play_order: 1,
  legacy_entry_id: null,
  legacy_release_id: null,
  add_time: new Date('2026-04-17T22:53:48.500Z'),
  dj_name: null,
  linkage_source: null,
  linkage_confidence: null,
  linked_at: null,
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
  on_streaming: null,
  discogs_unavailable: null,
  discogs_unavailable_note: null,
  metadata_status: 'enriched_no_match',
  enriching_since: null,
  radio_hour: null,
  ...overrides,
});

describe('transformToIFSEntry streaming-URL search-url fill (#2339)', () => {
  it('fills all five absent streaming URLs with synthesized search URLs, on both the top-level fields and nested metadata', () => {
    const entry = transformToIFSEntry(makeRaw());

    const expected = {
      spotify_url: 'https://open.spotify.com/search/Juana%20Molina%20la%20paradoja',
      apple_music_url: 'https://music.apple.com/search?term=Juana%20Molina%20la%20paradoja',
      youtube_music_url: 'https://music.youtube.com/search?q=Juana%20Molina%20la%20paradoja',
      bandcamp_url: 'https://bandcamp.com/search?q=Juana%20Molina%20DOGA',
      soundcloud_url: 'https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja',
    };

    expect(entry.spotify_url).toBe(expected.spotify_url);
    expect(entry.apple_music_url).toBe(expected.apple_music_url);
    expect(entry.youtube_music_url).toBe(expected.youtube_music_url);
    expect(entry.bandcamp_url).toBe(expected.bandcamp_url);
    expect(entry.soundcloud_url).toBe(expected.soundcloud_url);

    expect(entry.metadata.spotify_url).toBe(expected.spotify_url);
    expect(entry.metadata.apple_music_url).toBe(expected.apple_music_url);
    expect(entry.metadata.youtube_music_url).toBe(expected.youtube_music_url);
    expect(entry.metadata.bandcamp_url).toBe(expected.bandcamp_url);
    expect(entry.metadata.soundcloud_url).toBe(expected.soundcloud_url);
  });

  it('a verified persisted URL still wins — fill only touches absent fields', () => {
    const entry = transformToIFSEntry(
      makeRaw({
        spotify_url: 'https://open.spotify.com/album/genuine',
        youtube_music_url: 'https://music.youtube.com/playlist?list=verified',
      })
    );

    expect(entry.spotify_url).toBe('https://open.spotify.com/album/genuine');
    expect(entry.youtube_music_url).toBe('https://music.youtube.com/playlist?list=verified');
    // The other three were still absent, so they're filled.
    expect(entry.apple_music_url).not.toBeNull();
    expect(entry.bandcamp_url).not.toBeNull();
    expect(entry.soundcloud_url).not.toBeNull();
  });

  it('leaves every streaming URL null for a marker row with no artist_name (nothing to search on)', () => {
    const entry = transformToIFSEntry(
      makeRaw({ entry_type: 'talkset', artist_name: null, album_title: null, track_title: null })
    );

    expect(entry.spotify_url).toBeNull();
    expect(entry.apple_music_url).toBeNull();
    expect(entry.youtube_music_url).toBeNull();
    expect(entry.bandcamp_url).toBeNull();
    expect(entry.soundcloud_url).toBeNull();
  });
});
