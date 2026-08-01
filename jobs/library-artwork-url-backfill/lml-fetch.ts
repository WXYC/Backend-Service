/**
 * LML lookup fetcher for the library.artwork_url backfill (#637, BS#1282).
 *
 * Was a vendored `fetch()` straight to `${baseUrl()}/api/v1/lookup` — this
 * file's own header used to say it "mirrors flowsheet-metadata-backfill/
 * lml-fetch.ts near-verbatim," i.e. it duplicated logic that job had already
 * migrated onto `@wxyc/lml-client.lookupMetadata` (the shared HTTP +
 * Sentry-instrumentation chokepoint from BS#887). BS#1282 finishes that
 * consolidation: this is now a thin wrapper, matching
 * `jobs/rotation-release-id-backfill/lml-fetch.ts`'s shape.
 *
 * `opts.discogsUnavailable` threads the BS#1293 runtime-lookup gate.
 * `orchestrate.ts` pre-reads `library.discogs_unavailable` for each
 * candidate row and passes it through here — when `true`,
 * `sharedLookupMetadata` short-circuits before any HTTP call or
 * limiter/token spend and returns a `GatedLookupResponse` with
 * `outcome: 'skipped_discogs_unavailable'`, so a flagged album's
 * `artwork_url` is never overwritten with a false Discogs match (the
 * Natanya-record complaint this epic exists to fix).
 *
 * BS#1910: `caller: 'library-artwork-url-backfill'` is now threaded through
 * — registered as class 5 (batch/backfill enrichment) in
 * `shared/lml-client/src/policy.ts`'s `ALL_LML_CALLERS`. This closes the D4
 * gate library-metadata-lookup's `/lookup` location-union feature depends
 * on (`plans/location-union-transparent-results.md`): LML skips its
 * recall-index probe for callers it sees as low-priority
 * (`X-Caller-Class=5`), and this job's traffic was previously invisible to
 * that check. Registering the label also picks up the class-5 defaults — a
 * 29s client timeout plus an `X-Caller-Budget-Ms: 28000` header — in place
 * of the bare client default (30s, no budget header). The header's real
 * effect is not "28s soft budget": LML clamps the effective search budget to
 * `min(header − 200ms, LML_SEARCH_BUDGET_MS)`, and prod's
 * `LML_SEARCH_BUDGET_MS` default is 4000ms, so this job's empty-results
 * lookups now cut off around ~4s instead of grinding on to LML's headerless
 * hard cap (`LML_SEARCH_HARD_TIMEOUT_MS`, default 25000ms). Still an
 * intended consequence of classification, not a regression, for a
 * fire-and-forget one-shot backfill. Unlike the canonical-entity sibling,
 * this job deliberately stays on the shared client's process-wide
 * `defaultLimiter`: it runs as its own container with a strictly-sequential
 * orchestrator, so the limiter is process-local (no interactive contention
 * is possible), a shed resolves to an unstamped row that the next sweep
 * retries, and swapping limiters would change long-standing runtime
 * behavior for no benefit — the class-5 dedicated-limiter convention
 * question is BS#1914's to settle fleet-wide.
 */

import { lookupMetadata as sharedLookupMetadata, type GatedLookupResponse } from '@wxyc/lml-client';

export const lookupMetadata = (
  artist: string,
  album?: string,
  opts?: { discogsUnavailable?: boolean }
): Promise<GatedLookupResponse> =>
  sharedLookupMetadata(artist, album, undefined, { ...opts, caller: 'library-artwork-url-backfill' });
