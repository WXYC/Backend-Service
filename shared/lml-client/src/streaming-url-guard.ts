/**
 * Streaming-URL host guard (BS#1710).
 *
 * LML's `results[].artwork.spotify_url` is populated from the library
 * `streaming_links.spotify_url` artifact column, which for a subset of
 * releases literally stores a NON-Spotify URL (Deezer, Apple Music,
 * Bandcamp, …). Backend-Service persists and serves that value verbatim,
 * and iOS binds it to a hardwired green "Spotify" button — so the button
 * opens Deezer. See https://github.com/WXYC/Backend-Service/issues/1710.
 *
 * The invariant these guards enforce is purely about the field name: a
 * value stored under `spotify_url` must be a Spotify URL, and a value
 * under `apple_music_url` must be an Apple URL. `sanitizeLookupStreamingUrls`
 * applies it at the LML response boundary — the single chokepoint every
 * downstream writer (enrichment-worker + the backfill/reenrichment jobs)
 * and the request-path serve read from — so a mislabeled URL never reaches
 * a persisted `spotify_url`/`apple_music_url` column. A rejected value falls
 * to `null`; the writers' `?? searchUrls.spotify_url` fallback then persists
 * a real `open.spotify.com/search/…` URL instead.
 *
 * This does NOT heal rows already persisted before the guard shipped —
 * BS persistence is fill-only, so an existing bad value survives. Those
 * need the separate overwrite migration (BS#1710 fix #3).
 */
import type { LookupResponse } from '@wxyc/shared/dtos';

/**
 * True iff `host` is `apex` or a subdomain of it. The leading-dot check
 * rejects suffix spoofs like `spotify.com.evil.example` (whose host ends
 * in `.evil.example`, not `.spotify.com`).
 */
function hostIsUnder(host: string, apex: string): boolean {
  return host === apex || host.endsWith(`.${apex}`);
}

/**
 * Parse `url` to a lowercased hostname, or `null` if it isn't a usable
 * absolute URL. Returns `null` for a non-string or an unparseable value.
 *
 * Rejects any raw backslash up front — before `new URL()` sees it — to close
 * a parser differential: for the http(s) special schemes WHATWG folds `\` to
 * `/`, so `https://spotify.com\@evil.example/x` parses to hostname
 * `spotify.com` and would pass the host check, yet the guard's keep-or-null
 * contract persists that raw string verbatim, and a downstream URL parser that
 * keeps the backslash resolves the same string to host `evil.example` — the
 * "Spotify" button would then open `evil.example`. A genuine streaming URL
 * never contains a raw backslash (it would be percent-encoded as `%5C`), so
 * rejecting closes the differential at zero cost to real data (BS#1710).
 */
function safeHostname(url: string): string | null {
  if (url.includes('\\')) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True iff `url` parses to an absolute URL whose host is `spotify.com`
 * or a subdomain (`open.spotify.com`, `www.spotify.com`, …). Case-folds
 * the host; returns false for nullish, non-string, or unparseable input.
 */
export function isSpotifyUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHostname(url);
  return host !== null && hostIsUnder(host, 'spotify.com');
}

/**
 * True iff `url` parses to an absolute URL whose host is `apple.com` or a
 * subdomain (`music.apple.com`, `itunes.apple.com`, `geo.music.apple.com`).
 * Every Apple Music link lives under `apple.com`, so the apex covers the
 * legacy iTunes and geo-redirect hosts too.
 */
export function isAppleMusicUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHostname(url);
  return host !== null && hostIsUnder(host, 'apple.com');
}

/**
 * True iff `url` is an absolute `http`/`https` URL free of the
 * backslash-authority parser differential {@link safeHostname} rejects, and
 * free of any C0 control character, space, or DEL anywhere in the string.
 * That second bar mirrors `apps/backend/utils/album-metadata-projection.ts`'s
 * `wireUrl`/`hasWireUrlParserDifferential` well-formedness contract — the
 * layer-3 (client-facing) predicate this layer-2 (LML-response) guard is
 * deliberately kept in agreement with, without a cross-workspace import
 * (`shared/lml-client` has no dependency on `apps/backend`, and importing
 * one in would invert the package graph). BS#2339's own `wireUrl` docstring
 * is the source of truth for the contract; this is a same-workspace copy
 * of its predicate, not a re-export.
 *
 * `spotify_url`/`apple_music_url` deliberately do NOT run through this
 * stricter check — that would risk changing which URLs `isSpotifyUrl` /
 * `isAppleMusicUrl` accept, and BS#2350 requires their behavior stay
 * byte-identical. Only the three new-in-BS#2350 predicates below use it.
 */
function safeHttpHostname(url: string): string | null {
  const host = safeHostname(url);
  if (host === null) return null;
  for (const char of url) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return host;
}

