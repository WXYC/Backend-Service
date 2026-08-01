/**
 * LML lookup fetcher for the library.canonical_entity_id backfill (B-1.2).
 *
 * BS#1910: migrated off a vendored `fetch()` straight to
 * `${baseUrl()}/api/v1/lookup` onto `@wxyc/lml-client.lookupMetadata` — the
 * shared HTTP + Sentry-instrumentation chokepoint every other backfill job
 * already uses (mirrors `jobs/library-artwork-url-backfill/lml-fetch.ts`).
 * The prior hand-rolled fetch could never carry a `caller` label, so it was
 * invisible to the BS#1826 caller-classification policy and to LML's
 * `X-Caller-Class` header (BS#1843) — exactly the D4 gap
 * library-metadata-lookup's `/lookup` location-union feature depends on BS
 * closing (`plans/location-union-transparent-results.md`): LML skips its
 * recall-index probe for callers it sees as low-priority
 * (`X-Caller-Class=5`), and this job's traffic was previously unclassified.
 * Registering `library-canonical-entity-backfill` as class 5 in
 * `shared/lml-client/src/policy.ts` closes that gap.
 *
 * What is byte-identical, and what genuinely is not (BS#1911 review):
 *   - `timeoutMs: 30000` is passed explicitly (rather than left to default
 *     to the class-5 policy's 29s) so this job's per-call abort budget
 *     stays byte-identical to its pre-migration value — this job
 *     deliberately runs a longer timeout than the interactive-path default
 *     because it processes long-tail rows that trigger Discogs/MusicBrainz
 *     fallback chains, and `orchestrate.ts`'s `THROTTLE_MS=100` sequential
 *     loop caps in-flight requests at one, so the longer per-call cap
 *     doesn't risk piling up on LML.
 *   - The bearer header (`LML_API_KEY`, when set) is applied identically by
 *     the shared client's chokepoint.
 *   - A thrown failure (timeout, non-2xx, network error) still surfaces as
 *     a plain `Error` (`LmlClientError extends Error`) that
 *     `orchestrate.ts`'s `processRow` catches and counts as `'error'`, so a
 *     bad row still rolls forward to the next sweep unchanged. Unlike the
 *     old vendored fetch — which rethrew the original network exception
 *     unmodified and set `{ cause }` on its timeout wrapper — the shared
 *     client wraps every failure in `LmlClientError` without `.cause`, so
 *     the original `AbortError`/`TypeError` is no longer reachable from the
 *     thrown error; harmless today, since `processRow` only reads
 *     `.message`.
 *   - The shared client additionally runs the JSON response through
 *     `sanitizeLookupStreamingUrls` (BS#1710) before returning. This is a
 *     no-op for this job: `resolve.ts`'s `resolveCanonicalEntity` only reads
 *     `results[0].artwork.release_id` and `search_type`, never any
 *     streaming-URL field.
 *   - What is NOT byte-identical: class-5 registration adds an
 *     `X-Caller-Budget-Ms: 28000` header the old raw `fetch()` never sent.
 *     On LML's side (`core/search.py`), the effective search budget is
 *     `min(header − 200ms, LML_SEARCH_BUDGET_MS)`; prod leaves
 *     `LML_SEARCH_BUDGET_MS` at its default 4000, so the header's real
 *     effect is a ~4s budget — and the header's mere *presence* is what
 *     activates LML's empty-state cascade cutoff (LML#345) and
 *     enrichment-tail shed (LML#930). Headerless (the old behavior), an
 *     empty-results cascade instead grinds on to LML's own hard cap,
 *     `LML_SEARCH_HARD_TIMEOUT_MS` (default 25000) — the old 30s client
 *     abort here essentially never fired before LML gave up on its own. So
 *     the practical effect of this migration on a hard-miss row is going
 *     from "up to ~25s of LML grinding before the row counts as an error"
 *     to "~4s empty-state cutoff." This was measured, not assumed: a
 *     2026-07-31 30-row random probe of this job's live retry pool
 *     (34,520 rows on prod at the time), replaying the exact old
 *     (headerless) wire behavior against today's warmed LML, found 29/30
 *     rows auto-accepting sub-second (0.2–1.0s), zero rows landing in the
 *     4–25s band the header concedes, and the lone miss (a Various Artists
 *     compilation, "Cocktail Mix Vol. 3: Swingin' Singles") failing fast at
 *     0.51s — a structural VA-compilation gap (the
 *     WXYC/library-metadata-lookup#271 / #1018 compilation-recall family)
 *     that no amount of budget resolves. See PR #1911 for the full
 *     probe methodology. The recall this drift could plausibly cost is
 *     therefore ~empty, and the class-5 defaults are kept as intended
 *     behavior rather than overridden with an explicit `budgetMs`.
 *   - Also not byte-identical: the old raw `fetch()` had no rate/concurrency
 *     gate at all. Per the class-5 convention documented in
 *     `shared/lml-client/src/policy.ts` ("the caller MUST supply its own
 *     dedicated limiter, class 5 … never `defaultLimiter`"), this job now
 *     passes its own `defaultLmlLimiter` from `./lml-limiter.js` — see that
 *     file for the rate/concurrency defaults and their rationale.
 */

import { lookupMetadata as sharedLookupMetadata } from '@wxyc/lml-client';

import { defaultLmlLimiter } from './lml-limiter.js';
import type { LmlLookupResponse } from './lml-types.js';

export const lookupMetadata = (artist: string, album?: string): Promise<LmlLookupResponse> =>
  sharedLookupMetadata(artist, album, undefined, {
    caller: 'library-canonical-entity-backfill',
    timeoutMs: 30000,
    limiter: defaultLmlLimiter,
  });
