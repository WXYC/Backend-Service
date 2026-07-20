/**
 * Unit tests for the streaming-URL host guard (BS#1710).
 *
 * LML's `results[].artwork.spotify_url` is sourced from the library
 * `streaming_links.spotify_url` artifact column, which for a subset of
 * releases literally stores a NON-Spotify URL (Deezer/Apple/Bandcamp/…).
 * BS persists and serves that value verbatim, and iOS binds it to a
 * hardwired green "Spotify" button. The guard enforces the field-name
 * invariant — a value in the `spotify_url` slot must be a Spotify URL —
 * at the untrusted-upstream boundary, before any writer persists it.
 */
import type { LookupResponse } from '@wxyc/lml-client';
import { isSpotifyUrl, isAppleMusicUrl, sanitizeLookupStreamingUrls } from '@wxyc/lml-client';

describe('isSpotifyUrl', () => {
  it.each([
    ['open.spotify.com album', 'https://open.spotify.com/album/abc123'],
    ['open.spotify.com search (synthesized fallback)', 'https://open.spotify.com/search/kid%20606'],
    ['bare spotify.com apex', 'https://spotify.com/album/abc'],
    ['www.spotify.com', 'https://www.spotify.com/album/abc'],
    ['case-insensitive host', 'HTTPS://OPEN.SPOTIFY.COM/album/abc'],
  ])('accepts a Spotify-host URL (%s)', (_label, url) => {
    expect(isSpotifyUrl(url)).toBe(true);
  });

  it.each([
    ['Deezer (the pinned Kid 606 pollution)', 'https://www.deezer.com/album/254381182'],
    ['Apple Music', 'https://music.apple.com/us/album/foo/123'],
    ['Bandcamp', 'https://artist.bandcamp.com/album/foo'],
    ['Qobuz', 'https://www.qobuz.com/album/foo'],
    ['host-suffix spoof', 'https://spotify.com.evil.example/album/abc'],
    ['substring-not-host spoof', 'https://evil.example/spotify.com/album'],
    // WHATWG folds `\` to `/` for http(s), so `new URL(...).hostname` reads
    // `spotify.com` and the naive host check would ACCEPT — but the raw string
    // (persisted verbatim) resolves to `evil.example` under a parser that keeps
    // the backslash. The guard must reject the raw backslash (BS#1710).
    ['backslash-authority spoof', 'https://spotify.com\\@evil.example/x'],
    ['backslash after subdomain', 'https://open.spotify.com\\@evil.example/x'],
    // Tab/CR/LF need no special handling: unlike `\`, WHATWG strips them and
    // resolves the authority to the real (evil) host, so the guard already
    // rejects them. Characterized here so the backslash-only carve-out is
    // documented, not accidental.
    ['tab in authority (WHATWG resolves to evil host)', 'https://open.spotify.com\t@evil.example/x'],
    ['newline in authority (WHATWG resolves to evil host)', 'https://open.spotify.com\n@evil.example/x'],
    ['not a URL', 'not a url'],
    ['empty string', ''],
  ])('rejects a non-Spotify URL (%s)', (_label, url) => {
    expect(isSpotifyUrl(url)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects nullish input (%s)', (_label, input) => {
    expect(isSpotifyUrl(input)).toBe(false);
  });
});

describe('isAppleMusicUrl', () => {
  it.each([
    ['music.apple.com', 'https://music.apple.com/us/album/foo/123'],
    ['itunes.apple.com legacy', 'https://itunes.apple.com/us/album/foo/123'],
    ['geo.music.apple.com', 'https://geo.music.apple.com/us/album/foo'],
    ['bare apple.com apex', 'https://apple.com/foo'],
  ])('accepts an Apple-host URL (%s)', (_label, url) => {
    expect(isAppleMusicUrl(url)).toBe(true);
  });

  it.each([
    ['Spotify', 'https://open.spotify.com/album/abc'],
    ['Deezer', 'https://www.deezer.com/album/254381182'],
    ['host-suffix spoof', 'https://apple.com.evil.example/foo'],
    ['backslash-authority spoof', 'https://apple.com\\@evil.example/foo'],
    ['null', null],
  ])('rejects a non-Apple URL (%s)', (_label, url) => {
    expect(isAppleMusicUrl(url)).toBe(false);
  });
});

describe('sanitizeLookupStreamingUrls', () => {
  // The guard only reads `results[].artwork.{spotify_url,apple_music_url}`;
  // a minimal cast keeps the fixture legible without a full LibraryCatalogItem.
  const build = (artwork: Record<string, unknown> | undefined): LookupResponse => ({
    results: [{ library_item: { id: 1 }, artwork }],
    search_type: 'direct',
    song_not_found: false,
    found_on_compilation: false,
  });

  it('nulls a Deezer URL sitting in the spotify_url slot (the reported bug)', () => {
    const resp = build({ spotify_url: 'https://www.deezer.com/album/254381182' });
    const out = sanitizeLookupStreamingUrls(resp);
    expect(out.results[0].artwork?.spotify_url).toBeNull();
  });

  it('nulls a mislabeled non-Apple URL in the apple_music_url slot', () => {
    const resp = build({ apple_music_url: 'https://www.deezer.com/album/1' });
    const out = sanitizeLookupStreamingUrls(resp);
    expect(out.results[0].artwork?.apple_music_url).toBeNull();
  });

  it('nulls a backslash-authority spoof in the spotify_url slot (parser differential)', () => {
    // `new URL(...).hostname` folds this to `spotify.com`, but the raw string
    // persisted verbatim resolves to `evil.example` under a backslash-preserving
    // parser — the guard must null it, not persist it under the Spotify button.
    const resp = build({ spotify_url: 'https://spotify.com\\@evil.example/x' });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.spotify_url).toBeNull();
  });

  it('preserves a genuine Spotify URL', () => {
    const url = 'https://open.spotify.com/album/abc123';
    const resp = build({ spotify_url: url });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.spotify_url).toBe(url);
  });

  it('preserves a genuine Apple Music URL', () => {
    const url = 'https://music.apple.com/us/album/foo/123';
    const resp = build({ apple_music_url: url });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.apple_music_url).toBe(url);
  });

  it('leaves other streaming slots untouched (only spotify/apple are host-guarded)', () => {
    const resp = build({
      spotify_url: 'https://open.spotify.com/album/ok',
      bandcamp_url: 'https://artist.bandcamp.com/album/foo',
      soundcloud_url: 'https://soundcloud.com/artist/track',
    });
    const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
    expect(out?.bandcamp_url).toBe('https://artist.bandcamp.com/album/foo');
    expect(out?.soundcloud_url).toBe('https://soundcloud.com/artist/track');
  });

  it('tolerates a result item with no artwork', () => {
    const resp = build(undefined);
    expect(() => sanitizeLookupStreamingUrls(resp)).not.toThrow();
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork).toBeUndefined();
  });

  it('tolerates an empty results array', () => {
    const resp = build({ spotify_url: 'x' });
    resp.results = [];
    expect(sanitizeLookupStreamingUrls(resp).results).toEqual([]);
  });

  it('leaves an already-null spotify_url as null (idempotent)', () => {
    const resp = build({ spotify_url: null });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.spotify_url).toBeNull();
  });
});