/**
 * True iff `url` parses to an absolute http(s) URL whose host is
 * `youtube.com` or a subdomain (`music.youtube.com`, the host LML's
 * YouTube Music client and its `build_streaming_search_url` fallback both
 * emit — see `clients/streaming/youtube_music.py` and
 * `lookup/enrichment/search_urls.py` in library-metadata-lookup). Loose on
 * path shape, like `isSpotifyUrl`/`isAppleMusicUrl` — a field-name/host
 * invariant check, not a browse-ID extraction.
 */
export function isYouTubeMusicUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHttpHostname(url);
  return host !== null && hostIsUnder(host, 'youtube.com');
}

/**
 * True iff `url` parses to an absolute http(s) URL whose host is
 * `bandcamp.com` or a subdomain. Bandcamp direct links live on
 * `<artist>.bandcamp.com` (and, per library-metadata-lookup's
 * `docs/scripts.md`, sometimes a *label/imprint* subdomain rather than the
 * performing artist's own — e.g. `into-the-light.bandcamp.com`, not
 * `georgerakis.bandcamp.com`); the synthesized search fallback lives on the
 * bare `bandcamp.com` apex (`lookup/enrichment/search_urls.py`'s
 * `build_streaming_search_url("https://bandcamp.com/search?q=", …)`). Both
 * shapes are `*.bandcamp.com` subdomains, so a host allowlist under that
 * apex covers them without degrading a real link to a search URL.
 *
 * A true external custom domain (a label's own domain running a
 * Bandcamp-hosted storefront, rather than a `*.bandcamp.com` subdomain) was
 * the caveat this predicate's design had to rule out per BS#2350 — but
 * LML's own minting parser (`release/url_parser.py`'s `_BANDCAMP_HOST_RE`,
 * `^[a-z0-9][a-z0-9-]*\.bandcamp\.com$`) is exactly this strict: it never
 * mints an identity from a non-`bandcamp.com` host, and the scraper that
 * feeds LML's Bandcamp results (`clients/bandcamp.py`) only ever emits
 * `{slug}.bandcamp.com` URLs. Since LML itself never emits a genuine direct
 * link on a non-`bandcamp.com` host, an apex host allowlist here can't
 * suppress one — so, unlike the well-formedness-only fallback the issue
 * floated for a true custom-domain shape, this guard host-checks
 * `bandcamp_url` exactly like the other four fields.
 */
export function isBandcampUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHttpHostname(url);
  return host !== null && hostIsUnder(host, 'bandcamp.com');
}

/**
 * True iff `url` parses to an absolute http(s) URL whose host is
 * `soundcloud.com` or a subdomain (`www.soundcloud.com`). SoundCloud has no
 * cache/mint tier in LML (`lookup/enrichment/search_urls.py`'s deferred-fill
 * docstring: "SoundCloud is deliberately absent — it has no cache tier"), so
 * its only two shapes are the inline live-probe direct link and the
 * `https://soundcloud.com/search?q=…` synthesized fallback — both under this
 * apex.
 */
export function isSoundcloudUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHttpHostname(url);
  return host !== null && hostIsUnder(host, 'soundcloud.com');
}

/**
 * Enforce the field-name/host invariant on every result's artwork across all
 * five streaming URL slots: a value that isn't a host appropriate to its
 * field name is set to `null`. Mutates `response` in place (the caller owns
 * the freshly-parsed object) and returns it for convenience. A suppressed
 * value falls through each writer's `?? searchUrls.*` fallback to a
 * well-formed synthesized search URL, exactly as spotify/apple do today
 * (BS#1710); `spotify_url`/`apple_music_url` behavior is unchanged by
 * BS#2350 (`isSpotifyUrl`/`isAppleMusicUrl` are untouched).
 */
export function sanitizeLookupStreamingUrls(response: LookupResponse): LookupResponse {
  for (const item of response.results ?? []) {
    const artwork = item.artwork;
    if (!artwork) continue;
    if (artwork.spotify_url != null && !isSpotifyUrl(artwork.spotify_url)) {
      artwork.spotify_url = null;
    }
    if (artwork.apple_music_url != null && !isAppleMusicUrl(artwork.apple_music_url)) {
      artwork.apple_music_url = null;
    }
    if (artwork.youtube_music_url != null && !isYouTubeMusicUrl(artwork.youtube_music_url)) {
      artwork.youtube_music_url = null;
    }
    if (artwork.bandcamp_url != null && !isBandcampUrl(artwork.bandcamp_url)) {
      artwork.bandcamp_url = null;
    }
    if (artwork.soundcloud_url != null && !isSoundcloudUrl(artwork.soundcloud_url)) {
      artwork.soundcloud_url = null;
    }
  }
  return response;
}
