/**
 * Streaming-URL guard (BS#1710, extended to all five fields by BS#2350).
 *
 * LML's `results[].artwork.spotify_url` is populated from the library
 * `streaming_links.spotify_url` artifact column, which for a subset of
 * releases literally stores a NON-Spotify URL (Deezer, Apple Music,
 * Bandcamp, …). Backend-Service persists and serves that value verbatim,
 * and iOS binds it to a hardwired green "Spotify" button — so the button
 * opens Deezer. See https://github.com/WXYC/Backend-Service/issues/1710.
 *
 * For `spotify_url`/`apple_music_url` the invariant is purely about the
 * field name: a value stored under `spotify_url` must be a Spotify URL, and
 * a value under `apple_music_url` must be an Apple URL — enforced by a host
 * allowlist (`isSpotifyUrl`/`isAppleMusicUrl`). `youtube_music_url` and
 * `soundcloud_url` get the same host-allowlist treatment
 * (`isYouTubeMusicUrl`/`isSoundcloudUrl`), plus the well-formedness bar
 * below. `bandcamp_url` is the deliberate exception: it gets
 * well-formedness ONLY, no host allowlist. This `LookupResponse` also
 * carries LML probe/cache-resolved bandcamp deep links on label-owned
 * custom domains (LML#1069 album-first; LML's
 * `clients/bandcamp.py::fix_autocomplete_url` preserves them, pinned by
 * tests using `music.sufjan.com`) — a `bandcamp.com` allowlist would
 * silently degrade those to search URLs. The curated-column host check for
 * `streaming_links.bandcamp_url` lives writer-side in LML instead (see
 * WXYC/library-metadata-lookup#1296), which is the seam where "is this
 * really Bandcamp" is actually decidable; here it is not. See
 * `isBandcampUrl`'s own doc comment for the full rationale.
 *
 * `sanitizeLookupStreamingUrls` applies all five checks at the LML response
 * boundary — the single chokepoint every downstream writer
 * (enrichment-worker + the backfill/reenrichment jobs) and the request-path
 * serve read from — so a mislabeled or malformed URL never reaches a
 * persisted `*_url` column. A rejected value falls to `null`; the writers'
 * `?? searchUrls.*` fallback then persists a real synthesized search URL
 * instead.
 *
 * BS#2350 also closed a paired correctness gap: suppressing `bandcamp_url`
 * must also clear the sibling `artwork.streaming_status.bandcamp` verdict,
 * or `apps/enrichment-worker/enrich.ts`'s status-arbitrated merge persists
 * `bandcamp_url: null` alongside a stale `bandcamp_status: 'verified'` —
 * permanently terminal (never re-merged) and permanently un-re-askable
 * (`precheck.ts`/`streaming-reask.ts` only re-ask an `'unresolved'` status).
 * See `sanitizeLookupStreamingUrls`'s own doc comment for the mechanics.
 * `youtube_music_url`/`soundcloud_url` have no `streaming_status` key at all
 * (LML never emits a resolution verdict for those two search-URL-only
 * services), so there is nothing paired to clear for them.
 *
 * This does NOT heal rows already persisted before the guard shipped —
 * BS persistence is fill-only, so an existing bad value survives. Those
 * need a separate overwrite migration (BS#1710 fix #3 did this for
 * spotify/apple).
 */
import type { LookupResponse } from '@wxyc/shared/dtos';

/**
 * True iff `value` contains a character that makes `new URL()`'s verdict a
 * statement about a DIFFERENT string than the one that is actually
 * persisted or emitted: a C0 control character, space, or DEL
 * (`<= 0x20` or `0x7f`), or a raw backslash (`0x5c`) — the
 * WHATWG-vs-Foundation/RFC-3986 authority-folding differential
 * {@link safeHostname}'s own doc comment describes (BS#1710).
 *
 * The single exported primitive behind this module's `safeHttpHostname` and
 * `apps/backend/utils/album-metadata-projection.ts`'s
 * `hasWireUrlParserDifferential` (BS#2356) — see that function's doc comment
 * for the full per-character rationale (backslash-authority spoofing,
 * WHATWG's strip-and-percent-encode-on-parse behavior for whitespace and
 * other C0 controls).
 */
export function hasUrlParserDifferentialChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

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
 * free of any C0 control character, space, or DEL anywhere in the string
 * — {@link hasUrlParserDifferentialChar}. That second bar mirrors
 * `apps/backend/utils/album-metadata-projection.ts`'s
 * `wireUrl`/`hasWireUrlParserDifferential` well-formedness contract — the
 * layer-3 (client-facing) predicate this layer-2 (LML-response) guard is
 * deliberately kept in agreement with. BS#2356 collapsed the two into one
 * exported primitive here (`hasUrlParserDifferentialChar`), which
 * `hasWireUrlParserDifferential` now delegates to (`apps/backend` already
 * depends on `shared/lml-client`, not the other way around, so that import
 * doesn't invert the package graph); BS#2339's own `wireUrl` docstring
 * remains the source of truth for the wire contract's rationale.
 *
 * `spotify_url`/`apple_music_url` deliberately do NOT run through this
 * stricter check — that would risk changing which URLs `isSpotifyUrl` /
 * `isAppleMusicUrl` accept, and BS#2350 requires their behavior stay
 * byte-identical. Only the three BS#2350 predicates below use it.
 *
 * Checks run cheapest-first and share a single `new URL()` parse (unlike
 * {@link safeHostname}, which this function deliberately does not call —
 * calling it would parse `url` a second time): {@link hasUrlParserDifferentialChar}'s
 * scan is a plain string scan with no parsing cost, so it runs before the
 * one `new URL()` call.
 */
function safeHttpHostname(url: string): string | null {
  if (hasUrlParserDifferentialChar(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname.toLowerCase();
}

/**
 * True iff `url` parses to an absolute http(s) URL whose host is
 * `youtube.com` or a subdomain (`music.youtube.com`, the host LML's
 * YouTube Music client and its `build_streaming_search_url` fallback both
 * emit — see `clients/streaming/youtube_music.py` and
 * `lookup/enrichment/search_urls.py` in library-metadata-lookup), or the
 * `youtu.be` short-link apex (accepted preemptively, cheap over-suppression
 * insurance — LML is adding the same host to its own vocabulary so the two
 * stay in sync). Loose on path shape, like `isSpotifyUrl`/`isAppleMusicUrl`
 * — a field-name/host invariant check, not a browse-ID extraction.
 */
export function isYouTubeMusicUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHttpHostname(url);
  return host !== null && (hostIsUnder(host, 'youtube.com') || hostIsUnder(host, 'youtu.be'));
}

/**
 * True iff `url` is a well-formed absolute http(s) URL — see
 * {@link safeHttpHostname}. Deliberately NOT a host allowlist, unlike
 * `isYouTubeMusicUrl`/`isSoundcloudUrl` (and unlike this repo's first cut at
 * this predicate, which did allowlist `bandcamp.com`).
 *
 * Bandcamp direct links live on `<artist>.bandcamp.com` (and, per
 * library-metadata-lookup's `docs/scripts.md`, sometimes a *label/imprint*
 * subdomain rather than the performing artist's own — e.g.
 * `into-the-light.bandcamp.com`) — but the `LookupResponse` this guard
 * checks is not limited to those. Bandcamp supports label-owned CUSTOM
 * DOMAINS running a Bandcamp-hosted storefront (e.g. `music.sufjan.com`),
 * genuinely off the `*.bandcamp.com` apex entirely, and LML resolves and
 * caches those as real direct links (LML#1069, album-first resolution) —
 * `clients/bandcamp.py::fix_autocomplete_url` in library-metadata-lookup
 * exists specifically to preserve a custom-domain deep link rather than
 * rewrite it back onto `bandcamp.com`, and its own test suite pins
 * `music.sufjan.com` as a genuine shape. A `bandcamp.com` host allowlist at
 * THIS seam would silently degrade every one of those to the synthesized
 * `bandcamp.com/search?q=…` fallback — a regression, not a hardening, since
 * the well-formed custom-domain URL was the better answer.
 *
 * The curated `streaming_links.bandcamp_url` column LML also serves (the
 * seam `isBandcampUrl`'s first cut was actually trying to protect) gets its
 * host check writer-side in LML instead, where "is this really Bandcamp"
 * is actually decidable against LML's own minting parser
 * (`release/url_parser.py`'s `_BANDCAMP_HOST_RE`) — see
 * WXYC/library-metadata-lookup#1296. This guard, at the `LookupResponse`
 * boundary, cannot tell a genuine custom-domain deep link apart from a
 * mislabeled foreign URL by host alone, so it deliberately doesn't try —
 * it only screens out malformed/spoofed shapes (the same bar
 * `isYouTubeMusicUrl`/`isSoundcloudUrl` apply on top of their host check).
 */
export function isBandcampUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  return safeHttpHostname(url) !== null;
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
 * Enforce the field-name/well-formedness invariant on every result's
 * artwork across all five streaming URL slots: a value that fails its
 * field's check (host allowlist for spotify/apple/youtube_music/soundcloud;
 * well-formedness only for bandcamp — see `isBandcampUrl`) is set to
 * `null`. Mutates `response` in place (the caller owns the freshly-parsed
 * object) and returns it for convenience. A suppressed value falls through
 * each writer's `?? searchUrls.*` fallback to a well-formed synthesized
 * search URL, exactly as spotify/apple do today (BS#1710); `spotify_url`/
 * `apple_music_url` behavior is unchanged by BS#2350
 * (`isSpotifyUrl`/`isAppleMusicUrl` are untouched).
 *
 * BS#2350's central correctness fix: suppressing `bandcamp_url` also clears
 * the sibling `artwork.streaming_status.bandcamp` verdict when present.
 * Without this, a suppressed URL paired with a leftover `'verified'` (or
 * `'absent'`) verdict reaches `apps/enrichment-worker/enrich.ts`'s
 * `inferIncomingStreamingStatus`, which trusts the explicit status over the
 * (now-null) url and returns it unchanged; `mergeStreamingField` then
 * persists `bandcamp_status: 'verified'` alongside `bandcamp_url: null` —
 * terminal (rule 1 never revisits a `verified` field) and permanently
 * un-re-askable (`precheck.ts`/`streaming-reask.ts` only re-ask an
 * `'unresolved'` status), the BS#1747/#1915 permanent-null freeze. Deleting
 * the key instead makes this round read as "not consulted": the merge
 * leaves whatever was already persisted untouched, and the write path
 * falls back to the synthesized search URL instead of freezing a bare
 * null. `youtube_music_url`/`soundcloud_url` have no `streaming_status` key
 * to clear — LML never emits a resolution verdict for those two
 * search-URL-only services (see `StreamingResolution`'s own doc comment) —
 * so there is nothing paired to clear for them. `spotify_url`/
 * `apple_music_url` are untouched by this too, matching their byte-identical
 * predicate behavior.
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
      // No `streaming_status.youtube_music` key exists on this schema at
      // all (see `StreamingResolution`'s doc comment) — nothing paired to
      // clear.
      artwork.youtube_music_url = null;
    }
    if (artwork.bandcamp_url != null && !isBandcampUrl(artwork.bandcamp_url)) {
      artwork.bandcamp_url = null;
      // See this function's doc comment for why the status must go too.
      if (artwork.streaming_status) {
        delete artwork.streaming_status.bandcamp;
      }
    }
    if (artwork.soundcloud_url != null && !isSoundcloudUrl(artwork.soundcloud_url)) {
      // No `streaming_status.soundcloud` key exists either — see the
      // youtube_music_url branch above.
      artwork.soundcloud_url = null;
    }
  }
  return response;
}
