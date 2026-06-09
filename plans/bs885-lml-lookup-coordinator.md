> Plan for [BS#885 — B2 LmlLookupCoordinator: single chokepoint with in-flight coalescing](https://github.com/WXYC/Backend-Service/issues/885). Closes the last open child of [Epic B (BS#876)](https://github.com/WXYC/Backend-Service/issues/876). Slot 5 of [tracker BS#1279](https://github.com/WXYC/Backend-Service/issues/1279).

## Goal

Front every `lookupMetadata` call inside the `@wxyc/backend` API process with a single process-wide `LmlLookupCoordinator` that does two things and only two things:

1. **In-flight coalescing.** When two callers ask for the same `(artist, album, song)` while the first wire call is still in flight, the second caller awaits the first call's Promise instead of issuing its own LML request.
2. **Short-TTL response cache.** Successful `LookupResponse` payloads are memoized in a process-local LRU (~1000 entries, 5 min TTL) so a second request for the same key arriving 30 s after the first one's wire call resolves serves from cache.

LML's PG cache remains the source of truth; this is "we asked LML 30 s ago, the answer hasn't changed yet."

## Scope

### In scope (8 live callsites, all in `apps/backend`)

Identified by `grep -n 'lookupMetadata(' apps/backend/{controllers,services}/**/*.ts`, after BS#894 (orphan callers removed) and the BS#918 follow-up cleanup folded into this PR (removes the `PROXY_METADATA_SINGLE_LOOKUP=false` legacy `else` branch at `proxy.controller.ts:332`).

| #   | File:line                                                               | Function                                   | Path class     | `extended` today | Budget/timeout today                     | Existing `caller` tag      |
| --- | ----------------------------------------------------------------------- | ------------------------------------------ | -------------- | ---------------- | ---------------------------------------- | -------------------------- |
| 1   | `apps/backend/controllers/proxy.controller.ts:326`                      | `getAlbumMetadata`                         | iOS read       | `true`           | `PROXY_LML_BUDGET_MS=5000`               | `proxy-album-metadata`     |
| 2   | `apps/backend/controllers/library.controller.ts:98`                     | `addAlbum` (artwork+streaming)             | DJ write       | —                | `LIBRARY_LML_BUDGET_MS=5000`             | `library-add-album`        |
| 3   | `apps/backend/controllers/library.controller.ts:149`                    | `fireAndForgetCanonicalEntity`             | DJ write       | —                | `LIBRARY_LML_BUDGET_MS=5000`             | `library-canonical-entity` |
| 4   | `apps/backend/services/library.service.ts:639`                          | rotation picker `resolveRotationLmlSource` | DJ read        | `true`           | `ROTATION_LML_LOOKUP_TIMEOUT_MS=10000`   | `library-rotation-picker`  |
| 5   | `apps/backend/services/library.service.ts:893`                          | `enrichWithArtwork`                        | DJ read        | —                | `LIBRARY_INTERACTIVE_LML_BUDGET_MS=5000` | `library-enrich-artwork`   |
| 6   | `apps/backend/services/artwork/providers/discogs.ts:34`                 | Discogs artwork provider `search`          | proxy read     | —                | (none)                                   | `artwork-discogs-fallback` |
| 7   | `apps/backend/services/requestLine/requestLine.enhanced.service.ts:232` | `searchReleasesByArtist`                   | anonymous read | —                | (none)                                   | `request-line`             |
| 8   | `apps/backend/services/metadata/metadata.service.ts:67`                 | `fetchMetadata`                            | various        | —                | `METADATA_SERVICE_LML_BUDGET_MS=5000`    | `metadata-service`         |

The `proxy.controller.ts:332` legacy `else` branch is deleted as part of this PR — see Cleanups below.

### Out of scope

- **`apps/enrichment-worker/handler.ts:113`** — separate Docker container, separate Node process. Intra-instance coalescing in the API server cannot help a worker process; coordinating across processes is BS#885's explicit "out of scope" line (Redis Lua locks / PG advisory locks / sticky LB) and remains so. The worker keeps importing `lookupMetadata` directly from `@wxyc/lml-client`.
- **`lookupBySong`** at `library.service.ts:1620` (track-search) — different `/lookup` request body shape, already wrapped in its own well-tuned LRU at `searchLibraryByTrack`. A future iteration could fold both `lookupMetadata` and `lookupBySong` into one coordinator surface; out of scope here to keep the PR scoped.
- **Cross-instance coalescing.** Five BS instances each getting one user request for the same `(artist, album)` produces five LML calls; acceptable because dj-site session-stickiness collapses most same-key bursts onto one instance.
- **Coordinator-side field mapping** (the second cleanup item in BS#885's comment). Moves the duplicate `populateCommonMetadataFields` / `extractAlbumMetadata` maps into one place — worth doing but expands the PR significantly. Filed as follow-up. The narrow extended-field gap (`artist_image_url`, `profile_tokens`) is closed in this PR at the existing map sites.

## Design

### File layout

```
apps/backend/services/lml/
  lookup-coordinator.ts        # new — coordinator class + module-level singleton
  index.ts                     # new — re-exports `lmlLookupCoordinator`

tests/unit/services/lml/
  lookup-coordinator.test.ts   # new — unit tests for coalescing, caching, error semantics
```

### Coordinator shape

```typescript
import { LRUCache } from 'lru-cache';
import { lookupMetadata, type LookupOptions, type LookupResponse } from '@wxyc/lml-client';
import * as Sentry from '@sentry/node';

export interface CoordinatorLookupOptions extends Pick<
  LookupOptions,
  'budgetMs' | 'timeoutMs' | 'caller' | 'warm_cache' | 'limiter'
> {
  // `extended` is intentionally NOT exposed — the coordinator forces `true`
  // so cached responses are valid for any caller (BS#885's "passes `extended: true` explicitly").
}

interface InFlightEntry {
  promise: Promise<LookupResponse>;
}

export class LmlLookupCoordinator {
  private readonly inflight = new Map<string, InFlightEntry>();
  private readonly cache: LRUCache<string, LookupResponse>;

  constructor(opts?: { maxEntries?: number; ttlMs?: number }) {
    this.cache = new LRUCache({
      max: opts?.maxEntries ?? 1000,
      ttl: opts?.ttlMs ?? 5 * 60 * 1000,
    });
  }

  async lookup(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options?: CoordinatorLookupOptions
  ): Promise<LookupResponse> {
    const key = this.cacheKey(artist, album, song);

    return Sentry.startSpan({ name: 'lml.coordinator.lookup', op: 'function' }, async (span) => {
      const cached = this.cache.get(key);
      if (cached) {
        this.setSpanAttrs(span, { hit: 'cache', caller: options?.caller });
        return cached;
      }

      const existing = this.inflight.get(key);
      if (existing) {
        this.setSpanAttrs(span, { hit: 'inflight', caller: options?.caller });
        return existing.promise;
      }

      const promise = this.fetchUncached(artist, album, song, options).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, { promise });
      this.setSpanAttrs(span, { hit: 'miss', caller: options?.caller });

      const result = await promise;
      this.cache.set(key, result);
      return result;
    });
  }

  private async fetchUncached(
    artist: string | undefined,
    album: string | undefined,
    song: string | undefined,
    options?: CoordinatorLookupOptions
  ): Promise<LookupResponse> {
    return lookupMetadata(artist, album, song, {
      extended: true,
      warm_cache: options?.warm_cache,
      budgetMs: options?.budgetMs,
      timeoutMs: options?.timeoutMs,
      caller: options?.caller,
      limiter: options?.limiter,
    });
  }

  private cacheKey(artist?: string, album?: string, song?: string): string {
    return [normalize(artist), normalize(album), normalize(song)].join('|');
  }

  private setSpanAttrs(
    span: ReturnType<typeof Sentry.getActiveSpan>,
    attrs: { hit: 'cache' | 'inflight' | 'miss'; caller?: string }
  ): void {
    try {
      span?.setAttributes({
        'lml.coordinator.hit': attrs.hit,
        'lml.coordinator.caller': attrs.caller ?? 'unknown',
      });
    } catch (err) {
      console.warn('lml.coordinator: failed to project attrs onto span', err);
    }
  }
}

function normalize(s?: string): string {
  if (!s) return '∅';
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const lmlLookupCoordinator = new LmlLookupCoordinator();

// Test-only — lets a test exercise eviction/coalescing without leaking state.
// Mirrors `_resetLmlClientLimitersForTest()` in `@wxyc/lml-client`.
export function _resetLmlLookupCoordinatorForTest(): void {
  lmlLookupCoordinator['inflight'].clear();
  lmlLookupCoordinator['cache'].clear();
}
```

### Key semantic decisions

1. **`extended: true` is forced.** Some callers don't need the extra fields; passing them harmlessly inflates payload size by ~1 KB. The win — every cached entry is usable by every caller, no shape mismatch — outweighs the per-call cost. This is the issue's stated mandate.

2. **`warm_cache` follows first-caller-wins like every other LookupOption.** Whether the wire call carries `warm_cache: true` is decided by whichever caller arrived first. Subsequent coalescers don't union onto the in-flight request — the wire body is already serialized and in flight by the time they arrive. Write-path callers (`library-add-album`, `library-canonical-entity`) set `warm_cache: true` at their call site; whether a coalesced burst warms LML's PG cache is decided entirely by which caller arrived first. Acceptable in practice because (a) write-path callers dominate same-key bursts originating from a single user action, and (b) warm-cache is a best-effort side benefit, not a correctness invariant.

3. **First-caller-wins for budget/timeout/limiter/caller-tag on the wire.** Subsequent coalescers wait on the in-flight promise. Each caller wraps its own deadline locally via `Promise.race` against an `AbortSignal.timeout` if they need stricter semantics — out of scope for the coordinator itself; the read paths that have tight budgets (proxy, library) already handle their own catch arms. **This is documented behavior**: the coordinator does not honor per-caller timeoutMs after coalescing.

4. **No error caching.** Throws propagate to all coalescing waiters; the in-flight entry is cleared in `finally`. The next request for the same key issues a fresh wire call. LML's own short cache TTL on errors handles avalanche.

5. **5 min TTL** matches the issue's spec. Stale-but-fresh-enough for the typical "DJ adds a track, three downstream queries fire within seconds" pattern. LML's PG cache is the source of truth — for content changes (new artwork, corrected tracklist), the 5-min staleness window is acceptable.

6. **Cache key normalization** is conservative: trim, lowercase, collapse internal whitespace. No diacritic folding, no fuzzy normalization — that's LML's parser's job, not the coordinator's.

7. **Per-instance singleton.** Module-level instance like the existing `defaultLimiter`. Tests use `_resetLmlLookupCoordinatorForTest()` between cases.

### Span instrumentation

| Attribute                | Values                            | Purpose                                                                           |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------- |
| `lml.coordinator.hit`    | `cache` \| `inflight` \| `miss`   | Outcome class — drives the "did coalescing/caching collapse a call?" Sentry query |
| `lml.coordinator.caller` | the caller tag of THIS invocation | Per-call attribution even when underlying wire call inherited a different tag     |

The underlying `lml.lookup` span continues to fire on wire-call misses (existing chokepoint instrumentation in `@wxyc/lml-client`). Cache hits and in-flight coalesces produce only the `lml.coordinator.lookup` span — by construction, that's the observability win.

## Migration

8 callsite changes, each: replace `lookupMetadata(...)` with `lmlLookupCoordinator.lookup(...)`; drop the `extended` flag (coordinator forces it); keep `budgetMs`/`timeoutMs`/`caller`/`warm_cache`/`limiter`.

Write-path additions:

- `library.controller.ts:98` (`addAlbum`) → add `warm_cache: true`
- `library.controller.ts:149` (`fireAndForgetCanonicalEntity`) → add `warm_cache: true`

This replaces the orphan `flowsheet-linkage.service.ts` warm-cache opt-in that BS#1322 removes.

Test-side: 8 callsite test files (mostly proxy.controller.test.ts, library.controller.test.ts, library.service.test.ts, metadata.service.test.ts, requestLine.enhanced.service.test.ts, artwork providers tests) each swap `jest.mock('@wxyc/lml-client')` for `jest.mock('../../services/lml/lookup-coordinator')` and assert on the coordinator instead. Most are one-line mock target swaps.

## Cleanups folded into this PR (per BS#885 comment)

### 1. Delete `PROXY_METADATA_SINGLE_LOOKUP` machinery (per BS#918)

Since the coordinator forces `extended: true`, the flag becomes dead code. In the same PR:

- Delete `singleLookupEnabled()` in `apps/backend/controllers/proxy.controller.ts`
- Delete the legacy `else` branch in `getAlbumMetadata` (the `getRelease()` follow-up call)
- Delete the `describe('PROXY_METADATA_SINGLE_LOOKUP=true', ...)` block in `tests/unit/controllers/proxy.controller.test.ts`
- Remove `PROXY_METADATA_SINGLE_LOOKUP` from `.env.example` and `docs/env-vars.md`
- Note in PR body: Railway prod env should drop `PROXY_METADATA_SINGLE_LOOKUP` (no-op since the code path is gone, but env cleanup)

### 2. Forward `artist_image_url` + `profile_tokens` on the proxy response

`populateCommonMetadataFields` (`apps/backend/controllers/proxy.controller.ts:205-218`) maps `artistBio` and `artistWikipediaUrl` off the artwork block but stops there. Two-line addition:

```typescript
if (artwork.artist_image_url) metadata.artistImageUrl = artwork.artist_image_url;
if (artwork.profile_tokens) metadata.bioTokens = artwork.profile_tokens;
```

Consumed by `wxyc-ios-64#270`'s fallback path. The parallel `metadata.service.ts:extractAlbumMetadata` is intentionally NOT modified: its result shape (`AlbumMetadataResult`, `ArtistMetadataResult`) feeds persistence (flowsheet metadata columns), not the proxy response, and adding the fields there would require schema additions out of scope for B2. The persistence-side fix is filed as follow-up.

## Test plan

### Unit tests (`tests/unit/services/lml/lookup-coordinator.test.ts`)

- **Single call**: one `lookup()` → one `lookupMetadata` invocation.
- **In-flight coalescing**: two concurrent `lookup()` calls for the same key → one `lookupMetadata` invocation, both Promises resolve to the same response object.
- **Cache hit**: `lookup()` after a settled prior `lookup()` for the same key → zero `lookupMetadata` invocations, returns cached value.
- **TTL expiry**: `lookup()` after the TTL elapses → fresh `lookupMetadata` invocation (use jest fake timers + injected `ttlMs`).
- **Error propagation, no cache poisoning**: a throwing `lookupMetadata` rejects all coalescing waiters; the next call issues a fresh wire request.
- **Cache key normalization**: `("Beatles", "Abbey Road", undefined)` and `("BEATLES ", " abbey  road", "")` map to the same cache entry.
- **`warm_cache` passthrough (first-caller-wins)**: two concurrent callers where the first sets `warm_cache: false` and the second sets `warm_cache: true` produce one wire call with `warm_cache: false`. The reverse ordering produces `warm_cache: true`. (Documents the actual semantics — the wire body is in flight before coalescers arrive.)
- **First-caller-wins on caller tag**: the wire call's `caller` field matches the first caller in.

### Existing callsite unit tests

Each of the 8 callsite tests updates its mock target from `@wxyc/lml-client` to `../../services/lml/lookup-coordinator`. Assertions on the arguments passed are updated to match the new shape (drop `extended` from expectations; assert `warm_cache` on the two write-path callers).

### Integration test

Add `tests/integration/lml-coordinator.spec.js`:

- Submit two concurrent `/proxy/metadata/album?artistName=X&releaseTitle=Y` requests for the same key.
- Assert the mock LML server received exactly **one** `POST /api/v1/lookup`.

The mock LML server already exists in `dev_env/mock-lml/` per `metadata-lml.spec.js`; this just wires a call-counter assertion (existing pattern). Sentry span-tree assertions are deliberately NOT in the integration test — `getActiveSpan()` returns the active span at assertion time, not a historical trace, and the Sentry test SDK setup isn't worth the complexity. Span-tree shape is verified post-deploy via the Sentry trace explorer (see "Sentry acceptance" below).

### Sentry acceptance (post-deploy)

Per BS#885 acceptance criteria:

- A single dj-site addEntry that previously produced two `lml.lookup` spans (one from `fireAndForgetMetadata`, one from `fireAndForgetLinkage`) produces… well, the two-call pattern was already eliminated by BS#894, so this criterion is **already satisfied at the trace-shape level**. The coordinator's narrower acceptance is the next bullet:
- Two concurrent intra-instance calls for the same `(artist, album, song)` produce one outbound `lml.lookup` span (one coordinator-miss, one coordinator-inflight-hit). Verifiable in the Sentry trace explorer within 24h of deploy.

## Risks + mitigations

| Risk                                                                                                                                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forcing `extended: true` for callers that don't read those fields incurs LML cost.                                                           | LML's response shape already populates the fields on cache hit; on cache miss, the existing `extended` flag triggers the same downstream work. No new LML compute. Payload size grows by ~1 KB per response. Acceptable.                                                                                                                                                                |
| First-caller-wins for budget means a tight-deadline second caller waits for a longer-deadline first caller.                                  | Documented. Callers with hard deadlines (proxy) wrap with their own catch arm — the existing `try/catch` patterns in proxy.controller already do this.                                                                                                                                                                                                                                  |
| The new module-level singleton's state isn't reset between Jest test suites, leaking cache hits across tests.                                | Provide `_resetLmlLookupCoordinatorForTest()`; call from each callsite test's `beforeEach`.                                                                                                                                                                                                                                                                                             |
| `warm_cache` first-caller-wins means a read-path caller arriving first can prevent a coalescing write-path caller's PG cache warm.           | Warm-cache is a best-effort side benefit, not a correctness invariant. Same-key bursts that originate from a single DJ action almost always have the write-path caller arrive first because the write-path is what _triggers_ the burst (`library.controller.addAlbum` fires both the artwork lookup and the canonical-entity lookup before any downstream read paths see the new row). |
| Stale cached response (5 min TTL) returned after an artwork was updated in LML.                                                              | Cached response is the _prior_ LookupResponse; LML's own writes don't propagate through BS's cache. Acceptable for ~5 min UI staleness. If real, this becomes a TTL tuning ticket post-launch.                                                                                                                                                                                          |
| Per-instance singleton means N BS replicas have N independent caches; same-key bursts hitting different replicas still produce N wire calls. | Documented as "intra-instance only" — the issue's explicit out-of-scope. dj-site session stickiness collapses most bursts onto one replica.                                                                                                                                                                                                                                             |

## PR delta estimate

- New: `apps/backend/services/lml/lookup-coordinator.ts` (~150 lines), `apps/backend/services/lml/index.ts` (~5 lines)
- New: `tests/unit/services/lml/lookup-coordinator.test.ts` (~250 lines)
- 8 callsite migrations: 1-3 lines each (~20 lines total)
- 8 callsite test mock-target swaps + assertion updates: ~15 lines each (~120 lines)
- New: `tests/integration/lml-coordinator.spec.js` (~80 lines)
- `proxy.controller.ts` cleanup (delete `singleLookupEnabled` + legacy else branch + 2 forwarded fields): ~-40 / +4 lines
- `metadata.service.ts` cleanup (2 forwarded fields): +2 lines
- `proxy.controller.test.ts` cleanup (delete legacy describe): ~-60 lines
- `.env.example` + `docs/env-vars.md` (remove `PROXY_METADATA_SINGLE_LOOKUP`): ~-5 lines

**Net: ~+550 / -110, ~660 lines across ~18 files.** Comfortably under 1000.

## Sequencing relative to BS#1322 (orphan cleanup)

BS#1322 deletes `enrichment.service.ts` + `flowsheet-linkage.service.ts` + `linkage-metrics.service.ts` (the C5 cleanup). It is independent of this PR — neither blocks the other:

- BS#1322 can ship before this PR: removes already-orphan code; no LML callsite impact.
- This PR can ship before BS#1322: the orphan modules still call `lookupMetadata` directly, but they're not invoked from any live path, so the coordinator simply has no coalescing opportunity with them.

I'll let BS#1322 ship first if convenient (mechanical, low-risk); otherwise this PR proceeds independently.

## Rollout

1. Worktree off `main`. TDD: unit test for coalescing → coordinator skeleton → pass → migrate one caller (`metadata.service.ts` — simplest) → unit tests pass → migrate remaining 7 → unit tests pass → integration tests pass → cleanups (#918 dead code + extended fields).
2. Local `npm run typecheck && npm run lint && npm run format:check && npm run test:unit && npm run ci:testmock` before push.
3. Open PR; close BS#885 via `Closes #885` in PR body.
4. `/review-loop` to converge on substantive findings.
5. Rebase-and-merge to main (use `--admin` if needed for branch protection).
6. Post-merge: watch the 24h Sentry trace for the acceptance criterion (one wire call from two concurrent intra-instance lookups). If the rate isn't measurably collapsing, the LRU TTL or cache-key normalization may need tuning — file a follow-up.

## Open questions for review

1. **Should `library-rotation-picker`'s 10 s `ROTATION_LML_LOOKUP_TIMEOUT_MS` win over a competing proxy caller's 5 s `PROXY_LML_BUDGET_MS` when they coalesce?** Current plan: first-caller-wins on the wire. Alternative: max-wins (be patient enough for the slowest caller). I lean first-caller-wins because it's simpler and the worst case (longer-budget caller coalesces with shorter-budget first caller) gets a faster answer than it would have alone.
2. **Should the `lml.coordinator.lookup` span suppress the inner `lml.lookup` span on cache-hit / in-flight-hit?** Plan: no — Sentry handles span nesting; the absence of a child `lml.lookup` span on hits is itself the observability signal (verifiable in the trace tree). **Implementation verification step**: after wiring the coordinator + the first migrated caller, hit `/proxy/metadata/album` twice locally with the dev DB and inspect the local Sentry trace tree to confirm (a) the miss path produces `lml.coordinator.lookup` → `lml.lookup` as parent → child, and (b) the second-call cache hit produces only `lml.coordinator.lookup` with no inner `lml.lookup` child. If the trace shape is wrong (e.g., orphan inner span on cache hit), add an explicit no-op span context on hit paths.
3. **Test-only `_resetLmlLookupCoordinatorForTest()` — leak risk?** Plan: ship it as a named export with the `_` prefix convention. Mirrors `_resetLmlClientLimitersForTest()` in `@wxyc/lml-client`. Eslint already allows underscore-prefixed test-only exports here.
