/**
 * Unit tests for the streaming-URL guard (BS#1710, extended to all five
 * `LookupResponse` streaming fields by BS#2350).
 *
 * LML's `results[].artwork.spotify_url` is sourced from the library
 * `streaming_links.spotify_url` artifact column, which for a subset of
 * releases literally stores a NON-Spotify URL (Deezer/Apple/Bandcamp/…).
 * BS persists and serves that value verbatim, and iOS binds it to a
 * hardwired green "Spotify" button. The guard enforces the field-name
 * invariant — a value in the `spotify_url` slot must be a Spotify URL —
 * at the untrusted-upstream boundary, before any writer persists it.
 * `apple_music_url`/`youtube_music_url`/`soundcloud_url` get the same
 * host-invariant treatment. `bandcamp_url` is the deliberate exception —
 * well-formedness only, no host allowlist, because this boundary also
 * carries genuine LML-resolved custom-domain deep links a host allowlist
 * would wrongly degrade (see `isBandcampUrl`'s doc comment in
 * `streaming-url-guard.ts` and WXYC/library-metadata-lookup#1296) — and
 * suppressing `bandcamp_url` also clears the paired
 * `artwork.streaming_status.bandcamp` verdict, closing the BS#1747/#1915
 * permanent-null freeze this guard could otherwise cause.
 *
 * BS#2689 adds a PATH-shape screen for the `spotify_url` slot in a separate
 * predicate, `isSpotifyAlbumSlotUrl` — see its doc comment for why it is
 * composed over `isSpotifyUrl` rather than folded into it. Suppressing
 * `spotify_url` now clears the paired `streaming_status.spotify` verdict for
 * exactly the bandcamp reason above.
 */
import type { LookupResponse } from '@wxyc/lml-client';
import {
  isSpotifyUrl,
  isSpotifyAlbumSlotUrl,
  isAppleMusicUrl,
  isYouTubeMusicUrl,
  isBandcampUrl,
  isSoundcloudUrl,
  sanitizeLookupStreamingUrls,
  hasUrlParserDifferentialChar,
} from '@wxyc/lml-client';

describe('hasUrlParserDifferentialChar', () => {
  // BS#2356: the single exported scan `safeHttpHostname` and
  // `apps/backend/utils/album-metadata-projection.ts`'s
  // `hasWireUrlParserDifferential` both delegate to, instead of each
  // hand-maintaining their own copy of the `<= 0x20 || 0x7f || 0x5c` bar.
  it.each([
    ['space', 'https://e.com/a b'],
    ['tab', 'https://e.com/a\tb'],
    ['newline', 'https://e.com/a\nb'],
    ['carriage return', 'https://e.com/a\rb'],
    ['DEL (0x7f)', 'https://e.com/a\x7fb'],
    ['backslash', 'https://e.com\\@evil.example/x'],
    ['a NUL control character', 'https://e.com/a\x00b'],
  ])('is true for a string containing %s', (_label, value) => {
    expect(hasUrlParserDifferentialChar(value)).toBe(true);
  });

  it.each([
    ['a well-formed URL with no offending characters', 'https://e.com/a/b?q=1'],
    ['a raw non-ASCII character (not part of this bar)', 'https://en.wikipedia.org/wiki/Nilüfer_Yanya'],
    ['the empty string', ''],
  ])('is false for %s', (_label, value) => {
    expect(hasUrlParserDifferentialChar(value)).toBe(false);
  });
});

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

  // BS#2350 characterization: `isSpotifyUrl` must stay byte-identical.
  // `safeHttpHostname`'s stricter well-formedness bar (no embedded space,
  // no control chars) is used by the three new-in-BS#2350 predicates only —
  // it must never leak into this one. `new URL()` percent-encodes a raw
  // space rather than rejecting it, so this URL is (and must remain) a
  // genuine accept.
  it('accepts a raw space in the path (the stricter BS#2350 bar must not leak in here)', () => {
    expect(isSpotifyUrl('https://open.spotify.com/album/a b')).toBe(true);
  });

  // BS#2689 characterization: the album-slot PATH screen lives in a separate
  // predicate (`isSpotifyAlbumSlotUrl`), so this one stays host-only. Other
  // call sites depend on that — `proxy.controller.ts` gates the persisted
  // read path on `isSpotifyUrl`, where a non-album value is the corrective
  // pass's problem, not a reason to stop serving the field.
  it.each([
    ['artist page', 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7'],
    ['track page', 'https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M'],
  ])('still accepts a non-album Spotify entity URL (%s) — host-only by contract', (_label, url) => {
    expect(isSpotifyUrl(url)).toBe(true);
  });
});

