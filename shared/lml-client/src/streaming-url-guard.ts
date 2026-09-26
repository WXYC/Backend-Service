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
 * BS#2689 adds ONE thing on top of all that, for `spotify_url` alone: a path
 * check. `https://open.spotify.com/artist/7CaUk9xCxdXAmmqQn3PLR7` IS a Spotify
 * URL, so the host check passed it into a column whose name promises a
 * RELEASE — 3,468 artist pages and 841 track pages out of the 29,233 populated
 * prod `album_metadata.spotify_url` values (14.9%) sent a DJ tapping "Play on
 * Spotify" to an artist page or a single track. It went into its own predicate
 * ({@link isSpotifyAlbumSlotUrl}), composed over `isSpotifyUrl` rather than
 * folded into it; that predicate's doc comment is the single home for why, and
 * for the suppression's paired status clear.
 *
 * THIS GUARD IS PROSPECTIVE ONLY, and more strictly so than "persistence is
 * fill-only" suggests. For a row already holding `spotify_status = 'verified'`,
 * a suppression here is a NO-OP ON DISK: deleting the incoming
 * `streaming_status.spotify` makes the incoming verdict `undefined`, and
 * `apps/enrichment-worker/streaming-merge-sql.ts`'s not-consulted branch then
 * emits `url: CASE WHEN status = 'verified' THEN <live column> ELSE <fallback>
 * END`, writing the stored bad URL back verbatim; `mergeStreamingField`'s
 * `if (current.status === 'verified') return current` says the same thing one
 * layer up. That is deliberate — inventing a verdict LML did not assert is the
 * worse failure — but it means the corrective pass is LOAD-BEARING for this
 * guard rather than cleanup after it. `scripts/repair-non-album-spotify-urls.ts`
 * is BS#2689's (BS#1710 fix #3 was the equivalent for spotify/apple hosts).
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
 *
 * Host-only, deliberately, and DO NOT narrow it: an artist or track page is a
 * perfectly good Spotify URL and this function must keep saying so. BS#2689's
 * album-slot path screen is {@link isSpotifyAlbumSlotUrl} — see there for
 * which callers depend on which question.
 */
export function isSpotifyUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const host = safeHostname(url);
  return host !== null && hostIsUnder(host, 'spotify.com');
}

/**
 * True iff `url` is a Spotify URL (per {@link isSpotifyUrl}) whose path is a
 * shape the `spotify_url` slot may legitimately hold. `spotify_url` names a
 * RELEASE, so that is `/album/<id>` — optionally behind a locale segment, as
 * on a localized link like `open.spotify.com/intl-de/album/<id>` — or a
 * `/search…` page.
 *
 * SEPARATE from {@link isSpotifyUrl} and composed over it at the
 * `sanitizeLookupStreamingUrls` call site, rather than folded into it, because
 * the two questions have different callers. `isSpotifyUrl` answers "is this a
 * Spotify URL", and BS#2350 requires its accept set stay byte-identical;
 * several serve seams (`proxy.controller.ts`,
 * `album-metadata-projection.ts`'s `suppressMislabeledStreamingUrls`,
 * `flowsheet-projection.ts`) gate the PERSISTED-row READ path on it, where a
 * stored non-album value is the corrective pass's problem rather than the
 * serve seam's. Whether those seams should ALSO take this predicate is a live
 * question and deliberately not settled here — it would suppress the stored
 * artist/track rows on serve without writing anything, which is a different
 * change with a different blast radius than a write-path screen.
 *
 * Search is an accept, not an oversight. It is the resolution ladder's last
 * tier: BS mints exactly that shape itself in `apps/enrichment-worker/enrich.ts`'s
 * `synthesizeSearchUrls` (`open.spotify.com/search/<query>`), 3,787 of the
 * populated prod rows carry one, and `isSpotifyUrl`'s test list has pinned it
 * as an accept since BS#1710. Nulling a search URL would be a regression, not
 * a hardening — a search page for the record is a working answer, where an
 * artist page is the wrong record.
 *
 * Everything else under the host is a different ENTITY and is rejected:
 * `/artist/` (6,143 in LML's artifact), `/track/` (989), `/playlist/` (13),
 * `/user/` (7), `/show/` (1, a podcast), and the bare `/album` with no id
 * (11), which opens a Spotify error page rather than anything playable.
 *
 * The locale segment is matched as ANY first segment starting with `intl-`,
 * not as the two fixed widths the artifact happens to contain (`intl-de`,
 * `intl-pt-br`). The error directions are not symmetric: failing to recognize
 * a locale form reads the locale as the entity kind and NULLS A REAL ALBUM
 * LINK, while over-accepting costs nothing — Spotify has no entity kind
 * beginning `intl-`, so no rejectable shape can slip through. Same cheap
 * over-acceptance posture as `isYouTubeMusicUrl`'s `youtu.be`.
 *
 * Parses before delegating to {@link isSpotifyUrl} so the unparseable case is
 * caught by this function's own `catch` rather than resting on an inference
 * about another function's internals; the cost is a second `new URL()` on a
 * value that is about to be parsed anyway, which is off any hot loop.
 *
 * Suppressing a value this rejects must ALSO clear the paired
 * `streaming_status.spotify` verdict — see `sanitizeLookupStreamingUrls`.
 */
export function isSpotifyAlbumSlotUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // WHATWG parses an authority for any scheme written with `//`, so
  // `javascript://open.spotify.com/album/x` reaches here with a spotify.com
  // hostname and an album-shaped path. `isSpotifyUrl` inherits
  // `safeHostname`'s scheme-blindness and must keep it (BS#2350), but this
  // predicate has no pre-existing callers to preserve and its value is
  // rendered as an href, so it screens the scheme like every other predicate
  // in this file does via `safeHttpHostname`.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // Host + the backslash-authority parser differential, unchanged and not
  // reimplemented here.
  if (!isSpotifyUrl(url)) return false;
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  // Case-folded for the same reason the host and the locale segment are: a real
  // album link whose kind reads as unknown is one the corrective pass NULLs.
  if (segments[0]?.toLowerCase().startsWith('intl-')) segments.shift();
  const kind = segments[0]?.toLowerCase();
  if (kind === 'search') return true;
  return kind === 'album' && segments[1] !== undefined;
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
 * object) and returns it for convenience. On the live enrichment path a
 * suppressed value falls through `?? searchUrls.*` to a well-formed
 * synthesized search URL, exactly as spotify/apple do today (BS#1710) — but
 * that is the live writer's behavior, NOT a property of every consumer: some
 * `jobs/*` writers project `artwork.spotify_url ?? null` with no search
 * fallback, so for them a suppression lands a NULL column rather than a search
 * URL. `apple_music_url` behavior is unchanged by BS#2350 and BS#2689 alike;
 * the `spotify_url` slot additionally gets BS#2689's path screen, composed
 * here as {@link isSpotifyAlbumSlotUrl}.
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
 * so there is nothing paired to clear for them.
 *
 * BS#2689 extends that same treatment to `spotify_url`, because the freeze
 * mechanism is identical and the population is far larger: ~4,353 prod rows
 * hold a non-album value. It does NOT copy the `delete`, though — it writes
 * `'unresolved'`, because deleting only moves the freeze one square over.
 * An `undefined` incoming verdict makes `mergeStreamingField` return `current`
 * verbatim, so a FRESH album lands `spotify_status: NULL` beside the
 * synthesized search URL; NULL matches neither re-ask gate while the search URL
 * satisfies `hasAnyStreamingUrl`, so nothing ever looks at the row again. That
 * is not a hypothetical shape — it is the "legacy frozen" Bandcamp cohort
 * `precheck.ts`'s still-default-OFF `bandcampFrozenReask` arm exists to rescue,
 * spelled `bandcamp_status IS NULL AND bandcamp_url LIKE '%bandcamp.com/search%'`.
 * Writing `'unresolved'` keeps every terminal guarantee (the conflict set's
 * status CASE holds a live `'verified'`/`'absent'`, and its url CASE is
 * byte-identical to the not-consulted branch) and costs one thing only: a
 * NULL-status row becomes re-ask-eligible instead of invisible.
 *
 * The `bandcamp_url` branch still deletes, deliberately: that is BS#2350's
 * decision on a field whose frozen rows already have the gated precheck arm
 * above, and converting it would change behavior this ticket never measured.
 *
 * `apple_music_url` is the remaining gap and BS#2689 does NOT close it. Its
 * branch below suppresses on host (BS#1710) and does not clear
 * `streaming_status.apple_music`, so the exact freeze described above is
 * reachable there — and worse, because `enrich.ts` treats a null
 * `apple_music_url` as load-bearing with no search fallback (BS#1192), the
 * result is a permanently blank Apple Music button rather than a degraded
 * search link. That is a pre-existing BS#2350 omission, not something this
 * branch's addition introduces or fixes; it needs its own ticket and its own
 * regression test rather than a drive-by status write here.
 */
export function sanitizeLookupStreamingUrls(response: LookupResponse): LookupResponse {
  for (const item of response.results ?? []) {
    const artwork = item.artwork;
    if (!artwork) continue;
    if (artwork.spotify_url != null && !isSpotifyAlbumSlotUrl(artwork.spotify_url)) {
      artwork.spotify_url = null;
      // DEMOTED to 'unresolved', not deleted. See this function's doc comment
      // for why the status cannot be left at 'verified'; this is why the fix
      // is not `delete`. Deleting makes the incoming verdict `undefined`, and
      // `mergeStreamingField` returns `current` untouched for that — so a
      // FRESH album persists `spotify_status: NULL` beside the synthesized
      // search URL. NULL satisfies neither re-ask gate (`precheck.ts`'s
      // `needsStreamingReask` and the hourly sweep both spell it
      // `= 'unresolved'`) while the search URL satisfies `hasAnyStreamingUrl`,
      // so the row is skipped on every later play and never picks up LML's
      // corrected album URL. That pair is exactly the "legacy frozen shape"
      // Bandcamp needed a dedicated, still-default-OFF `bandcampFrozenReask`
      // arm to dig out of; suppression must not manufacture more of it.
      //
      // 'unresolved' loses nothing the delete kept: the conflict branch's
      // status CASE holds a live 'verified' or 'absent' row at its terminal
      // value either way, and the url CASE is identical — so the ~4,353
      // already-persisted rows still need the repair script, unchanged. The
      // only behaviour that moves is the fresh-row and NULL-status case, which
      // moves from never-consulted to re-ask-eligible.
      if (artwork.streaming_status) {
        artwork.streaming_status.spotify = 'unresolved';
      }
      // Note the asymmetry with the `bandcamp_url` branch below, which still
      // deletes: that is BS#2350's, its frozen rows already have the (gated)
      // precheck arm above, and giving it the same treatment changes a field
      // this ticket never measured. Filed rather than fixed in passing.
    }
    // Host-only, deliberately, and this is the OPEN QUESTION BS#2689 left: all
    // 288 populated `apple_url` values in LML's `streaming_links` artifact are
    // already album URLs, so there is no measured population of Apple artist
    // URLs to guard, and an unmeasured screen would risk degrading real links
    // (Apple album paths are locale-segmented and slug-bearing,
    // `/<cc>/album/<slug>/<id>`, a wider shape than Spotify's). BS has never
    // counted the path shapes in `album_metadata.apple_music_url`; if that
    // count turns up artist URLs, this branch is where the screen goes.
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
