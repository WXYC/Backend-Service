/**
 * Unit tests for `fillSynthesizedSearchUrls` (#2339) — the request-time-only
 * fallback that fills a still-absent streaming URL with a synthesized search
 * URL, mirroring `GET /proxy/metadata/album`'s degradation (BS#1184/#1185).
 *
 * The fill is GATED (owner decision, 2026-08-31): it only fires for a row whose
 * post-host-guard values already carry at least one REAL streaming URL —
 * non-null and non-blank. Shipped iOS 3.2 skips its live
 * `/proxy/metadata/album` fetch on `inline.streaming.hasAny`, so such a row
 * short-circuits inline regardless and the fill can only upgrade grey
 * Spotify/Apple buttons; a zero-streaming row must keep serving NULLs so the
 * live proxy fallback (full metadata plus its own synthesized links) still
 * fires.
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

const JUANA = { artist_name: 'Juana Molina', album_title: 'DOGA', track_title: 'la paradoja' };

/** The post-#2295-drain shape: synthesized YT/Bandcamp/SoundCloud, NULL Spotify/Apple. */
const DRAINED_YOUTUBE = 'https://music.youtube.com/search?q=Juana%20Molina%20la%20paradoja';

describe('fillSynthesizedSearchUrls', () => {
  describe('the gate: at least one real streaming URL', () => {
    it('fills the absent fields on a row that already carries one', () => {
      const filled = fillSynthesizedSearchUrls({ ...allNull, youtube_music_url: DRAINED_YOUTUBE }, JUANA);

      expect(filled.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
      expect(filled.apple_music_url).toBe('https://music.apple.com/search?term=Juana%20Molina%20la%20paradoja');
      expect(filled.bandcamp_url).toBe('https://bandcamp.com/search?q=Juana%20Molina%20DOGA');
      expect(filled.soundcloud_url).toBe('https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja');
      expect(filled.youtube_music_url).toBe(DRAINED_YOUTUBE);
    });

    it('fills nothing when every field is absent — the row must keep serving NULLs', () => {
      expect(fillSynthesizedSearchUrls(allNull, JUANA)).toEqual(allNull);
    });

    it("does not count a blank as real: '' / whitespace-only leave the row zero-streaming", () => {
      const filled = fillSynthesizedSearchUrls({ ...allNull, spotify_url: '', bandcamp_url: '   ' }, JUANA);

      // …and the blanks are normalized to null, so neither can reach the V1
      // `/flowsheet` wire as `""`.
      expect(filled).toEqual(allNull);
    });

    it('counts a caller-supplied post-guard null as absent (a suppressed URL never re-qualifies its own row)', () => {
      // `suppressMislabeledStreamingUrls` has already nulled the mislabeled
      // spotify_url before this helper sees it, so the row reads as
      // zero-streaming — BS#1714 degradation, unchanged.
      expect(fillSynthesizedSearchUrls(allNull, JUANA)).toEqual(allNull);
    });
  });

  describe('blank-aware degradation (matching the proxy falsy branch)', () => {
    it("degrades a persisted '' to a synthesized URL on a qualifying row", () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, spotify_url: '', youtube_music_url: DRAINED_YOUTUBE },
        JUANA
      );

      expect(filled.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
    });

    it('degrades a whitespace-only persisted value the same way', () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, soundcloud_url: ' \t ', youtube_music_url: DRAINED_YOUTUBE },
        JUANA
      );

      expect(filled.soundcloud_url).toBe('https://soundcloud.com/search?q=Juana%20Molina%20la%20paradoja');
    });
  });

  describe('the artist gate', () => {
    it('fills nothing when artist_name is null (marker/talkset/breakpoint rows, or a track with no artist)', () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, youtube_music_url: DRAINED_YOUTUBE },
        { artist_name: null, album_title: null, track_title: null }
      );

      expect(filled).toEqual({ ...allNull, youtube_music_url: DRAINED_YOUTUBE });
    });

    it("fills nothing when artist_name is '' ", () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, youtube_music_url: DRAINED_YOUTUBE },
        { artist_name: '', album_title: 'DOGA', track_title: null }
      );

      expect(filled.spotify_url).toBeNull();
    });

    // Pre-fix this synthesized five buttons opening `%20%20%20` searches.
    it('fills nothing when artist_name is whitespace-only', () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, youtube_music_url: DRAINED_YOUTUBE },
        { artist_name: '   ', album_title: 'DOGA', track_title: 'la paradoja' }
      );

      expect(filled.spotify_url).toBeNull();
      expect(filled.apple_music_url).toBeNull();
      expect(filled.bandcamp_url).toBeNull();
      expect(filled.soundcloud_url).toBeNull();
      expect(filled.youtube_music_url).toBe(DRAINED_YOUTUBE);
    });

    it('trims a padded artist_name / album_title / track_title out of the search query', () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, youtube_music_url: DRAINED_YOUTUBE },
        { artist_name: '  Juana Molina  ', album_title: '  DOGA  ', track_title: '  la paradoja  ' }
      );

      expect(filled.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina%20la%20paradoja');
      expect(filled.bandcamp_url).toBe('https://bandcamp.com/search?q=Juana%20Molina%20DOGA');
    });

    it('treats a whitespace-only album_title/track_title as absent rather than searching on the padding', () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, youtube_music_url: DRAINED_YOUTUBE },
        { artist_name: 'Juana Molina', album_title: '   ', track_title: '   ' }
      );

      expect(filled.spotify_url).toBe('https://open.spotify.com/search/Juana%20Molina');
      expect(filled.bandcamp_url).toBe('https://bandcamp.com/search?q=Juana%20Molina');
    });
  });

  it('fills only the absent fields, leaving a populated value untouched', () => {
    const filled = fillSynthesizedSearchUrls(
      { ...allNull, spotify_url: 'https://open.spotify.com/album/genuine' },
      JUANA
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

    expect(fillSynthesizedSearchUrls(populated, JUANA)).toEqual(populated);
  });
});
