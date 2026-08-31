/**
 * Unit tests for `fillSynthesizedSearchUrls` (#2339) — the request-time-only
 * fallback that fills a still-absent streaming URL with a synthesized search
 * URL, mirroring `GET /proxy/metadata/album`'s degradation (BS#1184/#1185).
 *
 * The fill is GATED (owner decision, 2026-08-31): it only fires for a row whose
 * post-host-guard values already carry at least one streaming URL the client
 * would actually see. "Would see" is `wireUrl`'s predicate — absolute http(s),
 * no parser differential — so the gate bit and shipped iOS 3.2's
 * `inline.streaming.hasAny` are the same bit by construction. Such a row skips
 * its live `/proxy/metadata/album` fetch regardless, so the fill can only
 * upgrade grey Spotify/Apple buttons; a row with no wireable streaming URL must
 * keep serving NULLs so the live proxy fallback (full metadata plus its own
 * synthesized links) still fires.
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
  describe('the gate: at least one streaming URL the client would see', () => {
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

    it("does not count a blank as present: '' / whitespace-only leave the row zero-streaming", () => {
      const filled = fillSynthesizedSearchUrls({ ...allNull, spotify_url: '', bandcamp_url: '   ' }, JUANA);

      // …and the blanks are normalized to null, so neither can reach the V1
      // `/flowsheet` wire as `""`.
      expect(filled).toEqual(allNull);
    });

    // The adjudicated fix: a non-blank value the wire would never carry must
    // not qualify its row, or the fill flips `streaming.hasAny` false -> true
    // out of nothing and suppresses 3.2's live proxy fallback. Every shape here
    // is one the columns permit and no write path validates — LML values reach
    // youtube/bandcamp/soundcloud verbatim, and BS#1710's guard covers only
    // spotify/apple.
    it.each([
      ['scheme-relative', '//open.spotify.com/album/xyz'],
      ['bare hostname', 'juanamolina.bandcamp.com/album/doga'],
      ['non-web scheme', 'javascript:alert(1)'],
      ['raw-tab parser differential', 'https://music.youtube.com/playlist?list=OLAK5uy_\tabc'],
      ['backslash parser differential', 'https://open.spotify.com\\@evil.example/album/1'],
      ['relative path', '/album/doga'],
    ])('does not count an unwireable value as present (%s)', (_label, hazard) => {
      expect(fillSynthesizedSearchUrls({ ...allNull, bandcamp_url: hazard }, JUANA)).toEqual(allNull);
    });

    it('normalizes an unwireable value to null rather than passing it through', () => {
      const filled = fillSynthesizedSearchUrls({ ...allNull, soundcloud_url: 'javascript:alert(1)' }, JUANA);

      expect(filled.soundcloud_url).toBeNull();
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

    // An unwireable value is absent for the FILL too: on a qualifying row it
    // degrades to a synthesized URL rather than surviving to be dropped
    // downstream with no fallback left to run.
    it('degrades an unwireable persisted value to a synthesized URL on a qualifying row', () => {
      const filled = fillSynthesizedSearchUrls(
        { ...allNull, bandcamp_url: 'juanamolina.bandcamp.com/album/doga', youtube_music_url: DRAINED_YOUTUBE },
        JUANA
      );

      expect(filled.bandcamp_url).toBe('https://bandcamp.com/search?q=Juana%20Molina%20DOGA');
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
