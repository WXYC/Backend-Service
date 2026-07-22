# Metadata Deep Module — collapse enrichment scaffolding behind one interface

Tracking: [#1242](https://github.com/WXYC/Backend-Service/issues/1242)

## Goal

Introduce `@wxyc/metadata` (`shared/metadata/`) as the single home for LML-response normalization logic. Today the same normalization (artwork filtering, search-URL synthesis, Discogs-markup cleanup, fallback application) is copy-pasted across five callsites and pinned together by seven parity tests + a CI allowlist script. The duplication exists because the worker and four jobs are bundled as independent Docker images and can't import from `apps/backend` — but they share a build-graph root (the npm workspace) with `shared/*` packages. Moving the canonical to `shared/metadata/` lets every caller import directly and lets all parity scaffolding be deleted.

The deepening also introduces a _new_ deeper interface, `normalizeLookup(LookupResponse, fallbacks?) → NormalizedMetadata`, which composes the existing helpers into one operation. This is more than deduplication: it concentrates the "how do we combine filter + synthesize + clean + fallback into a final write payload" logic — currently implicit in five callsites and untested as a unit — into one place where it can be tested at the interface.

Out of scope:

- Changes to LML itself or to `@wxyc/lml-client`. The deep module consumes `LookupResponse` from lml-client; lml-client's own transport, rate-limiting, and Sentry instrumentation are unchanged.
- Changes to the enrichment _pipeline_ — the worker's CDC claim, the per-row backfill's `metadata_attempt_at` guard, the bulk job's post-pass UPDATE all stay exactly as they are. Only the "normalize a LookupResponse" step inside each pipeline is replaced.
- Migration of the five existing backend consumers (`library.controller`, `proxy.controller`, `library.service`, `artwork/providers/discogs.ts`, `metadata/enrichment.service.ts`) off the re-export shim. The shim is permanent until/unless a follow-up cleanup PR is filed; backend behavior is byte-identical through it.
- Any change to `apps/backend/services/metadata/enrichment.service.ts`'s own enrichment pathway. It uses `SearchUrlProvider` directly (not via the worker), and continues to do so. It is a separate, in-process enrichment surface that may itself benefit from `normalizeLookup` in a future PR but is not part of this work.
- Database changes. No migrations, no schema edits, no column additions.

## Production state to address

Five inline implementations of the same normalization, plus the scaffolding that pins them together.

**Inline copies of `filterSpacerGif` and/or `synthesizeSearchUrls`:**

| File                                          | Helpers inlined                           | Pipeline role                              |
| --------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| `apps/enrichment-worker/enrich.ts`            | both                                      | Runtime CDC consumer (BS#892)              |
| `jobs/flowsheet-metadata-backfill/enrich.ts`  | both                                      | Per-row drift-repair cron (#631/#638/#641) |
| `jobs/library-artwork-url-backfill/enrich.ts` | `filterSpacerGif` only                    | One-shot library artwork warm (#637)       |
| `jobs/flowsheet-artwork-repair/repair.ts`     | `filterSpacerGif` only                    | One-shot artwork re-resolve (BS#1209)      |
| `jobs/album-level-backfill/job.ts`            | `filterSpacerGif` (in `upsertAlbumMatch`) | One-shot bulk drain (BS#1041)              |

**Canonical (referenced by the parity tests):**

- `apps/backend/services/metadata/metadata.service.ts` — exports `filterSpacerGif`
- `apps/backend/services/metadata/providers/search-urls.provider.ts` — exports `SearchUrlProvider` class with `getAllSearchUrls`

**Backend consumers of the canonical (NOT part of the deepening migration, kept working via re-export shim):**

- `apps/backend/controllers/library.controller.ts`
- `apps/backend/controllers/proxy.controller.ts`
- `apps/backend/services/library.service.ts`
- `apps/backend/services/artwork/providers/discogs.ts`
- `apps/backend/services/metadata/enrichment.service.ts`

**Parity tests pinning inline copies against canonical (all delete-able after migration):**

- `tests/unit/apps/enrichment-worker/filter-spacer-gif-parity.test.ts`
- `tests/unit/apps/enrichment-worker/synthesize-search-urls-parity.test.ts`
- `tests/unit/jobs/flowsheet-metadata-backfill/filter-spacer-gif-parity.test.ts`
- `tests/unit/jobs/flowsheet-metadata-backfill/synthesize-search-urls-parity.test.ts`
- `tests/unit/jobs/library-artwork-url-backfill/filter-spacer-gif-parity.test.ts`
- `tests/unit/jobs/flowsheet-artwork-repair/filter-spacer-gif-parity.test.ts`
- `tests/unit/jobs/album-level-backfill/filter-spacer-gif-parity.test.ts`

**CI guard (delete-able after migration):**

- `scripts/check-spacer-gif-callsites.sh` — allowlists the set of source files permitted to mention the literal `'spacer.gif'`. Run from `.husky/pre-push` and presumably a CI workflow step.

After migration: one file in the repo mentions `'spacer.gif'` (`shared/metadata/src/helpers/filter-spacer-gif.ts`). The allowlist is trivially satisfied and the script earns nothing.

## Design

### Package shape

`shared/metadata/` — new npm workspace, npm name `@wxyc/metadata`. Follows the noun-style naming of the existing shared workspaces (`shared/authentication`, `shared/database`, `shared/lml-client`). Builds with `tsup`, exports CJS + ESM + types, same pattern as `shared/lml-client/package.json`.

Dependencies:

- `@wxyc/lml-client` — type-only import of `LookupResponse` (and possibly `BulkLookupResultItem` for the bulk callsite's per-item shape). No runtime dependency.
- No other workspace deps.

Devdeps: `typescript`, `tsup`, `@types/jest`, the existing repo's standard test toolchain.

### Type verification (from `shared/lml-client/src/index.ts` and `@wxyc/shared/dtos`)

`lml-client` re-exports types from `@wxyc/shared/dtos`. The relevant shapes, verified by reading `shared/lml-client/src/index.ts` lines 23–41 and the usage in `apps/backend/services/metadata/metadata.service.ts` + `apps/enrichment-worker/enrich.ts`:

```ts
// from @wxyc/shared/dtos via @wxyc/lml-client
type LookupResponse = {
  results?: LookupResultItem[];
  // (other fields not used in the enrich path)
};

type LookupResultItem = {
  artwork?: DiscogsMatchResult | null;
  // (other fields not used in the enrich path)
};

type DiscogsMatchResult = {
  release_id: number; // 0 = synthetic (no real Discogs match)
  release_url: string; // "" = synthetic
  artwork_url: string | null; // may be 'spacer.gif' placeholder
  release_year: number; // 0 = Discogs "year unknown" sentinel
  spotify_url: string | null;
  apple_music_url: string | null;
  youtube_music_url: string | null;
  bandcamp_url: string | null;
  soundcloud_url: string | null;
  artist_bio: string | null; // contains Discogs markup tags
  wikipedia_url: string | null;
};
```

Notable invariants verified from the existing code:

1. **`artwork` is the metadata payload, not just artwork.** The field name is misleading; `DiscogsMatchResult` carries the whole album + artist payload including all streaming URLs and the artist bio. There is no separate `release` or `artist` sub-object on `LookupResultItem`.
2. **Synthetic-match sentinel.** When LML can't match Discogs but still synthesizes a streaming-only result (LML#401), it returns `release_id: 0` + `release_url: ""`. `isSyntheticArtwork(artwork)` (currently in `apps/backend/services/metadata/metadata.service.ts:138`) detects this; on synthetic, `release_id` and `discogs_url` are suppressed from the write payload.
3. **`release_year: 0` is "unknown".** Discogs returns 0 as a year-unknown sentinel. The existing code coerces with `release_year || null` so a literal "0" doesn't leak to iOS or persist. See #1002.
4. **Only three streaming services have synthesized fallbacks** in the current `synthesizeSearchUrls`: `youtube_music_url`, `bandcamp_url`, `soundcloud_url`. **Spotify and Apple Music do NOT have synthesized fallbacks** — they stay null when LML didn't supply them. Apple Music's absence is deliberate (BS#1192) — LML's `_fetch_apple_music_url` enforces an 80/80 fuzzy match + collection check, and a null return is load-bearing signal that gets laundered into a broken iOS button if you synthesize one. Spotify's absence is implicit (the worker's `synthesizeSearchUrls` doesn't emit one; `SearchUrlProvider.getAllSearchUrls` does, separately, for the backend's iOS proxy surface — different concern).
5. **The "canonical cleaning function" is `cleanDiscogsBio`, not `cleanDiscogsMarkup`.** It cleans Discogs's `[a=...]`, `[l=...]`, `[r=...]`, `[m=...]`, `[url=...]...[/url]` markup tags from the `artist_bio` field. It is NOT applied to artist names or album titles — those are passed through unchanged from `DiscogsMatchResult` (which doesn't carry them anyway; artist name and album title are caller-supplied via the lookup request, not echoed back in the response). This resolves the open question from the prior plan revision.
6. **Field naming is snake_case throughout the data path.** `DiscogsMatchResult` is snake_case; the Drizzle schema for `flowsheet`, `library`, and `album_metadata` is snake_case; the worker's inline `synthesizeSearchUrls` returns snake_case for ergonomic spreading into the Drizzle `set({...})` block. `NormalizedMetadata` follows suit. The existing camelCase `SearchUrlProvider.getAllSearchUrls` API used by backend's iOS proxy surface stays camelCase via the re-export shim (see "Re-export shim" below).

### Public surface

Six exports from `shared/metadata/src/index.ts`:

```ts
import type { LookupResponse } from '@wxyc/lml-client';

// The deep operation — preferred entry point for the enrich pipeline.
// `fallbacks.artist` is required because synthesized search URLs always
// need an artist name; without it normalization has nothing to compose.
export function normalizeLookup(response: LookupResponse, fallbacks: MetadataFallbacks): NormalizedMetadata;

// The deep operation's output type. Snake_case to spread directly into
// Drizzle `set({...})` blocks for flowsheet / album_metadata writes.
//
// LML-derived fields are nullable: null when LML returned no artwork, when
// artwork was synthetic (release_id=0 + release_url=""), or when LML's
// upstream Discogs didn't carry the field.
//
// Synthesized search URL fields are non-null: composition from fallbacks
// always produces a valid query URL.
export type NormalizedMetadata = {
  discogs_url: string | null; // null on no-match or synthetic
  artwork_url: string | null; // null on no-match, synthetic, or spacer.gif
  release_year: number | null; // null on no-match or year=0 sentinel
  spotify_url: string | null; // null on no-match or LML-null
  apple_music_url: string | null; // null on no-match or LML-null (intentional, BS#1192)
  artist_bio: string | null; // null on no-match; markup-cleaned when present
  artist_wikipedia_url: string | null; // null on no-match or LML-null
  youtube_music_url: string; // LML value if present, else synthesized — never null
  bandcamp_url: string; // LML value if present, else synthesized — never null
  soundcloud_url: string; // LML value if present, else synthesized — never null
};

// Note: there is no `discogs_release_id` field. The Drizzle schema for
// `flowsheet` (shared/database/src/schema.ts, flowsheet table block) and
// `album_metadata` (same file, album_metadata block) carries `discogs_url`
// but NOT a separate `discogs_release_id` integer column for these write
// paths. The numeric `artwork.release_id` from `DiscogsMatchResult` is used
// internally by `isSyntheticArtwork` (0 = synthetic) but the value itself
// is only persisted as the URL. (A `discogs_release_id` integer column
// exists on other tables — rotation, library — used by different code
// paths that are out of scope for this deepening.)

// The deep operation's required inputs for fallback / synthesis.
// `artist` is required (URL synthesis needs it); album and track are
// optional with the documented null-coalescing chain documented in
// `synthesizeSearchUrls` (see "Internal structure" below).
export type MetadataFallbacks = {
  artist: string;
  album?: string | null;
  track?: string | null;
};

// Lower-level helpers — escape hatches for callers that don't have a
// LookupResponse and want one specific operation. Backend consumers
// (library.controller, proxy.controller, etc.) use these via the
// apps/backend/services/metadata/ re-export shim.
export function filterSpacerGif(url: string | null | undefined): string | null;
export function synthesizeSearchUrls(input: MetadataFallbacks): {
  youtube_music_url: string;
  bandcamp_url: string;
  soundcloud_url: string;
};
export function cleanDiscogsBio(bio: string): string;
export function isSyntheticArtwork(artwork: DiscogsMatchResult): boolean;
```

Seven exports total (the `DiscogsMatchResult` predicate `isSyntheticArtwork` is exported so the proxy controller — which currently uses it via the backend canonical — keeps working through the shim).

### Nullability precedence table

For each `NormalizedMetadata` field, the resolution chain:

| Field                  | LML present + non-synthetic                            | LML synthetic                                          | No LML match              |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------ | ------------------------- |
| `discogs_url`          | `artwork.release_url`                                  | `null`                                                 | `null`                    |
| `artwork_url`          | `filterSpacerGif(artwork.artwork_url)`                 | `filterSpacerGif(artwork.artwork_url)`                 | `null`                    |
| `release_year`         | `artwork.release_year \|\| null`                       | `null`                                                 | `null`                    |
| `spotify_url`          | `artwork.spotify_url ?? null`                          | `artwork.spotify_url ?? null`                          | `null`                    |
| `apple_music_url`      | `artwork.apple_music_url ?? null`                      | `artwork.apple_music_url ?? null`                      | `null`                    |
| `artist_bio`           | `cleanDiscogsBio(artwork.artist_bio) ?? null`          | `null`                                                 | `null`                    |
| `artist_wikipedia_url` | `artwork.wikipedia_url ?? null`                        | `null`                                                 | `null`                    |
| `youtube_music_url`    | `artwork.youtube_music_url ?? synth.youtube_music_url` | `artwork.youtube_music_url ?? synth.youtube_music_url` | `synth.youtube_music_url` |
| `bandcamp_url`         | `artwork.bandcamp_url ?? synth.bandcamp_url`           | `artwork.bandcamp_url ?? synth.bandcamp_url`           | `synth.bandcamp_url`      |
| `soundcloud_url`       | `artwork.soundcloud_url ?? synth.soundcloud_url`       | `artwork.soundcloud_url ?? synth.soundcloud_url`       | `synth.soundcloud_url`    |

This precedence is the contract `normalize-lookup.test.ts` asserts. It is byte-equivalent to the worker's current per-branch logic (`finalizeRow` in `apps/enrichment-worker/enrich.ts:135-248`); the deepening preserves behavior while concentrating it.

The README at `shared/metadata/README.md` documents:

- `normalizeLookup` as the preferred entry point — "use this if you have a LookupResponse and need to produce field values to write."
- The four helpers as escape hatches — "use these only if you don't have a LookupResponse." Example: `library.controller` filtering a single URL pulled from a different code path.
- The dependency direction rule: this package is the _deep core_. It must not import from `apps/*` or `jobs/*`. Code review enforces.
- The "no I/O" rule: pure functions only. No HTTP, no DB, no filesystem, no `process.env`. The test for whether something belongs here: would unit tests need to mock anything to call it? If yes, it doesn't belong here.
- The "snake_case" rule: types and fields in this package are snake_case to match the Drizzle schema and the LML response shape. Convert to camelCase at the boundary if a consumer needs it (the `SearchUrlProvider` shim does this for backend's iOS proxy surface).

### Internal structure

```
shared/metadata/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
└── src/
    ├── index.ts                       — public exports only
    ├── normalize-lookup.ts            — the deep operation
    ├── helpers/
    │   ├── filter-spacer-gif.ts
    │   ├── synthesize-search-urls.ts
    │   ├── clean-discogs-bio.ts
    │   └── is-synthetic-artwork.ts
    └── __tests__/
        ├── normalize-lookup.test.ts
        ├── filter-spacer-gif.test.ts
        ├── synthesize-search-urls.test.ts
        ├── clean-discogs-bio.test.ts
        ├── is-synthetic-artwork.test.ts
        └── __fixtures__/
            └── lookup-responses.ts
```

`normalize-lookup.ts` is the composition layer. Implementation aligned to the nullability precedence table above:

```ts
import type { DiscogsMatchResult, LookupResponse } from '@wxyc/lml-client';
import { filterSpacerGif } from './helpers/filter-spacer-gif';
import { synthesizeSearchUrls } from './helpers/synthesize-search-urls';
import { cleanDiscogsBio } from './helpers/clean-discogs-bio';
import { isSyntheticArtwork } from './helpers/is-synthetic-artwork';

export type NormalizedMetadata = {/* snake_case, see "Public surface" */};
export type MetadataFallbacks = { artist: string; album?: string | null; track?: string | null };

export function normalizeLookup(response: LookupResponse, fallbacks: MetadataFallbacks): NormalizedMetadata {
  const artwork: DiscogsMatchResult | null = response.results?.[0]?.artwork ?? null;
  const synth = synthesizeSearchUrls(fallbacks);

  if (!artwork) {
    // No-match: search URLs only; everything else null.
    return {
      discogs_url: null,
      artwork_url: null,
      release_year: null,
      spotify_url: null,
      apple_music_url: null,
      artist_bio: null,
      artist_wikipedia_url: null,
      youtube_music_url: synth.youtube_music_url,
      bandcamp_url: synth.bandcamp_url,
      soundcloud_url: synth.soundcloud_url,
    };
  }

  const synthetic = isSyntheticArtwork(artwork);

  return {
    discogs_url: synthetic ? null : artwork.release_url,
    artwork_url: filterSpacerGif(artwork.artwork_url),
    release_year: artwork.release_year || null, // 0 sentinel → null (#1002)
    spotify_url: artwork.spotify_url ?? null,
    apple_music_url: artwork.apple_music_url ?? null,
    artist_bio: synthetic ? null : artwork.artist_bio ? cleanDiscogsBio(artwork.artist_bio) : null,
    artist_wikipedia_url: synthetic ? null : (artwork.wikipedia_url ?? null),
    youtube_music_url: artwork.youtube_music_url ?? synth.youtube_music_url,
    bandcamp_url: artwork.bandcamp_url ?? synth.bandcamp_url,
    soundcloud_url: artwork.soundcloud_url ?? synth.soundcloud_url,
  };
}
```

This mirrors the worker's current `finalizeRow` (`apps/enrichment-worker/enrich.ts:135-248`) and the backend's `extractAlbumMetadata` + `extractArtistMetadata` (`apps/backend/services/metadata/metadata.service.ts:145-173`) — collapsed into one composition rather than spread across three branches (match-linked, match-unlinked, no-match) × two writers (worker, backend service).

`synthesize-search-urls.ts` ports the worker's inline function **body** verbatim — same per-service fallback chain (YT: track > album > artist; Bandcamp: album > artist; SoundCloud: track > artist with no album fallback), same `encodeURIComponent`, same snake_case return keys. The **input shape changes**: the worker's inline takes `EnrichRow` (`{ id, artist_name, album_title, track_title, album_id }`) and reads `row.artist_name`, `row.album_title ?? undefined`, `row.track_title ?? undefined`. The deep module's version takes `MetadataFallbacks` (`{ artist, album?, track? }`) and reads the same three semantic fields by their cleaner names. The change is deliberate: `EnrichRow` is the worker's row-projection type (it carries `id` + `album_id` for the worker's own bookkeeping), but `synthesizeSearchUrls` only ever uses three fields and shouldn't take a dependency on the row shape. The five callsites adapt at the import: `synthesizeSearchUrls({ artist: row.artist_name, album: row.album_title, track: row.track_title })` is the migration shape and is identical in semantics to the inline call. The backend's existing camelCase `SearchUrlProvider.getAllSearchUrls(artist, album, track)` API is preserved separately via the re-export shim (next section) and the shim adapts to the new `MetadataFallbacks` input shape internally.

`clean-discogs-bio.ts` ports the regex from `apps/backend/services/metadata/metadata.service.ts:22-29` (also duplicated as `cleanDiscogsBio` in `apps/enrichment-worker/enrich.ts:61-67`).

`is-synthetic-artwork.ts` ports the predicate from `apps/backend/services/metadata/metadata.service.ts:138-140`.

`filter-spacer-gif.ts` returns `string | null` (matching the worker's inline shape, not the backend canonical's `string | undefined`). The backend canonical is changed to return `null` as part of this migration; backend consumers using `if (!url)` patterns are unaffected by `null` vs `undefined`. Specifically, the five consumers (`library.controller:110`, `proxy.controller:209,265`, `library.service:594`, `artwork/providers/discogs.ts:44`) all use the result in a conditional or coalescing context where null/undefined behave identically. Verified by grep before PR 1 lands.

### Re-export shim

To avoid churning the five backend consumers in this work, `apps/backend/services/metadata/metadata.service.ts` and `apps/backend/services/metadata/providers/search-urls.provider.ts` become thin re-exports from `@wxyc/metadata`. The shims preserve the existing API shapes (including the backend's camelCase return on `SearchUrlProvider.getAllSearchUrls` — the deep module's snake_case helper is converted at the shim boundary):

```ts
// apps/backend/services/metadata/metadata.service.ts
//
// Re-exports the migrated helpers from @wxyc/metadata. The deep module's
// helpers are the canonical source; this file is preserved for import
// stability so the five backend consumers don't need to change in this PR.
export { filterSpacerGif, isSyntheticArtwork } from '@wxyc/metadata';

// fetchMetadata and the album/artist-extraction logic remain inline here
// (not part of this deepening — they belong to the backend's separate
// enrichment pathway, which a future PR may migrate to normalizeLookup).
// ...
```

```ts
// apps/backend/services/metadata/providers/search-urls.provider.ts
//
// Class shim preserving the camelCase API the backend's iOS proxy surface
// expects. The deep module's synthesizeSearchUrls returns snake_case
// (matching the Drizzle schema); this shim converts at the boundary.
import { synthesizeSearchUrls } from '@wxyc/metadata';

export class SearchUrlProvider {
  getAllSearchUrls(artistName: string, albumTitle?: string, trackTitle?: string) {
    const snake = synthesizeSearchUrls({
      artist: artistName,
      album: albumTitle ?? null,
      track: trackTitle ?? null,
    });
    return {
      youtubeMusicUrl: snake.youtube_music_url,
      bandcampUrl: snake.bandcamp_url,
      soundcloudUrl: snake.soundcloud_url,
      spotifyUrl: this.getSpotifyUrl(artistName, albumTitle, trackTitle),
    };
  }
  // Preserve the spotify URL synthesis that the backend's iOS proxy surface
  // uses but the worker's inline synthesizeSearchUrls does not emit. This
  // method is unchanged from the existing class.
  private getSpotifyUrl(artist: string, album?: string, track?: string) {
    /* ... */
  }
}
```

Three notes on the shim:

1. **The Spotify URL synthesis stays in the shim**, not in `@wxyc/metadata`. The deep module's `synthesizeSearchUrls` matches the worker's snake_case 3-service shape exactly (intentional — the worker doesn't emit a synthesized Spotify URL because BS#1192-style considerations apply asymmetrically). The backend's proxy surface needs Spotify and gets it from the shim. If a future PR consolidates the Spotify synthesis into the deep module, it'd need to commit to the same nullability + emission semantics across all callers — out of scope here.
2. **The shim earns its keep** as a migration affordance: zero diff to the five backend consumer files in PR 1. The deletion test on the shim says it _is_ a pass-through — correct for a migration shim. A follow-up cleanup PR can inline it out if the team wants; not blocking.
3. **Error propagation**: both `synthesizeSearchUrls` (deep module) and `getSpotifyUrl` (shim-internal) are pure synchronous functions that do `encodeURIComponent` + string concatenation. Neither throws under any input the type system permits (`encodeURIComponent` on a string returns a string; concatenation can't fail). The shim does not introduce any try/catch — errors, if any future change adds one, propagate verbatim to the caller. The existing five backend consumers all call `getAllSearchUrls` synchronously without try/catch, matching this expectation.

### Dependency direction

```
@wxyc/metadata  ← @wxyc/lml-client (type-only)
       ↑
       ├── apps/enrichment-worker
       ├── apps/backend (via re-export shim in services/metadata/)
       ├── jobs/flowsheet-metadata-backfill
       ├── jobs/library-artwork-url-backfill
       ├── jobs/flowsheet-artwork-repair
       └── jobs/album-level-backfill
```

`@wxyc/metadata` is the _deepest_ node in this graph. It imports from nothing except the `LookupResponse` type. If `LookupResponse` ever migrates out of `lml-client` into a transport-neutral contract package, this dep goes away entirely — future refactor, not blocking.

`lml-client` continues to be a transport adapter. It produces values of type `LookupResponse` over HTTP. It does NOT import from `@wxyc/metadata` (would create a cycle and is the wrong direction — the transport shouldn't know about normalization).

## Deliverable shape

Seven PRs. Six functional, one cleanup. Each is independently shippable; each leaves the system in a coherent state.

### PR 1 — Introduce `@wxyc/metadata`, no behavior change

**Files added:**

- `shared/metadata/package.json` (npm name `@wxyc/metadata`, version `1.0.0`)
- `shared/metadata/tsconfig.json`
- `shared/metadata/tsup.config.ts`
- `shared/metadata/README.md` (documents the public surface, escape-hatch guidance, dependency-direction rule, no-I/O rule)
- `shared/metadata/src/index.ts` (public exports)
- `shared/metadata/src/normalize-lookup.ts`
- `shared/metadata/src/helpers/filter-spacer-gif.ts` (port from `apps/backend/services/metadata/metadata.service.ts:119-122`; change return type from `string | undefined` to `string | null` — five backend consumers verified compatible)
- `shared/metadata/src/helpers/synthesize-search-urls.ts` (port from worker's inline `apps/enrichment-worker/enrich.ts:85-101` — snake_case keys, 3-service shape; the backend's camelCase 4-service shape stays in the `SearchUrlProvider` shim)
- `shared/metadata/src/helpers/clean-discogs-bio.ts` (port from `apps/backend/services/metadata/metadata.service.ts:22-29`)
- `shared/metadata/src/helpers/is-synthetic-artwork.ts` (port from `apps/backend/services/metadata/metadata.service.ts:138-140`)
- `shared/metadata/src/__tests__/__fixtures__/lookup-responses.ts` (typed `LookupResponse` fixtures — see "Testing strategy")
- `shared/metadata/src/__tests__/normalize-lookup.test.ts`
- `shared/metadata/src/__tests__/filter-spacer-gif.test.ts`
- `shared/metadata/src/__tests__/synthesize-search-urls.test.ts`
- `shared/metadata/src/__tests__/clean-discogs-bio.test.ts`
- `shared/metadata/src/__tests__/is-synthetic-artwork.test.ts`

**Files modified:**

- `apps/backend/services/metadata/metadata.service.ts` — three changes:
  1. `filterSpacerGif` and `isSyntheticArtwork` converted to re-exports from `@wxyc/metadata`.
  2. The local `cleanDiscogsBio` function (lines 22–29) is deleted **and not re-exported**. Its sole caller, `extractArtistMetadata` (line 167), changes its import to `import { cleanDiscogsBio } from '@wxyc/metadata'`. Verified by grep before plan finalization: zero `import.*cleanDiscogsBio` results in `apps/backend/` or `shared/`. There are no external consumers, so there is no need for a re-export shim — keeping one would be dead code. The file's export list shrinks by one symbol after this change.
  3. `fetchMetadata`, `extractAlbumMetadata`, `extractArtistMetadata` are otherwise unchanged (they belong to the backend's separate enrichment pathway, out of scope).
- `apps/backend/services/metadata/providers/search-urls.provider.ts` — converted to class-shim wrapping `synthesizeSearchUrls`, with snake → camel conversion at the API boundary and Spotify URL synthesis preserved inline (see "Re-export shim" above).
- `apps/backend/package.json` — add `@wxyc/metadata` dep.
- `package.json` (workspace root) — add `shared/metadata` to the `workspaces` array (mirrors the existing entries for `shared/lml-client`, `shared/database`, `shared/authentication`).
- `tsconfig.base.json` (workspace root) — add `"@wxyc/metadata": ["shared/metadata/src"]` to `compilerOptions.paths`, mirroring the existing entries for `@wxyc/authentication`, `@wxyc/database`, `@wxyc/lml-client`. The root `tsconfig.base.json` does NOT use `references` or `composite: true` — type resolution is via the `paths` map only. Verified by reading the current `tsconfig.base.json`.

**Files unchanged in behavior; one allowlist entry added:**

- Worker, all four jobs (still have inline copies — migration in subsequent PRs).
- All seven parity tests (still pass — they pin inline ↔ canonical-via-shim, both resolve to the same code path).
- `scripts/check-spacer-gif-callsites.sh` — one entry added to the `ALLOWED` bash array (the canonical entry remains until PR 7 deletes the script):

  ```bash
  ALLOWED=(
    "apps/backend/services/metadata/metadata.service.ts"   # canonical, now a re-export shim
    "shared/metadata/src/helpers/filter-spacer-gif.ts"     # NEW — the deep module's canonical
    "jobs/flowsheet-metadata-backfill/enrich.ts"
    "jobs/library-artwork-url-backfill/enrich.ts"
    "jobs/album-level-backfill/job.ts"
    "jobs/flowsheet-artwork-repair/repair.ts"
    "apps/enrichment-worker/enrich.ts"
  )
  ```

  PRs 2–6 each remove one of the inline-callsite lines as that callsite migrates. PR 7 deletes the script.

**New tests pass; old tests pass; ESLint/typecheck clean; the integration suite is byte-identical.**

PR title: `feat(metadata): introduce @wxyc/metadata deep module + behavior tests`

PR size estimate: ~600 lines added (~400 source, ~200 tests), ~30 lines deleted (helpers extracted from backend canonical and replaced with re-exports). Net ~570 added.

### PR 2 — Port `jobs/library-artwork-url-backfill/`

Smallest blast radius. Narrow projection (one field). One-shot job, low activity.

**Files modified:**

- `jobs/library-artwork-url-backfill/package.json` — add `@wxyc/metadata` dep.
- `jobs/library-artwork-url-backfill/enrich.ts` — replace inline `filterSpacerGif` with `normalizeLookup(response, { artist: row.artist_name }).artworkUrl`. Delete inline function.

**Files deleted:**

- `tests/unit/jobs/library-artwork-url-backfill/filter-spacer-gif-parity.test.ts`

**Allowlist script update:**

- `scripts/check-spacer-gif-callsites.sh` — remove `jobs/library-artwork-url-backfill/enrich.ts` from the allowlist.

PR title: `refactor(library-artwork-url-backfill): use @wxyc/metadata.normalizeLookup`

PR size: ~30 lines deleted (inline function), ~5 lines changed (import + call), test file delete (~30 lines). Net ~50 deleted.

### PR 3 — Port `jobs/flowsheet-artwork-repair/`

Second-smallest. One-shot job (BS#1209), narrow projection.

**Files modified:**

- `jobs/flowsheet-artwork-repair/package.json` — add `@wxyc/metadata` dep.
- `jobs/flowsheet-artwork-repair/repair.ts` — replace inline `filterSpacerGif` with `normalizeLookup(response, fallbacks).artworkUrl`. Two populations (free-form and linked) both go through the same replacement.

**Files deleted:**

- `tests/unit/jobs/flowsheet-artwork-repair/filter-spacer-gif-parity.test.ts`

**Allowlist update:**

- `scripts/check-spacer-gif-callsites.sh` — remove `jobs/flowsheet-artwork-repair/repair.ts`.

PR title: `refactor(flowsheet-artwork-repair): use @wxyc/metadata.normalizeLookup`

### PR 4 — Port `jobs/flowsheet-metadata-backfill/`

Recurring cron (default 02:00 ET, `BACKFILL_CRON_SCHEDULE` overridable). Wider projection — writes full enrichment field set. Cooperative-pause when DJs active (#735) keeps it from competing with the runtime.

**Files modified:**

- `jobs/flowsheet-metadata-backfill/package.json` — add `@wxyc/metadata` dep.
- `jobs/flowsheet-metadata-backfill/enrich.ts` — replace both inline functions (`filterSpacerGif`, `synthesizeSearchUrls`) with a single `normalizeLookup(response, { artist: row.artist, album: row.album, track: row.track_name })` call. Project from `NormalizedMetadata` into the write payload.

**Files deleted:**

- `tests/unit/jobs/flowsheet-metadata-backfill/filter-spacer-gif-parity.test.ts`
- `tests/unit/jobs/flowsheet-metadata-backfill/synthesize-search-urls-parity.test.ts`

**Allowlist update:**

- `scripts/check-spacer-gif-callsites.sh` — remove `jobs/flowsheet-metadata-backfill/enrich.ts`.

**Post-deploy verification:**

- Watch the first cron run after deploy. Metadata-status distribution in the next day's digest should be unchanged. If `enriched_match` / `enriched_no_match` / `failed` counts shift materially, roll back.

PR title: `refactor(flowsheet-metadata-backfill): use @wxyc/metadata.normalizeLookup`

### PR 5 — Port `jobs/album-level-backfill/upsertAlbumMatch`

Bulk LML endpoint (`POST /api/v1/lookup/bulk`, BS#1041), per-item normalization is `.map(normalizeLookup)`. The post-pass `UPDATE flowsheet` that links pending rows to the enriched album_metadata is unchanged.

**Files modified:**

- `jobs/album-level-backfill/package.json` — add `@wxyc/metadata` dep.
- `jobs/album-level-backfill/job.ts` — `upsertAlbumMatch` (lines 239–284) gets its inline filter replaced with `normalizeLookup(item.lookup, fallbacks).artworkUrl` and per-item projection into the `album_metadata` write shape.

**Files deleted:**

- `tests/unit/jobs/album-level-backfill/filter-spacer-gif-parity.test.ts`

**Allowlist update:**

- `scripts/check-spacer-gif-callsites.sh` — remove `jobs/album-level-backfill/job.ts`.

PR title: `refactor(album-level-backfill): use @wxyc/metadata.normalizeLookup`

### PR 6 — Port `apps/enrichment-worker/`

Runtime CDC consumer (BS#892). Highest stakes — every flowsheet track row written by DJs goes through this. Save for last so the deep module has been exercised by four backfill ports first.

**Files modified:**

- `apps/enrichment-worker/package.json` — add `@wxyc/metadata` dep.
- `apps/enrichment-worker/enrich.ts` — replace both inline functions with single `normalizeLookup` call. Project into the flowsheet update payload. The claim → lookup → write structure stays exactly as it is; only the "what values go into the write" derivation collapses.

**Files deleted:**

- `tests/unit/apps/enrichment-worker/filter-spacer-gif-parity.test.ts`
- `tests/unit/apps/enrichment-worker/synthesize-search-urls-parity.test.ts`

**Allowlist update:**

- `scripts/check-spacer-gif-callsites.sh` — remove `apps/enrichment-worker/enrich.ts`.

**Post-deploy verification:**

- Watch CDC-driven enrichment latency for first 24 hours. Sentry breadcrumbs from `normalizeLookup` (if added) shouldn't appear at unusual rates.
- `metadata_status` distribution in flowsheet shouldn't shift. The reconciliation monitor (`docs/cdc.md`) provides the comparison baseline.

PR title: `refactor(enrichment-worker): use @wxyc/metadata.normalizeLookup`

### PR 7 — Cleanup: delete the allowlist script

After PRs 2–6, only one file in the repo mentions the literal `'spacer.gif'` — the helper inside `shared/metadata/src/helpers/filter-spacer-gif.ts`. The allowlist is trivially satisfied and the script has nothing left to defend.

**Files deleted:**

- `scripts/check-spacer-gif-callsites.sh`

**Files modified:**

- `.husky/pre-push` — remove the `check-spacer-gif-callsites.sh` invocation if present.
- Any GitHub Actions workflow that calls the script — remove the step.

PR title: `chore: remove check-spacer-gif-callsites allowlist script`

## Testing strategy

**Three new behavior tests** live in `shared/metadata/src/__tests__/`. The first two are reformulations of the existing parity-test cases; the third is new and is the deepening's primary verification payoff.

### `filter-spacer-gif.test.ts`

Cases lifted from the existing seven parity tests' shared input table:

- `null` input → `null`
- `undefined` input → `null`
- empty string → `null`
- plain URL → passes through unchanged
- `https://s.discogs.com/images/spacer.gif` → `null`
- `https://example.com/a/spacer.gif/x` (substring match) → behavior matches canonical (today: pass-through; verify against canonical at port time)
- capitalized `Spacer.gif` → does NOT match the canonical literal → pass-through

No longer described as "parity" — these are behavior assertions. There is one implementation.

### `synthesize-search-urls.test.ts`

Cases lifted from `synthesize-search-urls-parity.test.ts`:

- Full track + album + artist (Juana Molina / DOGA / "la paradoja")
- No track, album present (Stereolab / Dots and Loops / null)
- No album, track present (Autechre / null / "VI Scose Poise")
- Artist only (Chuquimamani-Condori / null / null)
- Diacritics in artist (Nilüfer Yanya / Painless / "stabilise")
- Diacritics + nothing else (Hermanos Gutiérrez / null / null)
- Spaces + ampersand in artist (Duke Ellington & John Coltrane / null / null)

Assertions on URL encoding, query-string composition, and per-service URL templates.

### `normalize-lookup.test.ts` — NEW

The behavior that's currently untested. Asserts on the _combination_ of helpers + the nullability precedence table. Test scope aligns directly with the precedence table — every cell in the table that has non-trivial resolution is one or more assertions.

```ts
describe('normalizeLookup', () => {
  const FALLBACKS = { artist: 'Stereolab', album: 'Dots and Loops', track: 'Diagonals' };

  describe('no-match (response.results empty or artwork missing)', () => {
    it('returns null for every LML-derived field');
    it('still emits synthesized youtube_music_url / bandcamp_url / soundcloud_url from fallbacks');
  });

  describe('synthetic-artwork match (release_id=0 + release_url="")', () => {
    it('suppresses discogs_url to null');
    it('suppresses artist_bio + artist_wikipedia_url to null');
    it('preserves streaming URLs (spotify, apple_music, youtube_music, bandcamp, soundcloud) from LML');
    it('still filters spacer.gif on artwork_url');
  });

  describe('full match', () => {
    it('returns artwork.release_url as discogs_url');
    it('filters spacer.gif on artwork_url (returns null when matched)');
    it('coerces release_year 0 to null (Discogs year-unknown sentinel)');
    it('cleans Discogs markup tags from artist_bio');
    it('returns null artist_bio when LML returned null artist_bio');
    it('prefers LML youtube_music_url over synthesized when both present');
    it('falls back to synthesized youtube_music_url when LML returned null');
    it('same precedence for bandcamp_url and soundcloud_url');
    it('returns spotify_url and apple_music_url verbatim from LML (no synthesis fallback)');
  });

  describe('fallback application in search URL synthesis', () => {
    it('uses fallbacks.artist for all three synthesized URLs');
    it('uses fallbacks.album when present in bandcamp URL query');
    it('uses fallbacks.track when present in youtube_music + soundcloud URL queries');
    it('handles null fallbacks.album by falling back to artist-only bandcamp query');
    it('handles null fallbacks.track by falling back to album-then-artist for youtube');
  });
});
```

This test never existed before. The combination logic — "what does the final write payload look like for this `LookupResponse` shape?" — was implicit across five copy-pasted callsites. Now it's a contract.

### Test fixtures

`shared/metadata/src/__tests__/__fixtures__/lookup-responses.ts` — typed `LookupResponse` values for the test cases. Sketches (typed against the upstream so a change to `LookupResponse` shape breaks the tests at compile time):

```ts
import type { LookupResponse } from '@wxyc/lml-client';

export const NO_MATCH: LookupResponse = {
  results: [],
};

export const NO_ARTWORK: LookupResponse = {
  results: [{ artwork: null }],
};

export const SYNTHETIC_MATCH: LookupResponse = {
  results: [
    {
      artwork: {
        release_id: 0,
        release_url: '',
        artwork_url: null,
        release_year: 0,
        spotify_url: 'https://open.spotify.com/track/abc',
        apple_music_url: null,
        youtube_music_url: 'https://music.youtube.com/watch?v=xyz',
        bandcamp_url: null,
        soundcloud_url: null,
        artist_bio: null,
        wikipedia_url: null,
      },
    },
  ],
};

export const FULL_MATCH: LookupResponse = {
  results: [
    {
      artwork: {
        release_id: 12345,
        release_url: 'https://www.discogs.com/release/12345',
        artwork_url: 'https://i.discogs.com/abc.jpg',
        release_year: 1997,
        spotify_url: 'https://open.spotify.com/album/def',
        apple_music_url: 'https://music.apple.com/album/123',
        youtube_music_url: 'https://music.youtube.com/playlist?list=PL...',
        bandcamp_url: 'https://stereolab.bandcamp.com/album/dots-and-loops',
        soundcloud_url: null, // LML didn't supply — normalizeLookup falls back to synthesized
        artist_bio: 'Stereolab is a band [a=Tim Gane] [url=https://stereolab.net]link[/url].',
        wikipedia_url: 'https://en.wikipedia.org/wiki/Stereolab',
      },
    },
  ],
};

export const SPACER_GIF_ARTWORK: LookupResponse = {
  results: [
    {
      artwork: {
        ...FULL_MATCH.results![0].artwork!,
        artwork_url: 'https://s.discogs.com/images/spacer.gif',
      },
    },
  ],
};

export const YEAR_ZERO_MATCH: LookupResponse = {
  results: [
    {
      artwork: {
        ...FULL_MATCH.results![0].artwork!,
        release_year: 0, // Discogs "year unknown" sentinel
      },
    },
  ],
};
```

Fixtures are TypeScript values, not JSON, so changes to the upstream type break the tests at compile time.

### Tests being deleted

Seven parity test files. Total ~280 lines.

Three new behavior test files. Total ~150 lines (estimate; tighter because no parity-comparison boilerplate).

Net test code: ~130 lines deleted.

### Tests untouched

- All integration tests (`tests/integration/**/*.spec.js`) — they exercise the enrich pipeline end-to-end and remain the safety net for each per-callsite port PR.
- All other unit tests in the workspace.

## Risk and rollback

### PR 1 risks

- **Risk**: `@wxyc/metadata` package wiring (`tsconfig.base.json:paths`, tsup config, workspace resolution) breaks the build.
  - **Detection**: `npm run typecheck` + `npm run build` locally before push; CI's `lint-and-typecheck` job catches in PR.
  - **Rollback**: revert.
- **Risk**: Re-export shim subtly changes a backend consumer's behavior (e.g., `SearchUrlProvider` class identity changes break an `instanceof` check somewhere).
  - **Detection**: integration tests on the affected backend routes.
  - **Mitigation**: grep for `instanceof SearchUrlProvider` before shim conversion. If any callers depend on identity, the shim returns the same wrapper class definition, not a thin proxy.
  - **Rollback**: revert.
- **Risk**: `filterSpacerGif` return-type change (`string | undefined` → `string | null`) breaks a backend consumer that does explicit type discrimination.
  - **Pre-PR gate**: Before opening PR 1, run `grep -rEn "filterSpacerGif" apps/backend/ shared/ | grep -v "\.test\.ts"` and verify every call site uses one of: a truthy/falsy conditional (`if (!url)`, `if (url)`), a nullish coalescer with another value (`?? other`), or a direct assignment to a `string | null | undefined` slot. Reject the gate if any callsite does `=== undefined`, `typeof url === 'undefined'`, or any other check that distinguishes null from undefined. As of plan revision, all five consumers (`library.controller:110`, `proxy.controller:209,265`, `library.service:594`, `artwork/providers/discogs.ts:44`) use truthy-check assignment patterns and pass the gate.
  - **Detection**: TypeScript catches at compile time if the assignment target is `string | undefined` (not `string | null`). The `strict: true` + `strictNullChecks: true` settings in `tsconfig.base.json` make this a build-time failure, not a runtime surprise.
  - **Rollback**: revert.

### PR 2–6 risks (per-callsite ports)

- **Risk**: `normalizeLookup` produces a different value than the inline copy for some edge case the behavior tests miss.
  - **Detection**: integration tests for the affected pipeline. For PR 6 specifically, post-deploy monitoring of `metadata_status` distribution and Sentry rates.
  - **Mitigation**: PR 1's behavior test suite covers the cases the parity tests already pin. The new composition test (`normalize-lookup.test.ts`) covers the combination logic. Remaining gap is "untested edge case in production data" — bounded by the fact that each port replaces logic that's already been running in prod.
  - **Rollback**: revert the per-callsite PR. The inline copy returns, the parity test returns. System is back to N-callsite duplication for that one site.
- **Risk**: `@wxyc/metadata` not packaged correctly in the Docker image for the worker or one of the jobs.
  - **Detection**: Docker build step in CI; smoke-test the image locally with `docker run`.
  - **Mitigation**: Follow the existing `@wxyc/lml-client` Dockerfile pattern (already used by every worker and job consuming lml-client). The new package follows identical packaging conventions.

### PR 7 risks

- **Risk**: the allowlist script is referenced from a workflow file we don't know about (e.g., a scheduled audit job).
  - **Detection**: grep across `.github/workflows/`, `.husky/`, `scripts/` for `check-spacer-gif-callsites` references before deletion.
  - **Rollback**: trivial — the script is just deleted; restoring it from `git` is one revert.

### Cross-cutting risk

- **Risk**: a sixth inline copy is introduced after PR 1 lands but before all five existing copies are migrated. The deep module exists but the new copy doesn't use it.
  - **Mitigation**: the allowlist script (kept until PR 7) catches any new mention of `'spacer.gif'` in pre-push.
  - **Detection**: code review.
- **Risk**: PRs 2–6 take longer than expected to merge, leaving the system in a mid-migration state for an extended period.
  - **Mitigation**: each PR leaves the system coherent. The mid-migration state has the deep module + some users + some inline-copy users. Both groups are correctly tested. There's no urgency.

### Active development during migration

- **Risk**: a developer lands a change to `apps/enrichment-worker/enrich.ts` or one of the inline-copy backfill files after PR 1 ships but before that callsite's port PR lands. If the change modifies the inline `filterSpacerGif`, `synthesizeSearchUrls`, or `cleanDiscogsBio` semantics, the relevant parity test starts failing.
  - **Detection**: the parity test fails in the developer's PR — _this is the intended behavior of the parity scaffolding_ and is exactly why we're keeping the seven parity tests + allowlist script alive until each callsite migrates.
  - **Resolution**: the developer coordinates with the open migration PR. Either (a) update both the inline copy AND the deep module's helper in the same PR, with the parity test confirming they still match, or (b) wait for the migration PR to land first, then make the change against `@wxyc/metadata` only (and the migrated callsite picks it up via import). Option (a) is fine and supported.
  - **Anti-pattern to avoid**: silencing the failing parity test by updating the inline copy alone. The test is there precisely to catch drift; updating one side without the other is the bug it's designed to surface.
  - **Note**: this is the same coordination cost the existing parity scaffolding already imposes — the deepening doesn't add new coordination risk during the migration window. After PR 7 lands, the scaffolding (and the coordination cost) is gone for good.

## Sequencing decisions and rationale

**Why one introduction PR + five port PRs + one cleanup PR, not one big PR:**

A single PR touching all seven files + the seven test deletions + the script removal would be ~700 lines added and ~400 lines deleted, with the diff spanning the runtime worker, four jobs, the backend shim conversion, the new package, and the test suite restructure. The review would block on too many independent questions: package shape, shim correctness, each port's correctness, test coverage of the new module. Splitting buys atomic reviewability and per-port rollback.

**Why backfills before the worker:**

The worker is the runtime hot path — every flowsheet entry written by a DJ goes through it. Backfills are cron-scheduled, idempotent, and easy to re-run after a fix. Porting backfills first exercises the deep module in production against real data shapes; by the time the worker ports, the module has four ports' worth of production validation behind it. If a defect surfaces in PR 6's worker port, we know the defect is in the worker's specific use of `normalizeLookup`, not in `normalizeLookup` itself.

**Why the order within backfills (library-artwork-url → flowsheet-artwork-repair → flowsheet-metadata-backfill → album-level-backfill):**

Smallest blast radius first. The library-artwork-url backfill writes one field (`library.artwork_url`) and is currently mostly drained. Even if the port introduced a regression, the consequence would be "one library row's artwork URL is wrong" — recoverable by re-running. Each subsequent port has a wider projection or higher activity. The bulk job is fourth because its `.map(normalizeLookup)` shape is the most novel — saving it for fourth means the per-row callers have validated the interface first.

**Why the cleanup PR is separate:**

Deleting the allowlist script is trivial but unrelated to any functional change. Keeping it in its own PR makes the diff trivial to review, and isolates the (small) risk that the script is referenced from somewhere we missed.

## Open questions

1. ~~**`cleanDiscogsMarkup` location.**~~ _Resolved during plan revision._ The canonical function is `cleanDiscogsBio` (at `apps/backend/services/metadata/metadata.service.ts:22-29`), and it cleans Discogs markup tags only from the `artist_bio` field — not from artist names or album titles. The migration ports `cleanDiscogsBio` (not a hypothetical `cleanDiscogsMarkup`) into `shared/metadata/src/helpers/clean-discogs-bio.ts`. The plan, helper file list, exports, and test list have been updated to reflect this.
2. **Sentry instrumentation inside `normalizeLookup`.** Should the deep module emit a Sentry breadcrumb when LML returned null artwork (signaling a "no match" rate) or when the synthesized fallback URLs are used (signaling LML coverage gaps)? Argument for: gives observability into LML coverage. Argument against: violates the "no I/O" rule for `shared/metadata/` — once Sentry is in, the package is no longer trivially testable without mocks. Resolution: leave Sentry out of the deep module; callers that want observability wrap the call (`Sentry.startSpan('normalize-lookup', () => normalizeLookup(...))`).
3. **Backend `enrichment.service.ts` migration.** `apps/backend/services/metadata/enrichment.service.ts` has its own enrichment pathway using `SearchUrlProvider` directly. It is out of scope for this work — left untouched, continues to work via the shim. Should there be a follow-up plan to migrate it to `normalizeLookup` as well? Suggest: yes, as a separate plan after this lands, since the `enrichment.service.ts` pathway has different invariants (it's called from the iOS proxy controller, not from the worker's CDC path, and it composes results across both album and artist scopes for the proxy response shape).
4. **README in `shared/metadata/`.** The body of the README — escape-hatch guidance, dependency-direction rule, no-I/O rule, snake_case rule — is sketched above. The exact text gets finalized in PR 1 implementation.
5. **Spotify URL synthesis consolidation.** The backend's `SearchUrlProvider.getAllSearchUrls` emits a synthesized Spotify URL (via the shim's `getSpotifyUrl`); the worker's `synthesizeSearchUrls` does not. The deep module preserves the worker's 3-service shape because that's what the write payloads need. If a future PR wants to add Spotify synthesis to the deep module, it'd need to define the emission semantics for the worker's path (should the worker now persist a synthesized Spotify URL even when LML returned null? — a behavior change). Out of scope here; flagging for future consideration.

## Acceptance

PR 1 — `@wxyc/metadata` exists, exports the six named symbols, has the three behavior test files passing, builds in the Docker images that depend on it (verified by integration test runs).

PRs 2–6 — each callsite imports from `@wxyc/metadata`, inline copies deleted, corresponding parity test deleted, allowlist entry removed. Integration tests pass. For PR 4 and PR 6, post-deploy `metadata_status` distribution unchanged for at least one cron cycle / one DJ shift respectively.

PR 7 — `scripts/check-spacer-gif-callsites.sh` deleted, no CI workflow or husky hook references it.

End state — single source of truth for LML-response normalization; one behavior test suite at the deep module's interface; zero scaffolding around inter-image code sharing for this specific concern.
