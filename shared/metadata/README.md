# @wxyc/metadata

Deep module that normalizes a `LookupResponse` from `@wxyc/lml-client` into a flat, snake_case `NormalizedMetadata` shape. One composition (`normalizeLookup`), four helpers (`filterSpacerGif`, `isSyntheticArtwork`, `cleanDiscogsBio`, `synthesizeSearchUrls`), and the `album_metadata` release-group mapping built on the composition (`buildReleaseGroup`).

## Why a separate package

Before this package, every flowsheet-enrichment callsite — `apps/enrichment-worker`, `jobs/flowsheet-metadata-backfill`, `jobs/library-artwork-url-backfill`, `jobs/flowsheet-artwork-repair`, `jobs/album-level-backfill` — kept its own inline copy of the same four helpers, pinned to the `apps/backend` canonical via parity tests + an allowlist script. Five copies, seven parity tests, one allowlist. Each copy was a deeper-than-it-looks consequence of build-graph isolation: a job's Docker image can't import from `apps/backend`. The historical workaround was duplication-with-tests; the new arrangement is a tiny shared workspace package with no I/O.

The composition that ties the helpers together (`normalizeLookup`) reads `LookupResponse.results[0].artwork`, decides synthetic vs full vs missing, and emits the same ten-column metadata payload the worker and jobs were each computing independently. Callers stop knowing about the four-way branching; they get a flat object back.

## Public surface

```ts
import {
  normalizeLookup,
  type NormalizedMetadata,
  type MetadataFallbacks,
  filterSpacerGif,
  isSyntheticArtwork,
  cleanDiscogsBio,
  synthesizeSearchUrls,
  buildReleaseGroup,
  CLEAR_RELEASE_GROUP,
  type ReleaseGroup,
} from '@wxyc/metadata';
```

`buildReleaseGroup` maps an answer to the release group of `album_metadata` (`discogs_url`, `artwork_url`, `release_year`, `label`, `full_release_date`, `genres`, `styles`, `tracklist`), written as a unit with nulls included. It moved here from the BS#3137 re-ask (BS#3791) so the release picker (BS#3790) writes those columns the same way. The artist group is not part of it; each caller decides whether to merge or overwrite it.

## Rules

- **No I/O.** Pure functions only. If you need to fetch from LML, do it in your caller and pass the response in. If you need to write to PG, do it in your caller and pass `normalizeLookup`'s return value to your DB code.
- **Depends only on `@wxyc/lml-client` and `@wxyc/database`**, both type-only: `LookupResponse` and `DiscogsMatchResult` from the first, and `AlbumMetadata` from the second, so `ReleaseGroup`'s column names and types follow the schema. Never import from `apps/*` or `jobs/*` — that would invert the dependency direction this package exists to flatten.
- **snake_case fields** on the API surface. Matches the Drizzle schema; lets callers spread directly into `.set({...})` blocks. Callers that need camelCase (e.g. the proxy controller's iOS response shape) convert at their own edge.

## Escape hatch

If you need to add a new helper that handles a piece of LML output, add it here, not inline at a callsite. Adding it inline reopens the duplication-with-parity-tests pattern this package was built to retire.

If a helper grows side effects (HTTP, DB, file I/O), it has outgrown this package — move it to the caller that needs the side effect, and keep the pure derivation here.

## Tests

Tests live in `src/__tests__/` and run via the root `npm run test:unit` (Jest is configured at the repo root, not per-workspace). The shape on test failure is _"the deep module's interface returned the wrong thing"_, not _"this inline copy diverged from the canonical"_ — the parity tests this package replaces are deleted by PR 7 of the rollout (see `plans/metadata-deep-module.md`).
