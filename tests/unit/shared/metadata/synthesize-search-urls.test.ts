import { synthesizeSearchUrls } from '@wxyc/metadata';

describe('synthesizeSearchUrls', () => {
  describe('YouTube Music (track > album > artist)', () => {
    it('uses track when available', () => {
      const urls = synthesizeSearchUrls({
        artist: 'Jessica Pratt',
        album: 'On Your Own Love Again',
        track: 'Back, Baby',
      });
      expect(urls.youtube_music_url).toBe('https://music.youtube.com/search?q=Jessica%20Pratt%20Back%2C%20Baby');
    });

    it('falls back to album when track is missing', () => {
      const urls = synthesizeSearchUrls({ artist: 'Jessica Pratt', album: 'On Your Own Love Again' });
      expect(urls.youtube_music_url).toBe(
        'https://music.youtube.com/search?q=Jessica%20Pratt%20On%20Your%20Own%20Love%20Again'
      );
    });

    it('falls back to artist when album + track are missing', () => {
      const urls = synthesizeSearchUrls({ artist: 'Jessica Pratt' });
      expect(urls.youtube_music_url).toBe('https://music.youtube.com/search?q=Jessica%20Pratt');
    });
  });

  describe('Bandcamp (album > artist, never track)', () => {
    it('uses album when available', () => {
      const urls = synthesizeSearchUrls({
        artist: 'Jessica Pratt',
        album: 'On Your Own Love Again',
        track: 'Back, Baby',
      });
      expect(urls.bandcamp_url).toBe('https://bandcamp.com/search?q=Jessica%20Pratt%20On%20Your%20Own%20Love%20Again');
    });

    it('falls back to artist when album is missing', () => {
      const urls = synthesizeSearchUrls({ artist: 'Jessica Pratt', track: 'Back, Baby' });
      expect(urls.bandcamp_url).toBe('https://bandcamp.com/search?q=Jessica%20Pratt');
    });
  });

  describe('SoundCloud (track > artist, never album)', () => {
    it('uses track when available', () => {
      const urls = synthesizeSearchUrls({
        artist: 'Jessica Pratt',
        album: 'On Your Own Love Again',
        track: 'Back, Baby',
      });
      expect(urls.soundcloud_url).toBe('https://soundcloud.com/search?q=Jessica%20Pratt%20Back%2C%20Baby');
    });

    it('falls back to artist when track is missing — never uses album', () => {
      const urls = synthesizeSearchUrls({ artist: 'Jessica Pratt', album: 'On Your Own Love Again' });
      expect(urls.soundcloud_url).toBe('https://soundcloud.com/search?q=Jessica%20Pratt');
    });
  });

  it('treats null and undefined album/track identically (artist-only)', () => {
    const fromNull = synthesizeSearchUrls({ artist: 'Jessica Pratt', album: null, track: null });
    const fromUndefined = synthesizeSearchUrls({ artist: 'Jessica Pratt' });
    expect(fromNull).toEqual(fromUndefined);
  });

  it('URL-encodes diacritics in the artist name', () => {
    const urls = synthesizeSearchUrls({ artist: 'Nilüfer Yanya' });
    expect(urls.youtube_music_url).toContain('Nil%C3%BCfer%20Yanya');
  });
});
