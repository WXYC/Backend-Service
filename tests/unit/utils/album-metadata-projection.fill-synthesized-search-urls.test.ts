/**
 * Unit tests for `fillSynthesizedSearchUrls` (#2339) — the request-time-only
 * fallback that fills a still-absent streaming URL with a synthesized search
 * URL, mirroring `GET /proxy/metadata/album`'s degradation (BS#1184/#1185).
 */

import {
  fillSynthesizedSearchUrls,
  type SynthesizableStreamingUrls,
} from '../../../apps/backend/utils/album-metadata-projection';

const allNull: SynthesizableStreamingUrls = {
  spotify_url: null,
  apple_music_url: null,
  youtube_music_url: null,
  bandcamp_url: null,
  soundcloud_url: null,
};

describe('fillSynthesizedSearchUrls', () => {
  it('fills all five absent URLs from artist/album/track text', () => {
    const filled = fillSynthesizedSearchUrls(allNull, {
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
    });

    expect(filled.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
    expect(filled.apple_music_url).toBe('https://music.apple.com/search?term=Juana%20Molina%20la%20paradoja');
    expect(filled.youtube_music_url).toBe('https://music.youtube.com/search?q=Juana%20Molina%20la%20paradoja');
    expect(filled.bandcamp_url).toBe('https://bandcamp.com/search?q=Juana%20Molina%20DOGA');
    expect(filled.soundcloud_url).toBe('https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja');
  });

  it('fills only the absent fields, leaving a populated value untouched', () => {
    const filled = fillSynthesizedSearchUrls(
      { ...allNull, spotify_url: 'https://open.spotify.com/album/genuine' },
      { artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja' }
    );

    expect(filled.spotify_url).toBe('https://open.spotify.com/album/genuine');
    expect(filled.apple_music_url).not.toBeNull();
  });

  it('returns the input unchanged when every field is already populated (no synthesis call needed)', () => {
    const populated: SynthesizableStreamingUrls = {
      spotify_url: 'https://open.spotify.com/album/1',
      apple_music_url: 'https://music.apple.com/us/album/1',
      youtube_music_url: 'https://music.youtube.com/playlist?list=1',
      bandcamp_url: 'https://artist.bandcamp.com/album/1',
      soundcloud_url: 'https://soundcloud.com/artist/1',
    };

    const filled = fillSynthesizedSearchUrls(populated, {
      artist_name: 'Juana Molina',
      album_title: 'DOGA',
      track_title: 'la paradoja',
    });

    expect(filled).toEqual(populated);
  });

  it('leaves every field null when artist_name is null (marker/talkset/breakpoint rows, or a track with no artist)', () => {
    const filled = fillSynthesizedSearchUrls(allNull, { artist_name: null, album_title: null, track_title: null });

    expect(filled).toEqual(allNull);
  });

  it('leaves every field null when artist_name is blank', () => {
    const filled = fillSynthesizedSearchUrls(allNull, { artist_name: '', album_title: 'DOGA', track_title: null });

    expect(filled).toEqual(allNull);
  });
});
