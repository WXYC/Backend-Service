import { transformToIFSEntry, type FSEntryRaw } from '../../../apps/backend/services/flowsheet.service';

/**
 * BS#1714. `transformToIFSEntry` is the single producer of every IFSEntry that
 * reaches the `/flowsheet` read (top-level `spotify_url`/`apple_music_url`) and
 * the `/v2/flowsheet` read (`transformToV2`, nested `metadata`). Fill-only
 * persistence left non-Spotify/non-Apple URLs under those two columns before
 * #1712's ingestion guard shipped; this seam host-guards them so a mislabeled
 * value never reaches the hardwired iOS "Spotify"/"Apple Music" button. Both the
 * top-level field and the nested `metadata` copy must be suppressed together.
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
  metadata_status: 'enriched_match',
  enriching_since: null,
  radio_hour: null,
  ...overrides,
});

describe('transformToIFSEntry streaming-URL host guard (BS#1714)', () => {
  it('suppresses a mislabeled spotify_url on both the top-level field and nested metadata', () => {
    const entry = transformToIFSEntry(makeRaw({ spotify_url: 'https://www.deezer.com/album/254381182' }));
    expect(entry.spotify_url).toBeNull();
    expect(entry.metadata.spotify_url).toBeNull();
  });

  it('suppresses a mislabeled apple_music_url on both the top-level field and nested metadata', () => {
    const entry = transformToIFSEntry(makeRaw({ apple_music_url: 'https://tidal.com/browse/album/254381182' }));
    expect(entry.apple_music_url).toBeNull();
    expect(entry.metadata.apple_music_url).toBeNull();
  });

  it('drops a suffix-spoof host to null', () => {
    const entry = transformToIFSEntry(makeRaw({ spotify_url: 'https://open.spotify.com.evil.example/album/1' }));
    expect(entry.spotify_url).toBeNull();
    expect(entry.metadata.spotify_url).toBeNull();
  });

  it('passes a genuine Spotify/Apple URL through on both positions', () => {
    const entry = transformToIFSEntry(
      makeRaw({
        spotify_url: 'https://open.spotify.com/album/genuine',
        apple_music_url: 'https://music.apple.com/us/album/genuine',
      })
    );
    expect(entry.spotify_url).toBe('https://open.spotify.com/album/genuine');
    expect(entry.metadata.spotify_url).toBe('https://open.spotify.com/album/genuine');
    expect(entry.apple_music_url).toBe('https://music.apple.com/us/album/genuine');
    expect(entry.metadata.apple_music_url).toBe('https://music.apple.com/us/album/genuine');
  });

  it('leaves the other three streaming fields untouched when spotify_url is mislabeled', () => {
    const entry = transformToIFSEntry(
      makeRaw({
        spotify_url: 'https://www.deezer.com/album/1',
        youtube_music_url: 'https://music.youtube.com/playlist?list=yt',
        bandcamp_url: 'https://artist.bandcamp.com/album/x',
        soundcloud_url: 'https://soundcloud.com/artist/x',
      })
    );
    expect(entry.youtube_music_url).toBe('https://music.youtube.com/playlist?list=yt');
    expect(entry.bandcamp_url).toBe('https://artist.bandcamp.com/album/x');
    expect(entry.soundcloud_url).toBe('https://soundcloud.com/artist/x');
  });
});
