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
 * Enforce the field-name/host invariant on every result's artwork: a
 * `spotify_url` that isn't a Spotify host and an `apple_music_url` that
 * isn't an Apple host are set to `null`. Mutates `response` in place (the
 * caller owns the freshly-parsed object) and returns it for convenience.
 * Other streaming slots are left untouched — only these two are rendered
 * under hardwired service-specific buttons in the iOS app.
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
  }
  return response;
}