/**
 * BS#2689: the album-slot path screen. `spotify_url` names a RELEASE, so a
 * value in that slot must point at the album — or at a search for it, the
 * resolution ladder's last tier — never at some other Spotify entity.
 *
 * Shape counts below are from LML's production `streaming_links` artifact
 * (46,907 values, 2026-09), under `open.spotify.com`.
 */
describe('isSpotifyAlbumSlotUrl', () => {
  it.each([
    ['plain album page (31,835 in the artifact)', 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo'],
    // The ticket calls these out explicitly: legitimate localized album
    // links that must NOT be nulled (24 in the artifact: fr, it, es, de, pt).
    ['intl-de locale-prefixed album', 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo'],
    ['intl-pt-br region-suffixed locale', 'https://open.spotify.com/intl-pt-br/album/1A2GTWGtFfWp7KSQTwWOyo'],
    // Over-acceptance is the deliberate posture: the cost of not recognizing
    // a locale segment is NULLING A REAL ALBUM LINK, so any `intl-`-prefixed
    // first segment is skipped rather than only the two forms measured in the
    // artifact. A script subtag and an uppercase region are the shapes a
    // fixed-width `intl-[a-z]{2}(-[a-z]{2})?` match would have dropped.
    ['intl-zh-hans script-subtag locale', 'https://open.spotify.com/intl-zh-hans/album/1A2GTWGtFfWp7KSQTwWOyo'],
    ['intl-pt-BR uppercase region', 'https://open.spotify.com/intl-pt-BR/album/1A2GTWGtFfWp7KSQTwWOyo'],
    // The synthesized last-tier fallback. BS mints exactly this shape in
    // `synthesizeSearchUrls`, and `isSpotifyUrl`'s accept list has pinned it
    // since BS#1710 — nulling it would be a regression, not a hardening.
    ['path-style search fallback', 'https://open.spotify.com/search/Jessica%20Pratt%20On%20Your%20Own%20Love%20Again'],
    ['query-style search fallback', 'https://open.spotify.com/search?q=Jessica%20Pratt'],
    ['bare spotify.com apex album', 'https://spotify.com/album/abc'],
    ['case-insensitive host', 'HTTPS://OPEN.SPOTIFY.COM/album/abc'],
    // The host and the locale segment are both case-folded, so the entity kind
    // must be too — otherwise the same asymmetry bites: a real album link read
    // as an unknown kind is NULLED by the corrective pass.
    ['mixed-case entity kind', 'https://open.spotify.com/Album/1A2GTWGtFfWp7KSQTwWOyo'],
    ['mixed-case search', 'https://open.spotify.com/Search/Jessica%20Pratt'],
  ])('accepts a value the album slot may hold (%s)', (_label, url) => {
    expect(isSpotifyAlbumSlotUrl(url)).toBe(true);
  });

  it.each([
    // The reported defect: 6,143 artist pages in the artifact, 3,468 served.
    ['artist page (the reported defect)', 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7'],
    ['intl-prefixed artist page', 'https://open.spotify.com/intl-fr/artist/7CaUk9xCxdXAmmqQn3PLR7'],
    ['track page (989 in the artifact, 841 served)', 'https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M'],
    ['playlist page (13 in the artifact)', 'https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd'],
    ['user page (7 in the artifact)', 'https://open.spotify.com/user/wxyc'],
    ['show page — a podcast (1 in the artifact)', 'https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk'],
    // 11 of these exist: the word "album" with no release behind it, which
    // opens a Spotify error page rather than anything a DJ can play.
    ['bare /album with no id (11 in the artifact)', 'https://open.spotify.com/album'],
    ['/album/ with an empty id', 'https://open.spotify.com/album/'],
    ['host root with no path at all', 'https://open.spotify.com/'],
    // Regression cover on the BS#1710 host check the screen composes over:
    // the path may be album-shaped and the value still be foreign.
    ['off-host album URL (Deezer)', 'https://www.deezer.com/album/254381182'],
    ['off-host album URL (Apple Music)', 'https://music.apple.com/us/album/foo/123'],
    ['host-suffix spoof with an album path', 'https://spotify.com.evil.example/album/abc'],
    ['backslash-authority spoof', 'https://open.spotify.com\\@evil.example/album/abc'],
    ['not a URL', 'not a url'],
    ['empty string', ''],
    // WHATWG parses an authority for any scheme written with `//`, so a
    // non-http(s) scheme reaches this predicate with a spotify.com hostname and
    // an album-shaped path. The value is rendered as an href on DJ-facing
    // surfaces, and every sibling predicate in this file screens the scheme via
    // `safeHttpHostname`; this one has no pre-existing callers to preserve, so
    // it screens it too rather than inheriting `isSpotifyUrl`'s scheme-blind host
    // check.
    ['javascript: scheme with a spotify authority', 'javascript://open.spotify.com/album/abc'],
    ['data: scheme with a spotify authority', 'data://open.spotify.com/album/abc'],
    ['ftp: scheme with a spotify authority', 'ftp://open.spotify.com/album/abc'],
  ])('rejects a value the album slot may not hold (%s)', (_label, url) => {
    expect(isSpotifyAlbumSlotUrl(url)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects nullish input (%s)', (_label, input) => {
    expect(isSpotifyAlbumSlotUrl(input)).toBe(false);
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

  // BS#2350 characterization: `isAppleMusicUrl` must stay byte-identical —
  // see the matching `isSpotifyUrl` characterization test above.
  it('accepts a raw space in the path (the stricter BS#2350 bar must not leak in here)', () => {
    expect(isAppleMusicUrl('https://music.apple.com/us/album/a b/123')).toBe(true);
  });
});

describe('isYouTubeMusicUrl', () => {
  it.each([
    ['music.youtube.com browse (direct album link)', 'https://music.youtube.com/browse/MPREb_abc123'],
    ['music.youtube.com search (synthesized fallback)', 'https://music.youtube.com/search?q=kid%20606'],
    ['bare youtube.com apex', 'https://youtube.com/watch?v=abc'],
    ['www.youtube.com', 'https://www.youtube.com/watch?v=abc'],
    // BS#2350: youtu.be short links accepted preemptively — LML is adding
    // the same host to its own vocabulary so the two stay in sync.
    ['youtu.be short link', 'https://youtu.be/abc123'],
    ['case-insensitive host', 'HTTPS://MUSIC.YOUTUBE.COM/browse/MPREb_abc123'],
  ])('accepts a YouTube-host URL (%s)', (_label, url) => {
    expect(isYouTubeMusicUrl(url)).toBe(true);
  });

  it.each([
    ['Spotify', 'https://open.spotify.com/album/abc'],
    ['scheme-relative', '//music.youtube.com/browse/MPREb_abc123'],
    ['bare host, no scheme', 'music.youtube.com/browse/MPREb_abc123'],
    ['non-web scheme', 'javascript:alert(1)'],
    ['host-suffix spoof', 'https://youtube.com.evil.example/browse/x'],
    ['youtu.be host-suffix spoof', 'https://youtu.be.evil.example/abc123'],
    ['backslash-authority spoof', 'https://youtube.com\\@evil.example/x'],
    ['embedded tab', 'https://music.youtube.com/\tbrowse/x'],
    ['embedded newline', 'https://music.youtube.com/\nbrowse/x'],
    ['embedded space', 'https://music.youtube.com/browse/ x'],
    ['not a URL', 'not a url'],
    ['empty string', ''],
    ['null', null],
  ])('rejects a non-YouTube-Music URL (%s)', (_label, url) => {
    expect(isYouTubeMusicUrl(url)).toBe(false);
  });
});

describe('isBandcampUrl', () => {
  // BS#2350: NO host allowlist — well-formedness only. This `LookupResponse`
  // boundary also carries genuine LML-resolved bandcamp deep links on
  // label-owned custom domains (LML#1069; `clients/bandcamp.py::fix_autocomplete_url`
  // preserves them), which a `bandcamp.com` allowlist would silently degrade
  // to search URLs. The curated-column host check lives writer-side in LML
  // instead (WXYC/library-metadata-lookup#1296). Consequently a well-formed
  // URL on ANY host — even a different service entirely — passes here; only
  // malformed/spoofed shapes are rejected (see the reject list below).
  it.each([
    ['artist subdomain album (direct link)', 'https://autechre.bandcamp.com/album/confield'],
    ['label/imprint-hosted subdomain', 'https://into-the-light.bandcamp.com/album/the-rules-of-the-game'],
    ['bandcamp.com search (synthesized fallback)', 'https://bandcamp.com/search?q=kid%20606'],
    ['bare bandcamp.com apex', 'https://bandcamp.com/foo'],
    ['label-owned custom domain (genuine LML-resolved deep link, LML#1069)', 'https://music.sufjan.com/album/x'],
    [
      'host-suffix shape (no host check, so no longer a spoof concern here)',
      'https://bandcamp.com.evil.example/album/foo',
    ],
    ['a different service entirely (no host check)', 'https://open.spotify.com/album/abc'],
    ['Deezer (no host check)', 'https://www.deezer.com/album/254381182'],
  ])('accepts any well-formed http(s) URL (%s)', (_label, url) => {
    expect(isBandcampUrl(url)).toBe(true);
  });

  it.each([
    ['scheme-relative', '//artist.bandcamp.com/album/foo'],
    ['bare host, no scheme', 'artist.bandcamp.com/album/foo'],
    ['non-web scheme', 'javascript:alert(1)'],
    // Well-formedness failure, not a host mismatch — the parser differential
    // check still applies regardless of the dropped host allowlist.
    ['backslash-authority spoof', 'https://bandcamp.com\\@evil.example/x'],
    ['embedded tab', 'https://artist.bandcamp.com/\talbum/foo'],
    ['embedded newline', 'https://artist.bandcamp.com/\nalbum/foo'],
    ['embedded space', 'https://artist.bandcamp.com/album/ foo'],
    ['not a URL', 'not a url'],
    ['empty string', ''],
    ['null', null],
  ])('rejects a malformed value (%s)', (_label, url) => {
    expect(isBandcampUrl(url)).toBe(false);
  });
});

describe('isSoundcloudUrl', () => {
  it.each([
    ['artist/track (direct link)', 'https://soundcloud.com/artist/track'],
    ['soundcloud.com search (synthesized fallback)', 'https://soundcloud.com/search?q=kid%20606'],
    ['www.soundcloud.com', 'https://www.soundcloud.com/artist/track'],
    // BS#2350: on.soundcloud.com short links.
    ['on.soundcloud.com short link', 'https://on.soundcloud.com/aBc123'],
    ['case-insensitive host', 'HTTPS://SOUNDCLOUD.COM/artist/track'],
  ])('accepts a SoundCloud-host URL (%s)', (_label, url) => {
    expect(isSoundcloudUrl(url)).toBe(true);
  });

  it.each([
    ['Spotify', 'https://open.spotify.com/album/abc'],
    ['scheme-relative', '//soundcloud.com/artist/track'],
    ['bare host, no scheme', 'soundcloud.com/artist/track'],
    ['non-web scheme', 'javascript:alert(1)'],
    ['host-suffix spoof', 'https://soundcloud.com.evil.example/artist/track'],
    ['backslash-authority spoof', 'https://soundcloud.com\\@evil.example/x'],
    ['embedded tab', 'https://soundcloud.com/\tartist/track'],
    ['embedded newline', 'https://soundcloud.com/\nartist/track'],
    ['embedded space', 'https://soundcloud.com/artist/ track'],
    ['not a URL', 'not a url'],
    ['empty string', ''],
    ['null', null],
  ])('rejects a non-SoundCloud URL (%s)', (_label, url) => {
    expect(isSoundcloudUrl(url)).toBe(false);
  });
});

describe('sanitizeLookupStreamingUrls', () => {
  // The guard reads `results[].artwork.{spotify_url,apple_music_url,
  // youtube_music_url,bandcamp_url,soundcloud_url,streaming_status}`; a
  // minimal cast keeps the fixture legible without a full LibraryCatalogItem.
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

  describe('BS#2689 spotify_url album-shape screen', () => {
    // Wiring only — that the slot runs through `isSpotifyAlbumSlotUrl` at all.
    // Which shapes it accepts is pinned exhaustively on the predicate above.
    it('nulls a non-album Spotify URL in the spotify_url slot', () => {
      const resp = build({ spotify_url: 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7' });
      expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.spotify_url).toBeNull();
    });

    it.each([
      ['locale-prefixed album (must NOT be nulled)', 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo'],
      ['synthesized search fallback', 'https://open.spotify.com/search/Jessica%20Pratt'],
    ])('preserves a legitimate album-slot value (%s)', (_label, url) => {
      const resp = build({ spotify_url: url });
      expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.spotify_url).toBe(url);
    });

    // The BS#2350 lesson applied to the new branch: without this, the merge
    // in `apps/enrichment-worker/enrich.ts` persists `spotify_url: null`
    // beside `spotify_status: 'verified'` — terminal under rule 1 and
    // un-re-askable by `precheck.ts`/`streaming-reask.ts`, i.e. ~4,353 rows
    // frozen with no Spotify link at all.
    it.each([['verified'], ['absent']])(
      "demotes streaming_status.spotify to 'unresolved' when spotify_url is suppressed (was '%s')",
      (status) => {
        const resp = build({
          spotify_url: 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7',
          streaming_status: { spotify: status },
        });
        const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
        expect(out?.spotify_url).toBeNull();
        // NOT deleted. Deleting the key makes the incoming verdict
        // `undefined`, and `mergeStreamingField` returns `current` unchanged
        // for that — so a FRESH album persisted `spotify_status: NULL` beside
        // the synthesized search URL. That pair is the "legacy frozen shape"
        // `precheck.ts` needed a dedicated (still default-OFF)
        // `bandcampFrozenReask` arm to escape: NULL satisfies neither re-ask
        // gate (both require `= 'unresolved'`) while the search URL satisfies
        // `hasAnyStreamingUrl`, so the row is skipped forever and never picks
        // up LML's corrected album URL. Suppression must not manufacture the
        // shape a sibling field needed a feature flag to dig out of.
        expect(out?.streaming_status?.spotify).toBe('unresolved');
      }
    );

    it("the demoted value is exactly the literal both re-ask gates test for", () => {
      // Pinned as a literal on purpose: `precheck.ts`'s `needsStreamingReask`
      // and the hourly sweep's `findUnresolvedStreamingCandidates` both spell
      // the predicate as SQL `= 'unresolved'`, so there is no shared TS
      // constant to import. If that vocabulary ever changes, this fails here
      // rather than silently re-freezing the cohort.
      const resp = build({
        spotify_url: 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7',
        streaming_status: { spotify: 'verified' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.streaming_status?.spotify).toBe('unresolved');
      expect(['verified', 'absent']).not.toContain(out?.streaming_status?.spotify);
    });

    it('leaves streaming_status.spotify untouched when spotify_url is preserved', () => {
      const url = 'https://open.spotify.com/intl-de/album/1A2GTWGtFfWp7KSQTwWOyo';
      const resp = build({ spotify_url: url, streaming_status: { spotify: 'verified' } });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.spotify_url).toBe(url);
      expect(out?.streaming_status?.spotify).toBe('verified');
    });

    it('leaves the sibling apple_music/bandcamp verdicts untouched by a spotify suppression', () => {
      const resp = build({
        spotify_url: 'https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7',
        apple_music_url: 'https://music.apple.com/us/album/foo/123',
        bandcamp_url: 'https://artist.bandcamp.com/album/foo',
        streaming_status: { spotify: 'verified', apple_music: 'absent', bandcamp: 'verified' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      // Whole object asserted, so a future branch that clobbers a sibling
      // verdict fails here: only spotify moves, and it moves to 'unresolved'.
      expect(out?.streaming_status).toEqual({
        spotify: 'unresolved',
        apple_music: 'absent',
        bandcamp: 'verified',
      });
    });

    it('tolerates a suppressed spotify_url with no streaming_status object at all', () => {
      const resp = build({ spotify_url: 'https://open.spotify.com/artist/abc' });
      // One call only: the function mutates in place, so a second call would
      // find the url already null and the assertion could not fail.
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.spotify_url).toBeNull();
      expect(out?.streaming_status).toBeUndefined();
    });

    // BS#2689 deliberately does NOT screen apple_music_url on path shape:
    // all 288 populated `apple_url` values in LML's artifact are already
    // album URLs, so there is no measured population to guard. See the
    // `apple_music_url` branch in `sanitizeLookupStreamingUrls`.
    it('leaves an apple_music_url artist page alone (unmeasured, deliberately unguarded)', () => {
      const url = 'https://music.apple.com/us/artist/stereolab/57312';
      const resp = build({ apple_music_url: url });
      expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.apple_music_url).toBe(url);
    });
  });

  it('preserves a genuine Apple Music URL', () => {
    const url = 'https://music.apple.com/us/album/foo/123';
    const resp = build({ apple_music_url: url });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.apple_music_url).toBe(url);
  });

  it('preserves genuine youtube_music_url, bandcamp_url and soundcloud_url values', () => {
    const resp = build({
      spotify_url: 'https://open.spotify.com/album/ok',
      youtube_music_url: 'https://music.youtube.com/browse/MPREb_abc123',
      bandcamp_url: 'https://artist.bandcamp.com/album/foo',
      soundcloud_url: 'https://soundcloud.com/artist/track',
    });
    const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
    expect(out?.youtube_music_url).toBe('https://music.youtube.com/browse/MPREb_abc123');
    expect(out?.bandcamp_url).toBe('https://artist.bandcamp.com/album/foo');
    expect(out?.soundcloud_url).toBe('https://soundcloud.com/artist/track');
  });

  it('nulls a mislabeled URL in the youtube_music_url slot', () => {
    const resp = build({ youtube_music_url: 'https://www.deezer.com/album/1' });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.youtube_music_url).toBeNull();
  });

  it('nulls a mislabeled URL in the soundcloud_url slot', () => {
    const resp = build({ soundcloud_url: 'https://www.deezer.com/album/1' });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.soundcloud_url).toBeNull();
  });

  it('nulls a whitespace-polluted value in the bandcamp_url slot (2026-08-11 audit shape)', () => {
    const resp = build({ bandcamp_url: 'https://artist.bandcamp.com/\talbum/foo' });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.bandcamp_url).toBeNull();
  });

  // BS#2350: bandcamp_url has NO host allowlist, so a well-formed URL on any
  // host — including a genuine LML-resolved custom-domain deep link
  // (LML#1069) — is preserved, never degraded to a search URL.
  it('preserves a bandcamp_url on a label-owned custom domain (LML#1069)', () => {
    const url = 'https://music.sufjan.com/album/x';
    const resp = build({ bandcamp_url: url });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.bandcamp_url).toBe(url);
  });

  // BS#2350: a well-formed but foreign-host URL in the bandcamp_url slot is
  // ALSO preserved now — this is the whole point of dropping the host
  // allowlist (the curated-column host check moved to LML#1296 instead).
  // Contrast with the youtube_music_url/soundcloud_url slots just above,
  // which still null a mislabeled foreign URL.
  it('preserves a well-formed foreign-host URL in the bandcamp_url slot (no host allowlist)', () => {
    const url = 'https://www.deezer.com/album/1';
    const resp = build({ bandcamp_url: url });
    expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.bandcamp_url).toBe(url);
  });

  describe('BS#2350 status-clearing (the permanent-null-freeze fix)', () => {
    it("clears streaming_status.bandcamp when bandcamp_url is suppressed (was 'verified')", () => {
      const resp = build({
        bandcamp_url: 'https://artist.bandcamp.com/\talbum/foo', // whitespace-polluted — suppressed
        streaming_status: { bandcamp: 'verified' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.bandcamp_url).toBeNull();
      expect(out?.streaming_status).not.toHaveProperty('bandcamp');
    });

    it("clears streaming_status.bandcamp when bandcamp_url is suppressed (was 'absent')", () => {
      const resp = build({
        bandcamp_url: 'https://artist.bandcamp.com/\talbum/foo',
        streaming_status: { bandcamp: 'absent' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.bandcamp_url).toBeNull();
      expect(out?.streaming_status).not.toHaveProperty('bandcamp');
    });

    it('leaves streaming_status.bandcamp untouched when bandcamp_url is preserved (not suppressed)', () => {
      const resp = build({
        bandcamp_url: 'https://music.sufjan.com/album/x',
        streaming_status: { bandcamp: 'verified' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.bandcamp_url).toBe('https://music.sufjan.com/album/x');
      expect(out?.streaming_status?.bandcamp).toBe('verified');
    });

    it('leaves the sibling spotify/apple_music streaming_status verdicts untouched by a bandcamp suppression', () => {
      const resp = build({
        spotify_url: 'https://open.spotify.com/album/ok',
        bandcamp_url: 'https://artist.bandcamp.com/\talbum/foo',
        streaming_status: { spotify: 'verified', apple_music: 'absent', bandcamp: 'verified' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.streaming_status?.spotify).toBe('verified');
      expect(out?.streaming_status?.apple_music).toBe('absent');
      expect(out?.streaming_status).not.toHaveProperty('bandcamp');
    });

    it('tolerates a suppressed bandcamp_url with no streaming_status object at all', () => {
      const resp = build({ bandcamp_url: 'https://artist.bandcamp.com/\talbum/foo' });
      expect(() => sanitizeLookupStreamingUrls(resp)).not.toThrow();
      expect(sanitizeLookupStreamingUrls(resp).results[0].artwork?.bandcamp_url).toBeNull();
    });

    // youtube_music_url/soundcloud_url have no `streaming_status` key on the
    // schema at all (LML never emits a resolution verdict for those two
    // search-URL-only services) — suppressing them must not touch
    // streaming_status, since there is nothing there naming either service.
    it('suppressing youtube_music_url/soundcloud_url leaves an unrelated streaming_status untouched', () => {
      const resp = build({
        youtube_music_url: 'https://www.deezer.com/album/1',
        soundcloud_url: 'https://www.deezer.com/album/1',
        streaming_status: { spotify: 'verified' },
      });
      const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
      expect(out?.youtube_music_url).toBeNull();
      expect(out?.soundcloud_url).toBeNull();
      expect(out?.streaming_status).toEqual({ spotify: 'verified' });
    });
  });

  it('preserves each genuine synthesized search-URL shape LML emits', () => {
    const resp = build({
      youtube_music_url: 'https://music.youtube.com/search?q=kid%20606',
      bandcamp_url: 'https://bandcamp.com/search?q=kid%20606',
      soundcloud_url: 'https://soundcloud.com/search?q=kid%20606',
    });
    const out = sanitizeLookupStreamingUrls(resp).results[0].artwork;
    expect(out?.youtube_music_url).toBe('https://music.youtube.com/search?q=kid%20606');
    expect(out?.bandcamp_url).toBe('https://bandcamp.com/search?q=kid%20606');
    expect(out?.soundcloud_url).toBe('https://soundcloud.com/search?q=kid%20606');
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
