# BS#1714 — read-time serve-seam host guard for already-persisted mislabeled streaming URLs

## Problem

The ingestion-boundary guard (#1712 / PR #1713, merged) stops _new_ mislabeled streaming URLs from being persisted, but BS persistence is fill-only: the ~68K `flowsheet` + ~3.9K `album_metadata` rows already holding a non-Spotify URL in `spotify_url` (or non-Apple in `apple_music_url`) are unaffected and still served verbatim — iOS still binds them to the hardwired green "Spotify" button, which opens Deezer/Apple/Bandcamp/Qobuz/Tidal. This is interim read-time protection until the #1715 overwrite migration heals the data.

## End state

At every serve seam that emits a _persisted_ `spotify_url`/`apple_music_url`, a value whose host isn't Spotify/Apple is suppressed (dropped to `null`, or falls through to the already-computed `open.spotify.com/search/…` synthesized fallback where one exists) rather than passed through. Host-matching logic is not re-implemented: every seam calls `isSpotifyUrl` / `isAppleMusicUrl` from `@wxyc/lml-client` (shipped in #1712), which URL-parse and apex-match the host (rejecting suffix spoofs like `spotify.com.evil.example` and — post-PR #1713 — raw-backslash authority spoofs).

## Scope: the serve seams (grounded against the current code)

Only seams that read **persisted** rows need guarding. The fresh-LML branch (`proxy.controller.ts` L224–225, reading `artwork` from `lookupMetadata`→`postLookup`) and the enrichment write path (`enrichment.service.ts`) are already covered by #1712's ingestion sanitize, so they are **out of scope** here.

1. **`apps/backend/controllers/proxy.controller.ts` — `buildLocalMetadataResponse` (L372–373).** Reads `persisted.spotify_url` / `persisted.apple_music_url` from `album_metadata`. Guard each read; when the value fails the host check it is simply not set on `metadata`, so the existing fallback at L508–509 (`if (!metadata.spotifyUrl) metadata.spotifyUrl = fallbackUrls.spotifyUrl`) synthesizes the `open.spotify.com/search/…` URL. Net effect: mislabeled → synthesized Spotify search URL, matching the fresh-LML branch's degradation. Serves `/proxy/metadata/album`.

2. **`apps/backend/services/flowsheet.service.ts` — `transformToIFSEntry` (L305–362).** The single producer of every `IFSEntry`. `raw.spotify_url` currently feeds both the top-level field (L334) and the nested `metadata` object (L352); `raw.apple_music_url` likewise (L335, L353). Sanitize once into two locals at the top of the transform and use them in all four positions. This transitively covers the `transformToV2` seam at L1223–1224 (`entry.metadata?.spotify_url`) because every `IFSEntry` that reaches `transformToV2` came through `transformToIFSEntry` (verified: the only three producers are `raw.map(transformToIFSEntry)` at L464/478/500). No synthesized fallback exists at this seam, so a mislabeled value drops to `null` — iOS then renders no Spotify button, or falls to the `/proxy/metadata` fetch path (which synthesizes). Serves `/flowsheet` + `/v2/flowsheet` reads.

3. **`apps/backend/utils/flowsheet-projection.ts` — `projectFlowsheetEntry` (L115–116)** _(not enumerated in the ticket; discovered by seam trace)._ Reads `row.spotify_url` / `row.apple_music_url` straight off a raw `FSEntry`. Feeds the mutation-handler responses (`addEntry`/`updateEntry`/`changeOrder`/`deleteEntry`) and the DJ peek (`getPlaylistsForDJ`) — the `/flowsheet` + `/v2/flowsheet` mutation 200s named in the ticket's AC. Guard both reads → `null` on mismatch.

4. **`apps/backend/utils/flowsheet-projection.ts` — `pickClientFacingColumns` (L135–144)** _(not enumerated in the ticket; discovered by seam trace)._ JSON-tolerant sibling projecting the CDC `to_jsonb(NEW)` payload the anonymous `liveFs:update` SSE broadcast forwards (BS#1534) — iOS consumes this for real-time flowsheet updates and renders inline streaming metadata off it (branches on `metadata_status`, wxyc-ios-64#270). Values arrive as `unknown` (parsed JSON); after the allow-list copy, null the two streaming keys if present and failing the host check. The guards type-narrow non-strings to `false`, so passing `unknown` is runtime-safe.

## Why include seams 3 & 4 beyond the ticket's list

The ticket's acceptance criterion is behavioral — "a persisted non-Spotify `spotify_url` … is not emitted under the Spotify field by `/proxy/metadata/*`, `/flowsheet`, and `/v2/flowsheet`." The mutation responses and the `liveFs:update` SSE are `/flowsheet`+`/v2/flowsheet`-family surfaces that emit persisted streaming URLs; leaving them unguarded would half-close the invariant and invite a regression. Same one-line-per-field guard, same shared helpers — no new host logic, low marginal cost.

## Non-goals

- No writes / no data migration — that is the sibling #1715 (durable fix).
- No change to `youtube_music_url` / `bandcamp_url` / `soundcloud_url` — the bug is specific to the two service-branded buttons iOS hardwires to `spotify_url` / `apple_music_url`. (A future generalization could host-gate all five; out of scope for this interim fix and for the shipped #1712 helpers, which only expose Spotify/Apple predicates.)
- No new host-matching code — reuse `@wxyc/lml-client` helpers only.

## TDD plan

Failing-first unit tests, one per seam, then implement:

- **flowsheet-projection.test.ts** (new or extend): `projectFlowsheetEntry` and `pickClientFacingColumns` — genuine `open.spotify.com/album/…` passes; Deezer-in-`spotify_url` → `null`; `music.apple.com` in `apple_music_url` passes; a non-Apple in `apple_music_url` → `null`; suffix spoof `spotify.com.evil.example` → `null`; genuine values on the other three streaming fields untouched.
- **flowsheet.service** V2 read path: exercise `transformToIFSEntry` output (via the exported read fn or `transformToV2`) — mislabeled `spotify_url` suppressed on both the top-level field and the nested `metadata`; genuine passes; nested seam (L1223) reflects the sanitized value.
- **proxy.controller** `getAlbumMetadata`: with `lookupAlbumMetadataByKey` mocked to return a persisted Deezer `spotify_url`, the response's `spotifyUrl` is the synthesized `open.spotify.com/search/…` fallback (not the Deezer URL); a genuine persisted Spotify URL passes through unchanged. Follow the existing proxy.controller test mock pattern.

Parameterize the shared reject/accept cases where the existing suite already parameterizes.

## Acceptance criteria (from #1714)

- [ ] A persisted non-Spotify `spotify_url` (e.g. the Deezer URL on release id=1580) is not emitted under the Spotify field by `/proxy/metadata/*`, `/flowsheet`, and `/v2/flowsheet` (incl. the mutation 200s and the `liveFs:update` SSE).
- [ ] Genuine Spotify/Apple URLs pass through unchanged.
- [ ] Unit coverage at each seam.
- [ ] `npm run typecheck` / `lint` / `format:check` / `test:unit` all pass.

## Risk / rollback

Pure read-path suppression; no writes, no schema change, no migration. Worst case a genuine-but-oddly-hosted Spotify/Apple URL is dropped to `null` — but the apex-match accepts every `*.spotify.com` / `*.apple.com` host, and the fallback path already synthesizes a working search URL, so the degradation is graceful. Revert = revert the PR.
